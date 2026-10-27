// PostgreSQL real: a reserva durable em refund_provider_claims serializa pedidos concorrentes antes do POST.
// Rodar: T4_PG_HOST=/tmp/pgt T4_PG_PORT=55432 node --test tests/integration/refund-auto-dispatch-postgres.test.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { handleRefundFlow } from "../../worker/refund-flow.mjs";
import { casRefundState, writeRefundState, getRefundState } from "../../worker/refund-state.mjs";
import { createRefundStateFake } from "../helpers/refund-state-fake.mjs";

const HOST = process.env.T4_PG_HOST, PORT = process.env.T4_PG_PORT || "5432";
const SKIP = !HOST && "T4_PG_HOST not set (throwaway local PostgreSQL required)";
const DB = "ci_refund_auto_dispatch";
const EMAIL = "buyer@example.com";
const ACCOUNT_ID = "123456789";
const ACCOUNT_HASH16 = createHash("sha256").update(ACCOUNT_ID).digest("hex").slice(0, 16);
const lit = (v) => v === null || v === undefined ? "NULL" : "'" + String(v).replace(/'/g, "''") + "'";
const inline = (q, p) => q.replace(/\$(\d+)(?:::\w+)?/g, (_, n) => lit(p[Number(n) - 1]));
const psql = (sql, db = DB) => execFileSync("psql", ["-h", HOST, "-p", PORT, "-U", "postgres", "-d", db,
  "-v", "ON_ERROR_STOP=1", "-q", "-tA", "-c", sql], { encoding: "utf8" }).trim();

const sqlFactory = () => ({ query: async (statement, params = []) => {
  const q = inline(statement, params).trim().replace(/;\s*$/, "");
  if (/^select\b/i.test(q)) return JSON.parse(psql(`select coalesce(json_agg(t), '[]'::json) from (${q}) t`) || "[]");
  if (/^with\b/i.test(q)) return csvRows(psqlCsv(q));
  if (/\breturning\b/i.test(q)) return JSON.parse(psql(`with changed as (${q}) select coalesce(json_agg(changed), '[]'::json) from changed`) || "[]");
  psql(q); return [];
} });
// Statements with data-modifying CTEs must run at top level: read their result as CSV.
const psqlCsv = (sql) => execFileSync("psql", ["-h", HOST, "-p", PORT, "-U", "postgres", "-d", DB, "-v", "ON_ERROR_STOP=1", "-q", "--csv", "-c", sql], { encoding: "utf8" });
const csvRows = (out) => { const [head, ...lines] = out.trim().split("\n").filter(Boolean); if (!head) return [];
  const cols = head.split(","); return lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], /^-?\d+$/.test(v) ? Number(v) : v]))); };
// Truly concurrent connections (one psql process per statement) for the race tests.
const run = promisify(execFile);
const asyncSqlFactory = (db = DB) => ({ query: async (statement, params = []) => {
  const q = inline(statement, params).trim().replace(/;\s*$/, "");
  const base = ["-h", HOST, "-p", PORT, "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q"];
  if (/^select\b/i.test(q)) return JSON.parse((await run("psql", [...base, "-tA", "-c", `select coalesce(json_agg(t), '[]'::json) from (${q}) t`])).stdout.trim() || "[]");
  if (/^with\b/i.test(q)) return csvRows((await run("psql", [...base, "--csv", "-c", q])).stdout);
  if (/\breturning\b/i.test(q)) return JSON.parse((await run("psql", [...base, "-tA", "-c", `with changed as (${q}) select coalesce(json_agg(changed), '[]'::json) from changed`])).stdout.trim() || "[]");
  await run("psql", [...base, "-c", q]); return [];
} });

before(() => {
  if (SKIP) return;
  try { psql(`drop database if exists ${DB}`, "postgres"); } catch {}
  psql(`create database ${DB}`, "postgres");
  psql(`create table orders (order_id uuid primary key, status text not null, amount numeric not null, offer_id text,
          certification_pilot boolean not null default false);
        create table financial_events (provider_event_id text primary key, provider_payment_id text not null,
          normalized_event text not null, order_id uuid references orders(order_id), received_at timestamptz not null);
        create table service_fulfillment (fulfillment_id uuid primary key, order_id uuid references orders(order_id),
          status text not null, evidence_ref text, delivered_at timestamptz);
        create table artifact_download_tokens (token_id uuid primary key, order_id uuid references orders(order_id), used_at timestamptz);`);
});

