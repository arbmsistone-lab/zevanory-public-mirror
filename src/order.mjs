import { PROJECT, isUuid } from './config.mjs';
import { resolveCheckoutOffer } from './offerCatalog.mjs';

export function normalizeCheckoutRequest(body) {
  if (!body || typeof body !== 'object') return null;
  if (!isUuid(body.request_id) || !isUuid(body.session_id)) return null;
  const offer=resolveCheckoutOffer(body.offer_id||body.sku||PROJECT.offerId);
  if(!offer) return null;
  return Object.freeze({requestId:String(body.request_id).toLowerCase(),sessionId:String(body.session_id).toLowerCase(),offer});
}

export function checkoutReplayDecision(order, sessionId, offerId='') {
  if (!order || typeof order !== 'object') return Object.freeze({ action:'lookup_failed' });
  if (String(order.session_id||'').toLowerCase() !== String(sessionId||'').toLowerCase()) return Object.freeze({ action:'conflict' });
  if (offerId && String(order.offer_id||'').toUpperCase() !== String(offerId).toUpperCase()) return Object.freeze({ action:'offer_conflict' });
  const status=String(order.status||'');
  if (status==='checkout_ready' && order.checkout_url) return Object.freeze({ action:'reuse', checkoutUrl:String(order.checkout_url) });
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

export function buildAsaasCheckoutPayload(orderId, publicBaseUrl, offer=resolveCheckoutOffer(PROJECT.offerId)) {
  const externalReference=externalReferenceForOrder(orderId);
  const base=safePublicBaseUrl(publicBaseUrl);
  if (!externalReference || !base || !offer) return null;
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
      name:`${offer.product} ${offer.version}`,
      description:offer.id,
      quantity:1,
      value:offer.price_brl,
    }],
  });
}

export function checkoutUrlForId(id, env='sandbox') {
  if(!isUuid(id)) return '';
  const mode=String(env||'').toLowerCase();
  if(mode==='production') return `https://asaas.com/checkoutSession/show?id=${id}`;
  if(mode==='sandbox') return `https://sandbox.asaas.com/checkoutSession/show/${id}`;
  return '';
}

export function normalizeAsaasCheckoutResponse(value, externalReference, env='sandbox') {
  if (!value || typeof value !== 'object' || !isUuid(value.id)) return null;
  if (value.externalReference && String(value.externalReference)!==externalReference) return null;
  const expected=checkoutUrlForId(String(value.id),env);
  const link=String(value.link||expected);
  if(!expected || new URL(link).hostname !== new URL(expected).hostname) return null;
  return Object.freeze({id:String(value.id),link});
}

export function validAsaasCheckoutResponse(value, externalReference, env='sandbox') {
  return Boolean(normalizeAsaasCheckoutResponse(value,externalReference,env));
}