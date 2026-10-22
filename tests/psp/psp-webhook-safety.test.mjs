// B05 — autenticação, deduplicação e log estruturado do webhook Asaas (unidade).
import test from "node:test";
import assert from "node:assert/strict";
import {
  ASAAS_WEBHOOK_DEDUPE_PREFIX, ASAAS_WEBHOOK_REVIEW_PREFIX, asaasWebhookAlreadyProcessed, authorizeAsaasWebhook, classifyAsaasEventShape,
  extractAsaasPathSecret, logAsaasWebhook, markAsaasWebhookProcessed, queueAsaasWebhookReview,
} from "../../worker/asaas-webhook-safety.mjs";

const PATH = "p".repeat(20) + "A1_-" + "q".repeat(20);
const TOKEN = "t".repeat(40) + "Z9";
const ENV = { ASAAS_WEBHOOK_PATH_SECRET: PATH, ASAAS_WEBHOOK_TOKEN: TOKEN };
const kv = () => { const m = new Map(); return { m, async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); } }; };

test("W01 caminho: só /api/webhooks/asaas/<32..128 [A-Za-z0-9_-]>", () => {
  assert.equal(extractAsaasPathSecret(`/api/webhooks/asaas/${PATH}`), PATH);
  assert.equal(extractAsaasPathSecret("/api/webhooks/asaas"), "");
  assert.equal(extractAsaasPathSecret("/api/webhooks/asaas/curto"), "");
  assert.equal(extractAsaasPathSecret(`/api/webhooks/asaas/${PATH}/x`), "");
  assert.equal(extractAsaasPathSecret(`/api/webhooks/asaas/${"a".repeat(129)}`), "");
  assert.equal(extractAsaasPathSecret(`/api/webhooks/asaas/${"a".repeat(31)}.`), "");
});

test("W02 segredo de caminho não configurado ou curto => 404 (rota não revelada)", () => {
  for (const env of [{ ASAAS_WEBHOOK_TOKEN: TOKEN }, { ...ENV, ASAAS_WEBHOOK_PATH_SECRET: "x".repeat(31) }]) {
    const r = authorizeAsaasWebhook({ env, pathSecret: PATH, token: TOKEN });
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
  }
});

test("W03 caminho errado => 404 mesmo com token certo; token nem é avaliado", () => {
  const r = authorizeAsaasWebhook({ env: ENV, pathSecret: PATH.slice(0, -1) + "x", token: TOKEN });
  assert.equal(r.status, 404);
  assert.equal(r.token_valid, false);
  assert.equal(authorizeAsaasWebhook({ env: ENV, pathSecret: "", token: TOKEN }).status, 404);
});

test("W04 caminho certo e token forjado/ausente/lista/curto => 401", () => {
  for (const token of [TOKEN.slice(0, -1) + "Y", "", undefined, [TOKEN, TOKEN], TOKEN + "x", TOKEN.slice(1)]) {
    const r = authorizeAsaasWebhook({ env: ENV, pathSecret: PATH, token });
    assert.equal(r.status, 401, String(token));
    assert.equal(r.path_valid, true);
    assert.equal(r.ok, false);
  }
  assert.equal(authorizeAsaasWebhook({ env: { ...ENV, ASAAS_WEBHOOK_TOKEN: "x".repeat(10) }, pathSecret: PATH, token: "x".repeat(10) }).status, 401, "token curto configurado não autentica");
});

test("W05 caminho e token certos => autorizado", () => {
  const r = authorizeAsaasWebhook({ env: ENV, pathSecret: PATH, token: TOKEN });
  assert.deepEqual({ ...r }, { ok: true, status: 200, reason: "authorized", path_valid: true, token_valid: true });
});

test("W06 forma do evento: suportado, conhecido-não-tratado (aceito sem efeito) e inválido", () => {
  assert.equal(classifyAsaasEventShape({ id: "evt_abcdef123", event: "PAYMENT_RECEIVED" }), "supported");
  assert.equal(classifyAsaasEventShape({ id: "evt_abcdef123", event: "PAYMENT_CREATED" }), "unsupported");
  assert.equal(classifyAsaasEventShape({ id: "evt_abcdef123", event: "CHECKOUT_PAID" }), "unsupported");
  assert.equal(classifyAsaasEventShape({ id: "x", event: "PAYMENT_RECEIVED" }), "invalid");
  assert.equal(classifyAsaasEventShape({ id: "evt_abcdef123", event: "payment_received" }), "invalid");
  assert.equal(classifyAsaasEventShape(null), "invalid");
});

test("W07 log estruturado: só campos autorizados, sem token, segredo, CPF ou corpo", () => {
  const lines = [];
  const logger = { info: (...a) => lines.push(a.join(" ")) };
  const entry = logAsaasWebhook(logger, { path_valid: true, token_valid: false, event_id: "evt_abcdef123", event: "PAYMENT_RECEIVED", outcome: "token_invalid", token: TOKEN, path: PATH, cpf: "52998224725", body: { x: 1 } });
  assert.deepEqual(Object.keys(entry).sort(), ["duplicate", "event", "event_id", "outcome", "path_valid", "token_valid"]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^asaas_webhook \{/);
  for (const secret of [TOKEN, PATH, "52998224725"]) assert.ok(!lines[0].includes(secret));
  const bad = logAsaasWebhook({ info() {} }, { event_id: "evt_x<script>", event: "drop table", outcome: "A B!" });
  assert.equal(bad.event_id, "");
  assert.equal(bad.event, "");
  assert.equal(bad.outcome, "");
});

test("W08 deduplicação por id do evento em KV (marca só id válido; TTL de 7 dias)", async () => {
  const store = kv();
  assert.equal(await asaasWebhookAlreadyProcessed(store, "evt_abcdef123"), false);
  assert.equal(await markAsaasWebhookProcessed(store, "evt_abcdef123", "payment_confirmed"), true);
  assert.equal(await asaasWebhookAlreadyProcessed(store, "evt_abcdef123"), true);
  assert.equal(await asaasWebhookAlreadyProcessed(store, "evt_outro12345"), false);
  assert.equal(await markAsaasWebhookProcessed(store, "../../x", "y"), false);
  assert.ok(store.m.has(ASAAS_WEBHOOK_DEDUPE_PREFIX + "evt_abcdef123"));
  assert.equal(await asaasWebhookAlreadyProcessed(null, "evt_abcdef123"), false);
});

test("W09 fila de revisão guarda só identificadores", async () => {
  const store = kv();
  assert.equal(await queueAsaasWebhookReview(store, { eventId: "evt_abcdef123", paymentId: "pay_abcdef1", orderId: "0F8FAD5B-D9CB-469F-A165-70867728950E", reason: "refund_before_payment_recorded" }), true);
  const rec = JSON.parse(store.m.get(ASAAS_WEBHOOK_REVIEW_PREFIX + "evt_abcdef123"));
  assert.deepEqual(Object.keys(rec).sort(), ["event_id", "order_id", "payment_id", "queued_at", "reason"]);
  assert.equal(rec.order_id, "0f8fad5b-d9cb-469f-a165-70867728950e");
  assert.equal(await queueAsaasWebhookReview(store, { eventId: "nao-e-evento" }), false);
});
