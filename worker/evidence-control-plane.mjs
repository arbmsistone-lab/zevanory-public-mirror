const REPO="arbmsistone-lab/zevanory-public-mirror";
const API="https://api.github.com/repos/"+REPO;
const LEDGER_PREFIX="control:v2:ledger:zevanory:";
const STATE_KEY="control:v2:state:zevanory";

export const ZEES16_POLICY={
  version:"ZEES-16/2026.09-control-v2",
  target:"zevanory",
  pillars:[
    {id:"P01",name:"Arquitetura e contrato do sistema",requires:["workflow:ZEVANORY apex engineering gate","runtime:exact_sha","runtime:health_ready"]},
    {id:"P02",name:"Interface e experiência visual",requires:["workflow:zevanory-p02-visual-regression","workflow:zevanory-p04-wcag"]},
    {id:"P03",name:"Performance e eficiência",requires:["workflow:zevanory-p12-continuous-slo","runtime:health_ready"]},
    {id:"P04",name:"Acessibilidade",requires:["workflow:zevanory-p04-wcag"]},
    {id:"P05",name:"Confiabilidade operacional",requires:["workflow:zevanory-remote-quality-gates","runtime:health_ready"]},
    {id:"P06",name:"Testes e regressão",requires:["workflow:ZEES-16 Evidence Gate","workflow:zevanory-remote-quality-gates"]},
    {id:"P07",name:"Segurança aplicável",requires:["workflow:ZEES-16 Evidence Gate","workflow:zevanory-p15-provenance"]},
    {id:"P08",name:"Observabilidade",requires:["workflow:zevanory-p12-continuous-slo","runtime:telemetry_active"]},
    {id:"P09",name:"Resiliência",requires:["workflow:ZEVANORY portable disaster recovery","workflow:zevanory-remote-quality-gates"]},
    {id:"P10",name:"Continuidade e recuperação",requires:["workflow:ZEVANORY portable disaster recovery","workflow:ZEVANORY authenticated three-provider runtime quorum","runtime:quorum_ok"]},
    {id:"P11",name:"Frontend e eficiência de entrega",requires:["workflow:zevanory-p02-visual-regression","workflow:zevanory-p12-continuous-slo"]},
    {id:"P12",name:"Produção e SRE",requires:["workflow:ZEVANORY central production deploy","runtime:exact_sha","runtime:health_ready"]},
    {id:"P13",name:"Governança e evidência",requires:["workflow:zevanory-p15-provenance","runtime:exact_sha"]},
    {id:"P14",name:"Automação, IA e provedores",requires:["workflow:ZEVANORY provider independence gate","workflow:ZEVANORY authenticated three-provider runtime quorum"]},
    {id:"P15",name:"CI/CD e proveniência",requires:["workflow:zevanory-p15-provenance","workflow:pages build and deployment","workflow:ZEVANORY central production deploy"]},
    {id:"P16",name:"Prontidão comercial",requires:["workflow:ZEVANORY consolidated closure gate","runtime:sales_fail_closed","runtime:health_ready"]}
  ]
};