test("PG real: 2 pedidos simultâneos reservam uma linha e fazem um POST", { skip: SKIP }, async () => {
  const oid = randomUUID(), paymentId = "778899", now = new Date(Date.now() - 3600_000).toISOString();
  psql(`insert into orders values (${lit(oid)},'paid',197,'ZEV-IA-011',false);
        insert into financial_events values ('ev-1',${lit(paymentId)},'payment_confirmed',${lit(oid)},${lit(now)});
        insert into service_fulfillment values (${lit(randomUUID())},${lit(oid)},'delivered',${lit(JSON.stringify({ email_recipient: EMAIL }))},${lit(now)});`);
  const state = new Map();
  const kv = { get: async (k) => state.get(k) ?? null, put: async (k, v) => { state.set(k, v); },
    list: async () => ({ keys: [], list_complete: true }) };
  const env = { REFUND_AUTO_DISPATCH: "true", MERCADOPAGO_ENV: "production",
    MERCADOPAGO_ACCESS_TOKEN: "APP_USR-FAKE-PRODUCTION-ABCDEFGHIJKLMNOP",
    MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16: ACCOUNT_HASH16,
    ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "postgres://psql.local/" + DB };
  let posts = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/users/me")) return Response.json({ id: Number(ACCOUNT_ID), site_id: "MLB", tags: [] });
    if (options.method === "POST") { posts++; return Response.json({ id: "refund-pg-1", status: "approved", amount: 197 }); }
    return Response.json({ id: Number(paymentId), status: "approved", status_detail: "accredited", external_reference: oid,
      transaction_amount: 197, transaction_amount_refunded: 0, refunds: [], payer: { email: EMAIL },
      metadata: { zevanory_order_id: oid, offer_id: "ZEV-IA-011" } });
  };
  const invoke = async (ip) => {
    const response = await handleRefundFlow(new Request("https://zevanory.api.br/api/support/refund-request", { method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify({ order_id: oid, email: EMAIL }) }), env, { sqlFactory });
    return response.status;
  };
  try {
    const statuses = await Promise.all([invoke("203.0.113.1"), invoke("203.0.113.2"), invoke("203.0.113.3")]);
    assert.equal(posts, 1, "[RAPG1] apenas uma chamada financeira");
    assert.equal(Number(psql(`select count(*) from refund_provider_claims where order_id=${lit(oid)}`)), 1, "[RAPG1] uma reserva transacional");
    assert.ok(statuses.includes(200), "[RAPG1] um solicitante conclui");
  } finally { globalThis.fetch = original; }
});

const rec = (oid, extra = {}) => ({ order_id: oid, status: "pending", auto_dispatch: true, request_nonce: "n", ...extra });

test("PG real: CAS concorrente na mesma versão tem exatamente um vencedor e um evento por transição", { skip: SKIP }, async () => {
  const sql = asyncSqlFactory(), oid = randomUUID();
  const created = await Promise.all(Array.from({ length: 8 }, () => casRefundState(sql, rec(oid), 0, { actor: "consumer-request" })));
  assert.equal(created.filter(Boolean).length, 1, "[RAPG2] uma criação");
  const updated = await Promise.all(Array.from({ length: 8 }, (_, i) => casRefundState(sql, rec(oid, { manual_reason: "r" + i }), 1, { actor: "w" + i })));
  assert.equal(updated.filter(Boolean).length, 1, "[RAPG2] um vencedor do CAS");
  assert.equal(Number(psql(`select count(*) from refund_request_events where order_id=${lit(oid)}`)), 2, "[RAPG2] dois eventos");
  assert.equal(Number(psql(`select version from refund_requests where order_id=${lit(oid)}`)), 2, "[RAPG2] versão 2");
});

