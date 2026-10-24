// AVAL Sol (#892 bf15436): outbox durável do formulário de atendimento contra PostgreSQL REAL.
// Cada consulta roda num processo psql próprio (conexão própria): concorrência de verdade.
// Prova: queda logo após gravar o protocolo (reenvio e cron completam), falha de envio e recuperação
// (exatamente UM e-mail ao proprietário e UM ao cliente), queda depois do envio e antes de marcar
// (Idempotency-Key estável), teto de tentativas que encerra efeitos externos + dead-letter único, drenos
// simultâneos (lease), cotas atômicas sob concorrência e fail-closed de configuração.
// Mutantes (cota lida-e-escrita, sem teto, chave de idempotência instável, duplicata sem processar, sem
// limite de tentativas, sem lease) precisam ser mortos.
// Rodar: T4_PG_HOST=/var/tmp/pg/sock T4_PG_PORT=55433 node --test tests/integration/atendimento-outbox-postgres.test.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { handleAtendimento, drainAtendimentoOutbox, ATENDIMENTO_SQL, MAX_ATTEMPTS, IP_HOURLY_CAP, EMAIL_DAILY_CAP } from "../../worker/atendimento.mjs";

const run = promisify(execFile);
const HOST = process.env.T4_PG_HOST, PORT = process.env.T4_PG_PORT || "5432";
const SKIP = !HOST && "T4_PG_HOST not set (throwaway local PostgreSQL required)";
const DB = "ci_atendimento_outbox";
const lit = (v) => v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : typeof v === "boolean" ? (v ? "true" : "false") : "'" + String(v).replace(/'/g, "''") + "'";
const inline = (q, p) => q.replace(/\$(\d+)/g, (_, n) => lit(p[Number(n) - 1]));
const psqlSync = (sql, db = DB) => execFileSync("psql", ["-h", HOST, "-p", PORT, "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "-tA", "-c", sql], { encoding: "utf8" }).trim();

function parseCsv(text) {
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] === "" ? null : r[i]])));
}
// sqlFactory sobre psql --csv: qualquer comando com linhas (SELECT, WITH…SELECT, …RETURNING) devolve objetos.
const pgQuery = async (statement, params = []) => {
  const { stdout } = await run("psql", ["-h", HOST, "-p", PORT, "-U", "postgres", "-d", DB, "-v", "ON_ERROR_STOP=1", "-q", "--csv", "-c", inline(statement, params)], { encoding: "utf8" });
  return parseCsv(stdout);
};
const sqlFactory = () => ({ query: pgQuery });

const SECRET = "s".repeat(40);
const ENV = Object.freeze({ DATABASE_URL: "postgres://ci", RESEND_API_KEY: "re_ci", LEAD_PRIVACY_SECRET: SECRET, SUPPORT_FORWARD_TO: "dono@example.com", OWNER_ALERT_EMAIL: "alerta@example.com" });
const OWNER = "dono@example.com";

