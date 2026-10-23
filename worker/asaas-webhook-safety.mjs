// B05 — endurecimento do webhook Asaas.
//
// O Asaas autentica o webhook só com token estático no cabeçalho `asaas-access-token` (32–255 caracteres),
// entrega "at least once" e pausa a fila depois de 15 falhas consecutivas
// (https://docs.asaas.com/docs/receba-eventos-do-asaas-no-seu-endpoint-de-webhook). Não há HMAC. Defesa em camadas:
//   1. segmento secreto no caminho registrado (/api/webhooks/asaas/<ASAAS_WEBHOOK_PATH_SECRET>) — ausente/errado => 404;
//   2. token comparado em tempo constante e independente do comprimento — errado => 401;
//   3. o corpo NUNCA é fonte da verdade: o handler re-consulta GET /v3/payments/{id} com a API key (já existente);
//   4. deduplicação pelo id do evento (KV) antes da re-consulta, além do ON CONFLICT no banco;
//   5. log estruturado só com campos autorizados (sem token, sem segredo, sem CPF, sem corpo).
import { constantTimeEqual } from "./psp-failover.mjs";

export const ASAAS_WEBHOOK_PATH_RE = /^\/api\/webhooks\/asaas\/([A-Za-z0-9_-]{32,128})$/;
export const ASAAS_WEBHOOK_DEDUPE_PREFIX = "asaas:webhook:done:v1:";
export const ASAAS_WEBHOOK_REVIEW_PREFIX = "asaas:webhook:review:v1:";
export const ASAAS_SUPPORTED_EVENTS = Object.freeze(["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED", "PAYMENT_REFUNDED", "PAYMENT_PARTIALLY_REFUNDED"]);
const MIN_SECRET = 32;
const EVENT_ID_RE = /^evt_[A-Za-z0-9_&.-]{6,120}$/;

export function extractAsaasPathSecret(pathname) {
  const m = String(pathname || "").match(ASAAS_WEBHOOK_PATH_RE);
  return m ? m[1] : "";
}

export function authorizeAsaasWebhook({ env = {}, pathSecret = "", token = "" } = {}) {
  const expectedPath = String(env.ASAAS_WEBHOOK_PATH_SECRET || "");
  const expectedToken = String(env.ASAAS_WEBHOOK_TOKEN || "");
  if (expectedPath.length < MIN_SECRET) return Object.freeze({ ok: false, status: 404, reason: "path_secret_unconfigured", path_valid: false, token_valid: false });
  const pathValid = constantTimeEqual(expectedPath, String(pathSecret || ""));
  if (!pathValid) return Object.freeze({ ok: false, status: 404, reason: "path_secret_invalid", path_valid: false, token_valid: false });
  if (expectedToken.length < MIN_SECRET) return Object.freeze({ ok: false, status: 401, reason: "token_unconfigured", path_valid: true, token_valid: false });
  const tokenValid = constantTimeEqual(expectedToken, Array.isArray(token) ? "" : String(token || ""));
  if (!tokenValid) return Object.freeze({ ok: false, status: 401, reason: "token_invalid", path_valid: true, token_valid: false });
  return Object.freeze({ ok: true, status: 200, reason: "authorized", path_valid: true, token_valid: true });
}

export function classifyAsaasEventShape(body) {
  if (!body || typeof body !== "object") return "invalid";
  const event = String(body.event || "");
  if (!EVENT_ID_RE.test(String(body.id || "")) || !/^[A-Z][A-Z_]{2,63}$/.test(event)) return "invalid";
  return ASAAS_SUPPORTED_EVENTS.includes(event) ? "supported" : "unsupported";
}

const cleanEventId = (v) => (EVENT_ID_RE.test(String(v || "")) ? String(v) : "");
const cleanEvent = (v) => (/^[A-Z][A-Z_]{2,63}$/.test(String(v || "")) ? String(v) : "");

