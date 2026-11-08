// P20 diário D1, PR 4: roda as consultas REAIS da reconciliação (worker/diario-reconcilia.mjs, NEON_FONTES) num
// PostgreSQL de verdade, com as colunas reais das tabelas de origem (db/migrations 002-007, refund-provider-claims.mjs,
// lead-magnet.mjs), e confere que a derivação casa com o diário gravado pelos construtores dos ganchos.
// Opcional, como os demais testes de tests/integration: pulado sem DIARIO_PG_HOST (banco descartável, nunca produção).
// Exemplo: DIARIO_PG_HOST=localhost PGPASSWORD=... node --test tests/integration/diario-reconcilia-postgres.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readTextNormalized } from "../helpers/text.mjs";
import { createD1 } from "../helpers/d1-sqlite.mjs";
import { appendEvent } from "../../worker/diario-p20.mjs";
import { eventoPedidoCriado, eventoPagamento, eventoEntrega, eventoReembolso, eventoConsentimento } from "../../worker/diario-sombra.mjs";
import { reconciliaDiario } from "../../worker/diario-reconcilia.mjs";

const HOST = process.env.DIARIO_PG_HOST;
const PORT = process.env.DIARIO_PG_PORT || "5432";
const DB = process.env.DIARIO_PG_DB || "diario_reconcilia_it";
const MIGRATION = readTextNormalized(new URL("../../migrations/d1/0001_diario_v1.sql", import.meta.url)) + "\n" + readTextNormalized(new URL("../../migrations/d1/0002_diario_v1_ts.sql", import.meta.url));

