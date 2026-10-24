// Outbox do suporte@ (worker/support-email-forward.mjs) contra PostgreSQL 16 REAL descartável: esquema aplicado
// exatamente como o Worker aplica (ensureSupportSchema), consumidores concorrentes com conexões separadas,
// reservas de cota simultâneas, lease/reap, limites de 10 tentativas e 23 h, transições e zero leitura, encaminhamento ou confirmação associada à mensagem após estouro
// (o único envio permitido é o alerta operacional ao dono, só com contagens). Resend é falso (contador por id); sem segredo, sem rede.
// Rodar: T4_PG_HOST=localhost T4_PG_PORT=5432 node --test tests/integration/support-outbox-postgres.test.mjs
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import * as fwd from "../../worker/support-email-forward.mjs";

const HOST = process.env.T4_PG_HOST, PORT = process.env.T4_PG_PORT || "5432";
const SKIP = !HOST && "T4_PG_HOST not set (throwaway local PostgreSQL required)";
const DB = "ci_support_outbox";
const run = promisify(execFile);
const OWNER = "dono-teste@example.org";

const lit = (v) => v === null || v === undefined ? "NULL" : typeof v === "boolean" ? String(v) : "'" + String(v).replace(/'/g, "''") + "'";
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}
const psqlArgs = (sql, db) => ["-h", HOST, "-p", PORT, "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "--csv", "-c", sql];
// Cada consulta = processo psql próprio = conexão própria: dois consumidores concorrem de verdade no servidor.
const sql = {
  count: 0,
  async query(q, params = []) {
    sql.count++;
    const inl = q.replace(/\$(\d+)/g, (_, n) => lit(params[Number(n) - 1]));
    const { stdout } = await run("psql", psqlArgs(inl, DB), { encoding: "utf8", maxBuffer: 1 << 24 });
    const rows = parseCsv(stdout.trim() ? stdout : "");
    if (!rows.length) return [];
    const [head, ...data] = rows;
    return data.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
  }
};
const psqlSync = (q, db = DB) => execFileSync("psql", psqlArgs(q, db), { encoding: "utf8" });
const one = async (q) => (await sql.query(q))[0];

// Resend falso: atraso para alargar a janela de corrida; contadores por id (GET pelo caminho, POST pela Idempotency-Key).
function resend({ senderOf = (id) => `cliente-${id}@example.com`, failForward = () => false, failAck = () => false, readStatus = () => 0, detailOf = () => ({}) } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    await new Promise((r) => setTimeout(r, 25));
    const u = new URL(url);
    assert.equal(u.hostname, "api.resend.com");
    if ((init.method || "GET") === "GET") {
      const id = decodeURIComponent(u.pathname.split("/")[3]);
      calls.push({ kind: "read", id });
      const st = readStatus(id);
      if (st) return new Response("{}", { status: st });
      return Response.json({ id, from: senderOf(id), subject: "Assunto", text: "corpo", headers: {}, attachments: [], created_at: "2026-10-23T12:00:00Z", message_id: `<${id}@example.com>`, ...detailOf(id) });
    }
    const body = JSON.parse(init.body);
    const idem = String(init.headers["idempotency-key"] || "");
    const kind = idem.startsWith("support-fwd/") ? "forward" : idem.startsWith("support-ack/") ? "ack" : "alert";
    const id = idem.split("/")[1] || "";
    calls.push({ kind, id, subject: body.subject, body });
    if ((kind === "forward" && failForward(id)) || (kind === "ack" && failAck(id))) return new Response("{}", { status: 500 });
    return Response.json({ id: "out-" + calls.length });
  };
  const of = (kind, id) => calls.filter((c) => c.kind === kind && (id === undefined || c.id === id)).length;
  const forId = (id) => calls.filter((c) => c.id === id).length;
  return { calls, fetchImpl, of, forId };
}
const env = { RESEND_API_KEY: "re_send_only", RESEND_RECEIVING_API_KEY: "re_full_receiving", SUPPORT_FORWARD_TO: OWNER, LEAD_PRIVACY_SECRET: "privacidade-sintetica-de-teste-0123456789abcdef", DATABASE_URL: "postgres://ci" };
const ctx = (r) => ({ env, forwardTo: OWNER, sendKey: env.RESEND_API_KEY, rKey: env.RESEND_RECEIVING_API_KEY, secret: env.LEAD_PRIVACY_SECRET, sql, fetchImpl: r.fetchImpl, nowMs: Date.now() });
const drain = (r, limit = 5) => fwd.drainSupportOutbox(env, { sqlFactory: () => sql, fetchImpl: r.fetchImpl, limit });
async function seed(ids, { sender = (id) => "ref-" + id, state = "forward_pending", attempts = 0, age = "0 seconds", readFailures = 0, sendFailures = 0 } = {}) {
  const values = ids.map((id) => `(${lit(id)}, 'suporte', ${lit(sender(id))}, ${lit(state)}, ${attempts}, now() - interval ${lit(age)}, ${readFailures}, ${sendFailures})`).join(",");
  await sql.query(`insert into zevanory_support_inbound (email_id, alias, sender_ref, state, attempts, created_at, read_failures, send_failures) values ${values}`);
}
const stateOf = async (id) => one(`select state, attempts, ack_status, (next_attempt_at > now()) as backoff, lease_until is not null as leased from zevanory_support_inbound where email_id = ${lit(id)}`);
const makeDue = (id) => sql.query(`update zevanory_support_inbound set next_attempt_at = now(), lease_until = null where email_id = ${lit(id)}`);

