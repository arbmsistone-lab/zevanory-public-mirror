import { PROJECT } from '../src/config.mjs';

export default function handler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'method_not_allowed' }));
  }

  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.statusCode = 200;
  return res.end(JSON.stringify({
    whatsapp_enabled: true,
    whatsapp_number: PROJECT.officialWhatsappE164,
    offer_id: PROJECT.offerId,
    experiment_id: PROJECT.experimentId,
    experimental_price_brl: PROJECT.experimentalPriceBrl,
    production_mode: 'telemetry-active-payment-pending'
  }));
}