export function logAsaasWebhook(logger = console, fields = {}) {
  const entry = {
    path_valid: fields.path_valid === true,
    token_valid: fields.token_valid === true,
    event_id: cleanEventId(fields.event_id),
    event: cleanEvent(fields.event),
    outcome: String(fields.outcome || "").replace(/[^a-z0-9_]/g, "").slice(0, 60),
    duplicate: fields.duplicate === true,
  };
  try { logger.info("asaas_webhook", JSON.stringify(entry)); } catch {}
  return entry;
}

// Erros do KV de deduplicação não são engolidos: logados (`asaas_webhook_kv_error`) e contados. Semântica: leitura
// falhou => "não sei se já processei" => segue para a re-consulta e o ON CONFLICT do banco (nunca efeito duplo).
export const asaasWebhookKvErrors = { dedupe_read: 0, dedupe_write: 0, review: 0 };
function kvError(op, error, logger = console) {
  asaasWebhookKvErrors[op] = (asaasWebhookKvErrors[op] || 0) + 1;
  try { logger.error("asaas_webhook_kv_error", JSON.stringify({ op, error: String(error?.name || "Error").slice(0, 40), count: asaasWebhookKvErrors[op] })); } catch {}
}

export async function asaasWebhookAlreadyProcessed(kv, eventId, { logger = console } = {}) {
  const id = cleanEventId(eventId);
  if (!id || !kv?.get) return false;
  try { return Boolean(await kv.get(ASAAS_WEBHOOK_DEDUPE_PREFIX + id)); } catch (error) { kvError("dedupe_read", error, logger); return false; }
}

export async function markAsaasWebhookProcessed(kv, eventId, outcome = "processed", { logger = console } = {}) {
  const id = cleanEventId(eventId);
  if (!id || !kv?.put) return false;
  try {
    await kv.put(ASAAS_WEBHOOK_DEDUPE_PREFIX + id, JSON.stringify({ outcome: String(outcome).slice(0, 60), at: new Date().toISOString() }), { expirationTtl: 7 * 24 * 3600 });
    return true;
  } catch (error) { kvError("dedupe_write", error, logger); return false; }
}

// Fila de revisão em KV privada (mesmo padrão de mercadopago-webhook-safety.mjs): casos aceitos sem efeito
// financeiro que exigem reconciliação humana/automática. Só identificadores, nunca dados pessoais.
export async function queueAsaasWebhookReview(kv, { eventId, event, paymentId, orderId, reason, now = Date.now() } = {}) {
  const id = cleanEventId(eventId);
  if (!id || !kv?.put) return false;
  // Reentrega do mesmo evento: mantém tentativas e data de entrada (a idade conta desde a 1ª vez).
  let prior = null;
  try { prior = JSON.parse(String((await kv.get?.(ASAAS_WEBHOOK_REVIEW_PREFIX + id)) || "null")); } catch { prior = null; }
  const record = {
    event_id: id,
    event: ASAAS_SUPPORTED_EVENTS.includes(String(event || "")) ? String(event) : "",
    attempts: Number.isInteger(prior?.attempts) ? prior.attempts : 0,
    first_queued_ms: Number.isFinite(prior?.first_queued_ms) ? prior.first_queued_ms : Number(now),
    payment_id: /^pay_[A-Za-z0-9_-]{6,120}$/.test(String(paymentId || "")) ? String(paymentId) : "",
    order_id: /^[0-9a-f-]{36}$/i.test(String(orderId || "")) ? String(orderId).toLowerCase() : "",
    reason: String(reason || "").replace(/[^a-z0-9_]/g, "").slice(0, 80),
    queued_at: new Date().toISOString(),
  };
  try {
    await kv.put(ASAAS_WEBHOOK_REVIEW_PREFIX + id, JSON.stringify(record), { expirationTtl: 30 * 24 * 3600 });
    return true;
  } catch (error) { kvError("review", error); return false; }
}

