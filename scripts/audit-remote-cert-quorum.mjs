import { execFileSync } from 'node:child_process';
import { validateAttestation } from './remote-attestation.mjs';
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const expected=(process.env.CERT_SHA||git('rev-parse','HEAD')).trim();
const remoteSha=(remote)=>git('ls-remote',remote,'refs/heads/main').split(/\s+/)[0]||'';
const results=[];
for(const [domain,remote] of [['github','origin'],['gitlab','gitlab']]){
  try { const sha=remoteSha(remote); results.push({domain,ok:false,sha,status:sha?200:404,error:'commit_presence_is_not_remote_certification'}); }
  catch(error){ results.push({domain,ok:false,error:String(error?.message||error)}); }
}
for(const [domain,url] of [
  ['cloudflare','https://zevanory-remote-certifier.zevanory.workers.dev/'],
  ['supabase','https://fxjytqscrnttcqovigpp.supabase.co/functions/v1/zevanory-remote-cert-v1'],
]){
  try { const r=await fetch(url,{headers:{'user-agent':'zevanory-cert/1'}}); const j=await r.json(); const sha=j.commit_sha; results.push({domain,ok:r.ok&&validateAttestation(j,expected),sha,status:r.status}); }
  catch(error){ results.push({domain,ok:false,error:String(error?.message||error)}); }
}
const passed=results.filter(x=>x.ok).length;
const out={schema:'zevanory-remote-cert-quorum-v1',expected,required:3,passed,state:passed>=3?'GREEN':'BLOCKED',results};
console.log(JSON.stringify(out,null,2));
if(passed<3) process.exit(1);
