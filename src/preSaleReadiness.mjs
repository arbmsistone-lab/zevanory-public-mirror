export const REQUIRED_DNS_RESOLVERS = Object.freeze(['1.1.1.1','8.8.8.8','9.9.9.9']);

export function evaluatePreSaleReadiness(input={}) {
  const dns=Array.isArray(input.dns)?input.dns:[];
  const dnsReady=REQUIRED_DNS_RESOLVERS.every((server)=>
    dns.some((item)=>item.server===server && item.address===true)
  );
  const ownershipReady=input.vercel_txt===true || input.vercel_claim_not_required===true;
  const asaasReady=input.asaas_key===true && input.asaas_webhook===true &&
    input.asaas_env_sandbox===true && input.public_base===true;
  const blockers=[];
  if(!dnsReady) blockers.push('custom_domain_dns_unready');
  if(!ownershipReady) blockers.push('vercel_ownership_unverified');
  if(!asaasReady) blockers.push('asaas_sandbox_unconfigured');
  return Object.freeze({
    ready:blockers.length===0,
    dns_ready:dnsReady,
    ownership_ready:ownershipReady,
    asaas_ready:asaasReady,
    blockers:Object.freeze(blockers),
  });
}
