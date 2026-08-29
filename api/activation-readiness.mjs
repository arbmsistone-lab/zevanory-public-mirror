import { buildActivationPlan } from '../src/activationPlan.mjs';
import { RELEASE } from '../src/release.mjs';

export default function handler(req,res){
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control','no-store');
  res.setHeader('x-content-type-options','nosniff');
  if(req.method!=='GET'){
    res.statusCode=405;
    return res.end(JSON.stringify({error:'method_not_allowed'}));
  }
  const plan=buildActivationPlan(process.env);
  res.statusCode=200;
  return res.end(JSON.stringify({
    service:'ZEVANORY',
    release_id:RELEASE.id,
    activation_phase:plan.phase,
    inputs_ready:plan.inputs_ready,
    commercial_enabled:plan.commercial_enabled,
    offer_type:plan.offer_type,
    external_inputs_remaining:plan.external_inputs_remaining,
    missing:plan.missing,
    gates:plan.gates,
    cutover_order:plan.cutover_order,
    rollback_order:plan.rollback_order,
  }));
}