const utf8=new TextEncoder();
async function sha256Hex(value){
  const digest=await crypto.subtle.digest("SHA-256",utf8.encode(String(value)));
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
function stable(value){
  if(value===null||typeof value!=="object") return JSON.stringify(value);
  if(Array.isArray(value)) return "["+value.map(stable).join(",")+"]";
  return "{"+Object.keys(value).sort().map(k=>JSON.stringify(k)+":"+stable(value[k])).join(",")+"}";
}
function json(body,status=200,extra={}){
  return new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store",...extra}});
}
async function fetchJson(url){
  const r=await fetch(url,{headers:{"accept":"application/vnd.github+json","user-agent":"ZEVANORY-Control-Plane-v2/1.0","cache-control":"no-cache"}});
  if(!r.ok) throw new Error("fetch_"+r.status+":"+url);
  return r.json();
}
async function readJsonThrough(worker,base,path,env,ctx){
  const r=await worker.fetch(new Request(new URL(path,base),{headers:{"accept":"application/json","user-agent":"ZEVANORY-Control-Plane-v2/1.0"}}),env,ctx);
  if(!r.ok) throw new Error("upstream_"+r.status+":"+path);
  return r.json();
}
function runtimeSignals(status,health,control,continuity){
  const releaseSha=control?.release?.deployment?.commit_sha||control?.proof_chain?.sha||null;
  const sales=status?.runtime?.sales;
  return {
    release_sha:releaseSha,
    signals:{
      "runtime:exact_sha":Boolean(releaseSha&&/^[0-9a-f]{40}$/.test(releaseSha)),
      "runtime:health_ready":health?.ready===true&&health?.live!==false,
      "runtime:telemetry_active":status?.runtime?.telemetry==="active",
      "runtime:quorum_ok":continuity?.quorum_ok===true,
      "runtime:sales_fail_closed":sales==="globally-blocked",
      "runtime:commercial_release":control?.global_state==="operational_commercial_enabled"&&sales!=="globally-blocked"
    }
  };
}
async function githubEvidence(sha){
  if(!sha) return {runs:[],workflows:new Map()};
  const doc=await fetchJson(API+"/actions/runs?head_sha="+encodeURIComponent(sha)+"&per_page=100");
  const runs=(doc.workflow_runs||[]).filter(r=>r.head_sha===sha&&r.status==="completed");
  const workflows=new Map();
  for(const run of runs){
    const current=workflows.get(run.name);
    if(!current||new Date(run.updated_at||run.created_at)>new Date(current.updated_at||current.created_at)) workflows.set(run.name,run);
  }
  return {runs,workflows};
}
function requirementResult(req,signals,workflows){
  if(req.startsWith("runtime:")) return {ok:signals[req]===true,source:"runtime",key:req};
  if(req.startsWith("workflow:")){
    const name=req.slice(9);
    const run=workflows.get(name);
    return {ok:run?.conclusion==="success",source:"github-actions",key:req,run_id:run?.id||null,url:run?.html_url||null,conclusion:run?.conclusion||null};
  }
  return {ok:false,source:"unknown",key:req};
}
export function evaluatePolicy({signals={},workflows=new Map(),releaseSha=null,observedAt=new Date().toISOString()}={}){
  const pillars=[];
  for(const p of ZEES16_POLICY.pillars){
    const evidence=p.requires.map(r=>requirementResult(r,signals,workflows));
    const passed=evidence.filter(x=>x.ok).length;
    let state="BLOCKED";
    if(passed===evidence.length&&evidence.length>0) state="PROVADO";
    else if(passed>0) state="PARTIAL";
    if(p.id==="P16"&&state==="BLOCKED"&&(p.partial_when||[]).some(r=>signals[r]===true)) state="PARTIAL";
    pillars.push({
      id:p.id,name:p.name,state,
      evidence,
      blockers:evidence.filter(x=>!x.ok).map(x=>x.key),
      release_sha:releaseSha,
      observed_at:observedAt
    });
  }
  const counts={
    proven:pillars.filter(x=>x.state==="PROVADO").length,
    partial:pillars.filter(x=>x.state==="PARTIAL").length,
    blocked:pillars.filter(x=>x.state==="BLOCKED").length,
    na:0
  };
  return {policy_version:ZEES16_POLICY.version,target:"zevanory",release_sha:releaseSha,observed_at:observedAt,counts,pillars};
}
async function persist(env,state){
  const kv=env?.ZEVANORY_PRIVATE_ARTIFACTS;
  if(!kv||typeof kv.put!=="function") return {
    ...state,
    persistence:"recomputed-immutable-sources",
    persistence_error:"kv_binding_unavailable",
    evaluator:"ZEES16_POLICY_ENGINE",
    evaluator_version:ZEES16_POLICY.version
  };

  let previous=null;
  if(typeof kv.get==="function"){
    try{
      const previousRaw=await kv.get(STATE_KEY);
      if(previousRaw) previous=JSON.parse(previousRaw);
    }catch{}
  }

  const semantic={
    policy_version:state.policy_version,
    release_sha:state.release_sha,
    counts:state.counts,
    pillars:(state.pillars||[]).map(p=>({
      id:p.id,
      state:p.state,
      release_sha:p.release_sha||null,
      evidence:(p.evidence||[]).map(e=>({key:e.key,ok:e.ok===true}))
    })),
    collector_error:state.collector_error||null,
    inputs:state.inputs||null
  };
  const semanticHash=await sha256Hex(stable(semantic));

  if(previous?.semantic_hash===semanticHash && previous?.release_sha===state.release_sha){
    return {
      ...previous,
      ...state,
      decision_hash:previous.decision_hash,
      semantic_hash:semanticHash,
      persistence:"kv-append-only",
      persistence_mode:"deduplicated-noop",
      persistence_error:null,
      evaluator:"ZEES16_POLICY_ENGINE",
      evaluator_version:ZEES16_POLICY.version
    };
  }

  const previousDecisionHash=previous?.decision_hash||null;
  const event={
    type:"ZEES16_RECONCILED",
    target:"zevanory",
    policy_version:state.policy_version,
    release_sha:state.release_sha,
    counts:state.counts,
    observed_at:state.observed_at,
    pillars:state.pillars,
    semantic_hash:semanticHash,
    previous_decision_hash:previousDecisionHash
  };
  const eventHash=await sha256Hex(stable(event));
  const key=LEDGER_PREFIX+state.observed_at.replace(/[:.]/g,"-")+":"+eventHash;
  const decision={
    ...state,
    decision_hash:eventHash,
    semantic_hash:semanticHash,
    previous_decision_hash:previousDecisionHash,
    persistence:"kv-append-only",
    persistence_mode:"append-on-change",
    persistence_error:null,
    evaluator:"ZEES16_POLICY_ENGINE",
    evaluator_version:ZEES16_POLICY.version
  };
  try{
    await kv.put(key,JSON.stringify({...event,event_hash:eventHash}),{metadata:{type:event.type,release_sha:state.release_sha||"",policy_version:state.policy_version,previous_decision_hash:previousDecisionHash||"",semantic_hash:semanticHash}});
    await kv.put(STATE_KEY,JSON.stringify(decision),{metadata:{release_sha:state.release_sha||"",decision_hash:eventHash,previous_decision_hash:previousDecisionHash||"",semantic_hash:semanticHash}});
    return decision;
  }catch(error){
    return {
      ...decision,
      persistence:"recomputed-immutable-sources",
      persistence_mode:"write-quota-fallback",
      persistence_error:String(error?.message||error||"kv_persistence_failed")
    };
  }
}
export async function reconcileControlPlane(worker,env,ctx,baseUrl="https://zevanory.api.br"){
  const observedAt=new Date().toISOString();
  const [status,health,control,continuity]=await Promise.all([
    readJsonThrough(worker,baseUrl,"/api/status",env,ctx),
    readJsonThrough(worker,baseUrl,"/api/health",env,ctx),
    readJsonThrough(worker,baseUrl,"/api/control-plane",env,ctx),
    readJsonThrough(worker,baseUrl,"/api/continuity",env,ctx)
  ]);
  const runtime=runtimeSignals(status,health,control,continuity);
  let workflows=new Map(),collector_error=null;
  try{
    const collected=await githubEvidence(runtime.release_sha);
    workflows=collected.workflows;
  }catch(e){collector_error=String(e?.message||e);}
  const state=evaluatePolicy({signals:runtime.signals,workflows,releaseSha:runtime.release_sha,observedAt});
  state.collector_error=collector_error;
  state.inputs={health_ready:runtime.signals["runtime:health_ready"],quorum_ok:runtime.signals["runtime:quorum_ok"],sales_fail_closed:runtime.signals["runtime:sales_fail_closed"],commercial_release:runtime.signals["runtime:commercial_release"]};
  return persist(env,state);
}
export async function readControlState(env){
  const kv=env?.ZEVANORY_PRIVATE_ARTIFACTS;
  if(!kv||typeof kv.get!=="function") return null;
  const raw=await kv.get(STATE_KEY);
  if(!raw) return null;
  try{return JSON.parse(raw);}catch{return null;}
}
export async function readOrReconcileControlState(worker,env,ctx,baseUrl,expectedReleaseSha=null){
  const current=await readControlState(env);
  const fresh=Boolean(current?.observed_at&&Date.now()-Date.parse(current.observed_at)<10*60*1000);
  const sameRelease=!expectedReleaseSha||current?.release_sha===expectedReleaseSha;
  if(fresh&&sameRelease) return current;
  return reconcileControlPlane(worker,env,ctx,baseUrl);
}
export async function listControlEvents(env,limit=30){
  const kv=env?.ZEVANORY_PRIVATE_ARTIFACTS;
  if(!kv||typeof kv.list!=="function") return [];
  const listed=await kv.list({prefix:LEDGER_PREFIX,limit:Math.max(1,Math.min(Number(limit)||30,100))});
  const out=[];
  for(const key of listed.keys||[]){
    const raw=await kv.get(key.name);
    if(!raw) continue;
    try{out.push(JSON.parse(raw));}catch{}
  }
  return out.sort((a,b)=>String(b.observed_at||"").localeCompare(String(a.observed_at||"")));
}
export async function handleControlPlaneV2Request(request,env,ctx,worker){
  const url=new URL(request.url);
  if(url.pathname==="/api/admin/control/v2/state"){
    const state=await readOrReconcileControlState(worker,env,ctx,url.origin);
    return json(state||{error:"state_unavailable"},state?200:503);
  }
  if(url.pathname==="/api/admin/control/v2/events"){
    return json({events:await listControlEvents(env,url.searchParams.get("limit")||30)});
  }
  if(url.pathname==="/api/admin/control/v2/reconcile"){
    if(request.method!=="POST") return json({error:"method_not_allowed"},405,{"allow":"POST"});
    return json(await reconcileControlPlane(worker,env,ctx,url.origin));
  }
  return json({error:"not_found"},404);
}
