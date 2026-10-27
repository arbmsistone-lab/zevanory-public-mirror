// PostgreSQL real: a reserva durable em refund_provider_claims serializa pedidos concorrentes antes do POST.
// Rodar: T4_PG_HOST=/tmp/pgt T4_PG_PORT=55432 node --test tests/integration/refund-auto-dispatch-postgres.test.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { handleRefundFlow } from "../../worker/refund-flow.mjs";

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
  if (/\breturning\b/i.test(q)) return JSON.parse(psql(`with changed as (${q}) select coalesce(json_agg(changed), '[]'::json) from changed`) || "[]");
  psql(q); return [];
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