// Drenagem da fila de revisão (Sol AVAL 083). Cada item é REPROCESSADO pelo próprio handler do webhook
// (replay: só ids; a verdade continua vindo da re-consulta ao Asaas):
//  * estorno aplicado (event refund_confirmed, novo ou já gravado) ou parcial superado => resolvido, sai da fila;
//  * qualquer outra resposta => tentativa++; ao atingir maxAttempts OU maxAgeMs => fila morta (DLQ, 90 dias) +
//    alerta ao proprietário.
// Alerta da DLQ (Sol, bloqueio #879-1: falha no envio + item removido da fila = alerta perdido para sempre):
//  * ANTES de remover o item da fila grava-se a pendência do alerta (marcador asaas:webhook:dlq-alert:v1:<id>, que só
//    existe enquanto o alerta não foi entregue) e o estado alert.state="pending" no registro da DLQ;
//  * toda drenagem também percorre os marcadores pendentes e reenvia os vencidos, com recuo exponencial
//    (5 min, 10 min, ... até 6 h) e no máximo DLQ_ALERT_DEFAULTS.maxAttempts tentativas; esgotado => estado
//    "exhausted", log de erro e contador (nunca silencioso);
//  * exatamente UM alerta entregue: com o livro-razão PostgreSQL (asaas_dlq_alerts, db/b05/asaas_dlq_alerts.sql) só
//    quem ganha a reivindicação (UPDATE ... WHERE pending AND vencido AND sem reivindicação viva) envia; enviado =>
//    "sent" e nunca mais é reivindicado. Toda tentativa leva a MESMA chave de idempotência
//    (asaas-dlq-alert-v1-<id>), repassada ao provedor de e-mail: queda depois do envio e antes do registro não gera
//    segundo e-mail. Sem banco (só KV) a exclusão entre drenagens concorrentes fica com a chave de idempotência.
export const ASAAS_WEBHOOK_DLQ_PREFIX = "asaas:webhook:dlq:v1:";
export const ASAAS_WEBHOOK_DLQ_ALERT_PREFIX = "asaas:webhook:dlq-alert:v1:";
export const REVIEW_DEFAULTS = Object.freeze({ maxAttempts: 6, maxAgeMs: 72 * 3600 * 1000, limit: 25 });
export const DLQ_ALERT_DEFAULTS = Object.freeze({ maxAttempts: 10, baseBackoffMs: 5 * 60 * 1000, maxBackoffMs: 6 * 3600 * 1000, claimMs: 120_000, sendTimeoutMs: 30_000 });
const DLQ_TTL = 90 * 24 * 3600;
const cleanDlqId = (v) => (/^[A-Za-z0-9_&.-]{1,140}$/.test(String(v || "")) ? String(v) : "");

export function dlqAlertIdempotencyKey(id) {
  const clean = cleanDlqId(id);
  return clean ? `asaas-dlq-alert-v1-${clean}` : "";
}

export function dlqAlertBackoffMs(attempts, { baseBackoffMs = DLQ_ALERT_DEFAULTS.baseBackoffMs, maxBackoffMs = DLQ_ALERT_DEFAULTS.maxBackoffMs } = {}) {
  const n = Math.max(1, Number.isInteger(attempts) ? attempts : 1);
  return Math.min(maxBackoffMs, baseBackoffMs * 2 ** Math.min(n - 1, 30));
}

export function reviewResolved(out) {
  const body = out?.body || {};
  return Number(out?.status) === 200 && body.accepted === true && (body.event === "refund_confirmed" || body.reason === "superseded_partial_refund");
}

// Livro-razão FORTEMENTE consistente do alerta da DLQ (PostgreSQL). Uma linha por chave de idempotência.
export const DLQ_ALERT_ENSURE_SQL = `INSERT INTO asaas_dlq_alerts (idempotency_key, event_id) VALUES ($1::text, $2::text)
ON CONFLICT (idempotency_key) DO NOTHING`;
export const DLQ_ALERT_CLAIM_SQL = `UPDATE asaas_dlq_alerts
SET claim_owner = $2::text, claim_until = now() + ($3::int * interval '1 millisecond'), attempts = attempts + 1, updated_at = now()
WHERE idempotency_key = $1::text AND state = 'pending' AND next_attempt_at <= now()
  AND (claim_until IS NULL OR claim_until <= now()) AND attempts < $4::int
RETURNING attempts`;
export const DLQ_ALERT_STATE_SQL = `SELECT state, attempts FROM asaas_dlq_alerts WHERE idempotency_key = $1::text`;
export const DLQ_ALERT_SENT_SQL = `UPDATE asaas_dlq_alerts SET state = 'sent', sent_at = now(), claim_owner = NULL, claim_until = NULL, updated_at = now()
WHERE idempotency_key = $1::text AND claim_owner = $2::text AND state = 'pending'
RETURNING idempotency_key`;
export const DLQ_ALERT_FAILED_SQL = `UPDATE asaas_dlq_alerts
SET claim_owner = NULL, claim_until = NULL, next_attempt_at = now() + ($3::int * interval '1 millisecond'),
    state = CASE WHEN attempts >= $4::int THEN 'exhausted' ELSE 'pending' END, last_error = $5::text, updated_at = now()
WHERE idempotency_key = $1::text AND claim_owner = $2::text AND state = 'pending'
RETURNING state, attempts`;

