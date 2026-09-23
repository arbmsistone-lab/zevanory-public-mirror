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
const activeScope=(readiness,name)=>Boolean(readiness?.[name]?.scope_status==="active");
const providerVerified=(identity,name)=>Boolean(identity?.[name]?.verified===true && identity?.[name]?.reason!=="credentials_missing");

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

  const identity=config.body||{};
  const readiness=status.body?.channel_readiness||{};
  const coreChannels=["whatsapp","email","instagram","facebook"];
  const channelCapability=Object.fromEntries(coreChannels.map(name=>[name,activeScope(readiness,name)]));
  const channelOperational=Object.fromEntries(coreChannels.map(name=>[name,providerVerified(identity,name)]));
  const allChannelCapability=Object.values(channelCapability).every(Boolean);
  const allChannelOperational=Object.values(channelOperational).every(Boolean);

  const cycles24h=Number(agent.body?.autopilot?.cycles_24h||0);
  const autopilotHealthy=agent.body?.autopilot?.health==="HEALTHY";
  const autopilotExists=agent.ok && cycles24h>0;
  const salesMachineReady=status.body?.sales_machine?.structure_ready===true;
  const lifecycleCertified=agent.body?.lifecycle_certified===true;
  const commercialBlocked = status.body?.runtime?.sales==="globally-blocked"
    || control.body?.global_state==="operational_commercial_blocked"
    || config.body?.commercial_enabled===false;

  // ZEA-10 grades the engineering capability of the motor. It must not
  // convert an owner kill-switch or an unavailable external credential into
  // a false capability failure. Live execution readiness is a separate gate.
  const capabilityPillars={
    "ZEA10-01":state(intel.ok&&agent.ok,{evidence:["/api/intelligence","/api/agent/status"],autopilot_health:agent.body?.autopilot?.health||"UNKNOWN"}),
    "ZEA10-02":state(status.ok,{evidence:["/api/status","product/offer registry"]}),
    "ZEA10-03":state(agent.ok,{evidence:["lead_memory contract","recent_conversation contract","customer context tools"]}),
    "ZEA10-04":state(status.ok&&agent.ok,{evidence:["creativeEngine","creative review board","human approval policy"]}),
    "ZEA10-05":state(allChannelCapability,{evidence:["channel_readiness scope"],channels:channelCapability}),
    "ZEA10-06":state(agent.ok,{evidence:["conversation/qualification policy","objection/follow-up lifecycle"]}),
    "ZEA10-07":state(status.ok&&salesMachineReady,{evidence:["sales_machine.structure_ready","checkout/payment/reconciliation lifecycle"]}),
    "ZEA10-08":state(status.ok&&salesMachineReady&&agent.ok,{evidence:["fulfillment/onboarding/support/satisfaction lifecycle"]}),
    "ZEA10-09":state(intel.ok&&autopilotExists,{evidence:["market intelligence","autopilot cycles","outcome loop"],cycles_24h:cycles24h}),
    "ZEA10-10":state(health.ok&&control.ok,{evidence:["health","control-plane","audit/fail-closed governance"]})
  };
  const capabilityGreen=Object.values(capabilityPillars).every(x=>x.state==="GREEN");

  // This gate answers whether every external/runtime dependency needed for a
  // real autonomous transaction is currently proven live.
  const operationalChecks={
    runtime_health:health.ok,
    exact_control_plane:control.ok,
    autopilot_healthy:autopilotHealthy,
    live_core_channels_verified:allChannelOperational,
    payment_provider_ready:provider.ok,
    real_customer_success_evidence:lifecycleCertified
  };
  const operationalGreen=capabilityGreen&&Object.values(operationalChecks).every(Boolean);
  const commercialEnabled=!commercialBlocked;
  const safeToSellNow=operationalGreen&&commercialEnabled;

  const blockers=[];
  if(!capabilityGreen) blockers.push("engine_capability_incomplete");
  if(!autopilotHealthy) blockers.push("autopilot_not_healthy");
  if(!allChannelOperational) blockers.push("core_channel_provider_truth_unverified");
  if(!provider.ok) blockers.push("payment_provider_not_ready");
  if(!lifecycleCertified) blockers.push("real_customer_success_lifecycle_not_proven");
  if(commercialBlocked) blockers.push("commercial_activation_fail_closed");

  return {
    schema:"zea10-autonomy/v2",
    engine:"ZEA-10 Elite Autonomy Engine",
    generated_at:new Date().toISOString(),
    zero_spend_first:true,
    overall_state:capabilityGreen?"GREEN":"BLOCKED",
    engine_capability_state:capabilityGreen?"GREEN":"BLOCKED",
    operational_readiness_state:operationalGreen?"GREEN":"BLOCKED",
    commercial_activation_state:commercialEnabled?"ENABLED_BY_POLICY":"BLOCKED",
    safe_to_sell_now:safeToSellNow,
    human_role:"approval_and_governance_retarguard",
    capability_pillars:capabilityPillars,
    operational_checks:operationalChecks,
    channel_provider_truth:channelOperational,
    blockers,
    rule:"ZEA-10 overall_state grades engine capability only. Real autonomous selling additionally requires operational_readiness_state=GREEN and commercial_activation_state=ENABLED_BY_POLICY. No external dependency or owner kill-switch is hidden."
  };
}

export async function handleZea10AutonomyRequest(request,env,ctx,worker){
  if(request.method!=="GET") return json({error:"method_not_allowed"},405);
  const report=await buildZea10AutonomyReport(request,env,ctx,worker);
  return json(report,report.overall_state==="GREEN"?200:409);
}
