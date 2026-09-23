import { readOrReconcileControlState, reconcileControlPlane } from "./evidence-control-plane.mjs";
import { evaluateZea10FromZees16 } from "./zea10-evaluator.mjs";
import { commandCatalog, executeCoreCommand, readCoreAuthorityState } from "./core-command-executor.mjs";

const CORE_VERSION="ZEVANORY-CONTROL-CORE/1.0";
const CRITICAL_MUTATIONS=new Set([
  "commercial.enable",
  "certification.promote",
  "release.promote",
  "state.transition"
]);

function json(body,status=200,extra={}){
  return new Response(JSON.stringify(body),{
    status,
    headers:{
      "content-type":"application/json; charset=utf-8",
      "cache-control":"no-store",
      "x-zevanory-control-core":CORE_VERSION,
      ...extra
    }
  });
}

async function readJsonThrough(worker,base,path,env,ctx){
  const r=await worker.fetch(new Request(new URL(path,base),{
    method:"GET",
    headers:{
      "accept":"application/json",
      "user-agent":"ZEVANORY-Control-Core/1.0"
    }
  }),env,ctx);
  if(!r.ok) throw new Error("upstream_"+r.status+":"+path);
  return r.json();
}

export async function buildCoreSnapshot(worker,env,ctx,baseUrl="https://zevanory.api.br"){
  const [status,health,control,continuity]=await Promise.all([
    readJsonThrough(worker,baseUrl,"/api/status",env,ctx),
    readJsonThrough(worker,baseUrl,"/api/health",env,ctx),
    readJsonThrough(worker,baseUrl,"/api/control-plane",env,ctx),
    readJsonThrough(worker,baseUrl,"/api/continuity",env,ctx)
  ]);

  const canonicalReleaseSha=
    control?.release?.deployment?.commit_sha ||
    control?.proof_chain?.sha ||
    null;
  const zees16=await readOrReconcileControlState(worker,env,ctx,baseUrl,canonicalReleaseSha).catch(()=>null);

  const releaseSha=
    canonicalReleaseSha ||
    zees16?.release_sha ||
    null;

  const zea10=evaluateZea10FromZees16(zees16);
  const zeaCounts=zea10?.counts||{};
  const zeesCounts=zees16?.counts||{};
  const authorityState=await readCoreAuthorityState(env).catch(()=>null);

  return {
    schema:"zevanory-control-core/v1",
    core:CORE_VERSION,
    authority:"server-side-core-only",
    fail_closed:true,
    ui_can_authorize:false,
    source_of_truth:true,
    generated_at:new Date().toISOString(),
    release_sha:releaseSha,
    status,
    health,
    control,
    continuity,
    zees16,
    zea10,
    authority_state:authorityState,
    architecture:{
      flow:["runtime-ci","ZEES-16","ZEA-10","ZEVANORY Control Core","Admin"],
      zees16_role:"proof",
      zea10_role:"evaluation",
      control_core_role:"decision",
      admin_role:"visualization-command",
      circular_dependency:false
    },
    invariants:{
      exact_release_bound:Boolean(releaseSha&&/^[0-9a-f]{40}$/.test(releaseSha)),
      health_ready:health?.ready===true&&health?.live!==false,
      quorum_ok:continuity?.quorum_ok===true,
      sales_fail_closed:status?.runtime?.sales==="globally-blocked",
      zea10_proven:Number(zeaCounts.proven||0),
      zea10_blocked:Number(zeaCounts.blocked||0),
      zees16_proven:Number(zeesCounts.proven||0),
      evidence_to_evaluation_unidirectional:true
    }
  };
}

function authorityContract(snapshot){
  return {
    core:CORE_VERSION,
    authority:"ZEVANORY Control Core",
    source_of_truth:true,
    fail_closed:true,
    ui_can_authorize:false,
    direct_ui_mutations:false,
    critical_state_changes:[
      "sale",
      "certification",
      "release",
      "state-transition"
    ],
    rule:"No critical state change is valid because a UI requested it; only a core decision may authorize it.",
    release_sha:snapshot?.release_sha||null,
    generated_at:snapshot?.generated_at||new Date().toISOString()
  };
}

export function evaluateCoreDecision(snapshot){
  const zeesCounts=snapshot?.zees16?.counts||{};
  const zeaCounts=snapshot?.zea10?.counts||{};
  const checks={
    exact_release_bound:snapshot?.invariants?.exact_release_bound===true,
    health_ready:snapshot?.invariants?.health_ready===true,
    quorum_ok:snapshot?.invariants?.quorum_ok===true,
    evidence_flow_unidirectional:snapshot?.invariants?.evidence_to_evaluation_unidirectional===true,
    evidence_persistence_ok:snapshot?.zees16?.persistence==="kv-append-only",
    zees16_complete:Number(zeesCounts.proven||0)===16 &&
      Number(zeesCounts.partial||0)===0 &&
      Number(zeesCounts.blocked||0)===0,
    zea10_complete:Number(zeaCounts.proven||0)===10 &&
      Number(zeaCounts.partial||0)===0 &&
      Number(zeaCounts.blocked||0)===0 &&
      Number(zeaCounts.unknown||0)===0
  };
  const blockers=Object.entries(checks).filter(([,ok])=>!ok).map(([key])=>key);
  const allow=blockers.length===0;
  return {
    schema:"zevanory-control-core/decision-v1",
    authority:"ZEVANORY Control Core",
    decision:allow?"ALLOW":"DENY",
    fail_closed:true,
    eligible_for_critical_promotion:allow,
    checks,
    blockers,
    release_sha:snapshot?.release_sha||null,
    zees16_decision_hash:snapshot?.zees16?.decision_hash||null,
    zea10_evaluator:snapshot?.zea10?.evaluator||null,
    generated_at:snapshot?.generated_at||new Date().toISOString()
  };
}

