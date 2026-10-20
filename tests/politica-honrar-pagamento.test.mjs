import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// POLÍTICA DO PROPRIETÁRIO (20/10/2026 13:54 BRT): pagamento aprovado de link emitido antes do
// fechamento DEVE SER HONRADO (pedido vira pago e o produto é entregue). A trava de vendas impede
// NOVAS cobranças e invalida links pendentes no provedor; ela nunca recusa quem já pagou.
const src = readFileSync(new URL("../worker/cloudflare-worker.recovered.mjs", import.meta.url), "utf8");
const ini = src.indexOf("async function handleMercadoPagoWebhook(");
const fim = src.indexOf("__name(handleMercadoPagoWebhook", ini);
const webhook = src.slice(ini, fim);

test("webhook do Mercado Pago não consulta o interruptor de vendas (honra pagamento já feito)", () => {
  assert.ok(ini > 0 && fim > ini, "handler localizado");
  for (const proibido of ["__ZEVANORY_SALES_SWITCH__", "salesGate(", "SALE_GLOBALLY_ENABLED", "readSalesSwitch"]) {
    assert.equal(webhook.includes(proibido), false, `webhook não pode depender de ${proibido}`);
  }
});

test("pagamento confirmado leva checkout_ready a pago e aciona a entrega digital", () => {
  assert.match(webhook, /payment_confirmed' AND status IN \('checkout_ready','checkout_uncertain','paid'\)/);
  assert.match(webhook, /WHEN i\.normalized_event='payment_confirmed' THEN 'paid'/);
  assert.match(webhook, /ensureMercadoPagoDigitalDelivery\(/);
});