export function createPgDlqAlertLedger(sql) {
  return Object.freeze({
    async claim(key, eventId, owner, { claimMs = DLQ_ALERT_DEFAULTS.claimMs, maxAttempts = DLQ_ALERT_DEFAULTS.maxAttempts } = {}) {
      await sql.query(DLQ_ALERT_ENSURE_SQL, [key, String(eventId || "")]);
      const rows = await sql.query(DLQ_ALERT_CLAIM_SQL, [key, String(owner), claimMs, maxAttempts]);
      if (Array.isArray(rows) && rows.length === 1) return { claimed: true, attempts: Number(rows[0].attempts) };
      const cur = await sql.query(DLQ_ALERT_STATE_SQL, [key]);
      return { claimed: false, state: String(cur?.[0]?.state || "unknown"), attempts: Number(cur?.[0]?.attempts || 0) };
    },
    async markSent(key, owner) {
      const rows = await sql.query(DLQ_ALERT_SENT_SQL, [key, String(owner)]);
      return Array.isArray(rows) && rows.length === 1;
    },
    async markFailed(key, owner, { backoffMs, maxAttempts = DLQ_ALERT_DEFAULTS.maxAttempts, error = "" } = {}) {
      const rows = await sql.query(DLQ_ALERT_FAILED_SQL, [key, String(owner), Math.max(0, Math.trunc(backoffMs || 0)), maxAttempts, String(error).replace(/[^a-z0-9_]/gi, "").slice(0, 60)]);
      return { state: String(rows?.[0]?.state || "unknown"), attempts: Number(rows?.[0]?.attempts || 0) };
    },
  });
}

// Mesmo contrato em memória (testes de unidade/isolate único; NÃO coordena isolates).
export function createMemoryDlqAlertLedger({ now = () => Date.now() } = {}) {
  const rows = new Map();
  return Object.freeze({
    rows,
    async claim(key, eventId, owner, { claimMs = DLQ_ALERT_DEFAULTS.claimMs, maxAttempts = DLQ_ALERT_DEFAULTS.maxAttempts } = {}) {
      if (!rows.has(key)) rows.set(key, { state: "pending", attempts: 0, next: 0, owner: null, until: 0 });
      const r = rows.get(key);
      const t = now();
      if (r.state === "pending" && r.next <= t && (!r.owner || r.until <= t) && r.attempts < maxAttempts) {
        Object.assign(r, { owner: String(owner), until: t + claimMs, attempts: r.attempts + 1 });
        return { claimed: true, attempts: r.attempts };
      }
      return { claimed: false, state: r.state, attempts: r.attempts };
    },
    async markSent(key, owner) {
      const r = rows.get(key);
      if (!r || r.owner !== String(owner) || r.state !== "pending") return false;
      Object.assign(r, { state: "sent", owner: null, until: 0 });
      return true;
    },
    async markFailed(key, owner, { backoffMs = 0, maxAttempts = DLQ_ALERT_DEFAULTS.maxAttempts } = {}) {
      const r = rows.get(key);
      if (!r || r.owner !== String(owner) || r.state !== "pending") return { state: "unknown", attempts: 0 };
      Object.assign(r, { owner: null, until: 0, next: now() + backoffMs, state: r.attempts >= maxAttempts ? "exhausted" : "pending" });
      return { state: r.state, attempts: r.attempts };
    },
  });
}

