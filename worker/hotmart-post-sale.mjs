import {restrictedQuota,reserveRestrictedQuota} from "./hotmart-post-sale-quota.mjs";
import {containsForbiddenCreativeText} from "./creative-autonomy.mjs";
import PRODUCTS from '../data/products.json' with {type:'json'};
import ALLOW from '../data/p18-commercial-allowlist.json' with {type:'json'};
import {validOwnerAuthorization} from './sales-control.mjs';
const DAY=86400000,BASE='zpc:posvenda:hotmart:',ORDER=BASE+'pedido:',STOP=BASE+'cancelado:',OPT=BASE+'optout:';
export const HOTMART_POSTSALE_OPTOUT='/pos-venda/hotmart/descadastrar';
export const STEPS=Object.freeze([{id:'d0',days:0},{id:'d1',days:1},{id:'d5',days:5}]);
const KITS=ALLOW.products.filter(p=>p.kind==='kit'&&PRODUCTS.products.some(c=>c.sku===p.sku&&c.slug===p.slug));
if(KITS.length!==5||new Set(KITS.map(p=>p.hotmart_product_id)).size!==5)throw Error('hotmart_catalog_invalid');
const enc=new TextEncoder(),hex=v=>[...new Uint8Array(v)].map(x=>x.toString(16).padStart(2,'0')).join('');
const sha=async s=>hex(await crypto.subtle.digest('SHA-256',enc.encode(s)));
const emailRe=/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const txnRe=/^[A-Za-z0-9._:-]{1,160}$/;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const json=(status,body)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
const eq=(a,b)=>{if(a.length!==b.length||!a.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;};
function authenticated(request,env){let cfg={};try{cfg=typeof env.CHANNEL_CREDENTIALS_JSON==='string'?JSON.parse(env.CHANNEL_CREDENTIALS_JSON):env.CHANNEL_CREDENTIALS_JSON||{};}catch{}const secret=String(env.HOTMART_HOTTOK||cfg.HOTMART_HOTTOK||'').trim();return secret.length>=16&&eq(secret,request.headers.get('x-hotmart-hottok')||'');}
async function read(kv,key,shape){const raw=await kv.get(key);if(raw===null)return null;const v=JSON.parse(raw);if(!shape(v))throw Error('state_unreadable');return v;}
const marker=v=>object(v)&&v.stopped===true;
const orderShape=v=>object(v)&&txnRe.test(v.transaction)&&KITS.some(k=>k.hotmart_product_id===v.product)&&emailRe.test(v.email)&&typeof v.firstName==='string'&&v.firstName.length<=60&&Number.isSafeInteger(v.approvedAt)&&Number.isSafeInteger(v.expiresAt)&&v.expiresAt===v.approvedAt+35*DAY&&v.legal==='execucao_contrato';
const stepShape=v=>object(v)&&['attempting','unknown','sent','rejected'].includes(v.status)&&Number.isInteger(v.attempts)&&v.attempts>=1&&v.attempts<=2&&typeof v.bodyHash==='string'&&/^[a-f0-9]{64}$/.test(v.bodyHash)&&Number.isSafeInteger(v.firstAttempt)&&Number.isSafeInteger(v.lastAttempt);
const confirmedShape=v=>object(v)&&typeof v.id==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v.id)&&typeof v.bodyHash==='string';
const expiry=(at,now)=>({expirationTtl:Math.max(60,Math.ceil((at-now)/1000))});
async function hmac(env,id){if(!env.RESEND_API_KEY)throw Error('mailer_unavailable');const key=await crypto.subtle.importKey('raw',enc.encode('hotmart-posvenda/v1:'+env.RESEND_API_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign']);return hex(await crypto.subtle.sign('HMAC',key,enc.encode(id)));}
export function transactionalContent(step,kit){
 const first={ 'ZEV-IA-011':'Escolha uma tarefa e revise o primeiro rascunho antes de usar.', 'ZEV-VEN-011':'Escolha um roteiro e adapte a abertura ao seu atendimento.', 'ZEV-LCX-011':'Comece preenchendo as entradas e saídas do primeiro dia.', 'ZEV-CMB-011':'Escolha uma tarefa de atendimento e adapte um dos modelos.', 'ZEV-NGC-011':'Escolha uma área do seu negócio e abra o respectivo guia inicial.' };
 if(step==='d0')return {subject:'Seu acesso a '+kit.name,text:'Boas-vindas à ZEVANORY. Acesse seu material em https://consumer.hotmart.com/ . Use a conta da compra e abra Minhas compras. A entrega é feita pela Hotmart; este e-mail não contém anexos.'};
 if(step==='d1')return {subject:'Primeiro passo: '+kit.name,text:first[kit.sku]+' Use o material na sua área de compras da Hotmart.'};
 if(step==='d5')return {subject:'Precisa de ajuda com '+kit.name+'?',text:'Conseguiu abrir e usar o material? Se precisar de ajuda, escreva para suporte@zevanory.api.br.'};
 throw Error('invalid_step');
}
export function safeTransactionalContent(mail){const text=mail.subject+' '+mail.text;return !containsForbiddenCreativeText(text)&&!/\b(upgrade|oferta|depoimento|whatsapp|telegram)\b|R\$|\b\d+[,.]\d{2}\b/i.test(text);}
export async function recordHotmartPostSale(request,env,body,{now=Date.now()}={}){
 // Defense in depth even when called after the authenticated sales ledger.
 if(new URL(request.url).pathname!=='/api/webhooks/hotmart'||request.method!=='POST')return {ok:true,ignored:true};
 if(!authenticated(request,env))return {ok:false,code:'unauthorized'};
 const event=body?.event,data=body?.data,kit=KITS.find(k=>k.hotmart_product_id===String(data?.product?.id));
 if(!kit)return {ok:true,ignored:true};
 if(!['PURCHASE_APPROVED','PURCHASE_REFUNDED','PURCHASE_CHARGEBACK'].includes(event))return {ok:true,ignored:true};
 const transaction=String(data?.purchase?.transaction||'');if(!txnRe.test(transaction))return {ok:false,code:'transaction_invalid'};
 const ref=await sha(transaction),kv=env.ZEVANORY_PRIVATE_ARTIFACTS;
 try{
  let stopped;
  const stoppedRaw=await kv.get(STOP+ref);
  if(stoppedRaw!==null){try{stopped=JSON.parse(stoppedRaw);if(!marker(stopped))throw Error('shape');}catch{if(event==='PURCHASE_APPROVED')throw Error('stop_unreadable');stopped=null;}}
  if(event!=='PURCHASE_APPROVED'){
   if(!stopped)await kv.put(STOP+ref,JSON.stringify({stopped:true}),{expirationTtl:400*86400});
   return {ok:true,canceled:true};
  }
  if(stopped)return {ok:true,canceled:true};
  let prior;
  const raw=await kv.get(ORDER+ref);
  if(raw!==null){try{prior=JSON.parse(raw);if(!orderShape(prior))throw Error('shape');}catch{
   // Fresh authenticated approval restores only the order projection. Never erase step receipts.
   for(const step of STEPS){await read(kv,BASE+transaction+':'+step.id,stepShape);await read(kv,BASE+transaction+':'+step.id+':confirmado',confirmedShape);}
   prior=null;
  }}
  if(prior)return {ok:true,duplicate:true};
  const approvedAt=data?.purchase?.approved_date,email=String(data?.buyer?.email||'').trim().toLowerCase();
  if(body.version!=='2.0.0'||!Number.isSafeInteger(approvedAt)||approvedAt<=0||approvedAt>now+60000||!emailRe.test(email)){
   const key=BASE+'pendente:'+ref;
   const pending=await read(kv,key,v=>object(v)&&v.pending===true&&v.reason==='purchase_details_invalid');
   if(!pending)await kv.put(key,JSON.stringify({pending:true,reason:'purchase_details_invalid'}),{expirationTtl:35*86400});
   return {ok:true,pending:true,code:'purchase_details_invalid'};
  }
  if(now>=approvedAt+35*DAY)return {ok:true,expired:true};
  const firstName=String(data?.buyer?.first_name||data?.buyer?.name||'').trim().split(/\s+/)[0].replace(/[^\p{L}'-]/gu,'').slice(0,60);
  const value={transaction,product:kit.hotmart_product_id,email,firstName,approvedAt,expiresAt:approvedAt+35*DAY,legal:'execucao_contrato'};
  await kv.put(ORDER+ref,JSON.stringify(value),expiry(value.expiresAt,now));return {ok:true,queued:true};
 }catch{return {ok:false,code:'post_sale_state_unavailable'};}
}
async function salesAllowed(kv,now){
 const sw=await read(kv,'sales:hotmart:v1',v=>object(v)&&v.channel==='hotmart'&&typeof v.enabled==='boolean');
 return sw!==null&&validOwnerAuthorization(sw,now);
}
async function providerGet(env,fetchImpl,path){const r=await fetchImpl('https://api.resend.com'+path,{headers:{authorization:'Bearer '+env.RESEND_API_KEY},signal:AbortSignal.timeout(10000)});if(r.status!==200){const e=Error('provider_read_failed');e.status=r.status;throw e;}return r.json();}
// Quota is independent of the sent-email history. Official GET /usage counts
// the account's rolling daily window and calendar month, including other flows.
async function providerUsage(env,fetchImpl,now){
 let v;try{v=await providerGet(env,fetchImpl,'/usage');}catch(error){if(error.status===401||error.status===403)return {restricted:true};throw error;}
 const valid=(w,maxWindow,nullable)=>object(w)&&Number.isSafeInteger(w.used)&&w.used>=0&&(nullable&&w.limit===null||Number.isSafeInteger(w.limit)&&w.limit>=0)&&typeof w.resets_at==='string'&&Number.isFinite(Date.parse(w.resets_at))&&Date.parse(w.resets_at)>now&&Date.parse(w.resets_at)<=now+maxWindow;
 if(v?.object!=='usage'||!valid(v?.emails?.daily,DAY+60000,true)||!valid(v?.emails?.monthly,32*DAY,false))throw Error('provider_usage_invalid');
 return {used:v.emails.daily.used,dailyLimit:Math.min(100,v.emails.daily.limit??100),monthlyUsed:v.emails.monthly.used,monthlyLimit:Math.min(3000,v.emails.monthly.limit)};
}
async function mailBody(order,step,env,ref){const kit=KITS.find(k=>k.hotmart_product_id===order.product),content=transactionalContent(step,kit);if(!safeTransactionalContent(content))throw Error('content_rejected');
 const opt='https://zevanory.api.br'+HOTMART_POSTSALE_OPTOUT+'?i='+ref+'&t='+await hmac(env,ref);
 const text='Olá'+(order.firstName?', '+order.firstName:'')+'.\n\n'+content.text+'\n\nEquipe ZEVANORY\nSuporte: suporte@zevanory.api.br\nInterromper este acompanhamento: '+opt;
 if(!safeTransactionalContent({subject:content.subject,text}))throw Error('content_rejected');
 return {from:String(env.RESEND_FROM_ADDRESS||'ZEVANORY <contato@zevanory.api.br>'),to:[order.email],reply_to:'suporte@zevanory.api.br',subject:content.subject,text,headers:{'List-Unsubscribe':'<'+opt+'>','List-Unsubscribe-Post':'List-Unsubscribe=One-Click'},tags:[{name:'flow',value:'hotmart_posvenda'},{name:'reference',value:ref.slice(0,32)+'_'+step}]};
}
// At most one list page per unknown stage/tick. The cursor and remaining
// candidates survive the tick; neither exhaustion nor read failure permits POST.
async function reconcile(env,fetchImpl,kv,key,body,state,{ttl,budget}){
 const cursorKey=key+':reconciliacao';
 const validId=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v);
 const shape=v=>object(v)&&v.bodyHash===state.bodyHash&&(v.after===null||validId(v.after))&&Array.isArray(v.candidates)&&v.candidates.length<=100&&v.candidates.every(validId);
 const rawCursor=await kv.get(cursorKey);let savedCursor=null;
 if(rawCursor!==null){try{const v=JSON.parse(rawCursor);if(shape(v))savedCursor=v;}catch{}}
 // This is a disposable search projection, never an attempt receipt. Restarting
 // a corrupt cursor only repeats GETs; the unknown-stage POST prohibition remains.
 let cursor=savedCursor||{bodyHash:state.bodyHash,after:null,candidates:[]};
 const get=async path=>{if(budget.remaining<=0)throw Error('reconcile_budget');budget.remaining--;return providerGet(env,fetchImpl,path);};
 const drain=async()=>{
  while(cursor.candidates.length&&budget.remaining>0){
   const id=cursor.candidates[0],v=await get('/emails/'+encodeURIComponent(id));
   if(!object(v)||v.id!==id||!Array.isArray(v.to)||typeof v.subject!=='string'||typeof v.text!=='string')throw Error('reconcile_detail_invalid');
   if(JSON.stringify(v.to)===JSON.stringify(body.to)&&v.subject===body.subject&&v.text===body.text)return id;
   cursor={...cursor,candidates:cursor.candidates.slice(1)};await kv.put(cursorKey,JSON.stringify(cursor),ttl);
  }
  return null;
 };
 if(cursor.candidates.length)return drain();
 if(budget.remaining<=0)return null;
 const page=await get('/emails?limit=100'+(cursor.after?'&after='+encodeURIComponent(cursor.after):''));
 if(!object(page)||!Array.isArray(page.data)||typeof page.has_more!=='boolean'||!page.data.every(x=>object(x)&&validId(x.id)&&Number.isFinite(Date.parse(x.created_at))))throw Error('reconcile_list_invalid');
 const after=page.has_more?page.data.at(-1)?.id:null;
 if(page.has_more&&(!after||after===cursor.after))throw Error('reconcile_cursor_invalid');
 const candidates=page.data.filter(x=>x.subject===body.subject&&Array.isArray(x.to)&&x.to.includes(body.to[0])&&Date.parse(x.created_at)>=state.firstAttempt-60000&&Date.parse(x.created_at)<=state.lastAttempt+60000).map(x=>x.id);
 cursor={bodyHash:state.bodyHash,after,candidates};
 await kv.put(cursorKey,JSON.stringify(cursor),ttl);
 return drain();
}
const STATUS=BASE+'status:v1',HOUR=3600000;
// Contrato ÚNICO do status (NC-G6-1025-02): tipos, campos e COERÊNCIA entre resultado, código e pendentes, com os
// códigos que o próprio gravador emite. Estado contraditório = LEITURA_INCONCLUSIVA (value:null). O Vigia
// (worker/vigia.mjs) importa esta mesma função, então os dois não divergem.
export const POST_SALE_STATUS_CODES=Object.freeze({
 ok:Object.freeze(['completed','no_due_steps','kv_budget_hold','sales_closed']),
 inconclusivo:Object.freeze(['not_configured','quota_ledger_unreadable','post_sale_inconclusive']),
 reconciliacao_pendente:Object.freeze(['reconciliation_pending','provider_restricted'])
});
export const validPostSaleStatusShape=v=>object(v)&&Object.keys(v).sort().join(',')==='codigo,em,pendentes,resultado'&&typeof v.em==='string'&&Number.isFinite(Date.parse(v.em))&&new Date(Date.parse(v.em)).toISOString()===v.em&&typeof v.resultado==='string'&&Object.hasOwn(POST_SALE_STATUS_CODES,v.resultado)&&typeof v.codigo==='string'&&POST_SALE_STATUS_CODES[v.resultado].includes(v.codigo)&&Number.isSafeInteger(v.pendentes)&&v.pendentes>=0&&(v.resultado==='reconciliacao_pendente'?v.pendentes>0:v.pendentes===0);
const statusShape=validPostSaleStatusShape;
export async function readHotmartPostSaleStatus(kv,{now=Date.now()}={}){
 try{const value=await read(kv,STATUS,statusShape);if(!value)return {status:'NAO_EXECUTADO',value:null};if(Date.parse(value.em)>now||now-Date.parse(value.em)>=7*DAY)throw Error('stale_status');return {status:'ok',value};}
 catch{return {status:'LEITURA_INCONCLUSIVA',value:null};}
}
const statusTasks=new WeakMap(),statusLastWrite=new WeakMap();
async function persistRunStatus(kv,out,now){
 if(!kv?.get||!kv?.put)return false;
 const previous=statusTasks.get(kv)||Promise.resolve();
 const task=previous.catch(()=>{}).then(async()=>{
  const raw=await kv.get(STATUS);let prior=null;
  if(raw!==null){try{const v=JSON.parse(raw);if(statusShape(v))prior=v;}catch{}}
  const resultado=!out.ok?'inconclusivo':out.reconciliationPending>0?'reconciliacao_pendente':'ok';
  const value={em:new Date(now).toISOString(),resultado,codigo:out.code||(resultado==='reconciliacao_pendente'?'reconciliation_pending':'completed'),pendentes:resultado==='reconciliacao_pendente'?out.reconciliationPending:0};
  const last=Math.max(prior?Date.parse(prior.em):-Infinity,statusLastWrite.get(kv)??-Infinity);
  if(now-last<HOUR)return true;
  if(prior&&prior.resultado===value.resultado&&prior.codigo===value.codigo&&prior.pendentes===value.pendentes)return true;
  await kv.put(STATUS,JSON.stringify(value),{expirationTtl:7*86400});
  statusLastWrite.set(kv,now);return true;
 });
 statusTasks.set(kv,task);
 try{return await task;}catch{return false;}finally{if(statusTasks.get(kv)===task)statusTasks.delete(kv);}
}
export async function runHotmartPostSale(env,options={}){
 const now=options.now??Date.now(),out=await runHotmartPostSaleInternal(env,{...options,now});
 if(out.code==='already_running'||(options.cron??'0 * * * *')!=='0 * * * *')return out;
 const statusPersisted=await persistRunStatus(env.ZEVANORY_PRIVATE_ARTIFACTS,out,now);
 if(!statusPersisted)console.error('hotmart_post_sale_status_unavailable');
 return {...out,statusPersisted};
}
const running=new WeakSet();
async function runHotmartPostSaleInternal(env,{now=Date.now(),fetchImpl=fetch,cron='0 * * * *',sqlFactory}={}){
 if(cron!=='0 * * * *')return {ok:true,sent:0,priority:1,code:'not_hourly_tick'};
 const kv=env.ZEVANORY_PRIVATE_ARTIFACTS;if(!kv?.list||!env.RESEND_API_KEY)return {ok:false,code:'not_configured',sent:0,priority:1};
 if(running.has(kv))return {ok:true,sent:0,priority:1,code:'already_running'};running.add(kv);
 let sent=0;
 try{
  if(!await salesAllowed(kv,now))return {ok:true,sent:0,priority:1,code:'sales_closed'};
  const budget=await read(kv,'zpc:kv:v1:budget',v=>object(v)&&typeof v.pct==='number'&&Number.isFinite(v.pct)&&typeof v.at==='string'&&Number.isFinite(Date.parse(v.at)));
  if(budget&&(budget.pct>=60||now-Date.parse(budget.at)>DAY))return {ok:true,sent:0,priority:1,code:'kv_budget_hold'};
  let cursor;const orders=[];
  for(let page=0;page<10;page++){
   const p=await kv.list({prefix:ORDER,limit:100,cursor});if(!object(p)||!Array.isArray(p.keys)||typeof p.list_complete!=='boolean'||!p.keys.every(k=>typeof k.name==='string'&&k.name.startsWith(ORDER)))throw Error('queue_unreadable');
   for(const key of p.keys){const order=await read(kv,key.name,orderShape);if(order)orders.push([key.name.slice(ORDER.length),order]);}
   if(p.list_complete)break;cursor=p.cursor;if(!cursor||page===9)throw Error('queue_incomplete');
  }
  let hasDue=false;
  for(const [ref,order] of orders){
   if(now>=order.expiresAt)continue;
   if(await read(kv,STOP+ref,marker)||await read(kv,OPT+ref,marker))continue;
   for(const step of STEPS){if(now<order.approvedAt+step.days*DAY)continue;
    const raw=await kv.get(BASE+order.transaction+':'+step.id+':confirmado');
    if(raw===null){hasDue=true;break;}
    try{if(!confirmedShape(JSON.parse(raw)))hasDue=true;}catch{hasDue=true;}
   }
   if(hasDue)break;
  }
  if(!hasDue)return {ok:true,sent:0,priority:1,code:'no_due_steps'};
  const usage=await providerUsage(env,fetchImpl,now);
  const restricted=usage.restricted===true;
  const quotaSql=restricted&&env.DATABASE_URL&&typeof sqlFactory==='function'?sqlFactory(env.DATABASE_URL):null;
  let {used,dailyLimit,monthlyUsed,monthlyLimit}=restricted?await restrictedQuota(quotaSql,now):usage;
  const reconciliationBudget={remaining:9};let reconciliationPending=0;
  for(const [ref,order] of orders.sort((a,b)=>a[1].approvedAt-b[1].approvedAt)){
   if(now>=order.expiresAt||await read(kv,STOP+ref,marker)||await read(kv,OPT+ref,marker))continue;
   for(const step of STEPS){
    if(now<order.approvedAt+step.days*DAY)continue;
    const key=BASE+order.transaction+':'+step.id,ttl=expiry(order.expiresAt,now),body=await mailBody(order,step.id,env,ref),bodyHash=await sha(JSON.stringify(body));
    const stageRead=async (k,shape)=>{const raw=await kv.get(k);if(raw===null)return {value:null,corrupt:false};try{const v=JSON.parse(raw);if(!shape(v))throw Error('shape');return {value:v,corrupt:false};}catch{return {value:null,corrupt:true};}};
    const confirmation=await stageRead(key+':confirmado',confirmedShape),confirmed=confirmation.value;if(confirmed){if(confirmed.bodyHash!==bodyHash)throw Error('body_changed');continue;}
    const attempt=await stageRead(key,stepShape);
    const prior=confirmation.corrupt||attempt.corrupt?{status:'unknown',attempts:2,bodyHash,firstAttempt:order.approvedAt,lastAttempt:now}:attempt.value;
    if(prior&&prior.bodyHash!==bodyHash)throw Error('body_changed');
    if(prior&&['attempting','unknown','sent'].includes(prior.status)){
     if(restricted){reconciliationPending++;continue;}
     try{const id=await reconcile(env,fetchImpl,kv,key,body,prior,{ttl,budget:reconciliationBudget});if(id)await kv.put(key+':confirmado',JSON.stringify({id,bodyHash}),ttl);else reconciliationPending++;}catch{reconciliationPending++;}
     continue; // unknown never permits another POST, even after the provider key expires
    }
    if(prior&&(prior.attempts>=2||now-prior.firstAttempt>=23*3600000||now-prior.lastAttempt<3600000))continue;
    if(used>=dailyLimit||monthlyUsed>=monthlyLimit||sent>=3)break;
    if(await read(kv,STOP+ref,marker)||await read(kv,OPT+ref,marker)||!await salesAllowed(kv,now))break;
    const state={status:'attempting',attempts:(prior?.attempts||0)+1,bodyHash,firstAttempt:prior?.firstAttempt??now,lastAttempt:now};
    if(restricted&&!await reserveRestrictedQuota(quotaSql,now))break;
    await kv.put(key,JSON.stringify(state),ttl);used++;monthlyUsed++;
    let response;try{response=await fetchImpl('https://api.resend.com/emails',{method:'POST',headers:{authorization:'Bearer '+env.RESEND_API_KEY,'content-type':'application/json','Idempotency-Key':'hm-posvenda-'+ref+'-'+step.id},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});}catch{}
    let v;try{v=await response?.json();}catch{}
    if(response?.status===200&&typeof v?.id==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v.id)){
     await kv.put(key+':confirmado',JSON.stringify({id:v.id,bodyHash}),ttl);state.status='sent';sent++;
    }else{state.status=response?.status===429?'rejected':'unknown';if(state.status==='unknown')reconciliationPending++;}
    await kv.put(key,JSON.stringify(state),ttl);
   }
  }
  return {ok:true,sent,priority:1,reconciliationPending,...(restricted&&reconciliationPending>0?{code:'provider_restricted'}:{})};
 }catch(e){return {ok:false,sent,priority:1,code:e.message==='quota_ledger_unreadable'?'quota_ledger_unreadable':'post_sale_inconclusive'};}finally{running.delete(kv);}
}
export async function handleHotmartPostSaleOptOut(request,env){
 const url=new URL(request.url);if(url.pathname!==HOTMART_POSTSALE_OPTOUT)return null;
 if(!['GET','POST'].includes(request.method))return json(405,{ok:false});
 const id=url.searchParams.get('i')||'',token=url.searchParams.get('t')||'';
 try{if(!/^[a-f0-9]{64}$/.test(id)||!eq(await hmac(env,id),token))return json(403,{ok:false});
  if(request.method==='GET')return new Response('<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Interromper acompanhamento</title><main><h1>Interromper o acompanhamento?</h1><p>Confirme abaixo para parar de receber estes e-mails da ZEVANORY.</p><form method="post"><button type="submit">Confirmar descadastro</button></form></main></html>',{status:200,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"}});
  const kv=env.ZEVANORY_PRIVATE_ARTIFACTS;let prior;
  const raw=await kv.get(OPT+id);if(raw!==null){try{prior=JSON.parse(raw);if(!marker(prior))prior=null;}catch{prior=null;}}
  if(!prior)await kv.put(OPT+id,JSON.stringify({stopped:true}),{expirationTtl:400*86400});
  return json(200,{ok:true,unsubscribed:true});
 }catch{return json(503,{ok:false,error:'suppression_unavailable'});}
}

// Secondary effect only. Every failure path remains unable to change sales ingress.
export async function enqueueHotmartPostSaleSecondary(request,env,body,{now=Date.now()}={}){
 try{
  const out=await recordHotmartPostSale(request,env,body,{now});
  if(out.ok){
   if(out.queued||out.duplicate||out.canceled){try{const key=BASE+'falha:'+await sha(String(body?.data?.purchase?.transaction||''));const old=await read(env.ZEVANORY_PRIVATE_ARTIFACTS,key,v=>object(v)&&typeof v.failed==='boolean');if(old?.failed)await env.ZEVANORY_PRIVATE_ARTIFACTS.put(key,JSON.stringify({failed:false}),{expirationTtl:7*86400});}catch{}}
   return true;
  }
 }catch{}
 console.error('hotmart_post_sale_enqueue_failed');
 try{const transaction=String(body?.data?.purchase?.transaction||'');if(txnRe.test(transaction))await env.ZEVANORY_PRIVATE_ARTIFACTS.put(BASE+'falha:'+await sha(transaction),JSON.stringify({failed:true}),{expirationTtl:7*86400});}catch{}
 return false;
}
export async function readHotmartPostSaleFailures(kv){
 try{let count=0,cursor;
  for(let page=0;page<100;page++){
   const result=await kv.list({prefix:BASE+'falha:',limit:100,cursor});
   if(!object(result)||!Array.isArray(result.keys)||typeof result.list_complete!=='boolean')throw Error('shape');
   for(const key of result.keys){if(!/^zpc:posvenda:hotmart:falha:[a-f0-9]{64}$/.test(key?.name))throw Error('shape');const value=await read(kv,key.name,v=>object(v)&&Object.keys(v).length===1&&typeof v.failed==='boolean');if(value?.failed)count++;}
   if(result.list_complete)return {status:'ok',count,label:'pós-venda não enfileirado ('+count+')'};
   cursor=result.cursor;if(!cursor)throw Error('cursor');
  }throw Error('limit');
 }catch{return {status:'LEITURA_INCONCLUSIVA',count:null,label:'pós-venda não enfileirado: leitura inconclusiva'};}
}
