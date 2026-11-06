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

// Instagram / Facebook Page inbound: MANUAL-ONLY by owner decision (the WhatsApp account of the same
// Meta Business portfolio and app 1071149631917061 was permanently disabled on 2026-10-10). There is no
// automated public or private reply path and no switch to enable one: this function only classifies the
// delivery so the webhook can acknowledge it. It sends nothing, calls no Graph endpoint and stores no
// message content. Bringing automation back requires a new reviewed PR.
export async function handleMetaSocialInbound(payload){
 const events=normalizeMetaSocialInbound(payload);
 if(!events.length)return {handled:false,received:0,replied:0};
 return {handled:true,received:events.length,replied:0,mode:"manual_only"};
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
