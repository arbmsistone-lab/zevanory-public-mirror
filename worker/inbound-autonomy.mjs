import { validateReply } from "./whatsapp-conversation.mjs";

const KEYWORD=/\b(quero|link|pre[cç]o)\b/i;
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean=(v,n=4000)=>String(v??"").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g," ").trim().slice(0,n);
let ddlByDatabase=new Map();

export function normalizeMetaSocialInbound(payload={}){
 const channel=payload.object==="instagram"?"instagram":"facebook",out=[];
 for(const entry of Array.isArray(payload.entry)?payload.entry:[]){
  for(const event of Array.isArray(entry?.messaging)?entry.messaging:[]){const text=clean(event?.message?.text);const sender=clean(event?.sender?.id,200);if(text&&sender)out.push({channel,kind:"dm",text,sender,event_id:clean(event?.message?.mid||`${entry.id}:${event.timestamp}`,300)});}
  for(const change of Array.isArray(entry?.changes)?entry.changes:[]){const v=change?.value||{},text=clean(v.message||v.text);const sender=clean(v.from?.id||v.sender_id,200),commentId=clean(v.comment_id||v.id,300);if(text&&sender&&commentId&&["feed","comments"].includes(String(change?.field||v?.item||"").toLowerCase()))out.push({channel,kind:"comment",text,sender,comment_id:commentId,event_id:commentId});}
 }
 return out;
}

const salesLink=(channel,eventId)=>`https://vendas.zevanory.api.br/solucoes?utm_source=${encodeURIComponent(channel)}&utm_medium=inbound&utm_campaign=meta_reply&utm_content=${encodeURIComponent(eventId)}`;
// One private reply, only when the person typed a keyword. No public comment reply, no greeting
// replies to non-keyword messages (automated engagement on the Meta portfolio is kept minimal: the
// WhatsApp account of the same Business portfolio/app 1071149631917061 was permanently disabled).
function replyFor(event){const trigger=KEYWORD.test(event.text);if(!trigger)return {private:null,trigger:false};const link=salesLink(event.channel,event.event_id);return {private:event.kind==="comment"?`Aqui está o link que você pediu: ${link}`:`Claro — aqui está o link oficial: ${link}`,trigger:true};}
function validateOutbound(text){const withoutUtm=String(text).replace(/https:\/\/vendas\.zevanory\.api\.br\/solucoes\?\S+/g,"https://vendas.zevanory.api.br/solucoes");const result=validateReply(withoutUtm);if(!result.ok)throw new Error(`meta_reply_invalid:${result.issues.join(",")}`);}
// Graph error codes that mean policy/permission/rate trouble: any of them (or any 4xx) trips the breaker.
const POLICY_CODES=new Set([4,10,17,32,100,190,200,230,368,551,613,2018108,2018278,80002,80006]);
class MetaReplyError extends Error{constructor(status,code){super(`meta_reply_http_${status}${code?"_"+code:""}`);this.status=status;this.code=code;this.trip=(status>=400&&status<500)||POLICY_CODES.has(Number(code));}}
async function graph(fetchImpl,path,token,body){const r=await fetchImpl(`https://graph.facebook.com/v26.0/${path}`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});const data=await r.json().catch(()=>({}));const code=Number(data?.error?.code||0)||null;if(!r.ok||data?.error||!(data.id||data.message_id||data.recipient_id))throw new MetaReplyError(r.status,code);return String(data.id||data.message_id||data.recipient_id);}

