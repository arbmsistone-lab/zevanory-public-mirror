import { PROJECT } from '../src/config.mjs';
import { salesGate, channelEnabled } from '../src/salesGate.mjs';
import { buildActivationPlan } from '../src/activationPlan.mjs';
import { RELEASE } from '../src/release.mjs';
import { publicOffer } from '../src/offerCatalog.mjs';

export default function handler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'method_not_allowed' }));
  }
  const url=new URL(req.url||'/api/config','https://zevanory.api.br');
  if(url.searchParams.get('view')==='activation'){
    const plan=buildActivationPlan(process.env);
    res.setHeader('content-type','application/json; charset=utf-8');
    res.setHeader('cache-control','no-store');
    res.setHeader('x-content-type-options','nosniff');
    res.statusCode=200;
    return res.end(JSON.stringify({service:'ZEVANORY',release_id:RELEASE.id,activation_phase:plan.phase,inputs_ready:plan.inputs_ready,commercial_enabled:plan.commercial_enabled,offer_type:plan.offer_type,external_inputs_remaining:plan.external_inputs_remaining,missing:plan.missing,gates:plan.gates,cutover_order:plan.cutover_order,rollback_order:plan.rollback_order}));
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
    offer: publicOffer(),
    support_whatsapp_number: PROJECT.officialWhatsappE164,
    production_mode: gate.enabled ? 'commercial-gated' : 'pre-sale-blocked'
  }));
}