// Resend falso com Idempotency-Key (mesma chave => mesmo id, sem nova entrega). fail(body) decide falhas.
function resend({ fail = () => false } = {}) {
  const calls = [], delivered = new Map();
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const key = init.headers["idempotency-key"];
    calls.push({ key, to: body.to[0], subject: body.subject });
    if (fail(body, key)) return new Response(JSON.stringify({ message: "falha" }), { status: 500 });
    if (!delivered.has(key)) delivered.set(key, { id: "em_" + delivered.size, to: body.to[0], subject: body.subject, text: body.text });
    return new Response(JSON.stringify({ id: delivered.get(key).id }), { status: 200 });
  };
  const sentTo = (to) => [...delivered.values()].filter((d) => d.to === to);
  return { fetchImpl, calls, delivered, sentTo };
}
const post = (fields, { ip = "203.0.113.10" } = {}) => new Request("https://zevanory.api.br/api/atendimento", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify(fields) });
let seq = 0;
const fields = (over = {}) => ({ tipo: "reclamacao", email: `cliente${++seq}@example.com`, pedido: "", mensagem: "O arquivo do produto veio corrompido, preciso de ajuda.", ...over });
const submit = async (f, opts = {}) => {
  const r = await handleAtendimento(post(f, opts), opts.env || ENV, { sqlFactory: opts.sqlFactory || sqlFactory, fetchImpl: opts.fetchImpl, q: opts.q });
  return { status: r.status, body: await r.json() };
};
const row = (protocolo) => JSON.parse(psqlSync(`select coalesce(row_to_json(o), 'null') from zevanory_atendimento_outbox o where protocolo = ${lit(protocolo)}`) || "null");
const makeDue = (protocolo) => psqlSync(`update zevanory_atendimento_outbox set next_attempt_at = now() - interval '1 second' where protocolo = ${lit(protocolo)}`);
const reset = () => psqlSync("truncate zevanory_atendimento_outbox, zevanory_atendimento_quota");

before(async () => {
  if (SKIP) return;
  try { psqlSync(`drop database if exists ${DB}`, "postgres"); } catch {}
  psqlSync(`create database ${DB}`, "postgres");
  for (const s of ATENDIMENTO_SQL.schema) await pgQuery(s);
});

test("caminho feliz: protocolo durável, UM e-mail ao proprietário e UM ao cliente, conteúdo apagado", { skip: SKIP }, async () => {
  reset();
  const m = resend();
  const f = fields();
  const r = await submit(f, { fetchImpl: m.fetchImpl });
  assert.equal(r.status, 200);
  assert.match(r.body.protocolo, /^ZEV-\d{8}-[0-9A-F]{10}$/);
  assert.equal(r.body.email_confirmacao, "enviado");
  assert.equal(m.sentTo(OWNER).length, 1);
  assert.equal(m.sentTo(f.email).length, 1);
  assert.ok(m.sentTo(f.email)[0].text.includes(r.body.protocolo));
  const o = row(r.body.protocolo);
  assert.deepEqual([o.owner_status, o.customer_status, o.payload], ["sent", "sent", null], "LGPD: payload apagado após os dois envios");
  assert.doesNotMatch(JSON.stringify(o), /example\.com/, "sem e-mail em claro no registro");
  const again = await submit(f, { fetchImpl: m.fetchImpl });
  assert.equal(again.body.protocolo, r.body.protocolo);
  assert.equal(again.body.duplicate, true);
  assert.equal(m.calls.length, 2, "reenvio idêntico não gera e-mail");
});

async function crashAfterAdmit(f) {
  // Processo morre logo depois do comando que grava o protocolo (antes de qualquer envio).
  const m = resend();
  const crashing = () => ({ query: async (s, p) => { const out = await pgQuery(s, p); if (s.includes("/*atendimento:admit*/")) throw new Error("crash"); return out; } });
  const r = await submit(f, { fetchImpl: m.fetchImpl, sqlFactory: crashing });
  assert.equal(r.status, 503);
  assert.equal(m.calls.length, 0);
  const pending = psqlSync("select protocolo from zevanory_atendimento_outbox where owner_status = 'pending' and customer_status = 'pending'");
  assert.match(pending, /^ZEV-/, "protocolo gravado antes da queda");
  return pending;
}

test("queda logo após o protocolo: o reenvio do formulário completa os DOIS envios, uma vez cada", { skip: SKIP }, async () => {
  reset();
  const f = fields();
  const protocolo = await crashAfterAdmit(f);
  const m = resend();
  const r = await submit(f, { fetchImpl: m.fetchImpl });
  assert.equal(r.body.protocolo, protocolo);
  assert.equal(r.body.duplicate, true);
  assert.equal(m.sentTo(OWNER).length, 1);
  assert.equal(m.sentTo(f.email).length, 1);
  assert.deepEqual([row(protocolo).owner_status, row(protocolo).customer_status], ["sent", "sent"]);
});

