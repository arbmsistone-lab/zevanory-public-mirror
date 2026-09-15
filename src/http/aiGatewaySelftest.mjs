import { askSignedFreeGateway } from '../aiProvider.mjs';

const json=(res,status,body)=>{res.statusCode=status;res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.end(JSON.stringify(body));};
const day=()=>new Date().toISOString().slice(0,10);

export default async function handler(req,res){
  if(req.method!=='GET')return json(res,405,{error:'method_not_allowed'});
  const kv=globalThis.__ZEVANORY_PRIVATE_KV__;
  const key=`ai-gateway-selftest:${day()}`;
  if(kv?.get){
    const cached=await kv.get(key);
    if(cached){try{return json(res,200,{...JSON.parse(cached),cached:true});}catch{}}
  }
  const systemInstruction='Return exactly one JSON object with action="review", confidence=0.9, rationale="gateway-selftest".';
  const input={stage:'certification',job_type:'learning_review',commercial:false};
  const results=[];
  for(const [providerHint,providerId] of [['mistral','ai-mistral-signed-free-adapter'],['lightning','ai-lightning-signed-free-adapter']]){
    try{
      const out=await askSignedFreeGateway({input,systemInstruction,providerHint,providerId});
      results.push({provider_hint:providerHint,state:'PASS',provider:out.provider,model:out.model,free_only:out.free_only===true,action:out.action||null});
    }catch(error){results.push({provider_hint:providerHint,state:'FAIL',error:String(error?.message||'unavailable').slice(0,100)});}
  }
  const ok=results.length===2&&results.every(x=>x.state==='PASS'&&x.free_only===true);
  const body={ok,state:ok?'PASS':'FAIL',zero_spend:true,commercial:false,providers:results,created_at:new Date().toISOString(),cached:false};
  if(kv?.put)await kv.put(key,JSON.stringify(body),{expirationTtl:86400});
  return json(res,ok?200:503,body);
}
