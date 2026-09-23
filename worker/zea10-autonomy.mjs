const json=(body,status=200)=>new Response(JSON.stringify(body,null,2),{
  status,
  headers:{
    "content-type":"application/json; charset=utf-8",
    "cache-control":"no-store",
    "x-zevanory-compatibility":"zea10-autonomy->control-core-evaluation"
  }
});

export async function buildZea10AutonomyReport(request,env,ctx,worker){
  const base=new URL(request.url);
  const coreUrl=new URL("/api/core/v1/snapshot",base);
  const r=await worker.fetch(new Request(coreUrl,{
    method:"GET",
    headers:{
      "accept":"application/json",
      "user-agent":"ZEVANORY-ZEA10-Compatibility/1.0"
    }
  }),env,ctx);
  if(!r.ok){
    return {
      schema:"zea10-autonomy/v2-compat",
      evaluator:"canonical-control-core",
      authority:false,
      overall_state:"BLOCKED",
      fail_closed:true,
      error:"canonical_evaluation_unavailable",
      upstream_status:r.status
    };
  }
  const core=await r.json();
  const evaluation=core?.zea10||null;
  const counts=evaluation?.counts||{};
  const green=Number(counts.proven||0)===10 &&
    Number(counts.partial||0)===0 &&
    Number(counts.blocked||0)===0 &&
    Number(counts.unknown||0)===0;
  return {
    schema:"zea10-autonomy/v2-compat",
    evaluator:evaluation?.evaluator||"canonical-control-core",
    source_layer:evaluation?.source_layer||"ZEES-16",
    authority:false,
    generated_at:core?.generated_at||new Date().toISOString(),
    release_sha:core?.release_sha||null,
    overall_state:green?"GREEN":"BLOCKED",
    counts,
    pillars:evaluation?.pillars||[],
    architecture:core?.architecture||null,
    rule:"Compatibility view only. ZEA-10 evaluation is produced from ZEES-16 evidence and only the ZEVANORY Control Core may authorize critical state."
  };
}

export async function handleZea10AutonomyRequest(request,env,ctx,worker){
  if(request.method!=="GET") return json({error:"method_not_allowed"},405);
  const report=await buildZea10AutonomyReport(request,env,ctx,worker);
  return json(report,report.overall_state==="GREEN"?200:409);
}