test("queda logo após o protocolo: o cron horário completa os envios", { skip: SKIP }, async () => {
  reset();
  const f = fields();
  const protocolo = await crashAfterAdmit(f);
  const m = resend();
  const d = await drainAtendimentoOutbox(ENV, { sqlFactory, fetchImpl: m.fetchImpl });
  assert.equal(d.ok, true);
  assert.equal(d.done, 1);
  assert.equal(m.sentTo(OWNER).length, 1);
  assert.equal(m.sentTo(f.email).length, 1);
  assert.equal(row(protocolo).payload, null);
});

test("falha de envio e recuperação: recuo exponencial, depois exatamente UM e-mail de cada", { skip: SKIP }, async () => {
  reset();
  const f = fields();
  const down = resend({ fail: () => true });
  const r = await submit(f, { fetchImpl: down.fetchImpl });
  assert.equal(r.status, 200, "o protocolo vale mesmo com o envio falhando");
  assert.equal(r.body.email_confirmacao, "pendente");
  let o = row(r.body.protocolo);
  assert.deepEqual([o.owner_status, o.customer_status, o.owner_attempts, o.customer_attempts], ["pending", "pending", 1, 1]);
  assert.ok(Date.parse(o.next_attempt_at) > Date.now() + 60_000, "recuo agendado");
  assert.equal((await drainAtendimentoOutbox(ENV, { sqlFactory, fetchImpl: down.fetchImpl })).checked, 0, "em recuo: nada é tentado");
  // Só o proprietário volta: o cliente continua falhando uma vez mais.
  makeDue(r.body.protocolo);
  const half = resend({ fail: (b) => b.to[0] !== OWNER });
  await drainAtendimentoOutbox(ENV, { sqlFactory, fetchImpl: half.fetchImpl });
  o = row(r.body.protocolo);
  assert.deepEqual([o.owner_status, o.customer_status, o.customer_attempts], ["sent", "pending", 2]);
  makeDue(r.body.protocolo);
  const up = resend();
  await drainAtendimentoOutbox(ENV, { sqlFactory, fetchImpl: up.fetchImpl });
  assert.equal(half.sentTo(OWNER).length + up.sentTo(OWNER).length, 1, "proprietário: exatamente um");
  assert.equal(up.sentTo(f.email).length, 1, "cliente: exatamente um");
  assert.equal(up.calls.filter((c) => c.to === OWNER).length, 0, "envio feito não é repetido");
  o = row(r.body.protocolo);
  assert.deepEqual([o.owner_status, o.customer_status, o.payload], ["sent", "sent", null]);
});

test("queda depois do envio e antes de marcar: a mesma Idempotency-Key evita segunda entrega", { skip: SKIP }, async () => {
  reset();
  const f = fields();
  const m = resend();
  const dying = () => ({ query: async (s, p) => { if (s.includes("/*atendimento:owner_sent*/") || s.includes("/*atendimento:customer_sent*/")) throw new Error("crash"); return pgQuery(s, p); } });
  const r = await submit(f, { fetchImpl: m.fetchImpl, sqlFactory: dying });
  assert.equal(r.status, 200);
  const protocolo = r.body.protocolo;
  psqlSync(`update zevanory_atendimento_outbox set lease_until = null, next_attempt_at = now() - interval '1 second' where protocolo = ${lit(protocolo)}`);
  await drainAtendimentoOutbox(ENV, { sqlFactory, fetchImpl: m.fetchImpl });
  const keys = m.calls.map((c) => c.key);
  assert.equal(new Set(keys).size, 2, "duas chaves estáveis (owner/ack), reenviadas iguais");
  assert.equal(m.delivered.size, 2, "uma entrega por e-mail");
  assert.deepEqual([row(protocolo).owner_status, row(protocolo).customer_status], ["sent", "sent"]);
});