// Alerta ao dono: destinatário = só o destino configurado; corpo = só categoria operacional + contagens.
// Nada do remetente (endereço), assunto, texto da mensagem, message-id ou email_id de nenhuma linha.
const SENDER_RE = /[a-z0-9._%+-]+@(?!zevanory\.api\.br\b)[a-z0-9.-]+\.[a-z]{2,}/gi;
function assertAlertPrivate(a, ids, { category, count, oldest }) {
  const b = a.body;
  assert.deepEqual(b.to, [OWNER], "destinatário é só o destino configurado");
  assert.equal(b.from, "ZEVANORY suporte <suporte@zevanory.api.br>");
  assert.equal(b.reply_to, undefined);
  assert.equal(b.cc, undefined); assert.equal(b.bcc, undefined); assert.equal(b.headers, undefined); assert.equal(b.attachments, undefined); assert.equal(b.html, undefined);
  assert.deepEqual(Object.keys(b).sort(), ["from", "subject", "text", "to"]);
  const visible = b.subject + "\n" + b.text;
  const others = (visible.match(SENDER_RE) || []);
  assert.deepEqual(others, [], "nenhum endereço de remetente no alerta");
  for (const id of ids) assert.ok(!visible.includes(id), "email_id ausente: " + id);
  for (const bad of ["Assunto", "corpo", "@example.com", "<", "message"]) assert.ok(!visible.includes(bad), "conteúdo ausente: " + bad);
  // Igualdade EXATA com o modelo canônico: só contagem/categoria substituídas. Qualquer campo ou palavra a mais falha.
  const expected = ALERT_TEMPLATES[category]({ count, oldest });
  assert.deepEqual({ to: b.to, from: b.from, subject: b.subject, text: b.text }, { to: [OWNER], from: "ZEVANORY suporte <suporte@zevanory.api.br>", ...expected });
  assert.deepEqual(b, { to: [OWNER], from: "ZEVANORY suporte <suporte@zevanory.api.br>", ...expected });
}
// Modelos canônicos dos alertas (escritos aqui de forma independente do módulo).
const ALERT_FOOTER = "\n\nVeja as mensagens no painel Resend > Receiving e o passo a passo em docs/ops/EMAIL_SUPORTE.md.";
const ALERT_TEMPLATES = {
  dead: ({ count }) => ({
    subject: "[ZEVANORY suporte] ALERTA: mensagens de clientes não entregues",
    text: `${count} mensagem(ns) para suporte@/contato@ esgotaram as tentativas (encaminhamento ou confirmação) e não serão mais tentadas.` + ALERT_FOOTER
  }),
  backlog: ({ count, oldest }) => ({
    subject: "[ZEVANORY suporte] ALERTA: fila de suporte atrasada",
    text: `${count} mensagem(ns) ainda pendente(s); a mais antiga chegou há ${oldest} min.` + ALERT_FOOTER
  })
};

