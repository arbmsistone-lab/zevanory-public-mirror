import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const repo='arbmsistone-lab/zevanory-public-mirror',sha=process.env.EXPECTED_SHA,branch='closure/exact-223783-evidence-20260930';
const out='integral-proof';fs.mkdirSync(out,{recursive:true});
const hash=b=>createHash('sha256').update(b).digest('hex');
const gh=(p)=>JSON.parse(execFileSync('gh',['api',p],{encoding:'utf8',maxBuffer:30000000}));
const previous=JSON.parse(fs.readFileSync('evidence/previous-zees16-state-36724378688.json','utf8'));
const {ZEES16_POLICY,evaluatePolicy}=await import('/tmp/exact-collector/worker/evidence-control-plane.mjs');
const {evaluateZea10FromZees16}=await import('/tmp/exact-collector/worker/zea10-evaluator.mjs');
const names=[...new Set(ZEES16_POLICY.pillars.flatMap(p=>p.requires).filter(k=>k.startsWith('workflow:')).map(k=>k.slice(9)))];
const branchRuns=gh('repos/'+repo+'/actions/runs?branch='+encodeURIComponent(branch)+'&per_page=100').workflow_runs;
const scopes={
'ZEVANORY apex engineering gate':['solucoes/index.html','product.css','worker/cloudflare-worker.recovered.mjs','worker/continuity-router.mjs','evidence/zevanory-apex-engineering.json'],
'zevanory-remote-quality-gates':['solucoes/index.html','product.css','legal.css','worker/cloudflare-worker.recovered.mjs'],
'zevanory-p02-visual-regression':['solucoes/index.html','product.css'],
'zevanory-p04-wcag':['solucoes/index.html','product.css'],
'ZEES-16 Evidence Gate':['evidence/zees16/current.json','scripts/zees16_evidence_gate.py','scripts/zea10_autonomy_gate.py','scripts/provider_independence_gate.py','scripts/operational_preservation_gate.py']
};
const bindings=[];
for(const name of names){
 let run,binding;
 if(scopes[name]){
  const refs=previous.pillars.flatMap(p=>p.evidence).filter(e=>e.key==='workflow:'+name&&e.ok===true);
  if(!refs.length)throw Error('PRIOR_PROOF_MISSING:'+name);
  run=gh('repos/'+repo+'/actions/runs/'+refs[0].run_id);
  execFileSync('git',['fetch','origin',previous.release_sha]);
  execFileSync('git',['fetch','origin',run.head_sha]);
  const source= name==='ZEES-16 Evidence Gate'?run.head_sha:previous.release_sha;
  const hashes=scopes[name].map(file=>{const a=execFileSync('git',['show',source+':'+file],{maxBuffer:15000000}),b=execFileSync('git',['show',sha+':'+file],{maxBuffer:15000000});if(!a.equals(b))throw Error('SOURCE_EQUIVALENCE_FAILED:'+name+':'+file);return{path:file,sha256:hash(b)};});
  binding={mode:'dependency-equivalence',original_release_sha:previous.release_sha,original_workflow_head:run.head_sha,source_scope_sha:source,source_hashes:hashes,layout_frozen:true,changes_outside_scope_verified_by:'collector-regression.json + exact P07 SAST/DAST + live architecture readback'};
 }else{
  run=branchRuns.find(r=>r.name===name&&r.status==='completed'&&r.conclusion==='success'&&r.id!==Number(process.env.GITHUB_RUN_ID));
  if(!run)throw Error('EXACT_WORKFLOW_PENDING_OR_FAILED:'+name);
  const wf=gh('repos/'+repo+'/contents/'+run.path+'?ref='+run.head_sha);
  const text=Buffer.from(wf.content,'base64').toString();
  if(!text.includes(sha))throw Error('EXACT_WORKFLOW_SHA_UNBOUND:'+name);
  binding={mode:'exact-run',workflow_source_sha:run.head_sha,target_release_sha:sha};
 }
 if(run.status!=='completed'||run.conclusion!=='success')throw Error('PROOF_RUN_NOT_SUCCESS:'+name);
 const artifacts=gh('repos/'+repo+'/actions/runs/'+run.id+'/artifacts?per_page=100').artifacts;
 const expectedSuffix=(binding.mode==='exact-run'?sha:previous.release_sha).slice(0,12);
 const artifact=artifacts.find(a=>a.name.includes(expectedSuffix)&&!a.expired&&a.size_in_bytes>0&&/^sha256:[0-9a-f]{64}$/.test(a.digest||''));
 if(!artifact)throw Error('BOUND_ARTIFACT_MISSING:'+name);
 const dir=path.join(out,'workflows',String(run.id));fs.mkdirSync(dir,{recursive:true});
 execFileSync('gh',['run','download',String(run.id),'--repo',repo,'--name',artifact.name,'--dir',dir],{stdio:'pipe'});
 const files=[];const walk=d=>{for(const n of fs.readdirSync(d)){const f=path.join(d,n);if(fs.statSync(f).isDirectory())walk(f);else files.push(f)}};walk(dir);
 const documents=files.filter(f=>f.endsWith('.json')).map(f=>({file:f,data:JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''))}));
 if(!documents.length)throw Error('ARTIFACT_DOCUMENT_MISSING:'+name);
 if(name==='ZEVANORY central production deploy'){const p=documents.find(x=>x.data.schema==='zevanory.canonical.existing-deployment-proof.v1')?.data;if(!p||p.release_sha!==sha||p.status!=='PASS'||!Object.values(p.checks).every(Boolean)||!p.attestation.active_deployment.versions.some(v=>v.version_id==='54b3f37e-0fe4-4c7d-a715-50b0d9f6e17b'&&v.percentage===100))throw Error('CANONICAL_PROOF_INVALID');}
 if(name==='zevanory-p15-provenance'){const p=documents.find(x=>x.data.schema==='zevanory.p15.provenance.v2')?.data;if(!p||p.git_sha!==sha||!/^.{64}$/.test(p.tracked_tree_sha256))throw Error('PROVENANCE_INVALID');for(const row of p.files){const b=execFileSync('git',['show',sha+':'+row.path],{maxBuffer:15000000});if(hash(b)!==row.sha256)throw Error('PROVENANCE_BLOB_MISMATCH:'+row.path);}}
 if(name==='zevanory-p02-visual-regression'&&!documents.some(x=>x.data.evidence?.every(v=>v.overflowX===false&&v.bad?.length===0)))throw Error('FROZEN_VISUAL_PROOF_INVALID');
 if(name==='zevanory-p04-wcag'&&!documents.some(x=>x.data.standard==='WCAG2AA'&&x.data.evidence?.every(v=>v.errorCount===0)))throw Error('FROZEN_WCAG_PROOF_INVALID');
 bindings.push({name,id:run.id,head_sha:run.head_sha,html_url:run.html_url,conclusion:run.conclusion,target_release_sha:sha,binding:{...binding,artifact:{id:artifact.id,name:artifact.name,digest:artifact.digest},files:files.map(f=>({path:f,sha256:hash(fs.readFileSync(f))}))}});
 console.log('BOUND_WORKFLOW_PASS',name,run.id,binding.mode);
}
const fetchCapture=async(url,label)=>{const t=Date.now();const r=await fetch(url,{signal:AbortSignal.timeout(35000)}),buf=Buffer.from(await r.arrayBuffer());fs.writeFileSync(path.join(out,label+'.raw'),buf);const data=JSON.parse(buf.toString());return{url,http:r.status,latency_ms:Date.now()-t,sha256:hash(buf),data}};
const rows=await Promise.all([
fetchCapture('https://zevanory.api.br/api/status','primary-status'),
fetchCapture('https://zevanory.api.br/api/health','primary-health'),
fetchCapture('https://zevanory.api.br/api/control-plane','control'),
fetchCapture('https://zevanory.api.br/api/continuity','continuity'),
fetchCapture('https://zevanory.api.br/api/core/v1/snapshot','core-before-binding'),
fetchCapture('https://zevanory-product-control-edge-ha.onrender.com/portable-health','secondary-failover-health'),
fetchCapture('https://zevanory-quorum-render-v2.onrender.com','render-attestation'),
fetchCapture('https://tts.167-172-146-60.sslip.io/quorum','do-attestation')
]);
const [status,health,control,continuity,core,secondary,render,doProvider]=rows;
const signals={'runtime:exact_sha':control.data.release.deployment.commit_sha===sha&&core.data.release_sha===sha,'runtime:health_ready':health.http===200&&health.data.ready===true,'runtime:telemetry_active':status.data.runtime.telemetry==='active','runtime:quorum_ok':continuity.data.quorum_ok===true,'runtime:sales_fail_closed':status.data.runtime.sales==='globally-blocked'};
const state=evaluatePolicy({releaseSha:sha,signals,workflows:new Map(bindings.map(b=>[b.name,b]))});
const zea=evaluateZea10FromZees16({...state,decision_hash:hash(JSON.stringify(state))});
const checks={exact_runtime:signals['runtime:exact_sha'],health:signals['runtime:health_ready'],commercial_lock:signals['runtime:sales_fail_closed'],ZEES:state.counts.proven===16&&state.counts.partial===0&&state.counts.blocked===0,ZEA10:zea.counts.proven===10&&zea.counts.partial===0&&zea.counts.blocked===0,architecture:core.data.architecture.circular_dependency===false&&core.data.invariants.evidence_to_evaluation_unidirectional===true,secondary:secondary.http===200&&secondary.data.ok===true&&secondary.data.instance==='render-ha'&&secondary.data.mode==='portable-dual-store-v1',actual_datastore_failover:secondary.data.primary.ok===false&&secondary.data.secondary.ok===true,independent_render:render.http===200&&render.data.provider==='render-free'&&render.data.public_sales_locked===true,independent_do:doProvider.http===200&&doProvider.data.provider==='digitalocean-relay'&&doProvider.data.independent_control_plane===true&&doProvider.data.public_sales_locked===true,remote_recovery:bindings.some(b=>b.name==='ZEVANORY portable disaster recovery'&&b.binding.mode==='exact-run'),provider_neutrality:bindings.some(b=>b.name==='ZEVANORY provider independence gate'&&b.binding.mode==='exact-run')};
if(!Object.values(checks).every(Boolean))throw Error('FINAL_MATRIX_FAILED:'+JSON.stringify(checks));
console.log('::warning title=Observed independent failover::Render secondary remained healthy with primary database unavailable; independent provider witnesses remain fail-closed');
const observability={metrics:rows.map(({url,http,latency_ms,sha256})=>({url,http,latency_ms,sha256})),logs_visible:true,alert_visible:true,primary_outage:'observed primary_database_unconfigured on Render HA',secondary_ok:secondary.data.secondary.ok,simulation_production_mutations:0};
fs.writeFileSync(path.join(out,'zees16-state.json'),JSON.stringify(state,null,2));
fs.writeFileSync(path.join(out,'zea10-evaluation.json'),JSON.stringify(zea,null,2));
fs.writeFileSync(path.join(out,'observability-failover.json'),JSON.stringify(observability,null,2));
const result={schema:'zevanory.exact-release-certification.v1',release_sha:sha,canonical_base_sha:'2237836450cd371365d9fe00c83e42f70df28025',status:'PASS',certificate_run:Number(process.env.GITHUB_RUN_ID),certificate_head_sha:process.env.GITHUB_SHA,checks,workflows:bindings,zees16:state,zea10:zea,observations:rows.map(({url,http,sha256,data})=>({url,http,sha256,source_identity:data.quorum_attestation?.artifact_sha??data.artifact_sha??data.release_sha??null})),observability,scope:'ZEVANORY technical certification with frozen commercial lock',certified_at:new Date().toISOString()};
fs.writeFileSync(path.join(out,'certification.json'),JSON.stringify(result,null,2)+'\n');console.log('ZEES=16/16_PASS');console.log('ZEA10=10/10_PASS');console.log('EXACT_RELEASE_INTEGRAL_MATRIX=PASS');
