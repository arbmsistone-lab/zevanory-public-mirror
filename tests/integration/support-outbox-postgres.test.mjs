// Outbox do suporte@ (worker/support-email-forward.mjs) contra PostgreSQL 16 REAL descartável: esquema aplicado
// exatamente como o Worker aplica (ensureSupportSchema), consumidores concorrentes com conexões separadas,
// reservas de cota simultâneas, lease/reap, limites de 10 tentativas e 23 h, transições e ZERO chamada externa
// depois do orçamento esgotado. Resend é falso (contador por id); sem segredo, sem rede.
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
function resend({ senderOf = (id) => `cliente-${id}@example.com`, failForward = () => false, failAck = () => false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    await new Promise((r) => setTimeout(r, 25));
    const u = new URL(url);
    assert.equal(u.hostname, "api.resend.com");
    if ((init.method || "GET") === "GET") {
      const id = decodeURIComponent(u.pathname.split("/")[3]);
      calls.push({ kind: "read", id });
      return Response.json({ id, from: senderOf(id), subject: "Assunto", text: "corpo", headers: {}, attachments: [], created_at: "2026-10-23T12:00:00Z", message_id: `<${id}@example.com>` });
    }
    const body = JSON.parse(init.body);
    const idem = String(init.headers["idempotency-key"] || "");
    const kind = idem.startsWith("support-fwd/") ? "forward" : idem.startsWith("support-ack/") ? "ack" : "alert";
    const id = idem.split("/")[1] || "";
    calls.push({ kind, id, subject: body.subject });
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
async function seed(ids, { sender = (id) => "ref-" + id, state = "forward_pending", attempts = 0, age = "0 seconds" } = {}) {
  const values = ids.map((id) => `(${lit(id)}, 'suporte', ${lit(sender(id))}, ${lit(state)}, ${attempts}, now() - interval ${lit(age)})`).join(",");
  await sql.query(`insert into zevanory_support_inbound (email_id, alias, sender_ref, state, attempts, created_at) values ${values}`);
}
const stateOf = async (id) => one(`select state, attempts, ack_status, (next_attempt_at > now()) as backoff, lease_until is not null as leased from zevanory_support_inbound where email_id = ${lit(id)}`);
const makeDue = (id) => sql.query(`update zevanory_support_inbound set next_attempt_at = now(), lease_until = null where email_id = ${lit(id)}`);

before(() => {
  if (SKIP) return;
  psqlSync(`drop database if exists ${DB}`, "postgres");
  psqlSync(`create database ${DB}`, "postgres");
});
beforeEach(async () => {
  if (SKIP) return;
  fwd.resetSupportSchemaCache();
  await fwd.ensureSupportSchema(sql);
  await sql.query("truncate zevanory_support_inbound, zevanory_support_ack_quota, zevanory_support_alerts");
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

test("O7 limite de 10 tentativas: a 10ª é a última; com 10 ou 11 registradas nenhuma chamada externa e vira dead", { skip: SKIP }, async () => {
  await seed(["a9"], { attempts: 9 });
  await seed(["a10"], { attempts: 10 });
  await seed(["a11"], { attempts: 11 });
  await seed(["k9"], { state: "ack_pending", attempts: 10 });
  const r = resend({ failForward: () => true });
  assert.equal((await fwd.processSupportEmail(ctx(r), "a9")).state, "forward_dead");
  assert.equal(r.of("forward", "a9"), 1);
  const st = await stateOf("a9");
  assert.equal(st.state, "forward_dead"); assert.equal(st.attempts, "10");
  for (const id of ["a10", "a11", "k9"]) assert.equal((await fwd.processSupportEmail(ctx(r), id)).state, "not_due", id);
  await drain(r);
  for (const id of ["a10", "a11"]) assert.equal((await stateOf(id)).state, "forward_dead", id);
  assert.equal((await stateOf("k9")).state, "ack_dead");
  for (const id of ["a10", "a11", "k9"]) assert.equal(r.forId(id), 0, "zero chamada externa para " + id);
});

test("O8 limite de 23 h (janela de 24 h da Idempotency-Key): 22h59 ainda tenta; 23h01 vira dead sem chamada", { skip: SKIP }, async () => {
  await seed(["young"], { age: "22 hours 59 minutes" });
  await seed(["old"], { age: "23 hours 1 minute" });
  const r = resend();
  await Promise.all([drain(r), drain(r)]);
  assert.equal((await stateOf("young")).state, "done");
  assert.equal(r.of("forward", "young"), 1);
  assert.equal((await stateOf("old")).state, "forward_dead");
  assert.equal(r.forId("old"), 0);
});

test("O9 lease protege a linha do reap e de outro consumidor; vencido o lease, o reap mata sem chamada", { skip: SKIP }, async () => {
  await seed(["l1"], { attempts: 10 });
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

test("O10 ZERO chamada externa por linha depois do orçamento esgotado, mesmo com consumidores concorrentes repetidos", { skip: SKIP }, async () => {
  const ids = ["z1", "z2", "z3"];
  await seed(["z1"], { attempts: 10 });
  await seed(["z2"], { age: "23 hours 30 minutes" });
  await seed(["z3"], { state: "ack_pending", attempts: 12 });
  const r = resend();
  for (let i = 0; i < 3; i++) {
    await sql.query("update zevanory_support_inbound set next_attempt_at = now(), lease_until = null");
    await Promise.all([drain(r, 5), drain(r, 5), ...ids.map((id) => fwd.processSupportEmail(ctx(r), id))]);
  }
  for (const id of ids) {
    assert.equal(r.forId(id), 0, "zero chamada para " + id);
    assert.match((await stateOf(id)).state, /_dead$/);
  }
  assert.equal(r.calls.filter((c) => c.kind !== "alert").length, 0, "nenhuma leitura, encaminhamento ou confirmação");
  assert.ok(r.of("alert") <= 1, "no máximo o alerta (sem conteúdo) de linhas mortas");
});

test("O11 alerta de linhas mortas reservado atomicamente: drenos concorrentes enviam um único alerta", { skip: SKIP }, async () => {
  await seed(["d1", "d2"], { attempts: 10 });
  const r = resend();
  await Promise.all([drain(r), drain(r), drain(r)]);
  const dead = r.calls.filter((c) => c.kind === "alert" && /não entregues/.test(c.subject));
  assert.equal(dead.length, 1);
  assert.equal((await one("select count(*)::int as n from zevanory_support_inbound where alerted_at is not null")).n, "2");
  await Promise.all([drain(r), drain(r)]);
  assert.equal(r.calls.filter((c) => c.kind === "alert" && /não entregues/.test(c.subject)).length, 1);
});