before(() => {
  if (SKIP) return;
  psqlSync(`drop database if exists ${DB}`, "postgres");
  psqlSync(`create database ${DB}`, "postgres");
});
beforeEach(async () => {
  if (SKIP) return;
  fwd.resetSupportSchemaCache();
  await fwd.ensureSupportSchema(sql);
  await sql.query("truncate zevanory_support_inbound, zevanory_support_ack_quota, zevanory_support_alerts, zevanory_support_drain_nonces");
});

test("O1 esquema aplicado exatamente como o Worker aplica (idempotente), com estados e chaves esperados", { skip: SKIP }, async () => {
  fwd.resetSupportSchemaCache();
  await fwd.ensureSupportSchema(sql);
  const cols = (await sql.query("select table_name, column_name from information_schema.columns where table_name like 'zevanory_support_%' order by 1, 2")).map((r) => `${r.table_name}.${r.column_name}`);
  for (const c of ["zevanory_support_inbound.email_id", "zevanory_support_inbound.sender_ref", "zevanory_support_inbound.state", "zevanory_support_inbound.attempts", "zevanory_support_inbound.next_attempt_at", "zevanory_support_inbound.lease_until", "zevanory_support_inbound.alerted_at", "zevanory_support_ack_quota.bucket", "zevanory_support_ack_quota.day", "zevanory_support_alerts.kind", "zevanory_support_alerts.last_sent_at"]) assert.ok(cols.includes(c), c);
  assert.ok(!cols.some((c) => /text|html|subject|from_|address|email$/.test(c.split(".")[1]) && c !== "zevanory_support_inbound.email_id"), "nenhuma coluna de conteúdo/endereço: " + cols.join(","));
  await assert.rejects(sql.query("insert into zevanory_support_inbound (email_id, alias, sender_ref, state) values ('x', 'suporte', 'r', 'inventado')"), "estado fora da lista é recusado");
  const pk = await one("select string_agg(a.attname, ',' order by a.attname) as cols from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey) where i.indrelid = 'zevanory_support_ack_quota'::regclass and i.indisprimary");
  assert.equal(pk.cols, "bucket,day");
});

test("O2 dois consumidores concorrentes nas mesmas linhas: cada e-mail encaminhado e confirmado exatamente uma vez", { skip: SKIP }, async () => {
  const ids = ["c1", "c2", "c3", "c4", "c5"];
  await seed(ids);
  const r = resend();
  await Promise.all([drain(r, 5), drain(r, 5)]);
  for (const id of ids) {
    assert.equal(r.of("forward", id), 1, "forward " + id);
    assert.equal(r.of("ack", id), 1, "ack " + id);
    assert.equal((await stateOf(id)).state, "done");
  }
  await Promise.all([drain(r, 5), drain(r, 5)]);
  assert.equal(r.of("forward") + r.of("ack"), 10, "nada se repete depois de done");
});

test("O3 oito consumidores disputando o MESMO e-mail: um lease só, um encaminhamento, uma confirmação", { skip: SKIP }, async () => {
  await seed(["s1"]);
  const r = resend();
  const results = await Promise.all(Array.from({ length: 8 }, () => fwd.processSupportEmail(ctx(r), "s1")));
  assert.equal(results.filter((x) => x.state === "not_due").length, 7);
  assert.equal(r.of("forward", "s1"), 1);
  assert.equal(r.of("ack", "s1"), 1);
  assert.equal((await stateOf("s1")).state, "done");
});

