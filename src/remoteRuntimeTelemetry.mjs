const ACTIVE_REMOTE_PROVIDERS=Object.freeze(['facebook','instagram','youtube']);
export async function remoteRuntimeChannelTruth(env=process.env,fetchImpl=globalThis.fetch){
  const url=String(env.REMOTE_CHANNEL_STATUS_URL||'').trim();
  if(!url||typeof fetchImpl!=='function')return Object.freeze({});
  let parsed;try{parsed=new URL(url);}catch{return Object.freeze({});}
  if(parsed.protocol!=='https:')return Object.freeze({});
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),3500);
  try{
    const r=await fetchImpl(url,{headers:{accept:'application/json'},cache:'no-store',signal:controller.signal});
    if(!r.ok)return Object.freeze({});
    const body=await r.json(),out={};
    for(const name of ACTIVE_REMOTE_PROVIDERS){const x=body?.channels?.[name];if(x?.api_configured===true&&x?.operational_ready===true)out[name]=Object.freeze({ready:true,mode:'provider_api_secondary_runtime'});}
    return Object.freeze(out);
  }catch{return Object.freeze({});}finally{clearTimeout(timer);}
}
export function overlayRemoteChannelTruth(summary,remote={}){
  return Object.freeze(Object.fromEntries(Object.entries(summary||{}).map(([name,state])=>[name,remote[name]?.ready?Object.freeze({...state,operational_ready:true,operational_mode:remote[name].mode,api_configured:true,automation_ready:true}):state])));
}
