import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mercadoPagoExpiryWindow, MERCADOPAGO_PREFERENCE_TTL_MS } from "../worker/payment-link-expiry.mjs";

// Trava comercial: link de pagamento do Mercado Pago não pode ficar pagável indefinidamente.
const NOW = Date.parse("2026-10-20T16:00:00.000Z");

test("janela expira em 24 h, formato aceito pelo provedor", () => {
  const w = mercadoPagoExpiryWindow(NOW);
  assert.equal(w.expires, true);
  assert.equal(MERCADOPAGO_PREFERENCE_TTL_MS, 24 * 3600 * 1000);
  assert.equal(Date.parse(w.expiration_date_to) - NOW, MERCADOPAGO_PREFERENCE_TTL_MS);
  assert.ok(Date.parse(w.expiration_date_from) < NOW);
  assert.equal(w.date_of_expiration, w.expiration_date_to);
  assert.match(w.expiration_date_to, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00$/);
});

test("relógio inválido ou ausente nunca gera link sem expiração", () => {
  for (const v of [undefined, null, "x", NaN]) {
    const before = Date.now(), w = mercadoPagoExpiryWindow(v), to = Date.parse(w.expiration_date_to);
    assert.equal(w.expires, true, String(v));
    assert.ok(to >= before + MERCADOPAGO_PREFERENCE_TTL_MS - 5000 && to <= Date.now() + MERCADOPAGO_PREFERENCE_TTL_MS + 5000, String(v));
  }
});

test("a única preferência do Mercado Pago no Worker usa a janela de expiração", () => {
  const src = readFileSync(new URL("../worker/cloudflare-worker.recovered.mjs", import.meta.url), "utf8");
  assert.match(src, /import \{ mercadoPagoExpiryWindow \} from "\.\/payment-link-expiry\.mjs";/);
  const start = src.indexOf("function buildMercadoPagoPreference(");
  const end = src.indexOf("__name(buildMercadoPagoPreference", start);
  assert.ok(start > 0 && end > start);
  assert.match(src.slice(start, end), /\.\.\.mercadoPagoExpiryWindow\(options\.now\)/);
  assert.equal((src.match(/function buildMercadoPagoPreference\(/g) || []).length, 1);
});