export async function handleControlCoreRequest(request,env,ctx,worker){
  const url=new URL(request.url);

  if(url.pathname==="/api/core/v1/snapshot"){
    if(request.method!=="GET") return json({error:"method_not_allowed"},405,{allow:"GET"});
    try{
      return json(await buildCoreSnapshot(worker,env,ctx,url.origin));
    }catch(error){
      return json({
        error:"core_snapshot_unavailable",
        fail_closed:true,
        detail:String(error?.message||error)
      },503);
    }
  }

  if(url.pathname==="/api/core/v1/evaluation/zea10"){
    if(request.method!=="GET") return json({error:"method_not_allowed"},405,{allow:"GET"});
    try{
      const snapshot=await buildCoreSnapshot(worker,env,ctx,url.origin);
      return json({
        ...snapshot.zea10,
        architecture:snapshot.architecture,
        release_sha:snapshot.release_sha
      });
    }catch(error){
      return json({
        framework:"ZEA-10",
        role:"evaluation",
        authority:false,
        fail_closed:true,
        state:"UNAVAILABLE",
        error:String(error?.message||error)
      },503);
    }
  }

  if(url.pathname==="/api/core/v1/decision"){
    if(request.method!=="GET") return json({error:"method_not_allowed"},405,{allow:"GET"});
    try{
      const snapshot=await buildCoreSnapshot(worker,env,ctx,url.origin);
      return json(evaluateCoreDecision(snapshot));
    }catch(error){
      return json({
        schema:"zevanory-control-core/decision-v1",
        authority:"ZEVANORY Control Core",
        decision:"DENY",
        fail_closed:true,
        eligible_for_critical_promotion:false,
        blockers:["core_snapshot_unavailable"],
        error:String(error?.message||error)
      },503);
    }
  }

  if(url.pathname==="/api/core/v1/authority"){
    if(request.method!=="GET") return json({error:"method_not_allowed"},405,{allow:"GET"});
    try{
      const snapshot=await buildCoreSnapshot(worker,env,ctx,url.origin);
      return json(authorityContract(snapshot));
    }catch(error){
      return json({
        ...authorityContract(null),
        state:"UNAVAILABLE",
        error:String(error?.message||error)
      },503);
    }
  }

  if(url.pathname==="/api/core/v1/commands"){
    if(request.method!=="GET") return json({error:"method_not_allowed"},405,{allow:"GET"});
    return json({
      core:CORE_VERSION,
      mode:"fail-closed",
      direct_ui_mutations:false,
      allowed:[
        {id:"inspect",effect:"none"},
        {id:"reconcile-evidence",effect:"evidence-derived-state-only"}
      ],
      critical_mutations:commandCatalog()
    });
  }

  if(url.pathname==="/api/core/v1/commands/inspect"){
    if(request.method!=="POST") return json({error:"method_not_allowed"},405,{allow:"POST"});
    try{
      return json({ok:true,command:"inspect",snapshot:await buildCoreSnapshot(worker,env,ctx,url.origin)});
    }catch(error){
      return json({ok:false,command:"inspect",fail_closed:true,error:String(error?.message||error)},503);
    }
  }

  if(url.pathname==="/api/core/v1/commands/reconcile-evidence"){
    if(request.method!=="POST") return json({error:"method_not_allowed"},405,{allow:"POST"});
    try{
      const output=await reconcileControlPlane(worker,env,ctx,url.origin);
      return json({ok:true,command:"reconcile-evidence",output});
    }catch(error){
      return json({ok:false,command:"reconcile-evidence",fail_closed:true,error:String(error?.message||error)},503);
    }
  }

  if(url.pathname.startsWith("/api/core/v1/commands/")){
    const command=url.pathname.slice("/api/core/v1/commands/".length);
    if(CRITICAL_MUTATIONS.has(command)){
      if(request.method!=="POST") return json({error:"method_not_allowed"},405,{allow:"POST"});
      try{
        const snapshot=await buildCoreSnapshot(worker,env,ctx,url.origin);
        const decision=evaluateCoreDecision(snapshot);
        const result=await executeCoreCommand({request,env,snapshot,decision,command});
        return json(result.body,result.status);
      }catch(error){
        return json({
          ok:false,
          command,
          decision:"DENY",
          fail_closed:true,
          error:String(error?.message||error||"critical_command_failed")
        },503);
      }
    }
  }

  return json({error:"not_found"},404);
}
