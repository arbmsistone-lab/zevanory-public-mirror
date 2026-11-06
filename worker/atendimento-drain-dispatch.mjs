// R138 | Same-zone SELF isolation for the /atendimento outbox. No change to Resend, retry, or 23h window.
import { drainAtendimentoOutbox } from "./atendimento.mjs";
import { senderSecret, signDrainRequest, DRAIN_NONCE_RE, ensureSupportSchema } from "./support-email-forward.mjs";

export const ATENDIMENTO_DRAIN_PATH = "/api/internal/atendimento/outbox/drain";
const json = (status, body) => new Response(JSON.stringify(body), {status, headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"}});
const same = (a,b) => { const x=String(a),y=String(b); if(!x||x.length!==y.length)return false;let v=0;for(let i=0;i<x.length;i++)v|=x.charCodeAt(i)^y.charCodeAt(i);return v===0; };

export async function handleAtendimentoDrainRequest(request,env,{sqlFactory,fetchImpl,nowMs=Date.now()}={}){
 const url=new URL(request.url);
 if(url.pathname!==ATENDIMENTO_DRAIN_PATH)return null;
 if(request.method!=="POST")return json(405,{error:"method_not_allowed"});
 const secret=senderSecret(env),minuteText=request.headers.get("x-atendimento-drain-minute")||"";
 const nonce=request.headers.get("x-atendimento-drain-nonce")||"",signature=request.headers.get("x-atendimento-drain-token")||"";
 const minute=/^\d{1,12}$/.test(minuteText)?Number(minuteText):NaN,now=Math.floor(nowMs/60000);
 if(!secret||!DRAIN_NONCE_RE.test(nonce)||!(/^[0-9a-f]{64}$/.test(signature))||(minute!==now&&minute!==now-1)||!same(signature,await signDrainRequest({secret,method:request.method,path:url.pathname,minute,nonce})))return json(401,{error:"unauthorized"});
 if((await request.text()).length)return json(400,{error:"body_not_allowed"});
 if(!env.DATABASE_URL||typeof sqlFactory!=="function")return json(503,{error:"nonce_store_unavailable"});
 try{
  const sql=sqlFactory(env.DATABASE_URL);
  await ensureSupportSchema(sql);
  const rows=await sql.query("/*atendimento:drain_nonce*/ insert into zevanory_support_drain_nonces (nonce) values ($1) on conflict (nonce) do nothing returning nonce",[nonce]);
  if(!rows?.length)return json(409,{error:"replay"});
  await sql.query("/*atendimento:drain_nonce_cleanup*/ delete from zevanory_support_drain_nonces where created_at < now() - interval '1 hour'",[]).catch(()=>null);
 }catch{return json(503,{error:"nonce_store_unavailable"});}
 try{
  const out=await drainAtendimentoOutbox(env,{sqlFactory,fetchImpl,limit:3});
  return json(out.ok===false?503:200,out);
 }catch{return json(503,{ok:false,reason:"atendimento_drain_failed"});}
}

// Strict isolation: NEVER fall back to inline draining inside the crowded hourly invocation.
// SELF returns a separate Worker invocation with its own Workers Free subrequest budget.
export async function dispatchAtendimentoDrain(env,{nowMs=Date.now()}={}){
 const secret=senderSecret(env),self=env?.SELF;
 if(!secret||typeof self?.fetch!=="function")return {via:"unavailable",status:null,result:{ok:false,reason:"self_unavailable"}};
 try{
  const minute=Math.floor(nowMs/60000),nonce=[...crypto.getRandomValues(new Uint8Array(16))].map(b=>b.toString(16).padStart(2,"0")).join("");
  const token=await signDrainRequest({secret,method:"POST",path:ATENDIMENTO_DRAIN_PATH,minute,nonce});
  const response=await self.fetch(new Request("https://zevanory.api.br"+ATENDIMENTO_DRAIN_PATH,{method:"POST",headers:{"x-atendimento-drain-token":token,"x-atendimento-drain-nonce":nonce,"x-atendimento-drain-minute":String(minute)},signal:AbortSignal.timeout(45000)}));
  const body=await response.json().catch(()=>null);
  return {via:"self",status:response.status,result:body&&typeof body==="object"?{...body,ok:response.ok&&body.ok!==false}:{ok:false,reason:"invalid_response"}};
 }catch{return {via:"self",status:0,result:{ok:false,reason:"self_dispatch_failed"}};}
}
