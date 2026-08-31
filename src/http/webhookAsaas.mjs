import { neon } from '@neondatabase/serverless';
import {
  secureTokenEqual,
  normalizeAsaasWebhook,
  normalizeFinancialEvent,
  paymentMatchesOrderWebhook,
  supersededPartialRefund,
  parseExternalReference,
  refundTotalForWebhook,
  asaasBaseUrl,
} from '../asaas.mjs';

export async function fetchAsaasPayment(paymentId, env, apiKey, fetchImpl = fetch) {
  const base = asaasBaseUrl(env);
  if (!base || !apiKey) throw new Error('asaas_not_configured');
  const response = await fetchImpl(`${base}/payments/${encodeURIComponent(paymentId)}`, {
    method: 'GET',
    headers: { accept: 'application/json', access_token: apiKey },
  });
  if (!response.ok) throw new Error(`asaas_lookup_${response.status}`);
  return response.json();
}

function json(res,status,body) {
  res.statusCode=status;
  return res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'method_not_allowed' }));
  }
  const webhookToken = process.env.ASAAS_WEBHOOK_TOKEN;
  const provided = req.headers?.['asaas-access-token'];
  if (!secureTokenEqual(webhookToken, provided)) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ error: 'webhook_auth_failed', accepted: false }));
  }
  if (process.env.FINANCIAL_EVENTS_ENABLED !== 'true') {
    res.statusCode = 503;
    return res.end(JSON.stringify({ error: 'financial_events_disabled', accepted: false }));
  }
  if (!process.env.DATABASE_URL || !process.env.ASAAS_API_KEY || !asaasBaseUrl(process.env.ASAAS_ENV)) {
    res.statusCode = 503;
    return res.end(JSON.stringify({ error: 'financial_provider_unavailable', accepted: false }));
  }
  const webhook = normalizeAsaasWebhook(req.parsedBody??req.body);
  if (!webhook) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'unsupported_webhook', accepted: false }));
  }
  try {
    const payment = await fetchAsaasPayment(webhook.paymentId, process.env.ASAAS_ENV, process.env.ASAAS_API_KEY);
    const parsedOrderId=parseExternalReference(payment.externalReference);
    const checkoutSession=String(payment.checkoutSession||'');
    const sql = neon(process.env.DATABASE_URL);
    const orders=await sql.query(`
      SELECT order_id,amount,status,external_reference,provider_checkout_id FROM orders
      WHERE ($1<>'' AND order_id::text=$1) OR ($2<>'' AND provider_checkout_id=$2)
    `,[parsedOrderId||'',checkoutSession]);
    if (orders.length === 0) return json(res,200,{accepted:true,ignored:true,reason:'unlinked_payment'});
    if (orders.length === 1 && supersededPartialRefund(webhook,payment,orders[0])) return json(res,200,{accepted:true,ignored:true,reason:'superseded_partial_refund'});
    if (orders.length !== 1 || !paymentMatchesOrderWebhook(webhook,payment,orders[0])) {
      res.statusCode = 409;
      return res.end(JSON.stringify({ error: 'payment_reconciliation_failed', accepted: false }));
    }
    const normalized = normalizeFinancialEvent(webhook.eventName);
    const externalReference = String(orders[0].external_reference);
    const orderId = String(orders[0].order_id);
    const refundedTotal = normalized === 'refund_confirmed' ? refundTotalForWebhook(webhook,payment) : null;
    const rows = await sql.query(`
      WITH target AS (
        SELECT order_id, amount, status FROM orders
        WHERE order_id=$8 AND external_reference=$6 AND provider_checkout_id=$10 AND amount=$7 AND (
          ($3='payment_confirmed' AND status IN ('checkout_ready','checkout_uncertain','paid')) OR
          ($3='refund_confirmed' AND status IN ('paid','partially_refunded','refunded'))
        )
      ), inserted AS (
        INSERT INTO financial_events
          (provider_event_id,provider,provider_payment_id,normalized_event,provider_event_name,provider_status,external_reference,amount,order_id,refunded_total)
        SELECT $1,'asaas',$2,$3,$4,$5,$6,$7,order_id,$9 FROM target
        ON CONFLICT DO NOTHING
        RETURNING order_id,normalized_event,refunded_total
      ), updated AS (
        UPDATE orders o SET status=CASE
          WHEN i.normalized_event='payment_confirmed' THEN 'paid'
          WHEN i.refunded_total >= o.amount THEN 'refunded'
          ELSE 'partially_refunded'
        END, updated_at=now()
        FROM inserted i WHERE o.order_id=i.order_id
        RETURNING o.order_id,o.status
      )
      SELECT
        (SELECT count(*)::int FROM target) AS target_count,
        (SELECT count(*)::int FROM inserted) AS inserted_count,
        (SELECT status FROM updated LIMIT 1) AS order_status,
        (SELECT status FROM orders WHERE order_id=$8) AS current_status
    `, [webhook.providerEventId,webhook.paymentId,normalized,webhook.eventName,String(payment.status),externalReference,Number(payment.value),orderId,refundedTotal,String(orders[0].provider_checkout_id)]);
    const outcome=rows[0]||{};
    if(Number(outcome.target_count)!==1) return json(res,409,{error:'order_state_invalid',accepted:false});
    if(Number(outcome.inserted_count)===1 && !outcome.order_status) return json(res,503,{error:'order_state_update_failed',accepted:false});
    res.statusCode = 200;
    return res.end(JSON.stringify({ accepted: true, duplicate: Number(outcome.inserted_count)===0, event: normalized, order_id: orderId, order_status: outcome.order_status||outcome.current_status, refunded_total: refundedTotal }));
  } catch {
    res.statusCode = 503;
    return res.end(JSON.stringify({ error: 'financial_reconciliation_unavailable', accepted: false }));
  }
}
