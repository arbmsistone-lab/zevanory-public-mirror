// B05 — autenticação, deduplicação e log estruturado do webhook Asaas (unidade).
import test from "node:test";
import assert from "node:assert/strict";
import {
  ASAAS_WEBHOOK_DEDUPE_PREFIX, ASAAS_WEBHOOK_REVIEW_PREFIX, asaasWebhookAlreadyProcessed, authorizeAsaasWebhook, classifyAsaasEventShape,
  extractAsaasPathSecret, logAsaasWebhook, markAsaasWebhookProcessed, queueAsaasWebhookReview,
  ASAAS_WEBHOOK_DLQ_PREFIX, asaasWebhookKvErrors, drainAsaasWebhookReview,
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
  assert.deepEqual(Object.keys(rec).sort(), ["attempts", "event", "event_id", "first_queued_ms", "order_id", "payment_id", "queued_at", "reason"]);
  assert.equal(rec.order_id, "0f8fad5b-d9cb-469f-a165-70867728950e");
  assert.equal(await queueAsaasWebhookReview(store, { eventId: "nao-e-evento" }), false);
});

// ---------- Sol AVAL 083: drenagem da fila de revisão e fila morta (DLQ) ----------
const fullKv = ({ failDelete = () => false, failList = false } = {}) => {
  const m = new Map();
  return { m, async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, String(v)); },
    async delete(k) { if (failDelete(k)) throw new Error("kv delete outage"); m.delete(k); },
    async list({ prefix = "" } = {}) { if (failList) throw new Error("kv list outage"); return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }; } };
};
const T0 = 1_800_000_000_000;
const queue = (store, id = "evt_early0001", extra = {}) => queueAsaasWebhookReview(store, { eventId: id, event: "PAYMENT_PARTIALLY_REFUNDED", paymentId: "pay_abcdef1", orderId: "0f8fad5b-d9cb-469f-a165-70867728950e", reason: "refund_before_payment_recorded", now: T0, ...extra });
const unresolved = async () => ({ status: 200, body: { accepted: true, ignored: true, reason: "refund_before_payment_recorded" } });
const quiet = { error() {}, info() {} };

test("W10 drenagem: quando a confirmação chegou, o replay aplica o estorno e o item SAI da fila", async () => {
  const store = fullKv();
  await queue(store);
  const seen = [];
  const out = await drainAsaasWebhookReview(store, { now: T0 + 60_000, logger: quiet, replay: async (rec) => { seen.push(rec); return { status: 200, body: { accepted: true, event: "refund_confirmed", duplicate: false } }; }, alert: async () => ({ sent: true }) });
  assert.deepEqual({ resolved: out.resolved, pending: out.pending, dlq: out.dead_lettered }, { resolved: 1, pending: 0, dlq: 0 });
  assert.equal(seen[0].event, "PAYMENT_PARTIALLY_REFUNDED", "replay leva o nome do evento original");
  assert.equal([...store.m.keys()].filter((k) => k.startsWith(ASAAS_WEBHOOK_REVIEW_PREFIX)).length, 0);
  // Idempotente: drenar de novo não faz nada.
  assert.equal((await drainAsaasWebhookReview(store, { now: T0, logger: quiet, replay: unresolved })).checked, 0);
});

test("W11 item preso: tentativas acumulam e, no limite, vai para a DLQ com UM alerta ao proprietário", async () => {
  const store = fullKv();
  await queue(store);
  const alerts = [];
  const alert = async (a) => { alerts.push(a); return { sent: true }; };
  for (let i = 1; i <= 5; i++) {
    const out = await drainAsaasWebhookReview(store, { now: T0 + i * 1000, maxAttempts: 6, logger: quiet, replay: unresolved, alert });
    assert.equal(out.pending, 1, `tentativa ${i}`);
    assert.equal(JSON.parse(store.m.get(ASAAS_WEBHOOK_REVIEW_PREFIX + "evt_early0001")).attempts, i);
  }
  const last = await drainAsaasWebhookReview(store, { now: T0 + 6000, maxAttempts: 6, logger: quiet, replay: unresolved, alert });
  assert.deepEqual({ dlq: last.dead_lettered, alerted: last.alerted, pending: last.pending }, { dlq: 1, alerted: 1, pending: 0 });
  const dlq = JSON.parse(store.m.get(ASAAS_WEBHOOK_DLQ_PREFIX + "evt_early0001"));
  assert.equal(dlq.cause, "max_attempts");
  assert.equal(dlq.attempts, 6);
  assert.equal(alerts.length, 1);
  assert.deepEqual(Object.keys(alerts[0]).sort(), ["attempts", "cause", "event_id", "order_id", "payment_id"]);
  assert.equal(store.m.has(ASAAS_WEBHOOK_REVIEW_PREFIX + "evt_early0001"), false);
});