export const META_SOCIAL_BREAKER_KEY="zpc:meta-social:breaker:v1";
export const META_SOCIAL_LIMITS=Object.freeze({per_sender_per_day:1,per_hour:5,per_day:20});
// Kill-switch: META_SOCIAL_AUTOREPLY must be exactly "true" to send anything (default OFF).
export function metaSocialAutoreplyEnabled(env={}){return String(env?.META_SOCIAL_AUTOREPLY??"").trim().toLowerCase()==="true";}
// Free counters (Cache API) with an in-memory fallback: no KV write per message.
const memoryCounters=new Map();
export function resetMetaSocialMemoForTest(){memoryCounters.clear();}
function defaultCounters(){const cache=globalThis.caches?.default;return {async get(k){if(cache?.match){const r=await cache.match(new Request("https://meta-social-limit.internal/"+k)).catch(()=>null);return r?Number(await r.text())||0:0;}const e=memoryCounters.get(k);return e&&e.exp>Date.now()?e.n:0;},async put(k,n,ttl){if(cache?.put){await cache.put(new Request("https://meta-social-limit.internal/"+k),new Response(String(n),{headers:{"cache-control":"max-age="+ttl}})).catch(()=>{});return;}memoryCounters.set(k,{n,exp:Date.now()+ttl*1000});}};}
async function senderHash(v){const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(String(v)));return [...new Uint8Array(d)].slice(0,12).map(x=>x.toString(16).padStart(2,"0")).join("");}

export async function handleMetaSocialInbound(payload,env={},fetchImpl=fetch,{counters=defaultCounters(),now=Date.now()}={}){
 const events=normalizeMetaSocialInbound(payload),kv=env.ZEVANORY_PRIVATE_ARTIFACTS,results=[];
 if(!events.length)return {handled:false,received:0,replied:0};
 if(!metaSocialAutoreplyEnabled(env))return {handled:true,received:events.length,replied:0,disabled:"meta_social_autoreply_off"};
 const token=clean(env.META_ACCESS_TOKEN);
 if(!token)return {handled:true,received:events.length,replied:0,error:"meta_access_token_missing"};
 if(await kv?.get?.(META_SOCIAL_BREAKER_KEY))return {handled:true,received:events.length,replied:0,breaker:"open"};
 const hour=new Date(now).toISOString().slice(0,13),day=hour.slice(0,10);
 for(const event of events){
  const reply=replyFor(event);
  if(!reply.trigger){results.push({channel:event.channel,kind:event.kind,event_id:event.event_id,skipped:"no_keyword"});continue;}
  const dedup=`zpc:inbound:meta:${event.event_id}`;if(await kv?.get?.(dedup))continue;
  const who=await senderHash(event.channel+":"+event.sender);
  const keys=[[`s/${who}/${day}`,META_SOCIAL_LIMITS.per_sender_per_day,90000],[`h/${hour}`,META_SOCIAL_LIMITS.per_hour,3700],[`d/${day}`,META_SOCIAL_LIMITS.per_day,90000]];
  const counts=await Promise.all(keys.map(([k])=>counters.get(k)));
  if(keys.some(([,max],i)=>counts[i]>=max)){results.push({channel:event.channel,kind:event.kind,event_id:event.event_id,skipped:"rate_limited"});continue;}
  try{
   validateOutbound(reply.private);
   // Reserve before sending: at most one private reply per comment/message, even on retries.
   await kv?.put?.(dedup,JSON.stringify({reserved_at:new Date(now).toISOString()}),{expirationTtl:30*86400});
   await Promise.all(keys.map(([k,,ttl],i)=>counters.put(k,counts[i]+1,ttl)));
   let privateId;
   if(event.kind==="comment")privateId=await graph(fetchImpl,`${encodeURIComponent(event.comment_id)}/private_replies`,token,{message:reply.private});
   else{const recipient={id:event.sender},account=clean(event.channel==="instagram"?env.INSTAGRAM_BUSINESS_ACCOUNT_ID:env.META_PAGE_ID,200)||"me";privateId=await graph(fetchImpl,`${encodeURIComponent(account)}/messages`,token,{recipient,message:{text:reply.private},messaging_type:"RESPONSE"});}
   const proof={channel:event.channel,kind:event.kind,event_id:event.event_id,public_reply_id:null,private_reply_id:privateId,keyword_triggered:true,replied_at:new Date(now).toISOString()};
   await kv?.put?.(dedup,JSON.stringify(proof),{expirationTtl:30*86400});results.push(proof);
  }catch(error){
   results.push({channel:event.channel,kind:event.kind,event_id:event.event_id,error:clean(error?.message,120)});
   if(error?.trip){await kv?.put?.(META_SOCIAL_BREAKER_KEY,JSON.stringify({at:new Date(now).toISOString(),reason:clean(error.message,80)}),{expirationTtl:7*86400}).catch(()=>{});return {handled:true,received:events.length,replied:results.filter(x=>x.private_reply_id).length,breaker:"tripped",results};}
  }
 }
 return {handled:true,received:events.length,replied:results.filter(x=>x.private_reply_id).length,results};
}

