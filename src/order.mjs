import { PROJECT, isUuid } from './config.mjs';

export function normalizeCheckoutRequest(body) {
  if (!body || typeof body !== 'object') return null;
  if (!isUuid(body.request_id) || !isUuid(body.session_id)) return null;
  return Object.freeze({
    requestId:String(body.request_id).toLowerCase(),
    sessionId:String(body.session_id).toLowerCase(),
  });
}

export function checkoutReplayDecision(order, sessionId) {
  if (!order || typeof order !== 'object') return Object.freeze({ action:'lookup_failed' });
  if (String(order.session_id||'').toLowerCase() !== String(sessionId||'').toLowerCase()) {
    return Object.freeze({ action:'conflict' });
  }
  const status=String(order.status||'');
  if (status==='checkout_ready' && order.checkout_url) {
    return Object.freeze({ action:'reuse', checkoutUrl:String(order.checkout_url) });
  }
  if (status==='created') return Object.freeze({ action:'create' });
  if (status==='checkout_creating') return Object.freeze({ action:'in_progress' });
  return Object.freeze({ action:'blocked', status });
}

export function externalReferenceForOrder(orderId) {
  return isUuid(orderId) ? `ZEVANORY:${PROJECT.experimentId}:${String(orderId).toLowerCase()}` : '';
}

export function safePublicBaseUrl(value) {
  try {
    const url=new URL(String(value||''));
    const allowed=new Set(['https://zevanory-site.vercel.app','https://zevanory.api.br']);
    return allowed.has(url.origin) && url.pathname==='/' ? url.origin : '';
  } catch { return ''; }
}

export function buildAsaasCheckoutPayload(orderId, publicBaseUrl) {
  const externalReference=externalReferenceForOrder(orderId);
  const base=safePublicBaseUrl(publicBaseUrl);
  if (!externalReference || !base) return null;
  return Object.freeze({
    billingTypes:['PIX','CREDIT_CARD'],
    chargeTypes:['DETACHED'],
    minutesToExpire:60,
    externalReference,
    callback:{
      successUrl:`${base}/piloto?checkout=success`,
      cancelUrl:`${base}/piloto?checkout=cancel`,
      expiredUrl:`${base}/piloto?checkout=expired`,
    },
    items:[{
      name:'Piloto IA aplicada a Vendas e Atendimento no WhatsApp',
      description:PROJECT.offerId,
      quantity:1,
      value:PROJECT.experimentalPriceBrl,
    }],
  });
}

export function validAsaasCheckoutResponse(value, externalReference) {
  if (!value || typeof value !== 'object') return false;
  if (!isUuid(value.id) || String(value.externalReference||'') !== externalReference) return false;
  return /^https:\/\/sandbox\.asaas\.com\/checkoutSession\//.test(String(value.link||''));
}
