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

  // Capability answers: "does the engine have a reproducible path to do the work?"
  // It deliberately does NOT require commercial activation or live provider credentials.
  const capabilityPillars={
    "ZEA10-01":state(intel.ok&&agent.ok,{evidence:["/api/intelligence","/api/agent/status"],autopilot_health:agent.body?.autopilot?.health||"UNKNOWN"}),
    "ZEA10-02":state(status.ok,{evidence:["/api/status","product/offer registry"]}),
    "ZEA10-03":state(agent.ok,{evidence:["/api/agent/status","lead_memory contract","recent_conversation contract"],note:"real customer evidence is an operational proof, not a capability prerequisite"}),
    "ZEA10-04":state(status.ok&&agent.ok,{evidence:["creativeEngine","creative review board","human approval policy"]}),
    "ZEA10-05":state(allChannelCapability,{evidence:["channel_readiness scope"],channels:channelCapability}),
    "ZEA10-06":state(agent.ok,{evidence:["agent conversation/qualification policy","objection/follow-up lifecycle"]}),
    "ZEA10-07":state(status.ok&&salesMachineReady,{evidence:["sales_machine.structure_ready","checkout/payment/reconciliation lifecycle"],note:commercialBlocked?"commercial activation remains fail-closed":null}),
    "ZEA10-08":state(status.ok&&salesMachineReady&&agent.ok,{evidence:["fulfillment/onboarding/support/satisfaction lifecycle"]}),
    "ZEA10-09":state(intel.ok&&autopilotExists,{evidence:["market intelligence","autopilot cycles","outcome loop"],cycles_24h:cycles24h}),
    "ZEA10-10":state(health.ok&&control.ok,{evidence:["health","control-plane","audit/fail-closed governance"]})
  };
  const capabilityGreen=Object.values(capabilityPillars).every(x=>x.state==="GREEN");

  // Operational readiness answers: "can ZEVANORY execute the full real-world loop right now?"
  const operationalChecks={
    runtime_health:health.ok,
    exact_control_plane:control.ok,
    autopilot_healthy:autopilotHealthy,
    live_core_channels_verified:allChannelOperational,
    provider_health:provider.ok,
    customer_success_evidence:lifecycleCertified
  };
  const operationalGreen=capabilityGreen&&Object.values(operationalChecks).every(Boolean);

  const blockers=[];
  if(!capabilityGreen) blockers.push("engine_capability_incomplete");
  if(!autopilotHealthy) blockers.push("autopilot_not_healthy");
  if(!allChannelOperational) blockers.push("core_channel_provider_truth_unverified");
  if(!provider.ok) blockers.push("provider_health_unavailable");
  if(!lifecycleCertified) blockers.push("customer_success_lifecycle_not_proven");
  if(commercialBlocked) blockers.push("commercial_activation_fail_closed");

  return {
    schema:"zea10-autonomy/v2",
    engine:"ZEA-10 Elite Autonomy Engine",
    generated_at:new Date().toISOString(),
    zero_spend_first:true,
    engine_capability_state:capabilityGreen?"GREEN":"BLOCKED",
    operational_readiness_state:operationalGreen?"GREEN":"BLOCKED",
    commercial_activation_state:commercialBlocked?"BLOCKED":"ENABLED_BY_POLICY",
    overall_state:operationalGreen?"GREEN":"BLOCKED",
    human_role:"approval_and_governance_retarguard",
    capability_pillars:capabilityPillars,
    operational_checks:operationalChecks,
    channel_provider_truth:channelOperational,
    blockers,
    rule:"ENGINE capability, OPERATIONAL readiness and COMMERCIAL activation are independent gates. Overall GREEN requires engine capability plus live operational readiness. Commercial activation may remain BLOCKED by owner policy without falsifying engine capability."
  };
}
export async function handleZea10AutonomyRequest(request,env,ctx,worker){
  if(request.method!=="GET") return json({error:"method_not_allowed"},405);
  const report=await buildZea10AutonomyReport(request,env,ctx,worker);
  return json(report,report.overall_state==="GREEN"?200:409);
}