test("O4 cota por remetente reservada sob concorrência: 6 e-mails do mesmo remetente => 6 encaminhamentos, 1 confirmação", { skip: SKIP }, async () => {
  const ids = ["p1", "p2", "p3", "p4", "p5", "p6"];
  await seed(ids, { sender: () => "ref-mesmo" });
  const r = resend({ senderOf: () => "mesmo@example.com" });
  await Promise.all(ids.map((id) => fwd.processSupportEmail(ctx(r), id)));
  assert.equal(r.of("forward"), 6);
  assert.equal(r.of("ack"), 1);
  const st = await sql.query("select ack_status, count(*)::int as n from zevanory_support_inbound group by 1 order by 1");
  assert.deepEqual(st.map((x) => `${x.ack_status}:${x.n}`), ["rate_limited_sender:5", "sent:1"]);
  assert.equal((await one("select n from zevanory_support_ack_quota where bucket = 's:ref-mesmo'")).n, "1");
});

test("O5 teto global sob concorrência: 36 remetentes distintos => exatamente 30 confirmações", { skip: SKIP }, async () => {
  const ids = Array.from({ length: 36 }, (_, i) => "g" + i);
  await seed(ids);
  const r = resend();
  await Promise.all(ids.map((id) => fwd.processSupportEmail(ctx(r), id)));
  assert.equal(r.of("forward"), 36);
  assert.equal(r.of("ack"), fwd.ACK_DAILY_CAP);
  assert.equal((await one("select n from zevanory_support_ack_quota where bucket = 'all'")).n, String(fwd.ACK_DAILY_CAP));
  assert.equal((await one("select count(*)::int as n from zevanory_support_inbound where ack_status = 'rate_limited_daily'")).n, "6");
  assert.equal((await one("select count(*)::int as n from zevanory_support_inbound where state = 'done'")).n, "36");
});

test("O6 transições: forward_pending (falha+recuo) -> ack_pending (falha+recuo) -> done, uma confirmação só", { skip: SKIP }, async () => {
  await seed(["t1"]);
  let fwdFail = 1, ackFail = 1;
  const r = resend({ failForward: () => fwdFail-- > 0, failAck: () => ackFail-- > 0 });
  assert.equal((await fwd.processSupportEmail(ctx(r), "t1")).state, "forward_pending");
  let st = await stateOf("t1");
  assert.equal(st.state, "forward_pending"); assert.equal(st.attempts, "1"); assert.equal(st.backoff, "t"); assert.equal(st.leased, "f");
  assert.equal((await one("select last_reason from zevanory_support_inbound where email_id = 't1'")).last_reason, "send_http_5xx", "motivo sem dado pessoal gravado");
  assert.equal((await fwd.processSupportEmail(ctx(r), "t1")).state, "not_due", "recuo respeitado");
  await makeDue("t1");
  assert.equal((await fwd.processSupportEmail(ctx(r), "t1")).state, "ack_pending");
  st = await stateOf("t1");
  assert.equal(st.state, "ack_pending"); assert.equal(st.backoff, "t");
  await makeDue("t1");
  assert.equal((await fwd.processSupportEmail(ctx(r), "t1")).state, "done");
  assert.equal(r.of("forward", "t1"), 2, "1 falha + 1 sucesso");
  assert.equal(r.calls.filter((c) => c.kind === "ack" && c.id === "t1").length, 2, "1 falha + 1 sucesso");
  await makeDue("t1");
  assert.equal((await fwd.processSupportEmail(ctx(r), "t1")).state, "not_due");
  assert.equal((await stateOf("t1")).ack_status, "sent");
});

test("O7 limites: 10 falhas de envio, 10 de leitura e 20 leases; estourado => nenhuma leitura/encaminhamento/confirmação da mensagem e vira dead", { skip: SKIP }, async () => {
  await seed(["s9"], { attempts: 9, sendFailures: 9 });
  await seed(["s10"], { attempts: 10, sendFailures: 10 });
  await seed(["r10"], { attempts: 10, readFailures: 10 });
  await seed(["a20"], { attempts: 20 });
  await seed(["a21"], { attempts: 21 });
  await seed(["k10"], { state: "ack_pending", attempts: 10, sendFailures: 10 });
  const r = resend({ failForward: () => true });
  assert.equal((await fwd.processSupportEmail(ctx(r), "s9")).state, "forward_dead", "a 10ª falha de envio é a última");
  assert.equal(r.of("forward", "s9"), 1);
  const st = await one("select state, send_failures, read_failures from zevanory_support_inbound where email_id = 's9'");
  assert.deepEqual(st, { state: "forward_dead", send_failures: "10", read_failures: "0" });
  const blocked = ["s10", "r10", "a20", "a21", "k10"];
  for (const id of blocked) assert.equal((await fwd.processSupportEmail(ctx(r), id)).state, "not_due", id);
  await drain(r);
  for (const id of ["s10", "r10", "a20", "a21"]) assert.equal((await stateOf(id)).state, "forward_dead", id);
  assert.equal((await stateOf("k10")).state, "ack_dead");
  for (const id of blocked) assert.equal(r.forId(id), 0, "zero leitura, encaminhamento ou confirmação associada à mensagem após estouro: " + id);
});

