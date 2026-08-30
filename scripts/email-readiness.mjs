import dns from 'node:dns/promises';
import { evaluateEmailReadiness } from '../src/emailReadiness.mjs';

const safe = async (fn) => { try { return await fn(); } catch { return []; } };
const [mx, dkim, dmarc] = await Promise.all([
  safe(()=>dns.resolveMx('zevanory.api.br')),
  safe(()=>dns.resolveTxt('resend._domainkey.zevanory.api.br')),
  safe(()=>dns.resolveTxt('_dmarc.zevanory.api.br')),
]);
const result = evaluateEmailReadiness({ mx, dkim, dmarc, env:process.env });
console.log(JSON.stringify(result,null,2));
process.exitCode = result.activation_ready ? 0 : 2;
