// B05 (Ordem 076-7, auditor Sol) — webhook de validação de saque/estorno Pix do Asaas.
//
// Antes: aprovava pela FORMA do pedido (type PIX_REFUND, valor fixo 5, prefixos). Um pedido com forma válida,
// sem pedido/valor/autorização reais por trás, era aprovado => estorno indevido.
// Agora: aprova SOMENTE se o pedido do Asaas casar EXATAMENTE (payment id + valor em centavos) com uma intenção
// de estorno persistida, não expirada e não usada, criada pelo fluxo do sistema/proprietário
// (createAsaasRefundIntent). O consumo do nonce é atômico (um único UPDATE ... RETURNING com FOR UPDATE SKIP
// LOCKED): uso único mesmo com entregas concorrentes. Qualquer outra coisa => REFUSED (fail-closed).
//
// Contrato do provedor (https://docs.asaas.com/docs/mecanismo-para-validacao-de-saque-via-webhooks, consultado em
// 22/10/2026): POST JSON com `type` ("PIX_REFUND" => objeto `pixRefund` com id, value, payment, ...), cabeçalho
// `asaas-access-token` com o token configurado; resposta {"status":"APPROVED"} ou {"status":"REFUSED","refuseReason"}.
// Qualquer resposta sem um desses status conta como falha; após 3 falhas a operação é CANCELADA (fail-closed
// do lado do provedor). Por isso erro de banco => REFUSED explícito (nunca 5xx ambíguo que pudesse ser reenviado
// e aprovado depois por acaso).
import crypto from "node:crypto";
import { constantTimeEqual } from "./psp-failover.mjs";

export const REFUND_INTENT_ROUTE = "/api/asaas/withdraw-authorization";
export const REFUND_INTENT_MAX_TTL_MS = 30 * 60 * 1000;
export const REFUND_INTENT_MIN_TTL_MS = 60 * 1000;
const PAYMENT_ID_RE = /^pay_[A-Za-z0-9_-]{6,120}$/;
const REFUND_ID_RE = /^[A-Za-z0-9_-]{8,120}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR_RE = /^[a-z0-9_.:@-]{3,80}$/i;

// Cria a intenção SÓ para pedido Asaas pago cuja confirmação de pagamento (payment id) está registrada em
// financial_events, com valor <= valor do pedido. Um único INSERT ... SELECT: sem pedido elegível => 0 linhas.
export const CREATE_REFUND_INTENT_SQL = `INSERT INTO asaas_refund_intents (nonce, order_id, payment_id, amount_cents, provider, approved_by, expires_at)
SELECT $1::text, o.order_id, $3::text, $4::bigint, 'asaas', $5::text, now() + ($6::int * interval '1 millisecond')
FROM orders o
WHERE o.order_id = $2::uuid AND o.provider = 'asaas' AND o.status = 'paid'
  AND $4::bigint > 0 AND $4::bigint <= round(o.amount * 100)::bigint
  AND EXISTS (SELECT 1 FROM financial_events fe WHERE fe.order_id = o.order_id AND fe.provider = 'asaas'
              AND fe.provider_payment_id = $3::text AND fe.normalized_event = 'payment_confirmed')
RETURNING nonce, order_id::text AS order_id, expires_at::text AS expires_at`;

// Revoga intenções VENCIDAS e não usadas do mesmo pagamento (libera o índice único parcial).
export const REVOKE_EXPIRED_INTENTS_SQL = `UPDATE asaas_refund_intents SET revoked_at = now()
WHERE payment_id = $1::text AND used_at IS NULL AND revoked_at IS NULL AND expires_at <= now()`;

// Consumo atômico de uso único: casa payment id + valor exato, não expirada, não usada.
export const CONSUME_REFUND_INTENT_SQL = `UPDATE asaas_refund_intents SET used_at = now(), used_refund_id = $3::text
WHERE nonce = (
  SELECT nonce FROM asaas_refund_intents
  WHERE provider = 'asaas' AND payment_id = $1::text AND amount_cents = $2::bigint
    AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
  ORDER BY created_at ASC LIMIT 1
  FOR UPDATE SKIP LOCKED)
AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
RETURNING nonce, order_id::text AS order_id, payment_id, amount_cents::text AS amount_cents`;

export function refundValueCents(value) {
  if (typeof value !== "number" && typeof value !== "string") return NaN;
  if (typeof value === "string" && !/^\d{1,9}(\.\d{1,2})?$/.test(value.trim())) return NaN;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return NaN;
  const cents = Math.round(n * 100);
  return Math.abs(cents - n * 100) < 1e-6 ? cents : NaN; // frações de centavo => inválido
}

