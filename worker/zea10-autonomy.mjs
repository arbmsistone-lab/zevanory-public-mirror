const json=(body,status=200)=>new Response(JSON.stringify(body,null,2),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});

async function get(worker,base,path,request,env,ctx){
  try{
    const u=new URL(path,base);
    const r=await worker.fetch(new Request(u,request),env,ctx);
    let body=null; try{body=await r.clone().json()}catch{}
    return {ok:r.ok,status:r.status,body};
  }catch(error){return {ok:false,status:0,error:String(error?.message||error)}}
}

function state(ok,details={}){return {state:ok?"GREEN":"BLOCKED",...details}}

export async function buildZea10AutonomyReport(request,env,ctx,worker){
  const base=new URL(request.url).origin;
  const [health,status,agent,intel,provider,config,control]=await Promise.all([
    get(worker,base,"/api/health",request,env,ctx),
    get(worker,base,"/api/status",request,env,ctx),
    get(worker,base,"/api/agent/status",request,env,ctx),
    get(worker,base,"/api/intelligence",request,env,ctx),
    get(worker,base,"/api/provider-health",request,env,ctx),
    get(worker,base,"/api/config?view=channel_identity_health",request,env,ctx),
    get(worker,base,"/api/control-plane",request,env,ctx)
  ]);
  const channels=config.body?.channels||config.body?.channel_identity_health||{};
  const channelOk=name=>{
    const v=channels?.[name];
    if(v===true) return true;
    if(v&&typeof v==="object") return v.ready===true||v.connected===true||v.enabled===true;
    return false;
  };
  const commercialBlocked = status.body?.runtime?.sales==="globally-blocked"
    || control.body?.global_state==="operational_commercial_blocked"
    || config.body?.commercial_enabled===false;
  const pillars={
    "ZEA10-01":state(intel.ok,{evidence:["/api/intelligence"]}),
    "ZEA10-02":state(status.ok,{evidence:["/api/status","product/offer registry"]}),
    "ZEA10-03":state(agent.ok,{evidence:["/api/agent/status","lead_memory contract"],note:"runtime identity continuity still requires E2E proof"}),
    "ZEA10-04":state(status.ok&&agent.ok,{evidence:["creativeEngine","human approval boundary"]}),
    "ZEA10-05":state(channelOk("whatsapp")&&channelOk("email")&&channelOk("instagram")&&channelOk("facebook"),{evidence:["channel_identity_health"],channels:{whatsapp:channelOk("whatsapp"),email:channelOk("email"),instagram:channelOk("instagram"),facebook:channelOk("facebook")}}),
    "ZEA10-06":state(agent.ok,{evidence:["agent conversation/qualification policy"]}),
    "ZEA10-07":state(!commercialBlocked&&provider.ok,{evidence:["commercial gate","provider-health"],note:commercialBlocked?"commercial gate remains fail-closed":null}),
    "ZEA10-08":state(agent.ok,{evidence:["lifecycle support/onboarding contract"],note:"full customer-success E2E proof required"}),
    "ZEA10-09":state(intel.ok&&agent.ok,{evidence:["market intelligence","agent outcome loop"],note:"closed-loop optimization must be proven with outcome evidence"}),
    "ZEA10-10":state(health.ok&&control.ok,{evidence:["health","control-plane","audit/fail-closed governance"]})
  };
  const green=Object.values(pillars).every(x=>x.state==="GREEN");
  return {
    schema:"zea10-autonomy/v1",
    engine:"ZEA-10 Elite Autonomy Engine",
    generated_at:new Date().toISOString(),
    zero_spend_first:true,
    overall_state:green?"GREEN":"BLOCKED",
    human_role:"approval_and_governance_retarguard",
    commercial_gate:commercialBlocked?"BLOCKED":"ENABLED_BY_POLICY",
    pillars,
    rule:"GREEN only when all 10 pillars are GREEN on live runtime; code presence alone never promotes a pillar"
  };
}
export async function handleZea10AutonomyRequest(request,env,ctx,worker){
  if(request.method!=="GET") return json({error:"method_not_allowed"},405);
  const report=await buildZea10AutonomyReport(request,env,ctx,worker);
  return json(report,report.overall_state==="GREEN"?200:409);
}
