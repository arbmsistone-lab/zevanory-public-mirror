import test from "node:test";
import assert from "node:assert/strict";
import { mercadoPagoExpiryWindow } from "../worker/payment-link-expiry.mjs";
import { invalidatePendingMercadoPagoCheckouts, closedExpiryPatch } from "../worker/close-invalidation.mjs";
import { applySalesSwitch } from "../worker/sales-control.mjs";

// LABORATÓRIO (Ordem 016-A, exigência GPT-6): cobrança SIMULADA -> fechar interruptor -> o link ainda paga?
// Provedor simulado reproduz a regra documentada da preferência: com expires=true só aceita
// pagamento entre expiration_date_from e expiration_date_to; sem expires, aceita sempre.
function provedorSimulado() {
  const prefs = new Map(); let seq = 0;
  return {
    prefs,
    criar(payload) { const id = `pref-lab-${++seq}`; prefs.set(id, { ...payload }); return id; },
    pagar(id, at) {
      const p = prefs.get(id); if (!p) return "not_found";
      if (p.expires === true && !(Date.parse(p.expiration_date_from) <= at && at <= Date.parse(p.expiration_date_to))) return "expired";
      return "approved";
    },
    fetch: async (url, init) => {
      const id = decodeURIComponent(String(url).split("/").pop());
      if (init?.method !== "PUT" || !prefs.has(id)) return { ok: false, status: 404 };
      Object.assign(prefs.get(id), JSON.parse(init.body)); return { ok: true, status: 200 };
    }
  };
}
const sqlCom = (ordens) => ({ query: async () => ordens });
const T0 = Date.parse("2026-10-20T16:00:00.000Z"), HORA = 3600 * 1000;

test("LAB 1: fechar o interruptor NÃO invalida link já emitido (risco residual comprovado)", () => {
  const mp = provedorSimulado();
  const id = mp.criar({ items: [{ unit_price: 47 }], ...mercadoPagoExpiryWindow(T0) });
  assert.equal(applySalesSwitch({ enabled: false }), false);
  assert.equal(globalThis.__ZEVANORY_SALES_SWITCH__, false);
  assert.equal(mp.pagar(id, T0 + HORA), "approved", "o link segue pagável dentro das 24 h mesmo com vendas fechadas");
  assert.equal(mp.pagar(id, T0 + 25 * HORA), "expired", "após 24 h o provedor recusa");
});

test("LAB 2: link legado sem expiração segue pagável indefinidamente", () => {
  const mp = provedorSimulado();
  const id = mp.criar({ items: [{ unit_price: 47 }] });
  assert.equal(mp.pagar(id, T0 + 365 * 24 * HORA), "approved");
});

test("LAB 3: invalidação no fechamento torna links pendentes (novos e legados) impagáveis imediatamente", async () => {
  const mp = provedorSimulado();
  const novo = mp.criar({ ...mercadoPagoExpiryWindow(T0) }), legado = mp.criar({});
  applySalesSwitch({ enabled: false });
  const out = await invalidatePendingMercadoPagoCheckouts(
    sqlCom([{ order_id: "o1", provider_checkout_id: novo }, { order_id: "o2", provider_checkout_id: legado }]),
    { accessToken: "lab-token-simulado", fetchImpl: mp.fetch, now: T0 + HORA, dryRun: false });
  assert.deepEqual([out.ok, out.checked, out.invalidated, out.failed.length], [true, 2, 2, 0]);
  assert.equal(mp.pagar(novo, T0 + HORA + 1000), "expired");
  assert.equal(mp.pagar(legado, T0 + HORA + 1000), "expired");
});

test("LAB 4: modo padrão é simulação (dryRun) — nenhuma chamada ao provedor", async () => {
  let chamadas = 0;
  const out = await invalidatePendingMercadoPagoCheckouts(sqlCom([{ order_id: "o1", provider_checkout_id: "pref-1" }]),
    { accessToken: "x", fetchImpl: async () => { chamadas++; return { ok: true, status: 200 }; } });
  assert.equal(out.dry_run, true); assert.equal(chamadas, 0); assert.deepEqual(out.pending, ["o1"]);
});

test("LAB 5: falha do provedor é reportada (não declara invalidado), sem token não chama", async () => {
  const mp = provedorSimulado();
  const out = await invalidatePendingMercadoPagoCheckouts(sqlCom([{ order_id: "o9", provider_checkout_id: "pref-inexistente" }]),
    { accessToken: "x", fetchImpl: mp.fetch, now: T0, dryRun: false });
  assert.equal(out.ok, false); assert.equal(out.invalidated, 0); assert.equal(out.failed[0].reason, "provider_http_404");
  let chamadas = 0;
  const sem = await invalidatePendingMercadoPagoCheckouts(sqlCom([{ order_id: "o1", provider_checkout_id: "pref-1" }]),
    { accessToken: "", fetchImpl: async () => { chamadas++; return { ok: true }; }, dryRun: false });
  assert.equal(sem.ok, false); assert.equal(sem.reason, "provider_token_unavailable"); assert.equal(chamadas, 0);
});

test("patch de fechamento: janela já encerrada no instante do fechamento", () => {
  const p = closedExpiryPatch(T0);
  assert.equal(p.expires, true); assert.ok(Date.parse(p.expiration_date_to) < T0); assert.ok(Date.parse(p.expiration_date_from) < Date.parse(p.expiration_date_to));
});

// SLA de fechamento: parte controlada pelo código = cache do isolate (10 s). A propagação global do
// KV é do provedor ("até 60 s ou mais", documentação Cloudflare) e NÃO é provada por este teste.
import { readSalesSwitch, resetSalesSwitchCache } from "../worker/sales-control.mjs";
test("SLA (parte do código): fechamento no KV é visto pelo isolate em ≤ 10 s; erro de leitura = fechado", async () => {
  resetSalesSwitchCache();
  const now0 = Date.now();
  const aberto = JSON.stringify({ enabled: true, authorization: "LIBERAR VENDAS", by: "lab-owner", at: new Date(now0 - 1000).toISOString(), ref: "lab-ref-001" });
  let valor = aberto;
  const kv = { get: async (k) => k === "sales:open:v1" ? valor : JSON.stringify({ ok: true, at: new Date(now0).toISOString() }) };
  assert.equal((await readSalesSwitch({ ZEVANORY_PRIVATE_ARTIFACTS: kv }, now0)).enabled, true);
  valor = JSON.stringify({ enabled: false });                       // proprietário fecha no instante now0
  assert.equal((await readSalesSwitch({ ZEVANORY_PRIVATE_ARTIFACTS: kv }, now0 + 9_999)).enabled, true, "janela de cache ainda vigente");
  assert.equal((await readSalesSwitch({ ZEVANORY_PRIVATE_ARTIFACTS: kv }, now0 + 10_000)).enabled, false, "≤ 10 s após o KV refletir");
  resetSalesSwitchCache();
  const quebrado = { get: async () => { throw new Error("kv_down"); } };
  assert.equal((await readSalesSwitch({ ZEVANORY_PRIVATE_ARTIFACTS: quebrado }, now0 + 20_000)).enabled, false);
  resetSalesSwitchCache();
});
