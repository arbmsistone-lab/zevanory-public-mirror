// Acquisition V1: independent channel outcomes, evidence-first and zero cold outreach.
// Cron ingress remains the existing Cloudflare hourly schedule; this module selects peak slots.
import { ensureDailyBlog, publishTelegram, channelChecklist, resolveChannelCredentials, localContentDay } from "./multichannel-autonomy.mjs";
import { publishBluesky, blueskyReady, blueskyPostText, graphemeCount } from "./bluesky-publisher.mjs";
import { emitActivity } from "./activity-ledger.mjs";
import { creativeAutopublishPaused } from "./creative-autonomy.mjs";
export const ACQUISITION_STATE_PREFIX="zpc:acquisition:daily:";
export const ACQUISITION_CALENDAR_KEY="zpc:acquisition:calendar:v1";
const DAY=86400000;
const PRODUCTS=Object.freeze([
 {sku:"ZEV-IA-011",name:"IA na Prática",price:197},
 {sku:"ZEV-VEN-011",name:"Vendas na Prática",price:197},
 {sku:"ZEV-LCX-011",name:"Lucro & Caixa",price:247},
 {sku:"ZEV-CMB-011",name:"Combo IA + Vendas",price:297},
 {sku:"ZEV-NGC-011",name:"Negócio Completo",price:397}
]);
const NICHES=Object.freeze(["salão","loja","prestador de serviço","delivery","autônomo"]);
const ANGLES=Object.freeze(["dor","tutorial","caso de uso","objeção","comparação"]);
const TIMEZONE="America/Sao_Paulo";
const PEAK_HOURS=Object.freeze({blog:9,telegram:12,bluesky:19});
const safeJson=async(kv,key,fallback)=>{try{return JSON.parse(String(await kv?.get?.(key)||"null"))??fallback;}catch{return fallback;}};
const dayOrdinal=day=>Math.floor(Date.parse(day+"T00:00:00Z")/DAY);
const localHour=now=>Number(new Intl.DateTimeFormat("en-GB",{timeZone:TIMEZONE,hour:"2-digit",hourCycle:"h23"}).format(now));
const localDay=now=>new Intl.DateTimeFormat("en-CA",{timeZone:TIMEZONE,year:"numeric",month:"2-digit",day:"2-digit"}).format(now);
export function calendarEntry(day){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw new Error("calendar_day_invalid");
 const n=dayOrdinal(day)-dayOrdinal("2026-10-10"); if(!Number.isInteger(n))throw new Error("calendar_day_invalid");
 const product=PRODUCTS[((n%5)+5)%5],niche=NICHES[((Math.floor(n/5)%5)+5)%5],angle=ANGLES[((n*3+Math.floor(n/5))%5+5)%5];
 const subject=niche+" · "+product.name+" · "+angle;
 return {day,product,niche,angle,subject,theme_id:[product.sku,niche,angle].join(":"),
  publish_at:{blog:"09:00",telegram:"12:00",bluesky:"19:00"},timezone:TIMEZONE};
}
export function planCalendar(now=new Date(),days=30){
 if(!Number.isInteger(days)||days<1||days>30)throw new Error("calendar_range_invalid");
 const first=localDay(now),epoch=Date.parse(first+"T00:00:00Z");
 return Array.from({length:days},(_,i)=>calendarEntry(new Date(epoch+i*DAY).toISOString().slice(0,10)));
}
export function productLink(entry,channel){
 if(!["blog","telegram","bluesky"].includes(channel))throw new Error("channel_not_enabled");
 const u=new URL("https://vendas.zevanory.api.br/comprar/"+entry.product.sku);
 u.searchParams.set("utm_source",channel);u.searchParams.set("utm_medium","organic");u.searchParams.set("utm_campaign","conteudo_"+entry.day.replaceAll("-",""));
 return u.toString();
}
const guidance=Object.freeze({
 "dor":"Identifique uma dúvida recorrente e registre o que precisa de confirmação antes de responder.",
 "tutorial":"Escolha uma tarefa pequena, documente o processo e revise cada resultado com uma pessoa.",
 "caso de uso":"Simule um atendimento com dados fictícios e confira informações antes de enviar.",
 "objeção":"Compare o trabalho manual com uma rotina assistida, sem presumir economia ou faturamento.",
 "comparação":"Avalie clareza, privacidade e possibilidade de desfazer cada automação antes de adotá-la."
});
export function generateNative(entry,channel){
 const headline=entry.angle==="tutorial"?"Passo a passo":entry.angle==="comparação"?"O que avaliar":"Uma ideia prática";
 const hook=headline+" para "+entry.niche;
 const value=entry.product.name+": "+guidance[entry.angle]+" Use o guia para organizar a rotina.";
 const cta="Veja o guia digital";
 const link=productLink(entry,channel);
 if(channel==="telegram")return {channel,hook,value,cta,link,text:hook+"\n\n"+value+"\n\n"+cta+": "+link+"\n#ZEVANORY #Negocios"};
 if(channel==="bluesky"){
  const generated=blueskyPostText({hook,value,cta,productUrl:link,day:entry.day});
  return {channel,hook,value,cta,link:generated.link,text:generated.text};
 }
 if(channel==="blog")return {channel,hook,value,cta,link,text:hook+". "+value+" "+cta+": "+link};
 throw new Error("channel_not_enabled");
}
export function textSimilarity(a,b){
 const tokens=s=>String(s||"").toLocaleLowerCase("pt-BR").match(/[\p{L}\p{N}]+/gu)||[];
 const grams=s=>{const t=tokens(s);return new Set(t.slice(0,-2).map((_,i)=>t.slice(i,i+3).join(" ")));};
 const x=grams(a),y=grams(b);return [...x].filter(k=>y.has(k)).length/(new Set([...x,...y]).size||1);
}
export function validateDraft({draft,entry,priorPosts=[],linkHttpStatus=200}={}){
 const reasons=[];
 const forbidden=/\b(?:lucro garantido|renda garantida|faturamento garantido|ganhe dinheiro|resultado garantido|depoimento real|cliente comprovou)\b/i;
 if(forbidden.test(draft?.text||""))reasons.push("claims");
 if(!draft?.text||!draft.text.includes(entry?.product?.name))reasons.push("product_identity");
 const link=productLink(entry,draft?.channel);
 if(draft.link!==link||!draft.text.includes(link))reasons.push("utm_or_sku");
 if(linkHttpStatus!==200)reasons.push("product_http_not_200");
 if(draft.channel==="bluesky"&&graphemeCount(draft.text)>300)reasons.push("channel_graphemes");
 if(draft.channel==="telegram"&&draft.text.length>4096)reasons.push("channel_length");
 if(priorPosts.slice(-30).some(p=>textSimilarity(draft.text,p.text)>=0.5))reasons.push("similarity");
 // Deterministic rubric: complete native format, true product, valid CTA, length and unique subject.
 const quality=100-[draft.hook?0:20,draft.value?0:20,draft.cta?0:20,draft.text?.includes(entry?.niche)?0:15].reduce((a,b)=>a+b,0);
 if(quality<85)reasons.push("quality");
 return {ok:reasons.length===0,compliance:reasons.includes("claims")?0:100,score:quality,similarity_max:Math.max(0,...priorPosts.slice(-30).map(p=>textSimilarity(draft.text,p.text))),reasons};
}
export async function verifyProductLink(url,fetchImpl=fetch){
 const u=new URL(url);if(u.protocol!=="https:"||u.hostname!=="vendas.zevanory.api.br"||!/^\/comprar\/ZEV-[A-Z0-9-]+$/.test(u.pathname))return 0;
 try{const r=await fetchImpl(url,{method:"HEAD",redirect:"manual",signal:AbortSignal.timeout(8000)});return r.status;}catch{return 0;}
}
async function publishChannel({channel,entry,env,now,kv,fetchImpl,past=[]}){
 const key=ACQUISITION_STATE_PREFIX+entry.day+":"+channel;
 const prior=await safeJson(kv,key,null);
 if(prior)return prior; // pending is terminal until provider reconciliation, never blindly retry
 // Preserve legacy Telegram publish-once marker during cutover. Never produce two posts in a day.
 if(channel==="telegram"){
  const previous=await safeJson(kv,"zpc:multichannel:evidence:telegram:daily:"+entry.day,null);
  if(previous){
   const adopted=previous.provider_post_id&&previous.url
    ?{channel,day:entry.day,status:"publicado",provider_post_id:String(previous.provider_post_id),url:previous.url,at:previous.publishedAt||null,product:null,provenance:"legacy"}
    :{channel,day:entry.day,status:"pending",code:"legacy_telegram_unverified",needs_reconciliation:true};
   await kv.put(key,JSON.stringify(adopted),{expirationTtl:45*86400});
   return adopted;
  }
 }
 const draft=generateNative(entry,channel);
 const linkHttpStatus=await verifyProductLink(draft.link,fetchImpl);
 const gate=validateDraft({draft,entry,priorPosts:past,linkHttpStatus});
 if(!gate.ok){return {channel,day:entry.day,status:"erro",code:gate.reasons.join(","),gate};}
 const reservation={channel,day:entry.day,status:"pending",startedAt:now.toISOString(),theme_id:entry.theme_id};
 await kv.put(key,JSON.stringify(reservation),{expirationTtl:45*86400});
 try{
  const receipt=channel==="telegram"
   ?await publishTelegram({env,payload:{content:draft.text},fetchImpl})
   :await publishBluesky({env,title:draft.hook,hook:draft.hook,value:draft.value,cta:draft.cta,productUrl:draft.link,day:entry.day,topic:entry.product.sku,fetchImpl});
  if(!receipt?.url||!receipt?.provider_post_id)throw new Error("provider_receipt_missing");
  const outcome={channel,day:entry.day,status:"publicado",provider_post_id:receipt.provider_post_id,url:receipt.url,product:entry.product.sku,utm:draft.link,text:draft.text,at:now.toISOString(),gate};
  await kv.put(key,JSON.stringify(outcome),{expirationTtl:45*86400});
  // An independent, masked activity record; a failed outbox must not repost to the provider.
  await emitActivity(env,{type:"post_published",channel,status:"published",ref:channel+":"+entry.day+":"+entry.theme_id,link:receipt.url},{now:now.getTime()}).catch(()=>null);
  return outcome;
 }catch(error){
  return {...reservation,status:"erro",code:/^bluesky_http_401$/.test(error?.message||"")?"credential_expired":"provider_unverified",needs_reconciliation:true};
 }
}
export async function runAcquisitionEngine(env={},now=new Date(),fetchImpl=fetch){
 env=resolveChannelCredentials(env);
 const kv=env.ZEVANORY_PRIVATE_ARTIFACTS;
 if(!kv?.get||!kv?.put)return {ok:false,code:"kv_unavailable"};
 const day=localContentDay(now),entry=calendarEntry(day),hour=localHour(now),channels=channelChecklist(env);
 const active=channel=>channels.find(x=>x.id===channel)?.configured===true;
 const paused=await creativeAutopublishPaused(env);
 const outcomes=[];
 if(hour>=PEAK_HOURS.blog){
  try{
   const blog=await ensureDailyBlog(env,now,fetchImpl);
   outcomes.push({channel:"blog",status:blog.latest?"publicado":"erro",url:blog.latest?.url||null,at:blog.latest?.publishedAt||null,day});
   if(blog.latest)await emitActivity(env,{type:"post_published",channel:"blog",status:"published",ref:"blog:"+day+":"+blog.latest.slug,link:blog.latest.url},{now:now.getTime()}).catch(()=>null);
  }catch{outcomes.push({channel:"blog",status:"erro",code:"blog_generation_failed",day});}
 }
 for(const channel of ["telegram","bluesky"]){
  if(hour<PEAK_HOURS[channel])continue;
  if(paused){outcomes.push({channel,status:"pausado",code:"creative_autopublish_paused",day});continue;}
  if(!active(channel)){
   outcomes.push({channel,status:"aguardando credencial",day});
   continue;
  }
  try{
   const archive=await safeJson(kv,"zpc:acquisition:history:"+channel,[]);
   const result=await publishChannel({channel,entry,env,now,kv,fetchImpl,past:Array.isArray(archive)?archive:[]});
   outcomes.push(result);
   if(result.status==="publicado"&&!archive.some(p=>p.day===day)){
    await kv.put("zpc:acquisition:history:"+channel,JSON.stringify([...archive,{day,text:result.text,product:result.product}].slice(-30)),{expirationTtl:45*86400});
   }
  }catch{outcomes.push({channel,status:"erro",code:"engine_exception",day});}
 }
 await kv.put(ACQUISITION_CALENDAR_KEY,JSON.stringify({updatedAt:now.toISOString(),days:planCalendar(now),timezone:TIMEZONE}),{expirationTtl:86400*2});
 const state={day,generatedAt:now.toISOString(),product:entry.product.sku,niche:entry.niche,angle:entry.angle,outcomes};
 await kv.put(ACQUISITION_STATE_PREFIX+day,JSON.stringify(state),{expirationTtl:45*86400});
 const ownerDigest=await runOwnerDailyDigest(env,now,fetchImpl);
 return {ok:true,...state,ownerDigest};
}
// 20:00 Sao Paulo owner digest: only real receipts, no invented funnel counts.
export async function runOwnerDailyDigest(env={},now=new Date(),fetchImpl=fetch){
 const kv=env.ZEVANORY_PRIVATE_ARTIFACTS,day=localDay(now),hour=localHour(now),key="zpc:acquisition:owner-digest:"+day;
 if(hour<20)return {status:"agendado",day};
 if(!kv?.get||!kv?.put)return {status:"erro",code:"kv_unavailable"};
 const existing=await safeJson(kv,key,null);if(existing)return existing;
 if(!env.RESEND_API_KEY||!env.OWNER_ALERT_EMAIL)return {status:"aguardando credencial",missing:["RESEND_API_KEY","OWNER_ALERT_EMAIL"].filter(x=>!env[x])};
 const state=await safeJson(kv,ACQUISITION_STATE_PREFIX+day,null);
 const actual=(state?.outcomes||[]).filter(x=>x.status==="publicado"&&x.url);
 const lines=actual.map(x=>"• "+x.channel+": "+x.url);
 const subject="ZEVANORY | Resumo de divulgação "+day;
 const content=["Publicações confirmadas:",...(lines.length?lines:["Sem publicações comprovadas."]),"","Leads: sem dados","Checkouts: sem dados","Vendas: sem dados","Alertas: sem dados","Agenda de amanhã: "+(calendarEntry(new Date(Date.parse(day+"T00:00:00Z")+DAY).toISOString().slice(0,10)).subject),"","Painel: https://controle.zevanory.api.br"].join("\n");
 await kv.put(key,JSON.stringify({status:"pending",day,at:now.toISOString()}),{expirationTtl:7*86400});
 try{
  const response=await fetchImpl("https://api.resend.com/emails",{method:"POST",headers:{"authorization":"Bearer "+String(env.RESEND_API_KEY),"content-type":"application/json"},body:JSON.stringify({from:String(env.RESEND_FROM_ADDRESS||"ZEVANORY <contato@zevanory.api.br>"),to:[String(env.OWNER_ALERT_EMAIL)],subject,text:content}),signal:AbortSignal.timeout(10000)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||!data?.id)throw new Error("owner_digest_provider_unverified");
  const receipt={status:"publicado",day,at:now.toISOString(),provider_post_id:String(data.id),channels:actual.map(x=>x.channel)};
  await kv.put(key,JSON.stringify(receipt),{expirationTtl:45*86400});
  return receipt;
 }catch{return {status:"erro",code:"owner_digest_unverified",needs_reconciliation:true};}
}

export async function acquisitionSnapshot(env={},now=new Date()){
 env=resolveChannelCredentials(env);
 const kv=env.ZEVANORY_PRIVATE_ARTIFACTS,day=localDay(now);
 const [today,calendar,blog,legacy]=await Promise.all([
  safeJson(kv,ACQUISITION_STATE_PREFIX+day,null),
  safeJson(kv,ACQUISITION_CALENDAR_KEY,null),
  safeJson(kv,"zpc:blog:index:v1",{articles:[]}),
  safeJson(kv,"zpc:multichannel:state:v1",{evidence:[]})
 ]);
 const channels=["blog","telegram","bluesky","pinterest","youtube","instagram","facebook","whatsapp","email"];
 const credentialList=channelChecklist(env);
 const fallback=[];
 const article=(blog.articles||[]).filter(x=>x.url&&x.publishedAt&&localDay(new Date(x.publishedAt))===day).sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt))[0];
 if(article)fallback.push({channel:"blog",status:"publicado",url:article.url,at:article.publishedAt});
 const telegram=(legacy.evidence||[]).filter(x=>x.channel==="telegram"&&x.url&&x.provider_post_id&&x.publishedAt&&localDay(new Date(x.publishedAt))===day).sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt))[0];
 if(telegram)fallback.push({channel:"telegram",status:"publicado",url:telegram.url,at:telegram.publishedAt});
 const proof=channels.map(channel=>{
  const configured=credentialList.find(x=>x.id===channel);
  const row=today?.outcomes?.find(x=>x.channel===channel)||fallback.find(x=>x.channel===channel)||null;
  const missing=Boolean(configured)&&!configured.configured;
  const awaitingApproval=missing&&configured.external_verification_pending===true;
  return {channel,configured:configured?.configured===true,
   status:row?.status||(awaitingApproval?"aguardando aprovação":missing?"aguardando credencial":"sem dados"),
   link:row?.url||null,at:row?.at||null,error:row?.code||null,
   next_post:calendarEntry(day).publish_at[channel]||null,
   posts_7d:null,clicks_7d:null,checkouts_7d:null};
 });
 return {schema:"zevanory.acquisition.v1",day,timezone:TIMEZONE,generatedAt:now.toISOString(),today:proof,calendar:calendar?.days||[],
   metrics:{visits:null,leads:null,checkouts:null,sales:null},
   timeline:proof.filter(x=>x.status==="publicado").map(x=>({at:x.at||null,channel:x.channel,type:"post_published",status:x.status,link:x.link}))};
}
