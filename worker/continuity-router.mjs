const DEFAULT_PRIORITY = Object.freeze(["zevanory","email","instagram","facebook","youtube","mercado_livre","google","affiliate","whatsapp"]);
const ACTIVE_SCOPE = new Set(["active","ready","enabled","operational"]);
const BLOCKED = new Set(["blocked","globally-blocked","disabled","unavailable","down"]);

function normalizeChannelState(name,value={}) {
  const scope=String(value.scope_status||"").toLowerCase();
  const release=String(value.release_gate||"").toLowerCase();
  const execution=String(value.commercial_execution||"").toLowerCase();
  const transportOperational=ACTIVE_SCOPE.has(scope);
  const commercialOperational=transportOperational && !BLOCKED.has(release) && !BLOCKED.has(execution);
  return Object.freeze({
    name,
    transport_operational:transportOperational,
    commercial_operational:commercialOperational,
    scope_status:scope||"unknown",
    release_gate:release||"unknown",
    commercial_execution:execution||"unknown"
  });
}

export function buildContinuityPlan(status={},options={}) {
  const minQuorum=Math.max(1,Math.trunc(Number(options.minQuorum||3)));
  const priority=Array.isArray(options.priority)&&options.priority.length?options.priority.map(String):DEFAULT_PRIORITY;
  const readiness=status.channel_readiness||{};
  const channels=Object.keys(readiness).map((name)=>normalizeChannelState(name,readiness[name]));
  const byName=new Map(channels.map((item)=>[item.name,item]));
  const eligible=[];

  for(const name of priority) {
    const state=byName.get(name);
    if(state?.transport_operational) eligible.push(state);
  }
  for(const state of channels) {
    if(state.transport_operational&&!eligible.some((x)=>x.name===state.name)) eligible.push(state);
  }

  const whatsapp=byName.get("whatsapp");
  const quorumOk=eligible.length>=minQuorum;
  const commercialChannels=eligible.filter((x)=>x.commercial_operational);

  return Object.freeze({
    mode:quorumOk?"provider_independent":"degraded_fail_closed",
    min_quorum:minQuorum,
    quorum_ok:quorumOk,
    primary_channel:eligible[0]?.name||null,
    fallback_channels:Object.freeze(eligible.slice(1).map((x)=>x.name)),
    available_channels:Object.freeze(eligible.map((x)=>x.name)),
    commercial_available_channels:Object.freeze(commercialChannels.map((x)=>x.name)),
    whatsapp_dependency_required:false,
    whatsapp_transport_operational:whatsapp?.transport_operational===true,
    whatsapp_commercial_operational:whatsapp?.commercial_operational===true,
    sales_state:String(status.runtime?.sales||"unknown"),
    policy:Object.freeze({
      never_wait_for_single_provider:true,
      technical_continuity_independent_from_commercial_release:true,
      commercial_actions_remain_fail_closed:true,
      automatic_fallback_only_to_transport_operational_channels:true
    })
  });
}

export function continuityHttpResponse(status={},options={}) {
  const plan=buildContinuityPlan(status,options);
  return new Response(JSON.stringify(plan),{
    status:plan.quorum_ok?200:503,
    headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}
  });
}
