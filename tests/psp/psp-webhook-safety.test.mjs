// B05 — autenticação, deduplicação e log estruturado do webhook Asaas (unidade).
import test from "node:test";
import assert from "node:assert/strict";
import {
  ASAAS_WEBHOOK_DEDUPE_PREFIX, ASAAS_WEBHOOK_REVIEW_PREFIX, asaasWebhookAlreadyProcessed, authorizeAsaasWebhook, classifyAsaasEventShape,
  extractAsaasPathSecret, logAsaasWebhook, markAsaasWebhookProcessed, queueAsaasWebhookReview,
  ASAAS_WEBHOOK_DLQ_PREFIX, asaasWebhookKvErrors, drainAsaasWebhookReview,
  ASAAS_WEBHOOK_DLQ_ALERT_PREFIX, DLQ_ALERT_DEFAULTS, createMemoryDlqAlertLedger, dlqAlertBackoffMs, dlqAlertIdempotencyKey,
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
  assert.deepEqual(Object.keys(alerts[0]).sort(), ["attempts", "cause", "event_id", "idempotency_key", "order_id", "payment_id"]);
  assert.equal(alerts[0].idempotency_key, "asaas-dlq-alert-v1-evt_early0001");
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
  const store = fullKv({ failDelete: (k) => failDel && k.startsWith(ASAAS_WEBHOOK_REVIEW_PREFIX) });
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

// ---------- Sol, bloqueio #879-1: alerta da DLQ nunca se perde (pendência persistida + reenvio idempotente) ----------
const dlqAlertMarker = (store, id = "evt_early0001") => JSON.parse(store.m.get(ASAAS_WEBHOOK_DLQ_ALERT_PREFIX + id) || "null");
const dlqRecord = (store, id = "evt_early0001") => JSON.parse(store.m.get(ASAAS_WEBHOOK_DLQ_PREFIX + id) || "null");
// Provedor de e-mail falso com a semântica do Resend: mesma chave de idempotência => um único e-mail entregue.
function mailer({ failFirst = 0 } = {}) {
  const m = { calls: [], delivered: new Map(), failures: failFirst };
  m.alert = async (a) => {
    m.calls.push(a);
    await new Promise((r) => setImmediate(r));
    if (m.failures > 0) { m.failures -= 1; return { sent: false, reason: "provider_503" }; }
    if (!m.delivered.has(a.idempotency_key || `nokey-${m.calls.length}`)) m.delivered.set(a.idempotency_key || `nokey-${m.calls.length}`, a);
    return { sent: true };
  };
  m.deliveredCount = () => m.delivered.size;
  return m;
}

test("W16 repro Sol #879: envio do alerta FALHA ao ir para a DLQ => pendência persistida; a drenagem seguinte entrega UM alerta", async () => {
  const store = fullKv();
  await queue(store);
  const mail = mailer({ failFirst: 1 });
  const lines = [];
  const logger = { error: (t, j) => lines.push([t, JSON.parse(j)]), info() {} };
  const a = await drainAsaasWebhookReview(store, { now: T0 + 1000, maxAttempts: 1, logger, replay: unresolved, alert: mail.alert });
  assert.deepEqual({ dlq: a.dead_lettered, alerted: a.alerted, alert_failed: a.alert_failed }, { dlq: 1, alerted: 0, alert_failed: 1 });
  assert.equal(store.m.has(ASAAS_WEBHOOK_REVIEW_PREFIX + "evt_early0001"), false, "item saiu da fila");
  assert.equal(dlqRecord(store).alert.state, "pending", "DLQ registra o alerta pendente");
  const marker = dlqAlertMarker(store);
  assert.equal(marker.state, "pending");
  assert.equal(marker.alert_attempts, 1);
  assert.equal(marker.next_ms, T0 + 1000 + DLQ_ALERT_DEFAULTS.baseBackoffMs, "recuo de 5 min");
  assert.ok(lines.some(([t, j]) => t === "asaas_webhook_dlq_alert_failed" && j.event_id === "evt_early0001" && j.alert_attempts === 1), "falha logada");
  // Antes do recuo vencer: nada é reenviado.
  const early = await drainAsaasWebhookReview(store, { now: T0 + 2000, logger: quiet, replay: unresolved, alert: mail.alert });
  assert.deepEqual({ checked: early.checked, alerted: early.alerted, waiting: early.alert_waiting }, { checked: 0, alerted: 0, waiting: 1 });
  assert.equal(mail.calls.length, 1);
  // Recuo vencido: a drenagem seguinte ENTREGA (era o defeito: checked=0 e nunca mais alertava).
  const b = await drainAsaasWebhookReview(store, { now: T0 + 1000 + DLQ_ALERT_DEFAULTS.baseBackoffMs, logger: quiet, replay: unresolved, alert: mail.alert });
  assert.deepEqual({ checked: b.checked, alerted: b.alerted }, { checked: 0, alerted: 1 });
  assert.equal(mail.deliveredCount(), 1);
  assert.equal(mail.calls[1].idempotency_key, mail.calls[0].idempotency_key, "mesma chave de idempotência em toda tentativa");
  assert.equal(dlqRecord(store).alert.state, "sent");
  assert.equal(dlqAlertMarker(store), null, "pendência removida depois da entrega");
  // Depois do sucesso: nunca reenvia.
  for (let i = 1; i <= 3; i++) {
    const c = await drainAsaasWebhookReview(store, { now: T0 + 10 * 3600 * 1000 * i, logger: quiet, replay: unresolved, alert: mail.alert });
    assert.equal(c.alerted, 0);
  }
  assert.equal(mail.calls.length, 2);
  assert.equal(mail.deliveredCount(), 1);
});

test("W17 alerta entregue na 1ª vez => nenhum reenvio, nenhuma pendência", async () => {
  const store = fullKv();
  await queue(store);
  const mail = mailer();
  const a = await drainAsaasWebhookReview(store, { now: T0, maxAttempts: 1, logger: quiet, replay: unresolved, alert: mail.alert });
  assert.equal(a.alerted, 1);
  assert.equal(dlqAlertMarker(store), null);
  assert.equal(dlqRecord(store).alert.state, "sent");
  for (let i = 1; i <= 4; i++) await drainAsaasWebhookReview(store, { now: T0 + i * 24 * 3600 * 1000, logger: quiet, replay: unresolved, alert: mail.alert });
  assert.equal(mail.calls.length, 1);
});

test("W18 recuo exponencial limitado; tentativas esgotadas => 'exhausted', log de erro e contador (nunca silencioso)", async () => {
  assert.deepEqual([1, 2, 3, 4, 7, 8, 20].map((n) => dlqAlertBackoffMs(n)), [300_000, 600_000, 1_200_000, 2_400_000, 19_200_000, 21_600_000, 21_600_000]);
  const store = fullKv();
  await queue(store);
  const lines = [];
  const logger = { error: (t, j) => lines.push([t, JSON.parse(j)]), info() {} };
  const mail = mailer({ failFirst: 100 });
  let t = T0;
  const first = await drainAsaasWebhookReview(store, { now: t, maxAttempts: 1, alertMaxAttempts: 3, logger, replay: unresolved, alert: mail.alert });
  assert.equal(first.alert_failed, 1);
  t += dlqAlertBackoffMs(1);
  const second = await drainAsaasWebhookReview(store, { now: t, alertMaxAttempts: 3, logger, replay: unresolved, alert: mail.alert });
  assert.equal(second.alert_failed, 1);
  t += dlqAlertBackoffMs(2);
  const third = await drainAsaasWebhookReview(store, { now: t, alertMaxAttempts: 3, logger, replay: unresolved, alert: mail.alert });
  assert.deepEqual({ failed: third.alert_failed, exhausted: third.alert_exhausted }, { failed: 1, exhausted: 1 });
  assert.equal(dlqRecord(store).alert.state, "exhausted");
  assert.equal(dlqAlertMarker(store), null);
  assert.ok(lines.some(([tag, j]) => tag === "asaas_webhook_dlq_alert_exhausted" && j.alert_attempts === 3));
  await drainAsaasWebhookReview(store, { now: t + 10 * 3600 * 1000, alertMaxAttempts: 3, logger, replay: unresolved, alert: mail.alert });
  assert.equal(mail.calls.length, 3, "limitado: nenhuma 4ª tentativa");
});

test("W19 drenagens CONCORRENTES com o livro-razão: exatamente UM envio (inclusive depois de falha e recuperação)", async () => {
  const store = fullKv();
  await queue(store);
  let t = T0;
  const ledger = createMemoryDlqAlertLedger({ now: () => t });
  const mail = mailer({ failFirst: 1 });
  const first = await Promise.all(Array.from({ length: 5 }, (_, i) => drainAsaasWebhookReview(store, { now: t, maxAttempts: 1, logger: quiet, replay: unresolved, alert: mail.alert, alertLedger: ledger, owner: `drain-${i}` })));
  assert.equal(first.reduce((n, o) => n + o.alerted, 0), 0);
  assert.equal(mail.calls.length, 1, "uma só tentativa (falhou) entre 5 drenagens concorrentes");
  t += DLQ_ALERT_DEFAULTS.baseBackoffMs;
  const second = await Promise.all(Array.from({ length: 6 }, (_, i) => drainAsaasWebhookReview(store, { now: t, logger: quiet, replay: unresolved, alert: mail.alert, alertLedger: ledger, owner: `drain-b${i}` })));
  assert.equal(second.reduce((n, o) => n + o.alerted, 0), 1, JSON.stringify(second));
  assert.equal(mail.calls.length, 2, "exatamente um envio depois da recuperação");
  assert.equal(ledger.rows.get(dlqAlertIdempotencyKey("evt_early0001")).state, "sent");
  t += 24 * 3600 * 1000;
  await Promise.all(Array.from({ length: 4 }, (_, i) => drainAsaasWebhookReview(store, { now: t, logger: quiet, replay: unresolved, alert: mail.alert, alertLedger: ledger, owner: `drain-c${i}` })));
  assert.equal(mail.calls.length, 2);
});

test("W20 enviado mas o registro falhou (KV fora ao remover a pendência): livro-razão diz 'sent' => nunca reenvia", async () => {
  let failMarkerDelete = true;
  let failMarkerPut = true;
  const store = fullKv({ failDelete: (k) => failMarkerDelete && k.startsWith(ASAAS_WEBHOOK_DLQ_ALERT_PREFIX) });
  const put = store.put;
  store.put = async (k, v, o) => { if (failMarkerPut && k.startsWith(ASAAS_WEBHOOK_DLQ_ALERT_PREFIX) && String(v).includes('"state":"sent"')) throw new Error("kv put outage"); return put.call(store, k, v, o); };
  await queue(store);
  let t = T0;
  const ledger = createMemoryDlqAlertLedger({ now: () => t });
  const mail = mailer();
  const a = await drainAsaasWebhookReview(store, { now: t, maxAttempts: 1, logger: quiet, replay: unresolved, alert: mail.alert, alertLedger: ledger, owner: "d1" });
  assert.equal(a.alerted, 1);
  assert.equal(dlqAlertMarker(store).state, "pending", "pendência ficou para trás (falha de KV simulada)");
  failMarkerDelete = false; failMarkerPut = false;
  t += 7 * 24 * 3600 * 1000;
  const b = await drainAsaasWebhookReview(store, { now: t, logger: quiet, replay: unresolved, alert: mail.alert, alertLedger: ledger, owner: "d2" });
  assert.equal(b.alerted, 0);
  assert.equal(mail.calls.length, 1, "nenhum segundo envio");
  assert.equal(dlqAlertMarker(store), null, "pendência fechada pelo estado do livro-razão");
});

test("W21 livro-razão indisponível => nada é enviado às cegas pela reivindicação, erro contado; pendência continua para a próxima", async () => {
  const store = fullKv();
  await queue(store);
  const lines = [];
  const logger = { error: (t, j) => lines.push([t, JSON.parse(j)]), info() {} };
  const mail = mailer();
  const broken = { async claim() { throw new Error("db down"); }, async markSent() {}, async markFailed() {} };
  const a = await drainAsaasWebhookReview(store, { now: T0, maxAttempts: 1, logger, replay: unresolved, alert: mail.alert, alertLedger: broken });
  assert.deepEqual({ dlq: a.dead_lettered, alerted: a.alerted, alert_errors: a.alert_errors }, { dlq: 1, alerted: 0, alert_errors: 1 });
  assert.equal(mail.calls.length, 0);
  assert.equal(dlqAlertMarker(store).state, "pending");
  assert.ok(lines.some(([t]) => t === "asaas_webhook_dlq_alert_ledger_error"));
  const ok = await drainAsaasWebhookReview(store, { now: T0 + 1, logger: quiet, replay: unresolved, alert: mail.alert, alertLedger: createMemoryDlqAlertLedger({ now: () => T0 + 1 }) });
  assert.equal(ok.alerted, 1);
  assert.equal(mail.calls.length, 1);
});
