import { alertOwnerNow } from "./owner-alerts.mjs";

export const MERCADOPAGO_PRODUCTION_APPLICATION_ID = "1481661361903088";
export const MERCADOPAGO_WEBHOOK_PROOF_KEY = "zpc-mercadopago-webhook-signature:v1";
export const MERCADOPAGO_WEBHOOK_RECOVERY_PREFIX = "mercadopago:webhook-recovery:v1:";

const cleanRequestId = (value) => String(value || "").replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 160);
const validPaymentId = (value) => /^[0-9]{4,32}$/.test(String(value || ""));

function privateKv(env) {
  return env?.ZEVANORY_PRIVATE_ARTIFACTS || globalThis.__ZEVANORY_PRIVATE_KV__ || null;
}

export async function recordMercadoPagoWebhookSignature(env, {
  signatureValid,
  requestId,
  paymentId,
  production = true,
  now = () => new Date(),
  alert = alertOwnerNow,
  logger = console,
} = {}) {
  if (!production) return { preserved: false, alerted: false };
  const signature_valid = signatureValid === true;
  const x_request_id = cleanRequestId(requestId);
  // Deliberately log only the two fields authorized for production evidence.
  logger.info("mercadopago_webhook_signature", JSON.stringify({ signature_valid, x_request_id }));
  const kv = privateKv(env);
  const generatedAt = now().toISOString();
  if (signature_valid) {
    let preserved = false;
    try {
      if (kv?.put) {
        await kv.put(MERCADOPAGO_WEBHOOK_PROOF_KEY, JSON.stringify({
          generatedAt,
          applicationId: MERCADOPAGO_PRODUCTION_APPLICATION_ID,
          signature_valid,
          x_request_id,
        }), { expirationTtl: 3 * 24 * 3600 });
        preserved = true;
      }
    } catch {}
    return { preserved, alerted: false };
  }
  let preserved = false;
  if (validPaymentId(paymentId)) {
    const key = `${MERCADOPAGO_WEBHOOK_RECOVERY_PREFIX}${paymentId}`;
    try {
      await kv?.put?.(key, JSON.stringify({ paymentId: String(paymentId), xRequestId: x_request_id, queuedAt: generatedAt }), { expirationTtl: 7 * 24 * 3600 });
      preserved = Boolean(kv?.put);
    } catch {}
  }
  let alerted = false;
  try {
    const result = await alert(env, {
      channel: "mercadopago-webhook",
      contact: "production-signature-invalid",
      excerpt: x_request_id ? `x-request-id: ${x_request_id}` : "x-request-id ausente",
      reason: preserved
        ? "Assinatura inválida no webhook de produção. A reconciliação direta foi enfileirada."
        : "Assinatura inválida no webhook de produção e a fila de reconciliação está indisponível.",
    });
    alerted = result?.sent === true || result?.reason === "recently_alerted";
  } catch {}
  return { preserved, alerted };
}

export async function drainMercadoPagoWebhookRecovery(env, reconcile, { limit = 10 } = {}) {
  const kv = privateKv(env);
  if (!kv?.list || typeof reconcile !== "function") return { checked: 0, recovered: 0, pending: 0 };
  const listed = await kv.list({ prefix: MERCADOPAGO_WEBHOOK_RECOVERY_PREFIX, limit });
  const keys = (listed?.keys || []).map((item) => String(item.name || "")).filter(Boolean);
  const out = { checked: keys.length, recovered: 0, pending: 0 };
  for (const key of keys) {
    let item = null;
    try { item = JSON.parse(String(await kv.get(key) || "null")); } catch {}
    if (!validPaymentId(item?.paymentId)) {
      await kv.delete?.(key).catch(() => null);
      continue;
    }
    try {
      const result = await reconcile(String(item.paymentId));
      if (result?.completed === true) {
        await kv.delete?.(key).catch(() => null);
        out.recovered += 1;
      } else {
        out.pending += 1;
      }
    } catch {
      out.pending += 1;
    }
  }
  return out;
}
