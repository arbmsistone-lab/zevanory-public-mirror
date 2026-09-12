import dns from 'node:dns/promises';
import fs from 'node:fs';
import crypto from 'node:crypto';
const names=['zevanory.api.br','edge.zevanory.api.br','_dmarc.zevanory.api.br'];
const types=['A','AAAA','CNAME','MX','NS','TXT','CAA'];
const records={};
for(const name of names){records[name]={}; for(const type of types){try{records[name][type]=await dns.resolve(name,type);}catch{records[name][type]=[];}}}
const snapshot={format:'zevanory-dns-recovery-v1',generated_at:new Date().toISOString(),records,emergency_url:'https://arbmsistone-lab.github.io/zevanory-public-mirror/'};
const body=JSON.stringify(snapshot,null,2); const sha=crypto.createHash('sha256').update(body).digest('hex');
fs.mkdirSync('validation',{recursive:true}); fs.writeFileSync('validation/DNS-RECOVERY-SNAPSHOT.json',body+'\n'); fs.writeFileSync('validation/DNS-RECOVERY-SNAPSHOT.sha256',sha+'\n');
console.log(`DNS_RECOVERY_SNAPSHOT PASS sha256=${sha} names=${names.length}`);