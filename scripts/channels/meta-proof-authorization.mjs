export const PROOF_KEY='zpc:meta:prova:dec23:v1';
export function validPreflight(run,env,now=Date.now()){
 const age=now-Date.parse(run?.created_at);return run?.path==='.github/workflows/meta-proof-preflight.yml'&&run.event==='workflow_dispatch'&&run.status==='completed'&&run.conclusion==='success'&&run.head_sha===env.GITHUB_SHA&&Number.isFinite(age)&&age>=0&&age<=86400000;
}
export async function authorizeProof({mode,env,kv,fetchImpl=fetch,now=Date.now()}){
 if(!/^\d+$/.test(env.PREFLIGHT_RUN_ID||'')||!env.GITHUB_TOKEN||env.GITHUB_REPOSITORY!=='arbmsistone-lab/zevanory-public-mirror')throw Error('preflight_required');
 const base='https://api.github.com/repos/'+env.GITHUB_REPOSITORY;
 const get=async path=>{const r=await fetchImpl(base+path,{method:'GET',headers:{authorization:'Bearer '+env.GITHUB_TOKEN,accept:'application/vnd.github+json'},signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('actions_unreadable');return r.json();};
 const run=await get('/actions/runs/'+env.PREFLIGHT_RUN_ID);if(!validPreflight(run,env,now))throw Error('preflight_unverified');
 const raw=await kv.get(PROOF_KEY);let state=null;if(raw!==null){state=JSON.parse(raw);if(mode==='reserve'||state?.schema!=='meta-proof-dec23/v1'||state.status!=='reserved'||state.run_id!==env.GITHUB_RUN_ID)throw Error('reservation_exists');}
 if(mode==='publish'&&!state)throw Error('reservation_missing');
 let foundOwn=false;
 for(let page=1;page<=100;page++){
  const runs=await get('/actions/workflows/meta-proof-post.yml/runs?per_page=100&page='+page);if(!Array.isArray(runs.workflow_runs)||!Number.isInteger(runs.total_count)||runs.total_count>10000)throw Error('actions_unreadable');
  for(const prior of runs.workflow_runs){if(!Number.isSafeInteger(prior.id))throw Error('actions_unreadable');for(let p=1;p<=100;p++){
   const a=await get('/actions/runs/'+prior.id+'/artifacts?per_page=100&page='+p);if(!Array.isArray(a.artifacts)||!Number.isInteger(a.total_count)||a.total_count>10000)throw Error('actions_unreadable');
   for(const artifact of a.artifacts)if(/^meta-proof-dec23-reservation-/.test(artifact.name||'')){
    if(mode==='publish'&&String(prior.id)===env.GITHUB_RUN_ID&&String(artifact.id)===env.RESERVATION_ARTIFACT_ID)foundOwn=true;else throw Error('reservation_exists');
   }
   if(p*100>=a.total_count)break;if(!a.artifacts.length||p===100)throw Error('actions_incomplete');
  }}
  if(page*100>=runs.total_count)break;if(!runs.workflow_runs.length||page===100)throw Error('actions_incomplete');
 }
 if(mode==='publish'&&!foundOwn)throw Error('reservation_artifact_missing');return true;
}
