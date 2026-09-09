import { defineExecutionProvider } from './universalExecutionFabric.mjs';

const freezeList=(items=[])=>Object.freeze(items.filter(Boolean));
const clean=(v)=>String(v||'').trim();

export function defineChannelProvider({id,channel,execute,ready=()=>true,independenceDomain=null,cost=0,priority=0}={}){
  const capability=`channel:${clean(channel).toLowerCase()}`;
  if(!clean(channel)) throw new Error('channel_provider_channel_required');
  return defineExecutionProvider({
    id,capabilities:[capability],cost,priority,independenceDomain,
    health:async()=>Boolean(await ready())?{state:'available'}:{state:'unavailable',reason:'provider_not_ready'},
    execute,
  });
}

export function buildChannelProviderPool(channel,{builtIn=[],external=[]}={}){
  const capability=`channel:${clean(channel).toLowerCase()}`;
  const providers=[...builtIn,...external].filter(Boolean);
  const unique=[];const ids=new Set();
  for(const provider of providers){
    if(ids.has(provider.id))continue;
    if(!provider.capabilities?.includes(capability))continue;
    ids.add(provider.id);unique.push(provider);
  }
  return freezeList(unique);
}
import { executeUniversallySafely } from './universalExecutionFabric.mjs';

export function buildUniversalChannelAdapter(channel,providers=[]){
  const capability=`channel:${clean(channel).toLowerCase()}`;
  return async(event,{sql}={})=>{
    const routed=await executeUniversallySafely({
      operation:Object.freeze({event,context:Object.freeze({sql})}),
      providers,
      requirements:{capabilities:[capability],zeroCost:true},
    });
    if(routed.ok) return Object.freeze({...routed.result,execution_provider:routed.provider,execution_attempts:routed.attempts});
    const deterministicReason=(!routed.reconciliation_required&&routed.attempts?.length===1)?routed.attempts[0]?.reason:null;
    const error=new Error(deterministicReason||routed.reason);
    error.code=deterministicReason||routed.reason;
    error.retryable=Boolean(routed.retryable||routed.attempts?.[0]?.retryable);
    error.routed=routed;
    error.ambiguous=Boolean(routed.reconciliation_required);
    throw error;
  };
}

export function externalChannelProviders(channel,registry={}){
  const value=registry?.[channel]||registry?.[`channel:${channel}`]||[];
  return freezeList(Array.isArray(value)?value:[value]);
}
