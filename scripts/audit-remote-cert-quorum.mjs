import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateAttestation, validateCloudflareRuntimeAttestation } from './remote-attestation.mjs';
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const expected=(process.env.CERT_SHA||git('rev-parse','HEAD')).trim().toLowerCase();
const remoteSha=(remote)=>git('ls-remote',remote,'refs/heads/main').split(/\s+/)[0]||'';
const results=[];
for(const [domain,remote] of [['github','origin'],['gitlab','gitlab']]){
  try { const sha=remoteSha(remote); results.push({domain,ok:false,sha,status:sha?200:404,error:'commit_presence_is_not_remote_certification'}); }
  catch(error){ results.push({domain,ok:false,error:String(error?.message||error)}); }
}
async function circleCiProof(){
  try{
    const runs=JSON.parse(execFileSync('circleci',['run','list','--project','gh/arbmsistone-lab/ZEVANORY','--branch','main','--limit','25','--json'],{encoding:'utf8'}));
    const run=runs.find(x=>String(x?.commit?.url||'').toLowerCase().endsWith('/'+expected));
    if(!run) return {domain:'circleci',ok:false,error:'matching_run_not_found'};
    const detail=JSON.parse(execFileSync('circleci',['run','get',run.id,'--json'],{encoding:'utf8'}));
    if(detail?.current_outcome!=='succeeded') return {domain:'circleci',ok:false,error:'matching_run_not_successful',run_id:run.id};
    const job=detail?.workflows?.flatMap(x=>x.jobs||[]).find(x=>x.name==='remote_attestation'&&x.outcome==='succeeded');
    if(!job) return {domain:'circleci',ok:false,error:'remote_attestation_job_not_successful',run_id:run.id};
    const artifacts=JSON.parse(execFileSync('circleci',['artifact',job.id,'--json'],{encoding:'utf8'}));
    const artifact=artifacts.find(x=>x.path==='remote-attestation/circleci.json');
    if(!artifact) return {domain:'circleci',ok:false,error:'attestation_artifact_missing',run_id:run.id,job_id:job.id};
    const temp=mkdtempSync(join(tmpdir(),'zevanory-circleci-'));
    try{
      execFileSync('circleci',['artifact',job.id,'--output',temp],{encoding:'utf8'});
      const attestation=JSON.parse(readFileSync(join(temp,'remote-attestation','circleci.json'),'utf8'));
      return {domain:'circleci',ok:validateAttestation(attestation,expected),sha:attestation?.commit_sha||null,status:200,run_id:run.id,job_id:job.id,artifact_hash:attestation?.artifact_hash||null};
    } finally { rmSync(temp,{recursive:true,force:true}); }
  }catch(error){ return {domain:'circleci',ok:false,error:String(error?.message||error)}; }
}
results.push(await circleCiProof());
const endpoints=[
  ['cloudflare','https://zevanory-remote-certifier.zevanory.workers.dev/','runtime'],
  ['supabase','https://fxjytqscrnttcqovigpp.supabase.co/functions/v1/zevanory-remote-cert-v1','immutable'],
];
for(const [domain,url,kind] of endpoints){
  try{
    const response=await fetch(url,{headers:{'user-agent':'zevanory-cert/2'}});
    const body=await response.json();
    const sha=String(body?.commit_sha||'').toLowerCase();
    const valid=kind==='runtime'?validateCloudflareRuntimeAttestation(body,expected):validateAttestation(body,expected);
    results.push({domain,ok:response.ok&&valid,sha,status:response.status,kind});
  }catch(error){ results.push({domain,ok:false,error:String(error?.message||error),kind}); }
}
const passed=results.filter(x=>x.ok).length;
const out={schema:'zevanory-remote-cert-quorum-v2',expected,required:3,passed,state:passed>=3?'GREEN':'BLOCKED',results};
console.log(JSON.stringify(out,null,2));
if(passed<3) process.exit(1);