test("O8 limite de 23 h (janela de 24 h da Idempotency-Key): 22h59 ainda tenta; 23h01 vira dead sem leitura/encaminhamento/confirmação", { skip: SKIP }, async () => {
  await seed(["young"], { age: "22 hours 59 minutes" });
  await seed(["old"], { age: "23 hours 1 minute" });
  const r = resend();
  await Promise.all([drain(r), drain(r)]);
  assert.equal((await stateOf("young")).state, "done");
  assert.equal(r.of("forward", "young"), 1);
  assert.equal((await stateOf("old")).state, "forward_dead");
  assert.equal(r.forId("old"), 0);
});

test("O9 lease protege a linha do reap e de outro consumidor; vencido o lease, o reap mata sem leitura/encaminhamento/confirmação", { skip: SKIP }, async () => {
  await seed(["l1"], { attempts: 20 });
  await sql.query("update zevanory_support_inbound set lease_until = now() + interval '1 minute' where email_id = 'l1'");
  const r = resend();
  await drain(r);
  assert.equal((await stateOf("l1")).state, "forward_pending", "lease ativo: reap não mexe");
  assert.equal((await fwd.processSupportEmail(ctx(r), "l1")).state, "not_due");
  await sql.query("update zevanory_support_inbound set lease_until = now() - interval '1 second' where email_id = 'l1'");
  await drain(r);
  assert.equal((await stateOf("l1")).state, "forward_dead");
  assert.equal(r.forId("l1"), 0);
});

test("O10 zero leitura, encaminhamento ou confirmação associada à mensagem após estouro, mesmo com consumidores concorrentes repetidos; alerta só com contagens", { skip: SKIP }, async () => {
  const ids = ["z1", "z2", "z3"];
  await seed(["z1"], { attempts: 20 });
  await seed(["z2"], { age: "23 hours 30 minutes" });
  await seed(["z3"], { state: "ack_pending", attempts: 21 });
  const r = resend();
  for (let i = 0; i < 3; i++) {
    await sql.query("update zevanory_support_inbound set next_attempt_at = now(), lease_until = null");
    await Promise.all([drain(r, 5), drain(r, 5), ...ids.map((id) => fwd.processSupportEmail(ctx(r), id))]);
  }
  for (const id of ids) {
    assert.equal(r.forId(id), 0, "zero leitura, encaminhamento ou confirmação associada à mensagem após estouro: " + id);
    assert.match((await stateOf(id)).state, /_dead$/);
  }
  assert.equal(r.calls.filter((c) => c.kind !== "alert").length, 0, "zero leitura, encaminhamento ou confirmação associada à mensagem após estouro");
  const al = r.calls.filter((c) => c.kind === "alert");
  assert.ok(al.length <= 1, "no máximo o alerta operacional de linhas mortas");
  for (const a of al) assertAlertPrivate(a, ids, { category: "dead", count: 3 });
});

