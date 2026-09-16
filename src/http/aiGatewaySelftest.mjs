import { askSignedFreeGateway } from '../aiProvider.mjs';

const CF_MODEL='@cf/meta/llama-3.2-1b-instruct';
const json=(res,status,body)=>{res.statusCode=status;res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.end(JSON.stringify(body));};
const day=()=>new Date().toISOString().slice(0,10);
const parseJson=(text)=>{const raw=String(text||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');const a=raw.indexOf('{'),b=raw.lastIndexOf('}');if(a<0||b<a)throw new Error('cloudflare_ai_invalid_json');return JSON.parse(raw.slice(a,b+1));};

export default async function handler(req,res){
  if(req.method!=='GET')return json(res,405,{error:'method_not_allowed'});
  const kv=globalThis.__ZEVANORY_PRIVATE_KV__;
  const key=`ai-gateway-selftest:v2:${day()}`;
  if(kv?.get){const cached=await kv.get(key);if(cached){try{const value=JSON.parse(cached);if(value?.ok===true)return json(res,200,{...value,cached:true});}catch{}}}
  const systemInstruction='Return exactly one JSON object with action="review", confidence=0.9, rationale="gateway-selftest".';
  const input={stage:'certification',job_type:'learning_review',commercial:false};
  const results=[];
  for(const [providerHint,providerId] of [['mistral','ai-mistral-signed-free-adapter'],['lightning','ai-lightning-signed-free-adapter']]){
    try{const out=await askSignedFreeGateway({input,systemInstruction,providerHint,providerId});results.push({provider_hint:providerHint,state:'PASS',provider:out.provider,model:out.model,free_only:out.free_only===true,action:out.action||null});}
    catch(error){results.push({provider_hint:providerHint,state:'FAIL',error:String(error?.message||'unavailable').slice(0,100)});}
  }
  try{
    const ai=globalThis.__ZEVANORY_EDGE_AI__?.AI;
    if(!ai)throw new Error('cloudflare_ai_binding_missing');
    const out=await ai.run(CF_MODEL,{messages:[{role:'system',content:`${systemInstruction} Return one strict JSON object only.`},{role:'user',content:JSON.stringify(input)}],max_tokens:96,temperature:0});
    const decision=parseJson(out?.response||out?.choices?.[0]?.message?.content||'');
    results.push({provider_hint:'cloudflare',state:'PASS',provider:'cloudflare-workers-ai',model:CF_MODEL,free_only:true,action:decision?.action||null});
  }catch(error){results.push({provider_hint:'cloudflare',state:'FAIL',error:String(error?.message||'unavailable').slice(0,100)});}
  const ok=results.length===3&&results.every(x=>x.state==='PASS'&&x.free_only===true&&x.action==='review');
  const body={ok,state:ok?'PASS':'FAIL',zero_spend:true,commercial:false,providers:results,created_at:new Date().toISOString(),cached:false};
  if(ok&&kv?.put)await kv.put(key,JSON.stringify(body),{expirationTtl:86400});
  return json(res,ok?200:503,body);
}
