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
//    alerta ao proprietário, uma única vez por item (idempotente mesmo se a remoção da fila falhar).
export const ASAAS_WEBHOOK_DLQ_PREFIX = "asaas:webhook:dlq:v1:";
export const REVIEW_DEFAULTS = Object.freeze({ maxAttempts: 6, maxAgeMs: 72 * 3600 * 1000, limit: 25 });

export function reviewResolved(out) {
  const body = out?.body || {};
  return Number(out?.status) === 200 && body.accepted === true && (body.event === "refund_confirmed" || body.reason === "superseded_partial_refund");
}

export async function drainAsaasWebhookReview(kv, { replay, alert, now = Date.now(), maxAttempts = REVIEW_DEFAULTS.maxAttempts, maxAgeMs = REVIEW_DEFAULTS.maxAgeMs, limit = REVIEW_DEFAULTS.limit, logger = console } = {}) {
  const out = { checked: 0, resolved: 0, pending: 0, dead_lettered: 0, alerted: 0, errors: 0 };
  if (!kv?.list || !kv?.get || !kv?.put || typeof replay !== "function") return { ...out, skipped: "unconfigured" };
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
      let already = null;
      try { already = await kv.get(dlqKey); } catch { already = null; }
      try {
        if (!already) {
          await kv.put(dlqKey, JSON.stringify({ ...next, dead_lettered_ms: Number(now), cause: !valid ? "invalid_record" : attempts >= maxAttempts ? "max_attempts" : "max_age" }), { expirationTtl: 90 * 24 * 3600 });
          out.dead_lettered += 1;
          let sent = false;
          try { sent = (await alert?.({ event_id: next.event_id || id, payment_id: next.payment_id || "", order_id: next.order_id || "", attempts, cause: !valid ? "invalid_record" : attempts >= maxAttempts ? "max_attempts" : "max_age" }))?.sent === true; } catch { sent = false; }
          if (sent) out.alerted += 1;
          try { logger.error("asaas_webhook_review_dead_letter", JSON.stringify({ event_id: next.event_id || "", attempts, alerted: sent })); } catch {}
        }
        await kv.delete(name);
      } catch (error) { kvError("review", error, logger); out.errors += 1; }
      continue;
    }
    try { await kv.put(name, JSON.stringify(next), { expirationTtl: 30 * 24 * 3600 }); out.pending += 1; } catch (error) { kvError("review", error, logger); out.errors += 1; }
  }
  return out;
}
