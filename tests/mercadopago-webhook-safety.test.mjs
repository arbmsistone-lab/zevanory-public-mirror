import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MERCADOPAGO_PRODUCTION_APPLICATION_ID,
  MERCADOPAGO_WEBHOOK_PROOF_KEY,
  MERCADOPAGO_WEBHOOK_RECOVERY_PREFIX,
  drainMercadoPagoWebhookRecovery,
  recordMercadoPagoWebhookSignature,
} from "../worker/mercadopago-webhook-safety.mjs";

function fakeKv() {
  const values = new Map();
  return {
    values,
    get: async (key) => values.get(key) ?? null,
    put: async (key, value) => values.set(key, value),
    delete: async (key) => values.delete(key),
    list: async ({ prefix, limit = 100 }) => ({ keys: [...values.keys()].filter((key) => key.startsWith(prefix)).slice(0, limit).map((name) => ({ name })) }),
  };
}

test("valid production signature stores only safe proof for the ZEVANORY app", async () => {
  const kv = fakeKv();
  const logs = [];
  const out = await recordMercadoPagoWebhookSignature({ ZEVANORY_PRIVATE_ARTIFACTS: kv }, {
    signatureValid: true,
    requestId: "request-safe-1",
    paymentId: "123456789",
    now: () => new Date("2026-10-07T19:00:00.000Z"),
    logger: { info: (...args) => logs.push(args) },
  });
  assert.equal(out.preserved, true);
  assert.equal(logs.length, 1);
  assert.deepEqual(JSON.parse(logs[0][1]), { signature_valid: true, x_request_id: "request-safe-1" });
  const proof = JSON.parse(await kv.get(MERCADOPAGO_WEBHOOK_PROOF_KEY));
  assert.equal(proof.applicationId, MERCADOPAGO_PRODUCTION_APPLICATION_ID);
  assert.equal(proof.signature_valid, true);
  assert.equal([...kv.values.keys()].some((key) => key.startsWith(MERCADOPAGO_WEBHOOK_RECOVERY_PREFIX)), false);
});

test("invalid production signature alerts and queues provider-truth recovery without logging payment data", async () => {
  const kv = fakeKv();
  const logs = [];
  let alert = null;
  const out = await recordMercadoPagoWebhookSignature({ ZEVANORY_PRIVATE_ARTIFACTS: kv }, {
    signatureValid: false,
    requestId: "request-safe-2",
    paymentId: "987654321",
    alert: async (_env, input) => { alert = input; return { sent: true }; },
    logger: { info: (...args) => logs.push(args) },
  });
  assert.deepEqual(JSON.parse(logs[0][1]), { signature_valid: false, x_request_id: "request-safe-2" });
  assert.doesNotMatch(logs.flat().join(" "), /987654321/);
  assert.equal(out.preserved, true);
  assert.equal(out.alerted, true);
  assert.match(alert.reason, /reconcilia/i);
  assert.ok(await kv.get(`${MERCADOPAGO_WEBHOOK_RECOVERY_PREFIX}987654321`));
});

test("invalid signature reports unavailable recovery storage without claiming preservation", async () => {
  let alert = null;
  const out = await recordMercadoPagoWebhookSignature({}, {
    signatureValid: false,
    requestId: "request-safe-3",
    paymentId: "987654322",
    alert: async (_env, input) => { alert = input; return { sent: true }; },
    logger: { info() {} },
  });
  assert.equal(out.preserved, false);
  assert.equal(out.alerted, true);
  assert.match(alert.reason, /indisponível/i);
});

test("watchdog drains only reconciled provider payments and leaves pending ones", async () => {
  const kv = fakeKv();
  await kv.put(`${MERCADOPAGO_WEBHOOK_RECOVERY_PREFIX}11111111`, JSON.stringify({ paymentId: "11111111" }));
  await kv.put(`${MERCADOPAGO_WEBHOOK_RECOVERY_PREFIX}22222222`, JSON.stringify({ paymentId: "22222222" }));
  const seen = [];
  const out = await drainMercadoPagoWebhookRecovery({ ZEVANORY_PRIVATE_ARTIFACTS: kv }, async (paymentId) => {
    seen.push(paymentId);
    return { completed: paymentId === "11111111" };
  });
  assert.deepEqual(seen, ["11111111", "22222222"]);
  assert.deepEqual(out, { checked: 2, recovered: 1, pending: 1 });
  assert.equal(await kv.get(`${MERCADOPAGO_WEBHOOK_RECOVERY_PREFIX}11111111`), null);
  assert.ok(await kv.get(`${MERCADOPAGO_WEBHOOK_RECOVERY_PREFIX}22222222`));
});

test("real worker wires invalid-signature preservation and trusted watchdog reconciliation", () => {
  const source = readFileSync(new URL("../worker/cloudflare-worker.recovered.mjs", import.meta.url), "utf8");
  assert.match(source, /recordMercadoPagoWebhookSignature\(safetyEnv/);
  assert.match(source, /drainMercadoPagoWebhookRecovery/);
  assert.match(source, /source: "mercadopago-watchdog", trustedRecovery: true/);
  assert.match(source, /fetchMercadoPagoPayment\(webhook\.paymentId, accessToken/);
  assert.match(source, /ensureMercadoPagoDigitalDelivery\(sql/);
});
