import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMERCIAL_DISTRIBUTION_CANONICAL, REQUIRED_DISTRIBUTION_FRONTS, commercialDistributionReadiness } from '../src/commercialDistribution.mjs';
import { evaluateAffiliateProgramReadiness, AFFILIATE_COMMISSION_STATES, AFFILIATE_REVENUE_TRUTH } from '../src/affiliateProgram.mjs';
import { buildOutboundAdapters } from '../src/outboundAdapters.mjs';
import { encryptSecret } from '../src/mercadoLivreOAuth.mjs';
import { encryptCommercialSecret } from '../src/commercialOAuthCrypto.mjs';

const certifiedGate=()=>({enabled:true});
const response=(status,body={})=>({status,json:async()=>body,headers:{get:()=>null}});
const affiliateEnv={AFFILIATE_PROVIDER:'network',AFFILIATE_WEBHOOK_URL:'https://affiliate.example/webhook',AFFILIATE_WEBHOOK_TOKEN:'token',AFFILIATE_TRACKING_READY:'true',AFFILIATE_TERMS_REVIEWED:'true',AFFILIATE_TERMS_VERSION:'v1',AFFILIATE_ATTRIBUTION_WINDOW_DAYS:'30',AFFILIATE_COMMISSION_BPS:'1000',AFFILIATE_PAYOUT_DELAY_DAYS:'30',AFFILIATE_SELF_REFERRAL_POLICY:'blocked',AFFILIATE_REFUND_REVERSAL_READY:'true',AFFILIATE_CHARGEBACK_REVERSAL_READY:'true',AFFILIATE_IDEMPOTENCY_READY:'true',AFFILIATE_PROVIDER_CONFIRMATION_READY:'true',AFFILIATE_DISCLOSURE_URL:'https://zevanory.api.br/afiliados',AFFILIATE_PRIVACY_URL:'https://zevanory.api.br/politica-de-privacidade'};

test('canonical distribution covers every intended commercial front',()=>{
  assert.deepEqual(REQUIRED_DISTRIBUTION_FRONTS,['zevanory','whatsapp','email','instagram','facebook','youtube','google','affiliate','mercado_livre']);
  assert.equal(Object.keys(COMMERCIAL_DISTRIBUTION_CANONICAL).length,12);
  assert.ok(Object.values(COMMERCIAL_DISTRIBUTION_CANONICAL).every(x=>x.global_gate_required&&x.policy_complete&&x.attribution&&x.provider_confirmation));
});

test('technical distribution is complete while external configuration remains fail closed',()=>{
  const r=commercialDistributionReadiness({});
  assert.equal(r.technical_ready,true);
  assert.equal(r.operational_ready,false);
  assert.equal(r.total_fronts,9);
  assert.ok(r.blockers.some(x=>x.startsWith('affiliate:')));
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

test('excluded TikTok LinkedIn and Nuvemshop cannot execute even with open gate',async()=>{
  const a=buildOutboundAdapters({env:{},commercialGate:certifiedGate,fetchImpl:async()=>response(200,{})});
  await assert.rejects(()=>a['channel:tiktok']({payload:{}},{sql:{query:async()=>[]}}),/channel_excluded_from_active_scope/);
  await assert.rejects(()=>a['channel:nuvemshop']({payload:{}},{sql:{query:async()=>[]}}),/channel_excluded_from_active_scope/);
  await assert.rejects(()=>a['channel:linkedin']({payload:{}},{sql:{query:async()=>[]}}),/channel_excluded_from_active_scope/);
});

test('Mercado Livre outbound uses persisted OAuth credential and requires provider id',async()=>{
  const calls=[];const env={MERCADOLIVRE_TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64')};
  const sql={query:async()=>[{account_id:'999',access_token_enc:encryptSecret('token',env),refresh_token_enc:encryptSecret('refresh',env),expires_at:new Date(Date.now()+3600000)}]};
  const a=buildOutboundAdapters({env,commercialGate:certifiedGate,fetchImpl:async(url,opt)=>{calls.push({url,opt});return response(201,{id:'MLB1'});}});
  const out=await a['channel:mercado_livre']({payload:{item:{title:'ARBM SIST'}}},{sql});
  assert.equal(out.provider_item_id,'MLB1');assert.equal(out.seller_id,'999');assert.equal(calls[0].url,'https://api.mercadolibre.com/items');assert.equal(calls[0].opt.headers.authorization,'Bearer token');
});

test('active marketplace identity and webhook verification remain mandatory',()=>{
  const r=commercialDistributionReadiness({MERCADOLIVRE_ACCESS_TOKEN:'t',MERCADOLIVRE_APP_ID:'a',MERCADOLIVRE_SELLER_ID:'s'});
  assert.equal(r.fronts.linkedin,undefined);
  assert.equal(r.fronts.nuvemshop,undefined);
  assert.equal(r.fronts.mercado_livre.operational_ready,false);
});
test('first-party affiliate readiness does not require an external webhook provider',()=>{
  const env={AFFILIATE_PROVIDER:'zevanory-first-party',AFFILIATE_TRACKING_READY:'true',AFFILIATE_TERMS_REVIEWED:'true',AFFILIATE_TERMS_VERSION:'2026-09',AFFILIATE_ATTRIBUTION_WINDOW_DAYS:'30',AFFILIATE_COMMISSION_BPS:'1000',AFFILIATE_PAYOUT_DELAY_DAYS:'30',AFFILIATE_SELF_REFERRAL_POLICY:'blocked',AFFILIATE_REFUND_REVERSAL_READY:'true',AFFILIATE_CHARGEBACK_REVERSAL_READY:'true',AFFILIATE_IDEMPOTENCY_READY:'true',AFFILIATE_PROVIDER_CONFIRMATION_READY:'true',AFFILIATE_DISCLOSURE_URL:'https://zevanory.api.br/afiliados',AFFILIATE_PRIVACY_URL:'https://zevanory.api.br/privacidade'};
  assert.equal(evaluateAffiliateProgramReadiness(env).ready,true);
  assert.equal(commercialDistributionReadiness(env).fronts.affiliate.operational_ready,true);
});
