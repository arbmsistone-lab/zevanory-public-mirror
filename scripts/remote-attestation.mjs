import crypto from 'node:crypto';
const SHA=/^[0-9a-f]{40}$/i;
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const canonical=value=>JSON.stringify(stable(value));
const hash=value=>'sha256:'+crypto.createHash('sha256').update(canonical(value)).digest('hex');
export function buildCiAttestation(env,{startedAt=new Date().toISOString(),completedAt=new Date().toISOString(),gateResults=[]}={}){
  const gitlab=env.GITLAB_CI==='true', circle=Boolean(env.CIRCLECI);
  if(gitlab===circle) throw new Error('attestation_requires_exactly_one_ci_provider');
  const provider=gitlab?'gitlab':'circleci'; const commitSha=String(gitlab?env.CI_COMMIT_SHA:env.CIRCLE_SHA1||'').toLowerCase();
  const runId=String(gitlab?env.CI_JOB_ID:env.CIRCLE_WORKFLOW_ID||'');
  if(!SHA.test(commitSha)||!runId) throw new Error('attestation_requires_provider_execution_identity');
  if(!Array.isArray(gateResults)||gateResults.length===0||gateResults.some(x=>x?.status!=='passed')) throw new Error('attestation_requires_passed_gates');
  const body={schema:'zevanory-remote-attestation-v2',commit_sha:commitSha,provider,domain:provider==='gitlab'?'gitlab.com':'circleci.com',pipeline_id:String(gitlab?env.CI_PIPELINE_ID:env.CIRCLE_PIPELINE_ID||''),job_run_id:runId,gate_results:gateResults,started_at:startedAt,completed_at:completedAt,deployment_version_id:null,served_version:null,zero_spend:true,paid_fallback_used:false,sales_gate:'blocked'};
  return Object.freeze({...body,artifact_hash:hash(body)});
}
export function validateAttestation(value,expected){
  const {artifact_hash,...body}=value||{};
  if(!SHA.test(String(body.commit_sha||''))||body.commit_sha!==expected||body.sales_gate!=='blocked'||body.zero_spend!==true||body.paid_fallback_used!==false) return false;
  if(!Array.isArray(body.gate_results)||body.gate_results.length===0||body.gate_results.some(x=>x?.status!=='passed')) return false;
  return artifact_hash===hash(body) && Boolean(body.provider&&body.domain&&body.job_run_id&&body.started_at&&body.completed_at);
}

export function validateCloudflareRuntimeAttestation(value,expected){
  const sha=String(value?.commit_sha||'').toLowerCase();
  if(!SHA.test(sha)||sha!==String(expected||'').toLowerCase()) return false;
  if(value?.provider!=='cloudflare-workers'||value?.sales_gate!=='blocked'||value?.zero_spend!==true||value?.paid_fallback_used!==false) return false;
  if(!value?.deployment_version_id||String(value?.served_version||'').toLowerCase()!==sha) return false;
  const gates=Array.isArray(value?.gate_results)?value.gate_results:[];
  if(gates.length===0||gates.some(x=>x?.status!=='passed')) return false;
  const targets=Array.isArray(value?.results)?value.results:[];
  return targets.filter(x=>x?.ok===true&&String(x?.commit_sha||'').toLowerCase()===sha&&x?.sales_blocked===true).length>=2;
}