test("teto de tentativas: envio vira dead, nenhum efeito externo depois, dead-letter UMA vez", { skip: SKIP }, async () => {
  reset();
  const f = fields();
  const down = resend({ fail: (b) => b.to[0] === OWNER });
  const r = await submit(f, { fetchImpl: down.fetchImpl });
  for (let i = 1; i < MAX_ATTEMPTS; i++) { makeDue(r.body.protocolo); await drainAtendimentoOutbox(ENV, { sqlFactory, fetchImpl: down.fetchImpl }); }
  const o = row(r.body.protocolo);
  assert.deepEqual([o.owner_status, o.owner_attempts, o.customer_status], ["dead", MAX_ATTEMPTS, "sent"]);
  assert.equal(down.calls.filter((c) => c.to === OWNER).length, MAX_ATTEMPTS);
  assert.equal(down.sentTo("alerta@example.com").length, 1, "dead-letter ao OWNER_ALERT_EMAIL");
  assert.ok(down.sentTo("alerta@example.com")[0].text.includes(f.mensagem), "o alerta leva a solicitação para ser respondida");
  makeDue(r.body.protocolo);
  const after = resend();
  const d = await drainAtendimentoOutbox(ENV, { sqlFactory, fetchImpl: after.fetchImpl });
  assert.equal(after.calls.length, 0, "dead: nenhum envio novo, nenhum alerta repetido");
  assert.equal(d.ok, true);
  assert.notEqual(row(r.body.protocolo).dead_alerted_at, null);
});

test("dead-letter sem conseguir avisar deixa o cron vermelho", { skip: SKIP }, async () => {
  reset();
  const f = fields();
  const down = resend({ fail: () => true });
  const r = await submit(f, { fetchImpl: down.fetchImpl });
  for (let i = 1; i <= MAX_ATTEMPTS; i++) { makeDue(r.body.protocolo); await drainAtendimentoOutbox(ENV, { sqlFactory, fetchImpl: down.fetchImpl }); }
  const d = await drainAtendimentoOutbox(ENV, { sqlFactory, fetchImpl: down.fetchImpl });
  assert.equal(d.ok, false);
  assert.ok(d.dead_unalerted >= 1);
});

test("drenos simultâneos: o lease garante uma única tentativa por e-mail", { skip: SKIP }, async () => {
  reset();
  const f = fields();
  await crashAfterAdmit(f);
  const m = resend();
  // Envio lento: os quatro drenos se sobrepõem de verdade.
  const slow = async (u, i) => { await new Promise((d) => setTimeout(d, 400)); return m.fetchImpl(u, i); };
  await Promise.all([1, 2, 3, 4].map(() => drainAtendimentoOutbox(ENV, { sqlFactory, fetchImpl: slow })));
  assert.equal(m.calls.filter((c) => c.to === OWNER).length, 1);
  assert.equal(m.calls.filter((c) => c.to === f.email).length, 1);
});

async function concurrentQuota(opts = {}) {
  reset();
  const m = resend();
  const ip = await Promise.all(Array.from({ length: 12 }, (_, i) => submit(fields({ mensagem: "Pedido simultâneo número " + i }), { ip: "198.51.100.77", fetchImpl: m.fetchImpl, ...opts })));
  reset();
  const email = await Promise.all(Array.from({ length: 9 }, (_, i) => submit(fields({ email: "mesmo@example.com", mensagem: "Mesmo e-mail, envio " + i }), { ip: "192.0.2." + i, fetchImpl: m.fetchImpl, ...opts })));
  return { ipOk: ip.filter((r) => r.status === 200).length, ip429: ip.filter((r) => r.status === 429).length, emailOk: email.filter((r) => r.status === 200).length };
}

