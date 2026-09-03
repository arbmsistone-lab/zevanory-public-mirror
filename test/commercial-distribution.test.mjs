import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMERCIAL_DISTRIBUTION_CANONICAL, REQUIRED_DISTRIBUTION_FRONTS, commercialDistributionReadiness } from '../src/commercialDistribution.mjs';
import { evaluateAffiliateProgramReadiness, AFFILIATE_COMMISSION_STATES, AFFILIATE_REVENUE_TRUTH } from '../src/affiliateProgram.mjs';
import { buildOutboundAdapters } from '../src/outboundAdapters.mjs';

const certifiedGate=()=>({enabled:true});
const response=(status,body={})=>({status,json:async()=>body,headers:{get:()=>null}});
const affiliateEnv={AFFILIATE_PROVIDER:'network',AFFILIATE_WEBHOOK_URL:'https://affiliate.example/webhook',AFFILIATE_WEBHOOK_TOKEN:'token',AFFILIATE_TRACKING_READY:'true',AFFILIATE_TERMS_REVIEWED:'true',AFFILIATE_TERMS_VERSION:'v1',AFFILIATE_ATTRIBUTION_WINDOW_DAYS:'30',AFFILIATE_COMMISSION_BPS:'1000',AFFILIATE_PAYOUT_DELAY_DAYS:'30',AFFILIATE_SELF_REFERRAL_POLICY:'blocked',AFFILIATE_REFUND_REVERSAL_READY:'true',AFFILIATE_CHARGEBACK_REVERSAL_READY:'true',AFFILIATE_IDEMPOTENCY_READY:'true',AFFILIATE_PROVIDER_CONFIRMATION_READY:'true',AFFILIATE_DISCLOSURE_URL:'https://zevanory.api.br/afiliados',AFFILIATE_PRIVACY_URL:'https://zevanory.api.br/politica-de-privacidade'};

test('canonical distribution covers every intended commercial front',()=>{
  assert.deepEqual(REQUIRED_DISTRIBUTION_FRONTS,['zevanory','whatsapp','email','instagram','facebook','tiktok','youtube','linkedin','google','affiliate','nuvemshop','mercado_livre']);
  assert.equal(Object.keys(COMMERCIAL_DISTRIBUTION_CANONICAL).length,12);
  assert.ok(Object.values(COMMERCIAL_DISTRIBUTION_CANONICAL).every(x=>x.global_gate_required&&x.policy_complete&&x.attribution&&x.provider_confirmation));
});

test('technical distribution is complete while external configuration remains fail closed',()=>{
  const r=commercialDistributionReadiness({});
  assert.equal(r.technical_ready,true);
  assert.equal(r.operational_ready,false);
  assert.equal(r.total_fronts,12);
  assert.ok(r.blockers.some(x=>x.startsWith('affiliate:')));
  assert.ok(r.blockers.some(x=>x.startsWith('nuvemshop:')));
  assert.ok(r.blockers.some(x=>x.startsWith('mercado_livre:')));
});

test('affiliate program requires professional policy, anti-fraud and provider truth',()=>{
  const missing=evaluateAffiliateProgramReadiness({});
  assert.equal(missing.ready,false);
  for(const code of ['affiliate_attribution_window_invalid','affiliate_commission_bps_invalid','affiliate_self_referral_policy_invalid','affiliate_refund_reversal_unready','affiliate_chargeback_reversal_unready','affiliate_idempotency_unready','affiliate_provider_confirmation_unready']) assert.ok(missing.blockers.includes(code));
  const ready=evaluateAffiliateProgramReadiness(affiliateEnv);
  assert.equal(ready.ready,true);
  assert.equal(ready.revenue_truth,AFFILIATE_REVENUE_TRUTH);
  assert.deepEqual([...AFFILIATE_COMMISSION_STATES],['pending','confirmed','reversed','paid']);
});

test('Nuvemshop outbound uses official v1 products API and remains globally gated',async()=>{
  const calls=[];const env={NUVEMSHOP_ACCESS_TOKEN:'token',NUVEMSHOP_STORE_ID:'123',NUVEMSHOP_APP_ID:'app'};
  const a=buildOutboundAdapters({env,commercialGate:certifiedGate,fetchImpl:async(url,opt)=>{calls.push({url,opt});return response(201,{id:99});}});
  const out=await a['channel:nuvemshop']({event_id:'e1',idempotency_key:'i1',payload:{product:{name:'ARBM SIST'}}});
  assert.equal(out.provider_product_id,'99');assert.equal(calls[0].url,'https://api.nuvemshop.com/v1/123/products');assert.equal(calls[0].opt.headers.authorization,'Bearer token');assert.match(calls[0].opt.headers['user-agent'],/ZEVANORY/);
  const closed=buildOutboundAdapters({env,fetchImpl:async()=>response(201,{id:1})});
  await assert.rejects(()=>closed['channel:nuvemshop']({payload:{product:{name:'x'}}}),/commercial_gates_closed/);
});

test('Mercado Livre outbound creates item with bearer token and requires provider id',async()=>{
  const calls=[];const env={MERCADOLIVRE_ACCESS_TOKEN:'token'};
  const a=buildOutboundAdapters({env,commercialGate:certifiedGate,fetchImpl:async(url,opt)=>{calls.push({url,opt});return response(201,{id:'MLB1'});}});
  const out=await a['channel:mercado_livre']({payload:{item:{title:'ARBM SIST'}}});
  assert.equal(out.provider_item_id,'MLB1');assert.equal(calls[0].url,'https://api.mercadolibre.com/items');assert.equal(calls[0].opt.headers.authorization,'Bearer token');
});

test('marketplace identities and webhook verification are mandatory for readiness',()=>{
  const n={NUVEMSHOP_ACCESS_TOKEN:'t',NUVEMSHOP_STORE_ID:'s',NUVEMSHOP_APP_ID:'a'};
  assert.equal(commercialDistributionReadiness(n).fronts.nuvemshop.operational_ready,false);
  const m={MERCADOLIVRE_ACCESS_TOKEN:'t',MERCADOLIVRE_APP_ID:'a',MERCADOLIVRE_SELLER_ID:'s'};
  assert.equal(commercialDistributionReadiness(m).fronts.mercado_livre.operational_ready,false);
});