export const asaasDlqAlertStats = { sent: 0, failed: 0, exhausted: 0, ledger_error: 0, kv_error: 0 };

export async function drainAsaasWebhookReview(kv, { replay, alert, now = Date.now(), maxAttempts = REVIEW_DEFAULTS.maxAttempts, maxAgeMs = REVIEW_DEFAULTS.maxAgeMs, limit = REVIEW_DEFAULTS.limit, logger = console,
  alertLedger = null, owner = "", alertMaxAttempts = DLQ_ALERT_DEFAULTS.maxAttempts, alertBaseBackoffMs = DLQ_ALERT_DEFAULTS.baseBackoffMs, alertMaxBackoffMs = DLQ_ALERT_DEFAULTS.maxBackoffMs,
  alertClaimMs = DLQ_ALERT_DEFAULTS.claimMs, alertSendTimeoutMs = DLQ_ALERT_DEFAULTS.sendTimeoutMs } = {}) {
  const out = { checked: 0, resolved: 0, pending: 0, dead_lettered: 0, alerted: 0, errors: 0, alert_checked: 0, alert_failed: 0, alert_waiting: 0, alert_exhausted: 0, alert_errors: 0 };
  if (!kv?.list || !kv?.get || !kv?.put || typeof replay !== "function") return { ...out, skipped: "unconfigured" };
  // A reivindicação do livro-razão precisa sobreviver ao envio: envio limitado a alertSendTimeoutMs < alertClaimMs.
  if (!(alertSendTimeoutMs > 0 && alertSendTimeoutMs < alertClaimMs)) return { ...out, skipped: "alert_timing_invalid" };
  const drainOwner = String(owner || `drain-${now}-${Math.random().toString(36).slice(2, 10)}`);
  const log = (tag, fields) => { try { logger.error(tag, JSON.stringify(fields)); } catch {} };
  const handled = new Set();

  async function finalizeAlert(id, markerKey, state, attempts) {
    const dlqKey = ASAAS_WEBHOOK_DLQ_PREFIX + id;
    try {
      const cur = JSON.parse(String((await kv.get(dlqKey)) || "null"));
      if (cur && typeof cur === "object") await kv.put(dlqKey, JSON.stringify({ ...cur, alert: { ...(cur.alert || {}), state, attempts, [state === "sent" ? "sent_ms" : "exhausted_ms"]: Number(now) } }), { expirationTtl: DLQ_TTL });
    } catch (error) { asaasDlqAlertStats.kv_error += 1; kvError("review", error, logger); out.errors += 1; }
    try { await kv.delete(markerKey); } catch (error) {
      asaasDlqAlertStats.kv_error += 1; kvError("review", error, logger); out.errors += 1;
      // Remoção falhou: o marcador passa a dizer o estado final (a próxima drenagem não reenvia).
      try { await kv.put(markerKey, JSON.stringify({ ...(JSON.parse(String((await kv.get(markerKey)) || "{}")) || {}), state, alert_attempts: attempts }), { expirationTtl: DLQ_TTL }); } catch {}
    }
  }

  async function sendAlert(payload) {
    let timer;
    try {
      const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ sent: false, reason: "alert_send_timeout" }), alertSendTimeoutMs); });
      const r = await Promise.race([Promise.resolve().then(() => alert?.(payload)), timeout]);
      return { sent: r?.sent === true, reason: String(r?.reason || (r?.sent === true ? "sent" : "not_sent")) };
    } catch (error) {
      return { sent: false, reason: String(error?.name || "alert_error") };
    } finally { clearTimeout(timer); }
  }

  async function deliver(id, markerKey, marker) {
    handled.add(id);
    out.alert_checked += 1;
    if (marker.state === "sent" || marker.state === "exhausted") return finalizeAlert(id, markerKey, marker.state, Number(marker.alert_attempts || 0));
    if (Number.isFinite(marker.next_ms) && marker.next_ms > Number(now)) { out.alert_waiting += 1; return; }
    const key = dlqAlertIdempotencyKey(id);
    let attempts = (Number.isInteger(marker.alert_attempts) ? marker.alert_attempts : 0) + 1;
    if (alertLedger) {
      let claim;
      try { claim = await alertLedger.claim(key, marker.event_id || id, drainOwner, { claimMs: alertClaimMs, maxAttempts: alertMaxAttempts }); }
      catch (error) { asaasDlqAlertStats.ledger_error += 1; out.alert_errors += 1; log("asaas_webhook_dlq_alert_ledger_error", { event_id: id, error: String(error?.name || "Error").slice(0, 40) }); return; }
      if (!claim?.claimed) {
        if (claim?.state === "sent" || claim?.state === "exhausted") return finalizeAlert(id, markerKey, claim.state, Number(claim.attempts || 0));
        out.alert_waiting += 1; // outra drenagem está com a reivindicação, ou recuo ainda não venceu no banco
        return;
      }
      attempts = Number(claim.attempts);
    } else if (attempts > alertMaxAttempts) {
      return finalizeAlert(id, markerKey, "exhausted", attempts - 1);
    }
    const r = await sendAlert({ event_id: marker.event_id || id, payment_id: marker.payment_id || "", order_id: marker.order_id || "", attempts: Number(marker.attempts || 0), cause: String(marker.cause || ""), idempotency_key: key });
    if (r.sent) {
      if (alertLedger) { try { await alertLedger.markSent(key, drainOwner); } catch (error) { asaasDlqAlertStats.ledger_error += 1; out.alert_errors += 1; log("asaas_webhook_dlq_alert_ledger_error", { event_id: id, op: "mark_sent", error: String(error?.name || "Error").slice(0, 40) }); } }
      out.alerted += 1;
      asaasDlqAlertStats.sent += 1;
      log("asaas_webhook_dlq_alert", { event_id: id, outcome: "sent", alert_attempts: attempts });
      return finalizeAlert(id, markerKey, "sent", attempts);
    }
    const exhausted = attempts >= alertMaxAttempts;
    const backoffMs = dlqAlertBackoffMs(attempts, { baseBackoffMs: alertBaseBackoffMs, maxBackoffMs: alertMaxBackoffMs });
    if (alertLedger) { try { await alertLedger.markFailed(key, drainOwner, { backoffMs, maxAttempts: alertMaxAttempts, error: r.reason }); } catch (error) { asaasDlqAlertStats.ledger_error += 1; out.alert_errors += 1; } }
    out.alert_failed += 1;
    asaasDlqAlertStats.failed += 1;
    log("asaas_webhook_dlq_alert_failed", { event_id: id, alert_attempts: attempts, reason: r.reason.replace(/[^a-z0-9_]/gi, "").slice(0, 60), next_in_ms: exhausted ? null : backoffMs, count: asaasDlqAlertStats.failed });
    if (exhausted) {
      out.alert_exhausted += 1;
      asaasDlqAlertStats.exhausted += 1;
      log("asaas_webhook_dlq_alert_exhausted", { event_id: id, alert_attempts: attempts });
      return finalizeAlert(id, markerKey, "exhausted", attempts);
    }
    try { await kv.put(markerKey, JSON.stringify({ ...marker, state: "pending", alert_attempts: attempts, next_ms: Number(now) + backoffMs, last_alert_error: r.reason.replace(/[^a-z0-9_]/gi, "").slice(0, 60) }), { expirationTtl: DLQ_TTL }); }
    catch (error) { asaasDlqAlertStats.kv_error += 1; kvError("review", error, logger); out.errors += 1; }
  }

  let keys = [];
  try { keys = (await kv.list({ prefix: ASAAS_WEBHOOK_REVIEW_PREFIX, limit })).keys || []; } catch (error) { kvError("review", error, logger); return { ...out, errors: 1, list_failed: true }; }
  for (const { name } of keys.slice(0, limit)) {
    out.checked += 1;
    let rec = null;
    try { rec = JSON.parse(String((await kv.get(name)) || "null")); } catch { rec = null; }
    const valid = rec && cleanEventId(rec.event_id) && ASAAS_SUPPORTED_EVENTS.includes(String(rec.event || "")) && /^pay_[A-Za-z0-9_-]{6,120}$/.test(String(rec.payment_id || ""));
    let result = null;
    if (valid) {
      try { result = await replay(rec); } catch (error) { result = { status: 0, body: { error: String(error?.name || "replay_error") } }; }
      if (reviewResolved(result)) {
        try { await kv.delete(name); out.resolved += 1; } catch (error) { kvError("review", error, logger); out.errors += 1; }
        continue;
      }
    }
    const attempts = (Number.isInteger(rec?.attempts) ? rec.attempts : 0) + 1;
    const age = Number(now) - (Number.isFinite(rec?.first_queued_ms) ? rec.first_queued_ms : Number(now));
    const lastOutcome = String(result?.body?.reason || result?.body?.error || (valid ? "unresolved" : "invalid_record")).replace(/[^a-z0-9_]/g, "").slice(0, 60);
    const next = { ...(rec || {}), attempts, last_outcome: lastOutcome, last_attempt_ms: Number(now) };
    if (!valid || attempts >= maxAttempts || age >= maxAgeMs) {
      const id = String(name).slice(ASAAS_WEBHOOK_REVIEW_PREFIX.length);
      const dlqKey = ASAAS_WEBHOOK_DLQ_PREFIX + id;
      const markerKey = ASAAS_WEBHOOK_DLQ_ALERT_PREFIX + id;
      const cause = !valid ? "invalid_record" : attempts >= maxAttempts ? "max_attempts" : "max_age";
      let already = null;
      try { already = JSON.parse(String((await kv.get(dlqKey)) || "null")); } catch { already = null; }
      let marker = null;
      try {
        if (!already) {
          const fresh = { ...next, dead_lettered_ms: Number(now), cause, alert: { state: "pending", idempotency_key: dlqAlertIdempotencyKey(id), attempts: 0 } };
          const pendingAlert = { event_id: next.event_id || id, payment_id: next.payment_id || "", order_id: next.order_id || "", attempts, cause, state: "pending", alert_attempts: 0, next_ms: Number(now) };
          // Pendência do alerta gravada ANTES da DLQ e da remoção da fila: se falhar, o item fica na fila.
          await kv.put(markerKey, JSON.stringify(pendingAlert), { expirationTtl: DLQ_TTL });
          await kv.put(dlqKey, JSON.stringify(fresh), { expirationTtl: DLQ_TTL });
          marker = pendingAlert;
          out.dead_lettered += 1;
          log("asaas_webhook_review_dead_letter", { event_id: next.event_id || "", attempts, cause });
        }
        await kv.delete(name);
      } catch (error) { kvError("review", error, logger); out.errors += 1; }
      if (marker) await deliver(id, markerKey, marker);
      continue;
    }
    try { await kv.put(name, JSON.stringify(next), { expirationTtl: 30 * 24 * 3600 }); out.pending += 1; } catch (error) { kvError("review", error, logger); out.errors += 1; }
  }

  // Reenvio dos alertas pendentes (inclusive de drenagens anteriores cujo envio falhou).
  let pendingKeys = [];
  try { pendingKeys = (await kv.list({ prefix: ASAAS_WEBHOOK_DLQ_ALERT_PREFIX, limit })).keys || []; } catch (error) { kvError("review", error, logger); out.errors += 1; out.alert_errors += 1; }
  for (const { name } of pendingKeys.slice(0, limit)) {
    const id = String(name).slice(ASAAS_WEBHOOK_DLQ_ALERT_PREFIX.length);
    if (handled.has(id)) continue;
    let marker = null;
    try { marker = JSON.parse(String((await kv.get(name)) || "null")); } catch { marker = null; }
    if (!marker || typeof marker !== "object" || !cleanDlqId(id)) { out.alert_errors += 1; log("asaas_webhook_dlq_alert_marker_invalid", { key_suffix: cleanDlqId(id) }); continue; }
    await deliver(id, name, marker);
  }
  return out;
}
