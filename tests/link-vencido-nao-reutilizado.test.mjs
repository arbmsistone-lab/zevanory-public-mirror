import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInboundLifecycle, resetInboundMemoForTest } from "../worker/inbound-autonomy.mjs";

// Achado da revisão do GitHub Copilot no #838: a expiração de 24 h da preferência Mercado Pago precisa ser
// respeitada por quem REUTILIZA links guardados (replay do checkout e e-mail de carrinho).
const SRC = readFileSync(new URL("../worker/cloudflare-worker.recovered.mjs", import.meta.url), "utf8");
const ini = SRC.indexOf("var MERCADOPAGO_REUSE_MAX_AGE_MS");
const fim = SRC.indexOf('__name(checkoutReplayDecision, "checkoutReplayDecision");');
const decide = new Function("__name", SRC.slice(ini, fim) + "\nreturn checkoutReplayDecision;")((f) => f);
const S = "11111111-1111-4111-8111-111111111111";
const pedido = (horas, provider = "mercadopago") => ({ session_id: S, offer_id: "ZEV-1", status: "checkout_ready", checkout_url: "https://www.mercadopago.com.br/checkout/x", provider,
  updated_at: new Date(Date.now() - horas * 3600 * 1000).toISOString() });

test("replay: link Mercado Pago com menos de 23 h é reutilizado", () => {
  assert.equal(decide(pedido(2), S, "ZEV-1").action, "reuse");
});
test("replay: link Mercado Pago com 23 h ou mais NÃO é devolvido (expirado no provedor)", () => {
  for (const h of [23, 30, 72]) assert.deepEqual({ ...decide(pedido(h), S, "ZEV-1") }, { action: "expired", status: "checkout_expired" }, String(h));
});
test("replay: data ausente ou inválida em pedido Mercado Pago = expirado (fail-closed)", () => {
  assert.equal(decide({ ...pedido(1), updated_at: null }, S, "ZEV-1").action, "expired");
  assert.equal(decide({ ...pedido(1), updated_at: "lixo" }, S, "ZEV-1").action, "expired");
  assert.equal(decide({ ...pedido(-2) }, S, "ZEV-1").action, "expired", "data no futuro");
});
test("replay: outros provedores mantêm o comportamento anterior", () => {
  assert.equal(decide(pedido(72, "asaas"), S, "ZEV-1").action, "reuse");
});
test("carrinho abandonado: só links com menos de 23 h entram na consulta", async () => {
  resetInboundMemoForTest(); const qs = [];
  await runInboundLifecycle({ DATABASE_URL: "db", RESEND_API_KEY: "k", RESEND_FROM_ADDRESS: "Z <c@z.com>" },
    { salesOpen: true, sqlFactory: () => ({ query: async (q) => { qs.push(q); return []; } }), fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  const carrinho = qs.find((q) => q.includes("o.status='checkout_ready'"));
  assert.ok(carrinho, "consulta do carrinho executada");
  assert.match(carrinho, /o\.updated_at>now\(\)-interval '23 hours'/);
  assert.doesNotMatch(carrinho, /7 days/);
});
