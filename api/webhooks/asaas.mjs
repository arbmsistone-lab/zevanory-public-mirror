import { neon } from '@neondatabase/serverless';
import {
  secureTokenEqual,
  normalizeAsaasWebhook,
  normalizeFinancialEvent,
  paymentMatchesWebhook,
  parseExternalReference,
  asaasBaseUrl,
} from '../../src/asaas.mjs';

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
  const webhook = normalizeAsaasWebhook(req.body);
  if (!webhook) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'unsupported_webhook', accepted: false }));
  }
  try {
    const payment = await fetchAsaasPayment(webhook.paymentId, process.env.ASAAS_ENV, process.env.ASAAS_API_KEY);
    if (!paymentMatchesWebhook(webhook, payment)) {
      res.statusCode = 409;
      return res.end(JSON.stringify({ error: 'payment_reconciliation_failed', accepted: false }));
    }
    const normalized = normalizeFinancialEvent(webhook.eventName);
    const externalReference = String(payment.externalReference);
    const orderId = parseExternalReference(externalReference);
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql.query(`
      INSERT INTO financial_events
        (provider_event_id,provider,provider_payment_id,normalized_event,provider_event_name,provider_status,external_reference,amount,order_id)
      VALUES ($1,'asaas',$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT DO NOTHING
      RETURNING provider_event_id
    `, [webhook.providerEventId,webhook.paymentId,normalized,webhook.eventName,String(payment.status),externalReference,Number(payment.value),orderId]);
    res.statusCode = 202;
    return res.end(JSON.stringify({ accepted: true, duplicate: rows.length === 0, event: normalized, order_id: orderId }));
  } catch {
    res.statusCode = 503;
    return res.end(JSON.stringify({ error: 'financial_reconciliation_unavailable', accepted: false }));
  }
}
