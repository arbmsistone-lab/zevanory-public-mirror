// AVAL Sol (2ff8678): o marco do prazo de arrependimento é o PRIMEIRO recebimento. Com mais de uma linha de
// entrega para o pedido, a subconsulta de worker/refund-flow.mjs (loadOrder) precisa escolher a MAIS ANTIGA
// de forma determinística (min(delivered_at)); antes era LIMIT 1 sem ORDER BY (linha arbitrária).
// Contra PostgreSQL REAL: duas entregas inseridas em ordem invertida (dia 6 antes do dia 1). O handler real
// (handleRefundFlow) roda com sqlFactory sobre psql. Os mutantes (LIMIT 1 sem ordem, max, ORDER BY desc)
// precisam ser mortos.
// Nota de esquema: db/migrations/007_no_inventory_commerce.sql declara service_fulfillment.order_id UNIQUE, o
// que hoje impede a segunda linha; a tabela aqui é criada SEM o UNIQUE para que a consulta seja correta por si
// mesma (não dependa de uma restrição que o código não verifica).
// Rodar: T4_PG_HOST=/tmp/pgt T4_PG_PORT=55432 node --test tests/integration/refund-window-postgres.test.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const HOST = process.env.T4_PG_HOST, PORT = process.env.T4_PG_PORT || "5432";
const SKIP = !HOST && "T4_PG_HOST not set (throwaway local PostgreSQL required)";
const DB = "ci_refund_window";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DAY = 86_400_000;
const EMAIL = "cliente@example.com";
const lit = (v) => v === null || v === undefined ? "NULL" : "'" + String(v).replace(/'/g, "''") + "'";
const inline = (q, p) => q.replace(/\$(\d+)/g, (_, n) => lit(p[Number(n) - 1]));
const psql = (sql, db = DB) => execFileSync("psql", ["-h", HOST, "-p", PORT, "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "-tA", "-c", sql], { encoding: "utf8" }).trim();

// sqlFactory mínimo sobre psql: SELECT devolve linhas como objetos (json_agg); o resto executa e devolve [].
const sqlFactory = () => ({ query: async (statement, params = []) => {
  const q = inline(statement, params).trim().replace(/;\s*$/, "");
  if (/^select\b/i.test(q)) return JSON.parse(psql(`select coalesce(json_agg(t), '[]'::json) from (${q}) t`) || "[]");
  psql(q);
  return [];
} });

before(() => {
  if (SKIP) return;
  try { psql(`drop database if exists ${DB}`, "postgres"); } catch {}
  psql(`create database ${DB}`, "postgres");
  psql(`create table orders (order_id uuid primary key, status text not null, amount numeric not null, offer_id text, certification_pilot boolean not null default false);
        create table financial_events (provider_event_id text primary key, provider_payment_id text not null, normalized_event text not null,
          order_id uuid references orders(order_id), received_at timestamptz not null default now());
        create table service_fulfillment (fulfillment_id uuid primary key, order_id uuid references orders(order_id), status text not null,
          evidence_ref text, delivered_at timestamptz);
        create table artifact_download_tokens (token_id uuid primary key, order_id uuid references orders(order_id), used_at timestamptz);`);
});

// Pagamento no dia 0; entregas no dia 1 e no dia 6, INSERIDAS NA ORDEM INVERTIDA (dia 6 primeiro).
// Hoje = dia 10. Contando do dia 1 (primeiro recebimento) o prazo terminou (fora do prazo, 409).
// Contando do dia 6 (linha arbitrária/a mais recente) estaria dentro do prazo (200) — o defeito.
function seed() {
  const oid = randomUUID(), now = Date.now(), paid = now - 10 * DAY;
  const day1 = new Date(paid + 1 * DAY).toISOString(), day6 = new Date(paid + 6 * DAY).toISOString();
  const ev = JSON.stringify({ email_recipient: EMAIL });
  psql(`insert into orders values (${lit(oid)}, 'paid', 197, 'ZEV-IA-011', true);
        insert into financial_events values (${lit("ev-" + oid)}, '123', 'payment_confirmed', ${lit(oid)}, ${lit(new Date(paid).toISOString())});
        insert into service_fulfillment values (${lit(randomUUID())}, ${lit(oid)}, 'delivered', ${lit(ev)}, ${lit(day6)});
        insert into service_fulfillment values (${lit(randomUUID())}, ${lit(oid)}, 'delivered', ${lit(ev)}, ${lit(day1)});`);
  return { oid, day1, day6 };
}

function loadOrderSql(src) {
  const m = src.match(/async function loadOrder\(sql, oid\) \{[\s\S]*?sql\.query\(\s*`([\s\S]+?)`/);
  if (!m) throw new Error("SQL de loadOrder não encontrado em worker/refund-flow.mjs");
  return m[1];
}

// Verificação compartilhada pelo caminho real e pelos mutantes.
async function check(src, handleRefundFlow) {
  const { oid, day1, day6 } = seed();
  // Linha física mais antiga = dia 6 (prova de que a ordem de inserção está invertida).
  assert.equal(Number(psql(`select (extract(epoch from delivered_at)*1000)::bigint from service_fulfillment where order_id=${lit(oid)} order by ctid limit 1`)), Date.parse(day6), "inserção invertida");
  const kvState = new Map();
  const kv = { get: async (k) => kvState.get(k) ?? null, put: async (k, v) => { kvState.set(k, v); }, list: async () => ({ keys: [], list_complete: true }) };
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "postgres://psql.local/" + DB };
  const res = await handleRefundFlow(new Request("https://zevanory.api.br/api/support/refund-request", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" }, body: JSON.stringify({ order_id: oid, email: EMAIL }) }), env, { sqlFactory });
  const body = await res.json();
  assert.equal(res.status, 409, "pedido no dia 10 com primeiro recebimento no dia 1: fora do prazo; obtido " + JSON.stringify(body));
  assert.equal(body.error, "fora_do_prazo");
  assert.equal(kvState.has("refund:req:" + oid), false, "fora do prazo nunca é registrado");
  const [row] = await sqlFactory().query(loadOrderSql(src), [oid]);
  assert.equal(Date.parse(row.delivered_at), Date.parse(day1), `marco = primeiro recebimento (dia 1), obtido ${row.delivered_at}`);
}

test("PG real: duas entregas inseridas invertidas (dia 6 antes do dia 1) => o prazo conta do dia 1 (loadOrder e handler real)", { skip: SKIP }, async () => {
  const src = readFileSync(join(ROOT, "worker/refund-flow.mjs"), "utf8");
  assert.match(loadOrderSql(src), /min\(sf\.delivered_at\)/);
  const { handleRefundFlow } = await import("../../worker/refund-flow.mjs");
  await check(src, handleRefundFlow);
});

test("PG real mutantes do marco: LIMIT 1 sem ordem, max() e ORDER BY desc são mortos", { skip: SKIP }, async () => {
  const FIXED = "(select min(sf.delivered_at) from service_fulfillment sf where sf.order_id=o.order_id and sf.status='delivered') as delivered_at";
  const mutants = {
    "W1 LIMIT 1 sem ORDER BY (código de 2ff8678)": "(select sf.delivered_at from service_fulfillment sf where sf.order_id=o.order_id and sf.status='delivered' limit 1) as delivered_at",
    "W2 max(delivered_at)": "(select max(sf.delivered_at) from service_fulfillment sf where sf.order_id=o.order_id and sf.status='delivered') as delivered_at",
    "W3 ORDER BY delivered_at desc": "(select sf.delivered_at from service_fulfillment sf where sf.order_id=o.order_id and sf.status='delivered' order by sf.delivered_at desc limit 1) as delivered_at",
  };
  const report = [];
  for (const [name, replacement] of Object.entries(mutants)) {
    const dir = mkdtempSync(join(tmpdir(), "refund-window-"));
    try {
      for (const d of ["worker", "data"]) cpSync(join(ROOT, d), join(dir, d), { recursive: true });
      const target = join(dir, "worker/refund-flow.mjs"), before = readFileSync(target, "utf8"), after = before.replace(FIXED, replacement);
      assert.notEqual(after, before, "mutação não aplicada: " + name);
      writeFileSync(target, after);
      const { handleRefundFlow } = await import(pathToFileURL(target).href + "?m=" + encodeURIComponent(name));
      let killed = false, why = "";
      try { await check(after, handleRefundFlow); } catch (e) { killed = e instanceof assert.AssertionError; why = String(e.message).split("\n")[0].slice(0, 110); }
      report.push(`${name}: ${killed ? "KILLED" : "SURVIVED"} ${why}`);
      assert.ok(killed, name + " sobreviveu (ou falhou por erro que não é de asserção): " + why);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  console.log(report.join("\n"));
});