test("O11 alertas (mortas e fila atrasada) reservados atomicamente e privados: um por tipo, só categoria e contagens", { skip: SKIP }, async () => {
  await seed(["d1", "d2"], { attempts: 20 });
  const r = resend();
  await Promise.all([drain(r), drain(r), drain(r)]);
  const dead = r.calls.filter((c) => c.kind === "alert" && /não entregues/.test(c.subject));
  assert.equal(dead.length, 1);
  assert.equal((await one("select count(*)::int as n from zevanory_support_inbound where alerted_at is not null")).n, "2");
  assertAlertPrivate(dead[0], ["d1", "d2"], { category: "dead", count: 2 });
  await Promise.all([drain(r), drain(r)]);
  assert.equal(r.calls.filter((c) => c.kind === "alert" && /não entregues/.test(c.subject)).length, 1);
  // Fila atrasada: 5 pendentes com encaminhamento falhando, drenos concorrentes => um único alerta de atraso, privado.
  await sql.query("truncate zevanory_support_inbound, zevanory_support_alerts");
  const q = ["b1", "b2", "b3", "b4", "b5"];
  await seed(q, { age: "3 minutes 5 seconds" });
  const rb = resend({ failForward: () => true });
  await Promise.all([drain(rb), drain(rb), drain(rb)]);
  const backlog = rb.calls.filter((c) => c.kind === "alert" && /atrasada/.test(c.subject));
  assert.equal(backlog.length, 1);
  assertAlertPrivate(backlog[0], q, { category: "backlog", count: 5, oldest: 3 });
  assert.equal(rb.calls.filter((c) => c.kind === "alert" && /não entregues/.test(c.subject)).length, 0);
});

// Webhook assinado (Svix) para o caminho completo com PostgreSQL real.
const WH_SECRET = "whsec_" + Buffer.from("segredo-sintetico-de-teste-32bytes!").toString("base64");
async function webhook(r, emailId, from, svixId) {
  const { createHmac } = await import("node:crypto");
  const body = JSON.stringify({ type: "email.received", data: { email_id: emailId, from, to: ["suporte@zevanory.api.br"], received_for: ["suporte@zevanory.api.br"], subject: "x" } });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", Buffer.from(WH_SECRET.slice(6), "base64")).update(`${svixId}.${ts}.${body}`).digest("base64");
  const request = new Request("https://zevanory.api.br/api/webhooks/resend", { method: "POST", headers: { "content-type": "application/json", "svix-id": svixId, "svix-timestamp": ts, "svix-signature": `v1,${sig}` }, body });
  return fwd.handleSupportInboundWebhook(request, { ...env, RESEND_WEBHOOK_SECRET: WH_SECRET }, { sqlFactory: () => sql, fetchImpl: r.fetchImpl });
}
const WA = "support@support.whatsapp.com";
const waDetail = () => ({ from: WA, reply_to: ["987654321@support.whatsapp.com"] });

test("O12 provedor automático: webhook duplicado + 2 drenos concorrentes => 1 encaminhamento (Reply-To do ticket), 0 confirmação, skipped_automated_provider", { skip: SKIP }, async () => {
  let failOnce = 1;
  const r = resend({ senderOf: () => WA, detailOf: waDetail, failForward: () => failOnce-- > 0 });
  const first = await webhook(r, "wa1", WA, "msg_a");
  assert.equal(first.status, 200);
  assert.equal((await stateOf("wa1")).state, "forward_pending");
  await makeDue("wa1");
  const results = await Promise.all([webhook(r, "wa1", WA, "msg_b"), drain(r), drain(r)]);
  assert.equal(results[0].status, 200);
  const st = await one("select state, ack_status from zevanory_support_inbound where email_id = 'wa1'");
  assert.deepEqual(st, { state: "done", ack_status: "skipped_automated_provider" });
  assert.equal(r.calls.filter((c) => c.kind === "forward" && c.id === "wa1").length, 2, "1 falha + 1 sucesso");
  assert.equal(r.of("ack"), 0);
  await Promise.all([webhook(r, "wa1", WA, "msg_c"), drain(r), drain(r)]);
  assert.equal(r.calls.filter((c) => c.kind === "forward" && c.id === "wa1").length, 2, "nada se repete");
});