async function ensureSchema(sql,databaseUrl){let ready=ddlByDatabase.get(databaseUrl);if(!ready){ready=sql.query(`create table if not exists inbound_followups (followup_key text primary key,kind text not null,subject_ref text not null,recipient_hash text not null,provider_message_id text null,sent_at timestamptz not null default now())`);ddlByDatabase.set(databaseUrl,ready);}await ready;}
async function hash(value){const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(String(value)));return [...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,"0")).join("");}
async function sendEmail(env,to,subject,text,key,fetchImpl){const r=await fetchImpl("https://api.resend.com/emails",{method:"POST",headers:{authorization:`Bearer ${env.RESEND_API_KEY}`,"content-type":"application/json","idempotency-key":key},body:JSON.stringify({from:String(env.RESEND_FROM_ADDRESS||"ZEVANORY <contato@zevanory.api.br>"),to:[to],subject,text}),signal:AbortSignal.timeout(15000)});const data=await r.json().catch(()=>({}));return r.ok&&data?.id?String(data.id):null;}

// Trava comercial: e-mail de "checkout em aberto" leva link de pagamento. Só sai com vendas ABERTAS
// (interruptor aplicado pelo cron antes de chamar o worker); ausente ou diferente de true = fechado.
export async function runInboundLifecycle(env={}, {sqlFactory,fetchImpl=fetch,salesOpen=globalThis.__ZEVANORY_SALES_SWITCH__===true}={}){
 if(salesOpen!==true)return {ok:true,skipped:"sales_closed",cart_checked:0,cart_sent:0};
 const databaseUrl=clean(env.DATABASE_URL,4000);if(!databaseUrl||!sqlFactory||!env.RESEND_API_KEY)return {ok:false,reason:"inbound_lifecycle_unconfigured"};const sql=sqlFactory(databaseUrl);await ensureSchema(sql,databaseUrl);
 const carts=await sql.query(`select o.order_id,o.checkout_url,l.contact_ref email from orders o join sales_leads l on l.session_id=o.session_id where o.status='checkout_ready' and o.updated_at<=now()-interval '1 hour' and o.updated_at>now()-interval '23 hours' and l.channel='email' and exists(select 1 from agent_jobs j where j.lead_id=l.lead_id and j.payload->>'consent_allowed'='true') and not exists(select 1 from inbound_followups f where f.followup_key='cart:'||o.order_id::text) limit 50`);
 let cart_sent=0;for(const row of carts){const email=clean(row.email,254);if(!EMAIL.test(email)||!clean(row.checkout_url).startsWith("https://"))continue;const key=`cart:${row.order_id}`,id=await sendEmail(env,email,"Você deixou um checkout em aberto",`Você iniciou um checkout e pediu comunicações sobre ele. Se ainda quiser concluir, use este link seguro:\n${row.checkout_url}\n\nEsta é a única lembrança desse checkout.`,key,fetchImpl);if(id){await sql.query("insert into inbound_followups(followup_key,kind,subject_ref,recipient_hash,provider_message_id) values($1,'cart_recovery',$2,$3,$4) on conflict do nothing",[key,String(row.order_id),await hash(email),id]);cart_sent++;}}
 return {ok:true,cart_checked:carts.length,cart_sent};
}
export function resetInboundMemoForTest(){ddlByDatabase=new Map();}