test("PG real: aprovado vence escritores pendentes concorrentes e nunca regride (hipótese L-2 eliminada)", { skip: SKIP }, async () => {
  const sql = asyncSqlFactory(), oid = randomUUID();
  assert.ok(await writeRefundState(sql, rec(oid, { customer_email_pending: true }), { actor: "consumer-request" }), "[RAPG3] criado");
  const base = await getRefundState(sql, oid);
  const writers = [];
  for (let i = 0; i < 6; i++) writers.push(writeRefundState(sql, { ...base, customer_email_pending: false, note: "p" + i }, { actor: "consumer-notification" }));
  writers.push(writeRefundState(sql, { ...base, status: "approved", refund_id: "ref-1", customer_email_pending: true }, { actor: "automatic-withdrawal" }));
  for (let i = 0; i < 6; i++) writers.push(writeRefundState(sql, { ...base, manual_reason: "late" + i }, { actor: "late-pending" }));
  const results = await Promise.all(writers);
  assert.equal(results[6], true, "[RAPG3] escrita terminal aceita");
  const final = await getRefundState(sql, oid);
  assert.equal(final.status, "approved", "[RAPG3] estado final aprovado");
  assert.equal(final.refund_id, "ref-1", "[RAPG3] identificador do estorno preservado");
  const events = JSON.parse(psql(`select coalesce(json_agg(t order by version), '[]') from (select version, to_status from refund_request_events where order_id=${lit(oid)}) t`));
  assert.deepEqual(events.map((e) => e.version), events.map((_, i) => i + 1), "[RAPG3] versões contíguas e únicas");
  const firstApproved = events.findIndex((e) => e.to_status === "approved");
  assert.ok(events.slice(firstApproved).every((e) => e.to_status === "approved"), "[RAPG3] nenhuma transição pendente após aprovado");
});

test("PG real: fluxo completo com KV falhando (leituras vazias e escritas com erro) mantém estado correto e um POST", { skip: SKIP }, async () => {
  const oid = randomUUID(), paymentId = "998877", now = new Date(Date.now() - 3600_000).toISOString();
  psql(`insert into orders values (${lit(oid)},'paid',197,'ZEV-IA-011',false);
        insert into financial_events values ('ev-kv-${oid}',${lit(paymentId)},'payment_confirmed',${lit(oid)},${lit(now)});
        insert into service_fulfillment values (${lit(randomUUID())},${lit(oid)},'delivered',${lit(JSON.stringify({ email_recipient: EMAIL }))},${lit(now)});`);
  const kv = { get: async () => null, put: async () => { throw Error("kv down"); }, list: async () => ({ keys: [], list_complete: true }) };
  const env = { REFUND_AUTO_DISPATCH: "true", MERCADOPAGO_ENV: "production", MERCADOPAGO_ACCESS_TOKEN: "APP_USR-FAKE-PRODUCTION-ABCDEFGHIJKLMNOP",
    MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16: ACCOUNT_HASH16, ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "postgres://psql.local/" + DB };
  let posts = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/users/me")) return Response.json({ id: Number(ACCOUNT_ID), site_id: "MLB", tags: [] });
    if (String(url).includes("resend")) return Response.json({ id: "mail" });
    if (options.method === "POST") { posts++; return Response.json({ id: "refund-kv-1", status: "approved", amount: 197 }); }
    return Response.json({ id: Number(paymentId), status: "approved", status_detail: "accredited", external_reference: oid,
      transaction_amount: 197, transaction_amount_refunded: 0, refunds: [], payer: { email: EMAIL },
      metadata: { zevanory_order_id: oid, offer_id: "ZEV-IA-011" } });
  };
  const sqlFactoryAsync = () => asyncSqlFactory();
  const invoke = (ip) => handleRefundFlow(new Request("https://zevanory.api.br/api/support/refund-request", { method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify({ order_id: oid, email: EMAIL }) }), env, { sqlFactory: sqlFactoryAsync });
  try {
    const out = await Promise.all([invoke("198.51.100.1"), invoke("198.51.100.2"), invoke("198.51.100.3"), invoke("198.51.100.4")]);
    const bodies = await Promise.all(out.map(async (r) => r.status + ":" + (await r.clone().text()).slice(0, 80)));
    assert.ok(out.every((r) => r.status === 200), "[RAPG4] respostas uniformes " + JSON.stringify(bodies));
    assert.equal(posts, 1, "[RAPG4] uma chamada financeira");
    assert.equal(psql(`select status from refund_requests where order_id=${lit(oid)}`), "approved", "[RAPG4] estado autoritativo aprovado");
    assert.equal(Number(psql(`select count(*) from refund_provider_claims where order_id=${lit(oid)}`)), 1, "[RAPG4] uma reserva");
    assert.ok(Number(psql(`select count(*) from refund_request_events where order_id=${lit(oid)} and to_status='approved'`)) >= 1, "[RAPG4] transição auditada");
    await invoke("198.51.100.5");
    assert.equal(posts, 1, "[RAPG4] repetição sem nova chamada");
  } finally { globalThis.fetch = original; }
});

