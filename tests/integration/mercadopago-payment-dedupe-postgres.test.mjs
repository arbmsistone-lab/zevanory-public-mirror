// B05 / G9 (D7): idempotência da transição "pagamento confirmado" em PostgreSQL REAL com conexões
// INDEPENDENTES e simultâneas (processos psql em paralelo). Usa o MESMO SQL do webhook do Worker
// (CTE target/inserted/updated/fulfillment_paid extraída do código-fonte) e o esquema tests/t4_sim/schema.sql.
// Sem rede, sem provedor, sem dinheiro. Rodar: T4_PG_HOST=/tmp/pgt T4_PG_PORT=55432 node --test tests/integration/mercadopago-payment-dedupe-postgres.test.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const HOST = process.env.T4_PG_HOST, PORT = process.env.T4_PG_PORT || "5432";
const SKIP = !HOST && "T4_PG_HOST not set (throwaway local PostgreSQL required)";
const DB = "ci_payment_dedupe";
const lit = (v) => v === null || v === undefined ? "NULL" : "'" + String(v).replace(/'/g, "''") + "'";
const args = (db) => ["-h", HOST, "-p", PORT, "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "-tA", "-F", ",", "-c"];
const psql = (sql, db = DB) => execFileSync("psql", [...args(db), sql], { encoding: "utf8" }).trim();
const psqlAsync = (sql) => new Promise((ok) => execFile("psql", [...args(DB), sql], { encoding: "utf8" }, (e, out, err) => ok(e ? "ERRO:" + String(err).slice(0, 200) : out.trim())));

const SRC = readFileSync(new URL("../../worker/cloudflare-worker.recovered.mjs", import.meta.url), "utf8");
const HANDLER = SRC.indexOf("async function handleMercadoPagoWebhook(");
const ini = SRC.indexOf("rows = await sql.query(`\n      WITH target AS (", HANDLER);
assert.ok(HANDLER > 0 && ini > HANDLER && ini < SRC.indexOf("__name(handleMercadoPagoWebhook", HANDLER), "CTE do webhook Mercado Pago não encontrada no Worker");
const CTE = SRC.slice(SRC.indexOf("`", ini) + 1, SRC.indexOf("`, [providerEventId", ini));
const PEID = SRC.slice(HANDLER).match(/const providerEventId = `\$\{prefix\}:\$\{webhook\.paymentId\}:\$\{String\(payment\.status \|\| ""\)\}:\$\{String\(payment\.transaction_amount_refunded \|\| 0\)\}`;/);
const inline = (q, p) => q.replace(/\$(\d+)/g, (_, n) => lit(p[Number(n) - 1]));

function pedido() {
  const id = randomUUID(), ref = `ZEVANORY:EXP-0001:${id}`;
  psql(`insert into orders (order_id, offer_id, amount, provider, external_reference, status) values (${lit(id)},'ZEV-IA-011','197.00','mercadopago',${lit(ref)},'checkout_ready')`);
  return { id, ref };
}
// Mesmos parâmetros que o handler passa: [providerEventId, paymentId, normalized, nome, status, ref, valor, orderId, reembolsado, fulfillmentId]
const params = (o, paymentId) => [`mp:${paymentId}:approved:0`, paymentId, "payment_confirmed", "payment.updated", "approved", o.ref, 197, o.id, 0, randomUUID()];
const um = (sql) => psql(sql);

before(() => {
  if (SKIP) return;
  try { psql(`drop database if exists ${DB}`, "postgres"); } catch {}
  psql(`create database ${DB}`, "postgres");
  execFileSync("psql", ["-h", HOST, "-p", PORT, "-U", "postgres", "-d", DB, "-v", "ON_ERROR_STOP=1", "-q", "-f", "-"],
    { input: readFileSync(new URL("../t4_sim/schema.sql", import.meta.url), "utf8"), encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
});

test("D1 chave de deduplicação do evento = provedor + pagamento + status + reembolsado (sem aleatoriedade)", { skip: SKIP }, () => {
  assert.ok(PEID, "providerEventId determinístico no Worker");
  assert.match(CTE, /INSERT INTO financial_events[\s\S]+ON CONFLICT DO NOTHING/);
  assert.match(CTE, /UPDATE orders o SET status=CASE[\s\S]+FROM inserted i WHERE o\.order_id=i\.order_id/, "a transição só ocorre se o evento foi inserido");
});

test("D2 8 conexões simultâneas com o MESMO pagamento aprovado => exatamente 1 inserção, 1 transição para pago, 1 entrega", { skip: SKIP }, async () => {
  const o = pedido(); const p = params(o, "77000001");
  const outs = await Promise.all(Array.from({ length: 8 }, (_, i) => psqlAsync(inline(CTE, [...p.slice(0, 9), randomUUID()]))));
  // colunas: target_count,inserted_count,order_status,current_status,fulfillment_status
  const linhas = outs.map((s) => s.split(","));
  assert.equal(linhas.filter((l) => l[1] === "1").length, 1, JSON.stringify(outs));
  assert.equal(linhas.filter((l) => l[2] === "paid").length, 1, "uma única transição registrada");
  assert.ok(outs.every((s) => !s.startsWith("ERRO:")), JSON.stringify(outs));
  assert.equal(um(`select count(*) from financial_events where order_id=${lit(o.id)}`), "1");
  assert.equal(um(`select count(*) from service_fulfillment where order_id=${lit(o.id)}`), "1");
  assert.equal(um(`select status from orders where order_id=${lit(o.id)}`), "paid");
});

test("D3 duplicata sequencial (reentrega do provedor) não insere nem transiciona de novo", { skip: SKIP }, () => {
  const o = pedido(); const p = params(o, "77000002");
  const r1 = psql(inline(CTE, p)).split(","), r2 = psql(inline(CTE, [...p.slice(0, 9), randomUUID()])).split(",");
  assert.deepEqual([r1[1], r1[2]], ["1", "paid"]);
  assert.deepEqual([r2[1], r2[2]], ["0", ""], "segunda entrega: nada inserido, nenhuma transição");
  assert.equal(um(`select count(*) from financial_events where order_id=${lit(o.id)}`), "1");
});

test("D4 pagamentos distintos do mesmo pedido em paralelo não duplicam a entrega (service_fulfillment único por pedido)", { skip: SKIP }, async () => {
  const o = pedido();
  const outs = await Promise.all(["77000003", "77000004", "77000005"].map((pid) => psqlAsync(inline(CTE, params(o, pid)))));
  assert.ok(outs.every((s) => !s.startsWith("ERRO:")), JSON.stringify(outs));
  assert.equal(um(`select count(*) from service_fulfillment where order_id=${lit(o.id)}`), "1");
  assert.equal(um(`select status from orders where order_id=${lit(o.id)}`), "paid");
});
