export const PAYMENT_PROVIDERS=Object.freeze(['asaas','mercadopago']);

const present=(value)=>Boolean(String(value||'').trim());

export function normalizePaymentProvider(value){
  const provider=String(value||'').trim().toLowerCase();
  return PAYMENT_PROVIDERS.includes(provider)?provider:'';
}

export function paymentProviderReadiness(env=process.env,{production=true}={}){
  const provider=normalizePaymentProvider(env.PAYMENT_PROVIDER);
  const blockers=[];
  if(!provider) blockers.push('payment_provider_not_selected');
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
  return Object.freeze({provider:provider||null,ready:blockers.length===0,blockers:Object.freeze(blockers)});
}