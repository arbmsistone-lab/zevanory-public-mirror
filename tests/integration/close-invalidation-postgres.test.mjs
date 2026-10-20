// Invalidação de links no fechamento contra PostgreSQL REAL descartável (dados sintéticos, provedor simulado).
// Cobre a contestação GPT-6 (016-C): limites exatos, empates de updated_at, microssegundos, registros
// adicionados durante a varredura, falhas parciais e teto sem ultrapassar maxTotal.
// Rodar: T4_PG_HOST=/tmp/pgt T4_PG_PORT=55432 node --test tests/integration/close-invalidation-postgres.test.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { invalidatePendingMercadoPagoCheckouts, preferenceIsClosed } from "../../worker/close-invalidation.mjs";

const HOST = process.env.T4_PG_HOST, PORT = process.env.T4_PG_PORT || "5432";
const SKIP = !HOST && "T4_PG_HOST not set (throwaway local PostgreSQL required)";
const DB = "ci_invalidation";
const lit = (v) => v === null || v === undefined ? "NULL" : "'" + String(v).replace(/'/g, "''") + "'";
const psql = (sql, db = DB) => execFileSync("psql", ["-h", HOST, "-p", PORT, "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-tA", "-F", "\t", "-c", sql], { encoding: "utf8" });
// Adaptador mínimo sql.query(texto, params) -> linhas como objeto (mesma forma do driver Neon).
function adaptador({ aoConsultar } = {}) {
  return { consultas: [], async query(q, params = []) {
    const inl = q.replace(/\$(\d+)/g, (_, n) => lit(params[Number(n) - 1]));
    this.consultas.push(params);
    const out = psql(inl).trim();
    const linhas = out ? out.split("\n").map((l) => l.split("\t")) : [];
    const r = linhas.map(([order_id, provider_checkout_id, cursor_at]) => ({ order_id, provider_checkout_id, cursor_at }));
    if (aoConsultar) aoConsultar(this.consultas.length);
    return r;
  } };
}
function provedor({ falhar = new Set() } = {}) {
  const prefs = new Map();
  return { prefs, criar() { const id = "pref-" + randomUUID().slice(0, 12); prefs.set(id, {}); return id; },
    fetch: async (url, init = {}) => {
      const id = decodeURIComponent(String(url).split("/").pop());
      if (!prefs.has(id)) return { ok: false, status: 404 };
      if (init.method === "PUT") { if (falhar.has(id)) return { ok: false, status: 500 }; Object.assign(prefs.get(id), JSON.parse(init.body)); return { ok: true, status: 200 }; }
      return { ok: true, status: 200, json: async () => ({ id, ...prefs.get(id) }) };
    } };
}
function semear(mp, n, { at = "2026-10-20 10:00:00.123456+00", status = "checkout_ready" } = {}) {
  const ids = [];
  for (let i = 0; i < n; i++) { const pref = mp.criar(); const oid = randomUUID(); ids.push({ oid, pref });
    psql(`insert into orders(order_id,amount,provider,external_reference,status,provider_checkout_id,updated_at) values (${lit(oid)},47,'mercadopago','ref-${oid}',${lit(status)},${lit(pref)},${lit(at)})`); }
  return ids;
}
const T = Date.parse("2026-10-20T16:00:00Z");

before(() => {
  if (SKIP) return;
  try { psql(`drop database if exists ${DB}`, "postgres"); } catch {}
  psql(`create database ${DB}`, "postgres");
  psql(`create table orders (order_id uuid primary key, amount numeric not null, provider text not null, external_reference text not null,
    status text not null, provider_checkout_id text, updated_at timestamptz not null default now())`);
});
const limpar = () => psql("truncate orders");

test("P1 limite exato: 100 pendentes, página 50 => 3 consultas (a 3ª prova o esgotamento), 100 fechados", { skip: SKIP }, async () => {
  limpar(); const mp = provedor(); semear(mp, 100, { at: "2026-10-20 10:00:00+00" });
  const db = adaptador();
  const out = await invalidatePendingMercadoPagoCheckouts(db, { accessToken: "x", fetchImpl: mp.fetch, now: T, dryRun: false, pageSize: 50 });
  assert.deepEqual([out.ok, out.checked, out.invalidated, out.exhausted, db.consultas.length], [true, 100, 100, true, 3]);
  assert.ok([...mp.prefs.values()].every((p) => preferenceIsClosed(p, T)));
});

test("P2 empates de updated_at com microssegundos: nenhuma linha repetida nem pulada", { skip: SKIP }, async () => {
  limpar(); const mp = provedor();
  semear(mp, 37, { at: "2026-10-20 10:00:00.123456+00" }); semear(mp, 25, { at: "2026-10-20 10:00:00.123457+00" });
  const vistos = [];
  const f = async (url, init) => { if (init?.method === "PUT") vistos.push(decodeURIComponent(String(url).split("/").pop())); return mp.fetch(url, init); };
  const out = await invalidatePendingMercadoPagoCheckouts(adaptador(), { accessToken: "x", fetchImpl: f, now: T, dryRun: false, pageSize: 10 });
  assert.equal(out.checked, 62); assert.equal(new Set(vistos).size, 62, "sem repetição"); assert.equal(vistos.length, 62); assert.equal(out.ok, true);
});

test("P3 teto: nunca ultrapassa maxTotal; com pendentes restantes => exhausted=false, ok=false", { skip: SKIP }, async () => {
  limpar(); const mp = provedor(); semear(mp, 30);
  const out = await invalidatePendingMercadoPagoCheckouts(adaptador(), { accessToken: "x", fetchImpl: mp.fetch, now: T, dryRun: false, pageSize: 20, maxTotal: 25 });
  assert.equal(out.checked, 25, "a 2ª página foi reduzida a 5"); assert.equal(out.exhausted, false); assert.equal(out.ok, false);
});

test("P4 teto exatamente igual ao total: prova por consulta extra que a fila acabou => ok=true", { skip: SKIP }, async () => {
  limpar(); const mp = provedor(); semear(mp, 20);
  const out = await invalidatePendingMercadoPagoCheckouts(adaptador(), { accessToken: "x", fetchImpl: mp.fetch, now: T, dryRun: false, pageSize: 10, maxTotal: 20 });
  assert.deepEqual([out.checked, out.exhausted, out.ok], [20, true, true]);
});

test("P5 registro adicionado DURANTE a varredura (pedido novo/atualizado) é alcançado na mesma execução", { skip: SKIP }, async () => {
  limpar(); const mp = provedor(); semear(mp, 15, { at: "2026-10-20 10:00:00+00" });
  let tardio = null;
  const db = adaptador({ aoConsultar: (n) => { if (n === 1) tardio = semear(mp, 1, { at: "2026-10-20 11:00:00+00" })[0]; } });
  const out = await invalidatePendingMercadoPagoCheckouts(db, { accessToken: "x", fetchImpl: mp.fetch, now: T, dryRun: false, pageSize: 10 });
  assert.equal(out.checked, 16); assert.ok(preferenceIsClosed(mp.prefs.get(tardio.pref), T));
});

test("P6 falha parcial do provedor: os demais seguem, falhas listadas, ok=false; nova execução fecha o restante", { skip: SKIP }, async () => {
  limpar(); const falhar = new Set(); const mp = provedor({ falhar }); const ids = semear(mp, 12);
  falhar.add(ids[3].pref); falhar.add(ids[9].pref);
  const out = await invalidatePendingMercadoPagoCheckouts(adaptador(), { accessToken: "x", fetchImpl: mp.fetch, now: T, dryRun: false, pageSize: 5 });
  assert.deepEqual([out.ok, out.invalidated, out.failed.length, out.exhausted], [false, 10, 2, true]);
  assert.ok(out.failed.every((f) => f.reason === "provider_http_500"));
  falhar.clear();
  const again = await invalidatePendingMercadoPagoCheckouts(adaptador(), { accessToken: "x", fetchImpl: mp.fetch, now: T, dryRun: false, pageSize: 5 });
  assert.equal(again.ok, true); assert.ok([...mp.prefs.values()].every((p) => preferenceIsClosed(p, T)));
});

test("P7 só pendentes do Mercado Pago: pago, reembolsado e outros provedores não são tocados", { skip: SKIP }, async () => {
  limpar(); const mp = provedor(); semear(mp, 3); const pagos = semear(mp, 2, { status: "paid" });
  psql(`insert into orders(order_id,amount,provider,external_reference,status,provider_checkout_id) values (${lit(randomUUID())},47,'asaas','r','checkout_ready','pay_x')`);
  const out = await invalidatePendingMercadoPagoCheckouts(adaptador(), { accessToken: "x", fetchImpl: mp.fetch, now: T, dryRun: false });
  assert.equal(out.checked, 3); assert.ok(pagos.every((p) => !preferenceIsClosed(mp.prefs.get(p.pref), T)));
});
