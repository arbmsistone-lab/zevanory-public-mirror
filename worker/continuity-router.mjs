const DEFAULT_PRIORITY = Object.freeze(["zevanory","email","instagram","facebook","youtube","mercado_livre","google","affiliate","whatsapp"]);
const ACTIVE = new Set(["active","ready","enabled","operational"]);
const BLOCKED = new Set(["blocked","globally-blocked","disabled","unavailable","down"]);
function normalizeChannelState(name,value={}){
  const scope=String(value.scope_status||"").toLowerCase();
  const release=String(value.release_gate||"").toLowerCase();
  const execution=String(value.commercial_execution||"").toLowerCase();
  const operational=ACTIVE.has(scope)&&!BLOCKED.has(release)&&!BLOCKED.has(execution);
  return Object.freeze({name,operational,scope_status:scope||"unknown",release_gate:release||"unknown",commercial_execution:execution||"unknown"});
}
export function buildContinuityPlan(status={},options={}){
  const minQuorum=Math.max(1,Math.trunc(Number(options.minQuorum||3)));
  const priority=Array.isArray(options.priority)&&options.priority.length?options.priority.map(String):DEFAULT_PRIORITY;
  const readiness=status.channel_readiness||{};
  const channels=Object.keys(readiness).map((name)=>normalizeChannelState(name,readiness[name]));
  const byName=new Map(channels.map((item)=>[item.name,item]));
  const eligible=[];
  for(const name of priority){const state=byName.get(name);if(state?.operational) eligible.push(state);}
  for(const state of channels){if(state.operational&&!eligible.some((x)=>x.name===state.name)) eligible.push(state);}
  const whatsapp=byName.get("whatsapp");
  const primary=eligible[0]?.name||null;
  const fallbacks=eligible.slice(1).map((x)=>x.name);
  const quorumOk=eligible.length>=minQuorum;
  return Object.freeze({mode:quorumOk?"provider_independent":"degraded_fail_closed",min_quorum:minQuorum,quorum_ok:quorumOk,primary_channel:primary,fallback_channels:Object.freeze(fallbacks),available_channels:Object.freeze(eligible.map((x)=>x.name)),whatsapp_dependency_required:false,whatsapp_operational:whatsapp?.operational===true,sales_state:String(status.runtime?.sales||"unknown"),policy:Object.freeze({never_wait_for_single_provider:true,commercial_actions_remain_fail_closed:true,automatic_fallback_only_to_operational_channels:true})});
}
export function continuityHttpResponse(status={},options={}){
  const plan=buildContinuityPlan(status,options);
  return new Response(JSON.stringify(plan),{status:plan.quorum_ok?200:503,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
}