test("O13 encaminhamento obrigatório: com o envio falhando a linha NUNCA vira skipped/done (até morrer como forward_dead)", { skip: SKIP }, async () => {
  const r = resend({ senderOf: () => WA, detailOf: waDetail, failForward: () => true });
  await webhook(r, "wa2", WA, "msg_d");
  for (let i = 0; i < fwd.MAX_SEND_FAILURES + 2; i++) {
    const st = await one("select state, ack_status from zevanory_support_inbound where email_id = 'wa2'");
    assert.notEqual(st.state, "done");
    assert.equal(st.ack_status, "", "ack_status continua vazio: " + JSON.stringify(st));
    if (st.state !== "forward_pending") break;
    await makeDue("wa2");
    await drain(r);
  }
  assert.deepEqual(await one("select state, ack_status, send_failures from zevanory_support_inbound where email_id = 'wa2'"), { state: "forward_dead", ack_status: "", send_failures: String(fwd.MAX_SEND_FAILURES) });
  assert.equal(r.of("ack"), 0);
});

test("O14 orçamentos separados com 404 transitório: leituras falhando não consomem envios; depois encaminha e confirma uma vez", { skip: SKIP }, async () => {
  let reads = 0, sends = 0;
  const r = resend({ readStatus: () => (reads++ < 3 ? 404 : 0), failForward: () => sends++ < 9 });
  await seed(["b1"]);
  for (let i = 0; i < 3; i++) { await makeDue("b1"); await fwd.processSupportEmail(ctx(r), "b1"); }
  let st = await one("select state, read_failures, send_failures, last_reason from zevanory_support_inbound where email_id = 'b1'");
  assert.deepEqual(st, { state: "forward_pending", read_failures: "3", send_failures: "0", last_reason: "content_http_404_not_found" });
  for (let i = 0; i < fwd.MAX_SEND_FAILURES; i++) {
    await makeDue("b1");
    await fwd.processSupportEmail(ctx(r), "b1");
    if ((await stateOf("b1")).state !== "forward_pending") break;
  }
  st = await one("select state, ack_status from zevanory_support_inbound where email_id = 'b1'");
  assert.deepEqual(st, { state: "done", ack_status: "sent" }, "9 falhas de envio + 1 sucesso cabem no orçamento de envio apesar das 3 de leitura");
  assert.equal(r.of("forward", "b1"), 10);
  assert.equal(r.of("ack", "b1"), 1);
});

test("O15 leitura: 400/422 permanentes e 404 depois da janela => dead sem envio; 429/5xx transitórios", { skip: SKIP }, async () => {
  const status = { p400: 400, p422: 422, nf_old: 404, t429: 429, t503: 503 };
  const r = resend({ readStatus: (id) => status[id] || 0 });
  await seed(["p400", "p422", "t429", "t503"]);
  await seed(["nf_old"], { age: `${fwd.NOT_FOUND_GRACE_MINUTES + 1} minutes` });
  await Promise.all(Object.keys(status).map((id) => fwd.processSupportEmail(ctx(r), id)));
  const rows = Object.fromEntries((await sql.query("select email_id, state, last_reason from zevanory_support_inbound")).map((x) => [x.email_id, `${x.state}:${x.last_reason}`]));
  assert.deepEqual(rows, {
    p400: "forward_dead:content_http_400_invalid_request",
    p422: "forward_dead:content_http_422_invalid_request",
    nf_old: "forward_dead:content_http_404_not_found_permanent",
    t429: "forward_pending:content_http_429_rate_limited",
    t503: "forward_pending:content_http_5xx"
  });
  assert.equal(r.of("forward") + r.of("ack"), 0);
});

