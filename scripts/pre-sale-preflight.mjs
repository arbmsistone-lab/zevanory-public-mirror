import { Resolver } from 'node:dns/promises';
import { evaluatePreSaleReadiness, REQUIRED_DNS_RESOLVERS } from '../src/preSaleReadiness.mjs';

const domain='zevanory.api.br';
const DNS_TIMEOUT_MS=2500;
async function withTimeout(promise,ms=DNS_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_,reject)=>{ timer=setTimeout(()=>reject(new Error('dns_timeout')),ms); }),
    ]);
  } finally { clearTimeout(timer); }
}
async function hasAddress(server) {
  const resolver=new Resolver();
  resolver.setServers([server]);
  try {
    const a=await withTimeout(resolver.resolve4(domain));
    if(a.length) return true;
  } catch {}
  try {
    const aaaa=await withTimeout(resolver.resolve6(domain));
    return aaaa.length>0;
  } catch { return false; }
}

async function hasVercelTxt() {
  const resolver=new Resolver();
  resolver.setServers(['1.1.1.1']);
  try {
    const rows=await withTimeout(resolver.resolveTxt(`_vercel.${domain}`));
    return rows.flat().some((x)=>String(x).startsWith('vc-domain-verify='));
  } catch { return false; }
}
const dns=[];
for(const server of REQUIRED_DNS_RESOLVERS) dns.push({server,address:await hasAddress(server)});
const dnsReady=dns.every((item)=>item.address===true);
async function probeCustomDomain() {
  if(!dnsReady) return {https:false,routes:false};
  const paths=['/','/piloto','/api/release','/api/config'];
  let https=false;
  for(const path of paths) {
    try {
      const response=await fetch(`https://${domain}${path}`,{signal:AbortSignal.timeout(3000)});
      if(path==='/') https=response.status===200;
      if(response.status!==200) return {https,routes:false};
    } catch { return {https:false,routes:false}; }
  }
  return {https,routes:true};
}
const customDomain=await probeCustomDomain();
const result=evaluatePreSaleReadiness({
  dns,
  vercel_txt:await hasVercelTxt(),
  vercel_claim_not_required:false,
  https_ready:customDomain.https,
  routes_ready:customDomain.routes,
  asaas_key:Boolean(process.env.ASAAS_API_KEY),
  asaas_webhook:Boolean(process.env.ASAAS_WEBHOOK_TOKEN),
  asaas_env_sandbox:String(process.env.ASAAS_ENV||'').toLowerCase()==='sandbox',
  public_base:Boolean(process.env.PUBLIC_BASE_URL),
});
console.log(JSON.stringify({
  ready:result.ready,
  dns:result.dns_ready,
  ownership:result.ownership_ready,
  https:result.https_ready,
  routes:result.routes_ready,
  asaas:result.asaas_ready,
  blockers:result.blockers,
}));
process.exit(result.ready?0:2);
