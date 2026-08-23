import { PROJECT } from '../src/config.mjs';
import { salesGate, channelEnabled } from '../src/salesGate.mjs';

export default function handler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'method_not_allowed' }));
  }
  const gate=salesGate();
  const whatsappEnabled=channelEnabled('WHATSAPP_SALES_ENABLED');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.statusCode = 200;
  return res.end(JSON.stringify({
    commercial_enabled: gate.enabled,
    commercial_blockers: gate.blockers,
    whatsapp_enabled: whatsappEnabled,
    whatsapp_number: whatsappEnabled ? PROJECT.officialWhatsappE164 : null,
    offer_id: PROJECT.offerId,
    experiment_id: PROJECT.experimentId,
    experimental_price_brl: PROJECT.experimentalPriceBrl,
    production_mode: gate.enabled ? 'commercial-gated' : 'pre-sale-blocked'
  }));
}