test("PG real: o fake das unidades aplica as mesmas regras que o PostgreSQL", { skip: SKIP }, async () => {
  const sql = sqlFactory(), oid = randomUUID(), fake = createRefundStateFake();
  const fsql = { query: async (s, a) => fake.handle(s, a) };
  const steps = [[rec(oid), 0], [rec(oid, { manual_reason: "x" }), 1], [rec(oid, { manual_reason: "stale" }), 1],
    [rec(oid, { status: "approved" }), 2], [rec(oid, { manual_reason: "after" }), 3], [rec(oid, { status: "approved", n: 1 }), 3]];
  for (const [r, v] of steps) assert.equal(await casRefundState(sql, r, v, { actor: "t" }), await casRefundState(fsql, r, v, { actor: "t" }), "[RAPG5] mesmo resultado " + JSON.stringify([r.status, r.manual_reason, v]));
});

test("PG real: primeiro uso concorrente com o banco sem as tabelas de reembolso não devolve 5xx nem recibo sem registro", { skip: SKIP }, async () => {
  const db = DB + "_init";
  try { psql(`drop database if exists ${db}`, "postgres"); } catch {}
  psql(`create database ${db}`, "postgres");
  psql(`create table orders (order_id uuid primary key, status text not null, amount numeric not null, offer_id text, certification_pilot boolean not null default false);
        create table financial_events (provider_event_id text primary key, provider_payment_id text not null, normalized_event text not null, order_id uuid, received_at timestamptz not null);
        create table service_fulfillment (fulfillment_id uuid primary key, order_id uuid, status text not null, evidence_ref text, delivered_at timestamptz);
        create table artifact_download_tokens (token_id uuid primary key, order_id uuid, used_at timestamptz);`, db);
  const oids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const now = new Date(Date.now() - 3600_000).toISOString();
  for (const oid of oids) psql(`insert into orders values (${lit(oid)},'paid',197,'ZEV-IA-011',false);
    insert into financial_events values ('ev-${oid}','pay-${oid}','payment_confirmed',${lit(oid)},${lit(now)});
    insert into service_fulfillment values (${lit(randomUUID())},${lit(oid)},'delivered',${lit(JSON.stringify({ email_recipient: EMAIL }))},${lit(now)});`, db);
  const kv = { m: new Map(), async get(k) { return this.m.get(k) ?? null; }, async put(k, v) { this.m.set(k, v); }, async list() { return { keys: [], list_complete: true }; } };
  const env = { REFUND_AUTO_DISPATCH: "true", MERCADOPAGO_ENV: "production", MERCADOPAGO_ACCESS_TOKEN: "APP_USR-FAKE-PRODUCTION-ABCDEFGHIJKLMNOP",
    MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16: ACCOUNT_HASH16, ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "postgres://psql.local/" + db };
  const posts = new Map();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const t = String(url);
    if (t.endsWith("/users/me")) return Response.json({ id: Number(ACCOUNT_ID), site_id: "MLB", tags: [] });
    if (t.includes("resend")) return Response.json({ id: "mail" });
    const pid = decodeURIComponent(t.split("/v1/payments/")[1] || "").split("/")[0];
    const oid = pid.replace(/^pay-/, "");
    if (options.method === "POST") { posts.set(oid, (posts.get(oid) || 0) + 1); return Response.json({ id: "r-" + oid, status: "approved", amount: 197 }); }
    return Response.json({ id: pid, status: "approved", status_detail: "accredited", external_reference: oid, transaction_amount: 197,
      transaction_amount_refunded: 0, refunds: [], payer: { email: EMAIL }, metadata: { zevanory_order_id: oid, offer_id: "ZEV-IA-011" } });
  };
  const sqlFactory = () => asyncSqlFactory(db);
  const invoke = (oid, i) => handleRefundFlow(new Request("https://zevanory.api.br/api/support/refund-request", { method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100." + i }, body: JSON.stringify({ order_id: oid, email: EMAIL }) }), env, { sqlFactory });
  try {
    const out = await Promise.all(oids.flatMap((oid, k) => [0, 1, 2].map((j) => invoke(oid, k * 3 + j))));
    const bodies = await Promise.all(out.map(async (r) => r.status + ":" + (await r.clone().text()).slice(0, 60)));
    assert.deepEqual(out.map((r) => r.status), out.map(() => 200), "[RAPG6] nenhum 5xx na criação concorrente das tabelas " + JSON.stringify(bodies));
    assert.equal(Number(psql("select count(*) from refund_requests", db)), oids.length, "[RAPG6] um registro por pedido");
    assert.ok(oids.every((oid) => posts.get(oid) === 1), "[RAPG6] um POST por pedido");
  } finally { globalThis.fetch = original; try { psql(`drop database if exists ${db} with (force)`, "postgres"); } catch {} }
});