test("W12 item velho (idade >= limite) vai para a DLQ mesmo com poucas tentativas", async () => {
  const store = fullKv();
  await queue(store);
  const out = await drainAsaasWebhookReview(store, { now: T0 + 72 * 3600 * 1000, logger: quiet, replay: unresolved, alert: async () => ({ sent: true }) });
  assert.equal(out.dead_lettered, 1);
  assert.equal(JSON.parse(store.m.get(ASAAS_WEBHOOK_DLQ_PREFIX + "evt_early0001")).cause, "max_age");
});

test("W13 idempotência: se a remoção da fila falhar após a DLQ, a próxima drenagem NÃO repete DLQ nem alerta", async () => {
  let failDel = true;
  const store = fullKv({ failDelete: () => failDel });
  await queue(store);
  const alerts = [];
  const opts = { now: T0 + 1000, maxAttempts: 1, logger: quiet, replay: unresolved, alert: async (a) => { alerts.push(a); return { sent: true }; } };
  const a = await drainAsaasWebhookReview(store, opts);
  assert.deepEqual({ dlq: a.dead_lettered, errors: a.errors }, { dlq: 1, errors: 1 });
  assert.equal(store.m.has(ASAAS_WEBHOOK_REVIEW_PREFIX + "evt_early0001"), true, "remoção falhou: item continua");
  failDel = false;
  const b = await drainAsaasWebhookReview(store, opts);
  assert.equal(b.dead_lettered, 0);
  assert.equal(alerts.length, 1, "um único alerta por item");
  assert.equal(store.m.has(ASAAS_WEBHOOK_REVIEW_PREFIX + "evt_early0001"), false);
});

test("W14 registro inválido ou replay que lança => DLQ (invalid_record) ou nova tentativa; falha de listagem é explícita", async () => {
  const store = fullKv();
  store.m.set(ASAAS_WEBHOOK_REVIEW_PREFIX + "evt_lixo00001", "{não json");
  const out = await drainAsaasWebhookReview(store, { now: T0, logger: quiet, replay: unresolved, alert: async () => ({ sent: false }) });
  assert.deepEqual({ dlq: out.dead_lettered, alerted: out.alerted }, { dlq: 1, alerted: 0 });
  assert.equal(JSON.parse(store.m.get(ASAAS_WEBHOOK_DLQ_PREFIX + "evt_lixo00001")).cause, "invalid_record");
  await queue(store, "evt_throws0001");
  const t = await drainAsaasWebhookReview(store, { now: T0, logger: quiet, replay: async () => { throw new Error("x"); }, alert: async () => ({ sent: true }) });
  assert.equal(t.pending, 1);
  const broken = await drainAsaasWebhookReview(fullKv({ failList: true }), { logger: quiet, replay: unresolved });
  assert.deepEqual({ list_failed: broken.list_failed, errors: broken.errors }, { list_failed: true, errors: 1 });
});

test("W15 falha do KV de deduplicação é logada e contada; leitura falha => segue ao banco (não marca duplicata)", async () => {
  const lines = [];
  const logger = { error: (t, j) => lines.push([t, JSON.parse(j)]) };
  const before = asaasWebhookKvErrors.dedupe_read;
  const bad = { async get() { throw new Error("down"); }, async put() { throw new Error("down"); } };
  assert.equal(await asaasWebhookAlreadyProcessed(bad, "evt_abcdef123", { logger }), false);
  assert.equal(await markAsaasWebhookProcessed(bad, "evt_abcdef123", "x", { logger }), false);
  assert.equal(asaasWebhookKvErrors.dedupe_read, before + 1);
  assert.deepEqual(lines.map(([t, j]) => [t, j.op]), [["asaas_webhook_kv_error", "dedupe_read"], ["asaas_webhook_kv_error", "dedupe_write"]]);
});
