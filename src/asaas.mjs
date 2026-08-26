import crypto from 'node:crypto';
import { PROJECT, isUuid } from './config.mjs';

export const ASAAS_API_BASES = Object.freeze({
  sandbox: 'https://api-sandbox.asaas.com/v3',
  production: 'https://api.asaas.com/v3',
});

export function asaasBaseUrl(env) {
  return ASAAS_API_BASES[String(env || '').toLowerCase()] || '';
}

export const ASAAS_EVENTS = new Set([
  'PAYMENT_CONFIRMED',
  'PAYMENT_RECEIVED',
  'PAYMENT_REFUNDED',
  'PAYMENT_PARTIALLY_REFUNDED',
]);

export function secureTokenEqual(expected, provided) {
  const a=Buffer.from(String(expected||''));
  const b=Buffer.from(String(provided||''));
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a,b);
}

export function normalizeAsaasWebhook(body) {
  if (!body || typeof body !== 'object') return null;
  if (!ASAAS_EVENTS.has(body.event)) return null;
  if (!/^evt_[A-Za-z0-9_&.-]{6,120}$/.test(String(body.id||''))) return null;
  if (!/^pay_[A-Za-z0-9_-]{6,120}$/.test(String(body.payment?.id||''))) return null;
  return Object.freeze({providerEventId:String(body.id),eventName:body.event,paymentId:String(body.payment.id)});
}

export function parseExternalReference(value) {
  const prefix=`ZEVANORY:${PROJECT.experimentId}:`;
  const text=String(value||'');
  if (!text.startsWith(prefix)) return null;
  const orderId=text.slice(prefix.length);
  return isUuid(orderId) ? orderId.toLowerCase() : null;
}

export function normalizeFinancialEvent(eventName) {
  if (eventName === 'PAYMENT_REFUNDED' || eventName === 'PAYMENT_PARTIALLY_REFUNDED') return 'refund_confirmed';
  if (eventName === 'PAYMENT_CONFIRMED' || eventName === 'PAYMENT_RECEIVED') return 'payment_confirmed';
  return '';
}

function moneyCents(value) {
  const number=Number(value);
  return Number.isFinite(number) ? Math.round(number*100) : NaN;
}

export function completedRefundTotal(payment) {
  if (!Array.isArray(payment?.refunds)) return 0;
  let cents=0;
  for (const refund of payment.refunds) {
    if (String(refund?.status||'') !== 'DONE') continue;
    const value=moneyCents(refund?.value);
    if (!Number.isFinite(value) || value <= 0) return NaN;
    cents += value;
  }
  return cents/100;
}

export function refundTotalForWebhook(webhook,payment) {
  if (!webhook || !payment) return null;
  if (!['PAYMENT_REFUNDED','PAYMENT_PARTIALLY_REFUNDED'].includes(webhook.eventName)) return null;
  const gross=moneyCents(payment.value);
  const refunded=moneyCents(completedRefundTotal(payment));
  if (!Number.isFinite(gross) || !Number.isFinite(refunded) || refunded <= 0 || refunded > gross) return null;
  if (webhook.eventName === 'PAYMENT_PARTIALLY_REFUNDED' && refunded >= gross) return null;
  if (webhook.eventName === 'PAYMENT_REFUNDED' && (refunded !== gross || String(payment.status||'') !== 'REFUNDED')) return null;
  return refunded/100;
}

export function paymentMatchesWebhook(webhook, payment) {
  if (!webhook || !payment || String(payment.id) !== webhook.paymentId) return false;
  if (!parseExternalReference(payment.externalReference)) return false;
  if (moneyCents(payment.value) !== moneyCents(PROJECT.experimentalPriceBrl)) return false;
  if (webhook.eventName === 'PAYMENT_CONFIRMED') return String(payment.status||'') === 'CONFIRMED';
  if (webhook.eventName === 'PAYMENT_RECEIVED') return String(payment.status||'') === 'RECEIVED';
  return refundTotalForWebhook(webhook,payment) !== null;
}

export function paymentMatchesOrderIdentity(payment, order) {
  if (!payment || !order) return false;
  const orderId=String(order.order_id||'').toLowerCase();
  const externalReference=String(order.external_reference||'');
  const providerCheckoutId=String(order.provider_checkout_id||'');
  if (!isUuid(orderId) || parseExternalReference(externalReference) !== orderId) return false;
  const paymentReference=String(payment.externalReference||'');
  const paymentCheckout=String(payment.checkoutSession||'');
  const hasReference=paymentReference !== '';
  const hasCheckout=paymentCheckout !== '';
  const linkedByReference=hasReference && parseExternalReference(paymentReference) === orderId && paymentReference === externalReference;
  const linkedByCheckout=hasCheckout && isUuid(paymentCheckout) && paymentCheckout.toLowerCase() === providerCheckoutId.toLowerCase();
  if ((hasReference && !linkedByReference) || (hasCheckout && !linkedByCheckout)) return false;
  if (!linkedByReference && !linkedByCheckout) return false;
  if (moneyCents(payment.value) !== moneyCents(order.amount) || moneyCents(order.amount) !== moneyCents(PROJECT.experimentalPriceBrl)) return false;
  return true;
}

export function paymentMatchesOrderWebhook(webhook, payment, order) {
  if (!webhook || String(payment?.id) !== webhook.paymentId || !paymentMatchesOrderIdentity(payment,order)) return false;
  if (webhook.eventName === 'PAYMENT_CONFIRMED') return String(payment.status||'') === 'CONFIRMED';
  if (webhook.eventName === 'PAYMENT_RECEIVED') return String(payment.status||'') === 'RECEIVED';
  return refundTotalForWebhook(webhook,payment) !== null;
}

export function supersededPartialRefund(webhook,payment,order) {
  if (webhook?.eventName !== 'PAYMENT_PARTIALLY_REFUNDED' || String(payment?.status||'') !== 'REFUNDED') return false;
  if (!paymentMatchesOrderIdentity(payment,order)) return false;
  return moneyCents(completedRefundTotal(payment)) === moneyCents(order.amount);
}
