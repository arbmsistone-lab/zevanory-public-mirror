import { assessServiceLevel } from '../src/enterpriseAssurance.mjs';
const base=process.env.PRODUCTION_BASE_URL||'https://zevanory.api.br';
const paths=['/api/live','/api/health','/api/release','/api/status','/api/assurance'];
const concurrency=Math.max(1,Math.min(20,Number(process.env.LOAD_CONCURRENCY)||10));
const rounds=Math.max(1,Math.min(20,Number(process.env.LOAD_ROUNDS)||5));
const samples=[];
async function hit(path){
  const started=Date.now(); let status=599;
  try{const r=await fetch(base+path,{cache:'no-store',signal:AbortSignal.timeout(5000)});status=r.status;await r.arrayBuffer();}catch{}
  samples.push({path,status,duration_ms:Date.now()-started});
}
for(let round=0;round<rounds;round++){
  const batch=[]; for(let i=0;i<concurrency;i++) batch.push(hit(paths[i%paths.length]));
  await Promise.all(batch);
}
const slo=assessServiceLevel(samples);
const failed=samples.filter(x=>x.status<200||x.status>=400);
console.log(JSON.stringify({ok:failed.length===0,base,requests:samples.length,failed:failed.length,current_sample:slo},null,2));
if(failed.length) process.exit(1);
