import { execFileSync } from 'node:child_process';
const expected=(process.env.CERT_SHA||execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'})).trim();
const probes=[
  ['github','https://api.github.com/repos/arbmsistone-lab/ZEVANORY/commits/main',j=>j.sha],
  ['gitlab','https://gitlab.com/api/v4/projects/arbm-sistone%2FZEVANORY/repository/commits/main',j=>j.id],
  ['cloudflare','https://zevanory-remote-cert-v1.zevanory.workers.dev/',j=>j.exact_sha],
  ['supabase','https://fxjytqscrnttcqovigpp.supabase.co/functions/v1/zevanory-remote-cert-v1',j=>j.exact_sha],
];
const results=[];
for(const [domain,url,pick] of probes){
  try{
    const r=await fetch(url,{headers:{'user-agent':'zevanory-cert/1'}});
    const j=await r.json(); const sha=pick(j);
    results.push({domain,ok:r.ok&&sha===expected,sha,status:r.status});
  }catch(error){results.push({domain,ok:false,error:String(error?.message||error)});}
}
const passed=results.filter(x=>x.ok).length;
const out={schema:'zevanory-remote-cert-quorum-v1',expected,required:3,passed,state:passed>=3?'GREEN':'BLOCKED',results};
console.log(JSON.stringify(out,null,2));
if(passed<3) process.exit(1);
