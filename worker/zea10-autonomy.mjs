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
    get(worker,base,"/api/config?view=closure_status",request,env,ctx),
    get(worker,base,"/api/control-plane",request,env,ctx)
  ]);
  const closure=config.body||{};
  const channels=closure.channels||{};
  const channelOk=name=>{
    const v=channels?.[name];
    return Boolean(v && v.operational_ready===true && v.scope_status==="active");
  };
  const autopilotHealthy=agent.body?.autopilot?.health==="HEALTHY";
  const lifecycleCertified=agent.body?.lifecycle_certified===true;
  const identityEvidence=Number(status.body?.metrics?.leads_qualified||0)>0;
  const learningEvidence=Number(agent.body?.autopilot?.cycles_24h||0)>0 && autopilotHealthy;
  const commercialBlocked = status.body?.runtime?.sales==="globally-blocked"
    || control.body?.global_state==="operational_commercial_blocked"
    || config.body?.commercial_enabled===false;
  const pillars={
    "ZEA10-01":state(intel.ok&&autopilotHealthy,{evidence:["/api/intelligence","autopilot health"],autopilot_health:agent.body?.autopilot?.health||"UNKNOWN"}),
    "ZEA10-02":state(status.ok,{evidence:["/api/status","product/offer registry"]}),
    "ZEA10-03":state(agent.ok&&identityEvidence,{evidence:["/api/agent/status","lead_memory contract","qualified lead identity evidence"],note:identityEvidence?null:"no qualified lead identity evidence observed"}),
    "ZEA10-04":state(status.ok&&agent.ok&&autopilotHealthy,{evidence:["creativeEngine","human approval boundary","autopilot health"]}),
    "ZEA10-05":state(channelOk("whatsapp")&&channelOk("email")&&channelOk("instagram")&&channelOk("facebook"),{evidence:["channel_identity_health"],channels:{whatsapp:channelOk("whatsapp"),email:channelOk("email"),instagram:channelOk("instagram"),facebook:channelOk("facebook")}}),
    "ZEA10-06":state(agent.ok,{evidence:["agent conversation/qualification policy"]}),
    "ZEA10-07":state(!commercialBlocked&&provider.ok&&provider.body?.payment?.ready===true,{evidence:["commercial gate","provider-health/v2"],note:commercialBlocked?"commercial gate remains fail-closed":provider.body?.payment?.ready===true?null:"payment provider not ready"}),
    "ZEA10-08":state(agent.ok&&lifecycleCertified,{evidence:["lifecycle support/onboarding contract","lifecycle certification"],note:lifecycleCertified?null:"full customer-success lifecycle is not yet certified"}),
    "ZEA10-09":state(intel.ok&&agent.ok&&learningEvidence,{evidence:["market intelligence","agent outcome loop","healthy autonomous cycle"],note:learningEvidence?null:"healthy closed-loop autonomous learning is not yet proven"}),
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
