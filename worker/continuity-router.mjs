const DEFAULT_PRIORITY = Object.freeze(["zevanory","email","instagram","facebook","youtube","mercado_livre","google","affiliate","whatsapp"]);
const ACTIVE_SCOPE = new Set(["active","ready","enabled","operational"]);

function normalizeChannelState(name,raw) {
  // B04: entrada nula/corrompida vira estado vazio (não operacional) em vez de lançar exceção.
  // Só texto conta: array/número/objeto não podem ser coeridos para "active".
  const value=raw&&typeof raw==="object"?raw:{};
  const text=(v)=>typeof v==="string"?v.toLowerCase():"";
  const scope=text(value.scope_status);
  const release=text(value.release_gate);
  const execution=text(value.commercial_execution);
  const transportOperational=ACTIVE_SCOPE.has(scope);
  // B04: comercial só com liberação explícita (lista de permissão); ausente, desconhecido,
  // "not_applicable" ou bloqueio explícito (blocked, globally-blocked, disabled...) fecham.
  const commercialOperational=transportOperational && ACTIVE_SCOPE.has(release) && ACTIVE_SCOPE.has(execution);
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
  const readiness=status?.channel_readiness&&typeof status.channel_readiness==="object"?status.channel_readiness:{};
  const channels=Object.keys(readiness).map((name)=>normalizeChannelState(name,readiness[name]));
  const byName=new Map(channels.map((item)=>[item.name,item]));
  const eligible=[];

  // A retired channel (WhatsApp since 2026-10-10, Meta account permanently disabled) never counts
  // toward quorum, whatever its readiness entry says.
  const retired=new Set(Array.isArray(options.retiredChannels)?options.retiredChannels.map(String):[]);
  if(String(status?.runtime?.whatsapp||"")==="disabled_permanent"||String(status?.runtime?.whatsapp_state||"")==="retired") retired.add("whatsapp");
  for(const [name,raw] of Object.entries(readiness)) if(raw&&typeof raw==="object"&&(raw.retired===true||String(raw.scope_status||"").toLowerCase()==="retired")) retired.add(name);
  for(const name of retired) byName.delete(name);
  const countable=channels.filter((item)=>!retired.has(item.name));

  for(const name of priority) {
    const state=byName.get(name);
    // B04: prioridade duplicada não pode contar o mesmo canal duas vezes no quórum.
    if(state?.transport_operational&&!eligible.includes(state)) eligible.push(state);
  }
  for(const state of countable) {
    if(state.transport_operational&&!eligible.some((x)=>x.name===state.name)) eligible.push(state);
  }

  const whatsapp=byName.get("whatsapp");
  const retiredChannels=[...retired].sort();
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
    retired_channels:Object.freeze(retiredChannels),
    whatsapp_transport_operational:whatsapp?.transport_operational===true,
    whatsapp_commercial_operational:whatsapp?.commercial_operational===true,
    sales_state:String(status?.runtime?.sales||"unknown"),
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