// Fluxo do sistema/proprietário: grava a intenção ANTES de pedir o estorno ao Asaas.
export async function createAsaasRefundIntent(sql, { orderId, paymentId, amountCents, approvedBy, ttlMs = 15 * 60 * 1000, nonce } = {}) {
  if (!sql || typeof sql.query !== "function") return Object.freeze({ created: false, reason: "storage_unavailable" });
  if (!UUID_RE.test(String(orderId || ""))) return Object.freeze({ created: false, reason: "order_id_invalid" });
  if (!PAYMENT_ID_RE.test(String(paymentId || ""))) return Object.freeze({ created: false, reason: "payment_id_invalid" });
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return Object.freeze({ created: false, reason: "amount_invalid" });
  if (!ACTOR_RE.test(String(approvedBy || ""))) return Object.freeze({ created: false, reason: "approver_invalid" });
  const ttl = Number.isInteger(ttlMs) ? Math.min(Math.max(ttlMs, REFUND_INTENT_MIN_TTL_MS), REFUND_INTENT_MAX_TTL_MS) : 15 * 60 * 1000;
  const n = typeof nonce === "string" && /^[a-f0-9]{64}$/.test(nonce) ? nonce : crypto.randomBytes(32).toString("hex");
  let rows;
  try {
    await sql.query(REVOKE_EXPIRED_INTENTS_SQL, [String(paymentId)]);
    rows = await sql.query(CREATE_REFUND_INTENT_SQL, [n, String(orderId).toLowerCase(), String(paymentId), amountCents, String(approvedBy), ttl]);
  } catch (error) {
    // unique parcial (uma intenção aberta por pagamento) ou banco indisponível: nada aprovado.
    return Object.freeze({ created: false, reason: /duplicate key|unique/i.test(String(error?.message || "")) ? "open_intent_exists" : "storage_error" });
  }
  if (!Array.isArray(rows) || rows.length !== 1) return Object.freeze({ created: false, reason: "order_not_eligible" });
  return Object.freeze({ created: true, nonce: rows[0].nonce, order_id: rows[0].order_id, expires_at: rows[0].expires_at });
}

export function parsePixRefundRequest(body) {
  if (!body || typeof body !== "object" || body.type !== "PIX_REFUND") return null;
  const r = body.pixRefund;
  if (!r || typeof r !== "object") return null;
  const paymentId = String(r.payment || "");
  const refundId = String(r.id || "");
  const cents = refundValueCents(r.value);
  if (!PAYMENT_ID_RE.test(paymentId) || !REFUND_ID_RE.test(refundId) || !Number.isSafeInteger(cents)) return null;
  return Object.freeze({ paymentId, refundId, amountCents: cents });
}

// Decide APPROVED/REFUSED. Pura (sem Request), para testes e mutantes.
export async function authorizeAsaasPixRefund({ env = {}, token, body, sql } = {}) {
  const expected = String(env.ASAAS_WITHDRAW_AUTH_TOKEN || "");
  if (expected.length < 32) return Object.freeze({ status: "REFUSED", refuseReason: "authorization_token_unconfigured", http: 200 });
  if (!constantTimeEqual(expected, Array.isArray(token) ? "" : String(token || ""))) return Object.freeze({ status: "REFUSED", refuseReason: "authorization_token_invalid", http: 401 });
  // Ambiente (inalterado): só piloto em sandbox com vendas fechadas. Produção continua recusada até decisão do
  // proprietário em PR próprio; mesmo aqui a intenção persistida é obrigatória.
  const salesClosed = String(env.SALE_GLOBALLY_ENABLED || "").toLowerCase() !== "true";
  const sandbox = String(env.CERTIFICATION_PILOT_ENV || "").toLowerCase() === "sandbox";
  if (!salesClosed || !sandbox) return Object.freeze({ status: "REFUSED", refuseReason: "fail_closed_environment_required", http: 200 });
  const req = parsePixRefundRequest(body);
  if (!req) return Object.freeze({ status: "REFUSED", refuseReason: "unrecognized_pix_refund", http: 200 });
  if (!sql || typeof sql.query !== "function") return Object.freeze({ status: "REFUSED", refuseReason: "intent_storage_unavailable", http: 200 });
  let rows;
  try {
    rows = await sql.query(CONSUME_REFUND_INTENT_SQL, [req.paymentId, req.amountCents, req.refundId]);
  } catch {
    return Object.freeze({ status: "REFUSED", refuseReason: "intent_storage_error", http: 200 });
  }
  if (!Array.isArray(rows) || rows.length !== 1) return Object.freeze({ status: "REFUSED", refuseReason: "no_matching_intent", http: 200 });
  const row = rows[0];
  // Defesa extra: o que voltou do banco tem que ser exatamente o que o Asaas pediu.
  if (String(row.payment_id) !== req.paymentId || Number(row.amount_cents) !== req.amountCents) return Object.freeze({ status: "REFUSED", refuseReason: "intent_mismatch", http: 200 });
  return Object.freeze({ status: "APPROVED", http: 200, order_id: String(row.order_id || "") });
}

function respond(decision) {
  const body = decision.status === "APPROVED" ? { status: "APPROVED" } : { status: "REFUSED", refuseReason: decision.refuseReason };
  return new Response(JSON.stringify(body), { status: decision.http || 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function log(decision, logger = console) {
  try {
    logger.info("asaas_refund_authorization", JSON.stringify({ status: decision.status, reason: decision.refuseReason || "matched_intent", order_id: decision.order_id || "" }));
  } catch {}
}

// deps.sql: cliente com query(text, params) -> rows. Sem injeção, usa o driver Neon HTTP do bundle (import
// dinâmico literal, só na rota, para não carregar o bundle nos testes de unidade).
export async function handleAsaasPixRefundAuthorization(request, env, deps = {}) {
  const url = new URL(request.url);
  if (url.pathname !== REFUND_INTENT_ROUTE) return null;
  if (String(request.method || "GET").toUpperCase() !== "POST") {
    return new Response(JSON.stringify({ status: "REFUSED", refuseReason: "method_not_allowed" }), { status: 405, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  }
  let body = null;
  try { body = await request.json(); } catch {}
  let sql = deps.sql || null;
  if (!sql && env?.DATABASE_URL) {
    try {
      const { whatsappProofDatabase } = await import("./cloudflare-worker.recovered.mjs");
      sql = whatsappProofDatabase(env.DATABASE_URL);
    } catch { sql = null; }
  }
  const decision = await authorizeAsaasPixRefund({ env, token: request.headers.get("asaas-access-token"), body, sql });
  log(decision, deps.logger);
  return respond(decision);
}
