import { createHash } from 'node:crypto';

export const PAYMENT_PROVIDERS=Object.freeze(['asaas','mercadopago']);
const present=(value)=>Boolean(String(value||'').trim());
const csv=(value)=>String(value||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);

export function normalizePaymentProvider(value){
  const provider=String(value||'').trim().toLowerCase();
  return PAYMENT_PROVIDERS.includes(provider)?provider:'';
}

function readinessFor(provider,env,{production=true}={}){
  const blockers=[];
  const delegated=String(env.PAYMENT_RUNTIME_MODE||'').trim().toLowerCase()==='delegated';
  const delegatedReady=delegated&&String(env.PAYMENT_RUNTIME_ORIGIN_VERIFIED||'').toLowerCase()==='true';
  const pool=csv(env.PAYMENT_PROVIDER_POOL);
  const legacy=normalizePaymentProvider(env.PAYMENT_PROVIDER);
  if(delegatedReady && (pool.includes(provider)||legacy===provider)) return Object.freeze({provider,ready:true,delegated:true,blockers:Object.freeze([])});
  if(delegated&&!delegatedReady) blockers.push('payment_runtime_origin_unverified');
  if(provider==='asaas'){
    const mode=String(env.ASAAS_ENV||'').trim().toLowerCase();
    if(mode!==(production?'production':'sandbox')) blockers.push(production?'asaas_production_not_configured':'asaas_sandbox_unconfigured');
    if(!present(env.ASAAS_API_KEY)||!present(env.ASAAS_WEBHOOK_TOKEN)) blockers.push('asaas_credentials_missing');
  }
  if(provider==='mercadopago'){
    const mode=String(env.MERCADOPAGO_ENV||'').trim().toLowerCase();
    if(mode!==(production?'production':'sandbox')) blockers.push(production?'mercadopago_production_not_configured':'mercadopago_sandbox_unconfigured');
    if(!present(env.MERCADOPAGO_ACCESS_TOKEN)||!present(env.MERCADOPAGO_WEBHOOK_SECRET)) blockers.push('mercadopago_credentials_missing');
  }
  return Object.freeze({provider,ready:blockers.length===0,delegated:false,blockers:Object.freeze(blockers)});
}
export function paymentProviderCandidates(env=process.env,{production=true}={}){
  const preferred=normalizePaymentProvider(env.PAYMENT_PROVIDER);
  const pool=csv(env.PAYMENT_PROVIDER_POOL).filter(x=>PAYMENT_PROVIDERS.includes(x));
  const ordered=[...new Set([preferred,...pool,...PAYMENT_PROVIDERS].filter(Boolean))];
  return Object.freeze(ordered.map(provider=>readinessFor(provider,env,{production})));
}

export function selectPaymentProvider(env=process.env,{production=true,operationKey=''}={}){
  const ready=paymentProviderCandidates(env,{production}).filter(x=>x.ready);
  if(!ready.length) return Object.freeze({provider:null,ready:false,reason:'no_payment_provider_available',candidates:paymentProviderCandidates(env,{production})});
  const preferred=normalizePaymentProvider(env.PAYMENT_PROVIDER);
  if(preferred){const match=ready.find(x=>x.provider===preferred);if(match)return Object.freeze({...match,reason:'preferred_ready'});}
  const digest=createHash('sha256').update(String(operationKey||'zevanory')).digest();
  const selected=ready[digest[0]%ready.length];
  return Object.freeze({...selected,reason:ready.length>1?'deterministic_pool_selection':'single_ready_provider'});
}

export function paymentProviderReadiness(env=process.env,{production=true}={}){
  const selected=selectPaymentProvider(env,{production});
  const blockers=selected.ready?[]:['payment_provider_pool_unavailable',...selected.candidates.flatMap(x=>x.blockers.map(b=>`${x.provider}:${b}`))];
  return Object.freeze({provider:selected.provider,ready:selected.ready,delegated:Boolean(selected.delegated),selection_reason:selected.reason,candidates:selected.candidates||paymentProviderCandidates(env,{production}),blockers:Object.freeze(blockers)});
}
export function resolveCheckoutProviderRequest(req={},env=process.env,{production=true}={}){
  const direct=normalizePaymentProvider(req.query?.provider);
  let explicit=direct;
  if(!explicit){
    try{explicit=normalizePaymentProvider(new URL(req.url||'', 'https://zevanory.api.br').searchParams.get('provider'));}catch{}
  }
  if(explicit){
    const candidate=paymentProviderCandidates(env,{production}).find(x=>x.provider===explicit);
    return Object.freeze({provider:explicit,ready:Boolean(candidate?.ready),reason:candidate?.ready?'explicit_ready':'explicit_unavailable'});
  }
  const key=String(req.body?.request_id||req.body?.requestId||req.body?.session_id||req.body?.sessionId||'');
  return selectPaymentProvider(env,{production,operationKey:key});
}