test("cotas atômicas sob concorrência real: 5/h por IP e 4/dia por e-mail, nem um a mais", { skip: SKIP }, async () => {
  const r = await concurrentQuota();
  assert.deepEqual(r, { ipOk: IP_HOURLY_CAP, ip429: 12 - IP_HOURLY_CAP, emailOk: EMAIL_DAILY_CAP });
});

test("fail-closed: sem segredo, sem destino do proprietário ou destino no próprio domínio => 503 e nada gravado", { skip: SKIP }, async () => {
  reset();
  const m = resend();
  for (const env of [
    { ...ENV, LEAD_PRIVACY_SECRET: "curto" },
    { ...ENV, SUPPORT_FORWARD_TO: "" },
    { ...ENV, SUPPORT_FORWARD_TO: "suporte@zevanory.api.br" },
    { ...ENV, RESEND_API_KEY: "" },
  ]) {
    const r = await submit(fields(), { env, fetchImpl: m.fetchImpl });
    assert.equal(r.status, 503);
  }
  // destino lido do KV support-config:forward-to (mesma chave do #894)
  const kv = { get: async (k) => (k === "support-config:forward-to" ? "dona@example.com" : null) };
  const ok = await submit(fields(), { env: { ...ENV, SUPPORT_FORWARD_TO: "", ZEVANORY_PRIVATE_ARTIFACTS: kv }, fetchImpl: m.fetchImpl });
  assert.equal(ok.status, 200);
  assert.equal(m.sentTo("dona@example.com").length, 1);
  assert.equal(psqlSync("select count(*) from zevanory_atendimento_outbox"), "1", "as quatro recusas não gravaram nada");
});

