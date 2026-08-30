export const REQUIRED_DNS_RESOLVERS=Object.freeze(['1.1.1.1','8.8.8.8','9.9.9.9']);
const provider=(value)=>['asaas','mercadopago'].includes(String(value||'').toLowerCase())?String(value).toLowerCase():'';

export function evaluatePreSaleReadiness(input={}){
  const dns=Array.isArray(input.dns)?input.dns:[];
  const dnsReady=REQUIRED_DNS_RESOLVERS.every(server=>dns.some(item=>item.server===server&&item.address===true));
  const ownershipReady=input.vercel_txt===true||input.vercel_claim_not_required===true;
  const httpsReady=input.https_ready===true; const routesReady=input.routes_ready===true;
  const commercialFlagsSafe=[input.sale_globally_enabled,input.pre_sale_gates_approved,input.checkout_enabled,input.whatsapp_sales_enabled,input.financial_events_enabled].every(value=>value!==true);
  const selected=provider(input.payment_provider);
  const common=input.database_url===true&&input.public_base_https===true&&commercialFlagsSafe;
  const asaasReady=selected==='asaas'&&input.asaas_key===true&&input.asaas_webhook===true&&input.asaas_env_sandbox===true&&common;
  const mercadoPagoReady=selected==='mercadopago'&&input.mercadopago_token===true&&input.mercadopago_webhook===true&&input.mercadopago_env_sandbox===true&&common;
  const paymentReady=asaasReady||mercadoPagoReady;
  const blockers=[];
  if(!dnsReady) blockers.push('custom_domain_dns_unready');
  if(!ownershipReady) blockers.push('vercel_ownership_unverified');
  if(!httpsReady) blockers.push('custom_domain_https_unready');
  if(!routesReady) blockers.push('custom_domain_routes_unready');
  if(!selected) blockers.push('payment_provider_not_selected');
  else if(!paymentReady) blockers.push(`${selected}_sandbox_unconfigured`);
  return Object.freeze({ready:blockers.length===0,dns_ready:dnsReady,ownership_ready:ownershipReady,https_ready:httpsReady,routes_ready:routesReady,payment_provider:selected||null,payment_ready:paymentReady,asaas_ready:asaasReady,mercadopago_ready:mercadoPagoReady,commercial_flags_safe:commercialFlagsSafe,blockers:Object.freeze(blockers)});
}