const lit = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (Array.isArray(v)) return "'{" + v.map((x) => '"' + String(x).replace(/["\\]/g, "\\$&") + '"').join(",") + "}'";
  return "'" + String(v).replace(/'/g, "''") + "'";
};
function psql(sqlText, db = DB) {
  const out = execFileSync("psql", ["-h", HOST, "-p", PORT, "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "--csv", "-c", sqlText], { encoding: "utf8" });
  const lines = out.trim().split("\n").filter(Boolean);
  if (!lines.length || /^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP) /.test(lines[0])) return [];
  const [head, ...rows] = lines;
  const cols = head.split(",");
  return rows.map((r) => Object.fromEntries(r.split(",").map((v, i) => [cols[i], v === "" ? null : v])));
}
const sqlFactory = () => ({ query: async (text, params = []) => psql(text.replace(/\$(\d+)/g, (_, n) => lit(params[Number(n) - 1]))) });

test("real PostgreSQL: as consultas de NEON_FONTES derivam as mesmas chaves que os ganchos gravaram", { skip: !HOST && "DIARIO_PG_HOST not set" }, async () => {
  try { psql(`create database ${DB}`, "postgres"); } catch { /* já existe */ }
  psql(`drop table if exists service_fulfillment, financial_events, refund_provider_claims, zevanory_lead_events, orders cascade;
    create table orders (order_id uuid primary key, offer_id text not null, amount numeric(12,2) not null, provider text not null, status text not null, created_at timestamptz not null default now());
    create table financial_events (provider_event_id text primary key, provider text not null, provider_payment_id text not null, normalized_event text not null, provider_status text not null, amount numeric(12,2) not null, order_id uuid references orders(order_id), refunded_total numeric(12,2), received_at timestamptz not null default now());
    create table service_fulfillment (fulfillment_id uuid primary key, order_id uuid not null unique references orders(order_id), status text not null, delivery_mode text not null, delivered_at timestamptz, evidence_ref text, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create table refund_provider_claims (order_id uuid primary key, payment_id text not null, test boolean not null, stage text not null, claimed_at timestamptz not null default now(), reconciled_at timestamptz, reconciled_status text);
    create table zevanory_lead_events (id bigserial primary key, subject_ref text, event text not null, consent_version text, at timestamptz not null default now());`);
  const O1 = "3f2a9c1e-7b4d-4abc-9def-0123456789ab", O2 = "9b1c0d2e-3f4a-4b5c-8d6e-7f8091a2b3c4", REF = "c".repeat(64);
  psql(`insert into orders values ('${O1}','ia-na-pratica',97,'mercadopago','refunded', now() - interval '10 hours'), ('${O2}','ia-na-pratica',97,'asaas','paid', now() - interval '20 hours');
    insert into financial_events values ('mp:1','mercadopago','1234567890','payment_confirmed','approved',97,'${O1}',null, now() - interval '9 hours'),
      ('mp:2','mercadopago','1234567890','refund_confirmed','refunded',97,'${O1}',97.00, now() - interval '5 hours'),
      ('as:1','asaas','pay_abc123','payment_confirmed','RECEIVED',97,'${O2}',null, now() - interval '19 hours');
    insert into service_fulfillment values ('11111111-2222-4333-8444-555555555555','${O1}','delivered','digital', now() - interval '8 hours', '{"email_status":"sent","email_recipient":"cliente@example.com"}');
    insert into service_fulfillment values ('11111111-2222-4333-8444-666666666666','${O2}','delivered','digital', now() - interval '8 hours', 'texto legado sem json');
    insert into refund_provider_claims values ('${O1}','1234567890',false,'reconciled_refunded', now() - interval '6 hours', now() - interval '5 hours 50 minutes','approved');
    insert into zevanory_lead_events (subject_ref, event, consent_version, at) values ('${REF}','consent_given','v1', now() - interval '12 hours'), ('${REF}','erased_inactive','v1', now() - interval '11 hours'), (null,'consent_given','v1', now() - interval '11 hours');`);
  const ts = (q) => Number(psql(q)[0].t);
  const now = Date.now();
  const tsOf = (tabela, col, where) => ts(`select (floor(extract(epoch from ${col}) * 1000))::bigint as t from ${tabela} where ${where}`);
  const eventos = [
    eventoPedidoCriado({ orderId: O1, provider: "mercadopago", ts: tsOf("orders", "created_at", `order_id='${O1}'`) + 800 }),
    eventoPedidoCriado({ orderId: O2, provider: "asaas", ts: tsOf("orders", "created_at", `order_id='${O2}'`) + 500 }),
    eventoPagamento({ orderId: O1, provider: "mercadopago", paymentId: "1234567890", status: "approved", normalized: "payment_confirmed", refundedTotal: null, ts: tsOf("financial_events", "received_at", "provider_event_id='mp:1'") + 300 }),
    eventoPagamento({ orderId: O1, provider: "mercadopago", paymentId: "1234567890", status: "refunded", normalized: "refund_confirmed", refundedTotal: 97, ts: tsOf("financial_events", "received_at", "provider_event_id='mp:2'") + 300 }),
    eventoPagamento({ orderId: O2, provider: "asaas", paymentId: "pay_abc123", status: "RECEIVED", normalized: "payment_confirmed", refundedTotal: null, ts: tsOf("financial_events", "received_at", "provider_event_id='as:1'") + 300 }),
    eventoEntrega({ orderId: O1, provider: "mercadopago", channel: "email", ts: tsOf("service_fulfillment", "delivered_at", `order_id='${O1}'`) + 900 }),
    eventoReembolso({ orderId: O1, provider: "mercadopago", stage: "provider_call_may_have_been_sent", amount: 97, ts: tsOf("refund_provider_claims", "claimed_at", `order_id='${O1}'`) + 100 }),
    eventoReembolso({ orderId: O1, provider: "mercadopago", stage: "approved", refundId: "88990011", amount: 97, ts: tsOf("refund_provider_claims", "reconciled_at", `order_id='${O1}'`) + 100 }),
    eventoConsentimento({ event: "consent_given", subjectRef: REF, consentVersion: "v1", ts: tsOf("zevanory_lead_events", "at", "event='consent_given' and subject_ref is not null") }),
  ].sort((a, b) => a.ts_ms - b.ts_ms);
  const db = createD1(MIGRATION);
  for (const ev of eventos) assert.equal((await appendEvent(db, ev)).ok, true);
  const r = await reconciliaDiario({ DIARIO: db, DATABASE_URL: "postgres://descartavel" }, { sqlFactory, now });
  assert.equal(r.estado, "ok", JSON.stringify({ amostra: r.amostra, fontes: r.neon?.fontes }));
  assert.equal(r.esperados, 9);
  assert.deepEqual(r.neon.fontes, { orders: 2, financial_events: 3, service_fulfillment: 1, refund_provider_claims: 2, zevanory_lead_events: 1 });
  psql("drop table refund_provider_claims");
  const r2 = await reconciliaDiario({ DIARIO: db, DATABASE_URL: "postgres://descartavel" }, { sqlFactory, now });
  assert.equal(r2.neon.fontes.refund_provider_claims, "ausente", "tabela criada sob demanda e ainda ausente = fonte vazia");
  assert.equal(r2.estado, "divergente", "sem a fonte, os dois estornos do diário sobram");
  assert.equal(r2.sobrando, 2);
});