test("mutantes: cota lida-e-escrita, sem teto, chave instável, duplicata sem processar, sem teto de tentativas, sem lease — mortos", { skip: SKIP }, async () => {
  const report = [];
  const killed = (name, ok) => { report.push(`${name}: ${ok ? "KILLED" : "SURVIVED"}`); assert.ok(ok, name + " sobreviveu"); };

  // Q1: cota como leitura seguida de escrita (o antigo padrão KV get/put), em comandos separados.
  const readThenWrite = () => ({ query: async (s, p) => {
    if (!s.includes("/*atendimento:admit*/")) return pgQuery(s, p);
    const [protocolo, ipB, ipCap, emB, emCap, tipo, ref, payload, days] = p;
    const n = async (b) => Number((await pgQuery("select coalesce((select n from zevanory_atendimento_quota where bucket = $1), 0) as n", [b]))[0].n);
    const ipN = await n(ipB), emN = await n(emB);
    await new Promise((done) => setTimeout(done, 400)); // janela de corrida determinística entre ler e escrever
    if (ipN >= ipCap || emN >= emCap) return [{ ip_ok: ipN < ipCap ? 1 : 0, email_ok: 0 }];
    await pgQuery("insert into zevanory_atendimento_quota (bucket, n, expires_at) values ($1, $2, now() + interval '1 day') on conflict (bucket) do update set n = $2", [ipB, ipN + 1]);
    await pgQuery("insert into zevanory_atendimento_quota (bucket, n, expires_at) values ($1, $2, now() + interval '1 day') on conflict (bucket) do update set n = $2", [emB, emN + 1]);
    const ins = await pgQuery("insert into zevanory_atendimento_outbox (protocolo, tipo, email_ref, payload, responder_ate) values ($1, $2, $3, $4::jsonb, now() + make_interval(days => $5::int)) on conflict (protocolo) do nothing returning protocolo, recebido_em, responder_ate", [protocolo, tipo, ref, payload, days]);
    return [{ ip_ok: 1, email_ok: 1, ...(ins[0] || {}) }];
  } });
  const q1 = await concurrentQuota({ sqlFactory: readThenWrite });
  killed("Q1 cota lida-e-escrita (não atômica)", q1.ipOk > IP_HOURLY_CAP || q1.emailOk > EMAIL_DAILY_CAP);

  // Q2: sem o teto no ON CONFLICT.
  const noCap = { ...ATENDIMENTO_SQL, admit: ATENDIMENTO_SQL.admit.replaceAll(/ where zevanory_atendimento_quota\.n < \$\d/g, "") };
  assert.notEqual(noCap.admit, ATENDIMENTO_SQL.admit);
  const q2 = await concurrentQuota({ q: noCap });
  killed("Q2 cota sem teto", q2.ipOk > IP_HOURLY_CAP);

  // I1: chave de idempotência instável por tentativa (queda depois do envio entrega de novo).
  reset();
  {
    const m = resend();
    let n = 0;
    const unstable = (url, init) => m.fetchImpl(url, { ...init, headers: { ...init.headers, "idempotency-key": init.headers["idempotency-key"] + "/" + (++n) } });
    const dying = () => ({ query: async (s, p) => { if (s.includes("/*atendimento:owner_sent*/")) throw new Error("crash"); return pgQuery(s, p); } });
    const r = await submit(fields(), { fetchImpl: unstable, sqlFactory: dying });
    psqlSync(`update zevanory_atendimento_outbox set lease_until = null, next_attempt_at = now() - interval '1 second' where protocolo = ${lit(r.body.protocolo)}`);
    await drainAtendimentoOutbox(ENV, { sqlFactory, fetchImpl: unstable });
    killed("I1 Idempotency-Key instável", m.sentTo(OWNER).length > 1);
  }

  // D1: duplicata devolve o protocolo sem processar os envios pendentes (o defeito apontado pelo Sol).
  reset();
  {
    const f = fields();
    await crashAfterAdmit(f);
    const m = resend();
    const skipPending = { ...ATENDIMENTO_SQL, find: ATENDIMENTO_SQL.find.replace("owner_status, customer_status", "'sent' as owner_status, 'sent' as customer_status") };
    await submit(f, { fetchImpl: m.fetchImpl, q: skipPending });
    killed("D1 duplicata sem processar pendências", m.sentTo(f.email).length === 0);
  }

  // T1: sem teto de tentativas (efeitos externos não param).
  reset();
  {
    const noMax = { ...ATENDIMENTO_SQL, ownerFailed: ATENDIMENTO_SQL.ownerFailed.replace("owner_attempts + 1 >= $2", "owner_attempts + 1 >= 1000") };
    const down = resend({ fail: (b) => b.to[0] === OWNER });
    const r = await submit(fields(), { fetchImpl: down.fetchImpl, q: noMax });
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) { makeDue(r.body.protocolo); await drainAtendimentoOutbox(ENV, { sqlFactory, fetchImpl: down.fetchImpl, q: noMax }); }
    killed("T1 sem teto de tentativas", down.calls.filter((c) => c.to === OWNER).length > MAX_ATTEMPTS);
  }

  // L1: sem lease (drenos simultâneos tentam o mesmo e-mail mais de uma vez).
  reset();
  {
    const drop = (s) => s.replace(/\s+and \(lease_until is null or lease_until < now\(\)\)/, "");
    const noLease = { ...ATENDIMENTO_SQL, lease: drop(ATENDIMENTO_SQL.lease), due: drop(ATENDIMENTO_SQL.due) };
    assert.notEqual(noLease.lease, ATENDIMENTO_SQL.lease);
    assert.notEqual(noLease.due, ATENDIMENTO_SQL.due);
    await crashAfterAdmit(fields());
    const m = resend();
    const slow = async (u, i) => { await new Promise((d) => setTimeout(d, 400)); return m.fetchImpl(u, i); };
    await Promise.all([1, 2, 3, 4].map(() => drainAtendimentoOutbox(ENV, { sqlFactory, fetchImpl: slow, q: noLease })));
    killed("L1 sem lease", m.calls.filter((c) => c.to === OWNER).length > 1);
  }
  console.log("ATENDIMENTO_OUTBOX_MUTANTS " + report.join(" | "));
});
