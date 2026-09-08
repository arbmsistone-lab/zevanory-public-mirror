import dns from 'node:dns/promises';
import { evaluateEmailReadiness } from '../src/emailReadiness.mjs';
const domain = 'zevanory.api.br';
const safe = async fn => { try { return await fn(); } catch { return []; } };
const failures = [];
async function api(path) {
  if (!process.env.RESEND_API_KEY) throw new Error('api_key_missing');
  const r = await fetch('https://api.resend.com'+path, {headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY}, signal:AbortSignal.timeout(15000)});
  const b = await r.json();
  if (!r.ok || b.error || b.name?.endsWith('_error')) throw new Error('provider_http_'+r.status);
  return b;
}
let providerDomain = null, webhookVerified = false;
try {
  const domains = await api('/domains');
  const found = domains.data?.find(x=>x.name===domain);
  if (!found) throw new Error('domain_not_found');
  providerDomain = await api('/domains/'+encodeURIComponent(found.id));
  const webhooks = await api('/webhooks');
  webhookVerified = webhooks.data?.some(x=>x.endpoint==='https://zevanory.api.br/api/webhooks/resend' && x.status==='enabled' && x.events?.includes('email.received')) === true;
} catch (e) { failures.push(/^provider_http_\d+$|^api_key_missing$|^domain_not_found$/.test(e.message)?e.message:'provider_lookup_failed'); }
const signing = providerDomain?.records?.filter(r=>r.type==='TXT' && r.record==='DKIM') || [];
const signingNames = signing.map(r=>String(r.name).endsWith('.'+domain)?r.name:r.name+'.'+domain);
const [mx, dkim, dmarc] = await Promise.all([
  safe(()=>dns.resolveMx(domain)),
  Promise.all(signingNames.map(name=>safe(()=>dns.resolveTxt(name)))).then(rows=>rows.flat()),
  safe(()=>dns.resolveTxt('_dmarc.'+domain)),
]);
const result = evaluateEmailReadiness({ mx, dkim, dmarc, env:process.env, providerDomain, webhookVerified });
console.log(JSON.stringify({checked_at:new Date().toISOString(), ...result, failures},null,2));
process.exitCode = result.activation_ready ? 0 : 2;
