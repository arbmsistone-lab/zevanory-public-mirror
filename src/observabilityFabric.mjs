import { defineExecutionProvider, providerSatisfies } from './universalExecutionFabric.mjs';

const clean=(v,max=4000)=>String(v??'').trim().slice(0,max);

export function defineObservabilitySink({id,emit,ready=()=>true,independenceDomain=null,cost=0}={}){
  if(typeof emit!=='function')throw new Error('observability_sink_invalid');
  return defineExecutionProvider({id,capabilities:['observability:log'],cost,independenceDomain,
    health:async()=>Boolean(await ready())?{state:'available'}:{state:'unavailable'},
    execute:emit,
  });
}

export function buildHttpObservabilitySink({id,endpoint,token,independenceDomain,fetchImpl=globalThis.fetch}={}){
  const url=clean(endpoint,2000);const secret=clean(token,4000);
  return defineObservabilitySink({id,independenceDomain,cost:0,ready:()=>Boolean(url&&secret&&typeof fetchImpl==='function'),emit:async(record)=>{
    const response=await fetchImpl(url,{method:'POST',headers:{authorization:`Bearer ${secret}`,'content-type':'application/json'},body:JSON.stringify(record)});
    if(!response.ok)throw new Error(`observability_http_${response.status}`);
    return Object.freeze({accepted:true});
  }});
}

export function observabilitySinksFromEnv(env=process.env,{fetchImpl=globalThis.fetch}={}){
  let rows=[];try{rows=JSON.parse(String(env.OBSERVABILITY_SINKS_JSON||'[]'));}catch{return Object.freeze([]);}
  if(!Array.isArray(rows))return Object.freeze([]);
  return Object.freeze(rows.slice(0,8).map((row,index)=>buildHttpObservabilitySink({id:clean(row?.id,80)||`sink-${index+1}`,endpoint:row?.endpoint,token:row?.token,independenceDomain:clean(row?.independence_domain,120)||clean(row?.id,80)||`sink-${index+1}`,fetchImpl})));
}
export async function emitObservabilityCopies(record,providers=[],{requiredCopies=1}={}){
  const eligible=providers.filter(p=>providerSatisfies(p,{capabilities:['observability:log'],zeroCost:true}));
  const accepted=[];const failed=[];const domains=new Set();
  for(const provider of eligible){
    if(domains.has(provider.independence_domain))continue;
    let health;try{health=await provider.health();}catch{health={state:'unavailable'};}
    if(!['available','recovering','degraded'].includes(health?.state))continue;
    try{const result=await provider.execute(record);accepted.push({provider:provider.id,independence_domain:provider.independence_domain,result});domains.add(provider.independence_domain);}
    catch(error){failed.push({provider:provider.id,reason:clean(error?.message||'observability_emit_failed',240)});}
  }
  const required=Math.max(1,Number(requiredCopies)||1);const durable=accepted.length>=required;
  return Object.freeze({durable,required_copies:required,copies:accepted.length,independent_domains:domains.size,accepted:Object.freeze(accepted),failed:Object.freeze(failed)});
}

export function dispatchOperationalRecord(record,env=process.env,{fetchImpl=globalThis.fetch}={}){
  const providers=observabilitySinksFromEnv(env,{fetchImpl});
  if(!providers.length)return Promise.resolve(Object.freeze({durable:false,required_copies:0,copies:0,independent_domains:0,accepted:Object.freeze([]),failed:Object.freeze([])}));
  const required=Math.max(1,Math.min(providers.length,Number(env.OBSERVABILITY_REQUIRED_COPIES)||1));
  return emitObservabilityCopies(record,providers,{requiredCopies:required});
}