test("O16 orçamento global por mensagem: 9 falhas de envio no encaminhamento + falhas na confirmação => ack_dead, encaminhamento preservado", { skip: SKIP }, async () => {
  let fwdFails = 9;
  const r = resend({ failForward: () => fwdFails-- > 0, failAck: () => true });
  await seed(["g1"]);
  for (let i = 0; i < 12; i++) {
    await makeDue("g1");
    await fwd.processSupportEmail(ctx(r), "g1");
    if (!/_pending$/.test((await stateOf("g1")).state)) break;
  }
  const st = await one("select state, send_failures, read_failures, forward_id is not null as fwd, ack_status from zevanory_support_inbound where email_id = 'g1'");
  assert.deepEqual(st, { state: "ack_dead", send_failures: String(fwd.MAX_SEND_FAILURES), read_failures: "0", fwd: "t", ack_status: "pending" });
  assert.equal(r.calls.filter((c) => c.kind === "forward" && c.id === "g1").length, 10, "9 falhas + 1 entrega");
  const acks = r.calls.filter((c) => c.kind === "ack" && c.id === "g1").length;
  assert.ok(acks >= 1 && acks <= 2, "teto atingido em no máximo 2 falhas de confirmação: " + acks);
  const fwdAt = (await one("select forwarded_at from zevanory_support_inbound where email_id = 'g1'")).forwarded_at;
  await makeDue("g1");
  await Promise.all([drain(r), drain(r)]);
  await drain(r);
  assert.equal(r.calls.filter((c) => c.kind !== "read" && c.kind !== "alert" && c.id === "g1").length, 10 + acks, "nenhum envio depois do teto");
  assert.equal((await one("select forwarded_at from zevanory_support_inbound where email_id = 'g1'")).forwarded_at, fwdAt, "forwarded_at preservado");
  assert.equal(r.calls.filter((c) => c.kind === "alert" && /não entregues/.test(c.subject)).length, 1, "alerta de morte exatamente uma vez");
});

test("O18 orçamento global de LEITURA: 9 falhas no encaminhamento + 1 na releitura da confirmação => ack_dead, encaminhamento preservado", { skip: SKIP }, async () => {
  let readFail = false, ackFails = 1;
  const r = resend({ readStatus: () => (readFail ? 503 : 0), failAck: () => ackFails-- > 0 });
  await seed(["h1"], { readFailures: 9 });
  await fwd.processSupportEmail(ctx(r), "h1");
  let st = await one("select state, read_failures, send_failures from zevanory_support_inbound where email_id = 'h1'");
  assert.deepEqual(st, { state: "ack_pending", read_failures: "9", send_failures: "1" }, "contadores não zeram na transição");
  readFail = true;
  await makeDue("h1");
  await fwd.processSupportEmail(ctx(r), "h1");
  st = await one("select state, read_failures, forward_id is not null as fwd from zevanory_support_inbound where email_id = 'h1'");
  assert.deepEqual(st, { state: "ack_dead", read_failures: "10", fwd: "t" });
  assert.equal(r.of("forward", "h1"), 1);
  await makeDue("h1");
  await drain(r);
  assert.equal(r.of("forward", "h1"), 1, "nenhum novo encaminhamento");
});

test("O17 dreno interno: nonce consumido atomicamente no PostgreSQL — pedidos simultâneos com o mesmo nonce => um 200, os demais 409; minuto velho 401", { skip: SKIP }, async () => {
  await seed(["n1"]);
  const r = resend();
  const minute = Math.floor(Date.now() / 60000);
  const nonce = "ab".repeat(16);
  const mk = async (min = minute, n = nonce) => new Request("https://zevanory.api.br" + fwd.DRAIN_PATH, { method: "POST", headers: {
    "x-support-drain-token": await fwd.signDrainRequest({ secret: env.LEAD_PRIVACY_SECRET, method: "POST", path: fwd.DRAIN_PATH, minute: min, nonce: n }),
    "x-support-drain-nonce": n, "x-support-drain-minute": String(min) } });
  const call = async (q) => fwd.handleSupportDrainRequest(q, env, { sqlFactory: () => sql, fetchImpl: r.fetchImpl });
  const statuses = (await Promise.all(Array.from({ length: 5 }, async () => (await call(await mk())).status))).sort();
  assert.deepEqual(statuses, [200, 409, 409, 409, 409]);
  assert.equal(r.of("forward", "n1"), 1, "um único dreno efetivo");
  const before = r.calls.length;
  assert.equal((await call(await mk())).status, 409, "replay");
  assert.equal((await call(await mk(minute - 2, "cd".repeat(16)))).status, 401, "minuto velho");
  assert.equal(r.calls.length, before, "zero chamada extra ao Resend");
  assert.equal((await one("select count(*)::int as n from zevanory_support_drain_nonces")).n, "1");
});
