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

export async function asaasWebhookAlreadyProcessed(kv, eventId) {
  const id = cleanEventId(eventId);
  if (!id || !kv?.get) return false;
  try { return Boolean(await kv.get(ASAAS_WEBHOOK_DEDUPE_PREFIX + id)); } catch { return false; }
}

export async function markAsaasWebhookProcessed(kv, eventId, outcome = "processed") {
  const id = cleanEventId(eventId);
  if (!id || !kv?.put) return false;
  try {
    await kv.put(ASAAS_WEBHOOK_DEDUPE_PREFIX + id, JSON.stringify({ outcome: String(outcome).slice(0, 60), at: new Date().toISOString() }), { expirationTtl: 7 * 24 * 3600 });
    return true;
  } catch { return false; }
}

// Fila de revisão em KV privada (mesmo padrão de mercadopago-webhook-safety.mjs): casos aceitos sem efeito
// financeiro que exigem reconciliação humana/automática. Só identificadores, nunca dados pessoais.
export async function queueAsaasWebhookReview(kv, { eventId, paymentId, orderId, reason } = {}) {
  const id = cleanEventId(eventId);
  if (!id || !kv?.put) return false;
  const record = {
    event_id: id,
    payment_id: /^pay_[A-Za-z0-9_-]{6,120}$/.test(String(paymentId || "")) ? String(paymentId) : "",
    order_id: /^[0-9a-f-]{36}$/i.test(String(orderId || "")) ? String(orderId).toLowerCase() : "",
    reason: String(reason || "").replace(/[^a-z0-9_]/g, "").slice(0, 80),
    queued_at: new Date().toISOString(),
  };
  try {
    await kv.put(ASAAS_WEBHOOK_REVIEW_PREFIX + id, JSON.stringify(record), { expirationTtl: 30 * 24 * 3600 });
    return true;
  } catch { return false; }
}
