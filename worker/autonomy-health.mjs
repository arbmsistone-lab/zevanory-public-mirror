import { BLOG_INDEX_KEY, CHANNEL_STATE_KEY } from "./multichannel-autonomy.mjs";
import { CREATIVE_AUTONOMY_FEED_KEY } from "./creative-autonomy.mjs";

export const AUTONOMY_HEALTH_KEY="zpc:autonomy:health:v1";
const ALLOWED_ALERTS=new Set(["channel_down","compliance_rejected_3x","refund","complaint"]);
const DAY=86400;
const safeJson=async(kv,key,fallback)=>{try{return JSON.parse(String(await kv?.get?.(key)||"null"))??fallback}catch{return fallback}};

export function selectAutonomyAlerts({channelState={},creativeFeed=[],events=[]}={}){
 const alerts=[];
 for(const item of channelState.evidence||[])if(item?.error)alerts.push({type:"channel_down",channel:String(item.channel||"unknown"),reason:String(item.error).slice(0,120)});
 const ordered=[...(Array.isArray(creativeFeed)?creativeFeed:[])].sort((a,b)=>Date.parse(b?.evaluated_at||0)-Date.parse(a?.evaluated_at||0));
 if(ordered.slice(0,3).length===3&&ordered.slice(0,3).every(x=>Number(x?.compliance)<100||x?.status==="discarded"))alerts.push({type:"compliance_rejected_3x",channel:String(ordered[0]?.channel||"content"),reason:"three_consecutive_compliance_rejections"});
 for(const event of Array.isArray(events)?events:[])if(ALLOWED_ALERTS.has(String(event?.type)))alerts.push({type:String(event.type),channel:String(event.channel||"operations"),reason:String(event.reason||event.type).slice(0,120)});
 return alerts.filter(x=>ALLOWED_ALERTS.has(x.type));
}

export async function collectAutonomyHealth(env={},now=new Date()){
 const kv=env.ZEVANORY_PRIVATE_ARTIFACTS;
 const [blog,channels,creativeFeed,events]=await Promise.all([
  safeJson(kv,BLOG_INDEX_KEY,{articles:[]}),safeJson(kv,CHANNEL_STATE_KEY,{channels:[],evidence:[]}),
  safeJson(kv,CREATIVE_AUTONOMY_FEED_KEY,[]),safeJson(kv,"zpc:autonomy:alert-events:v1",[])
 ]);
 const evidence=[];
 for(const article of blog.articles||[])if(article?.slug&&/^https:\/\//.test(String(article?.url||"")))evidence.push({front:"F2",channel:"blog",provider_post_id:String(article.slug),url:String(article.url),published_at:String(article.publishedAt||""),metrics:article.metrics||null});
 for(const row of channels.evidence||[])if(row?.provider_post_id&&/^https:\/\//.test(String(row?.url||"")))evidence.push({front:"F2",channel:String(row.channel),provider_post_id:String(row.provider_post_id),url:String(row.url),published_at:String(row.publishedAt||""),metrics:row.metrics||null});
 const payload={generatedAt:now.toISOString(),evidence,alerts:selectAutonomyAlerts({channelState:channels,creativeFeed,events}),channels:(channels.channels||[]).map(x=>({id:x.id,mode:x.mode,configured:Boolean(x.configured)}))};
 await kv?.put?.(AUTONOMY_HEALTH_KEY,JSON.stringify(payload),{expirationTtl:8*DAY});
 return payload;
}

export async function deliverAutonomyAlerts(env={},payload={},fetchImpl=fetch){
 const kv=env.ZEVANORY_PRIVATE_ARTIFACTS,delivered=[];
 if(!env.RESEND_API_KEY)return {sent:0,reason:"mailer_unavailable"};
 for(const alert of payload.alerts||[]){
  if(!ALLOWED_ALERTS.has(String(alert?.type)))continue;
  const key=`zpc:autonomy:alert-sent:${alert.type}:${alert.channel}`;
  if(await kv?.get?.(key))continue;
  const response=await fetchImpl("https://api.resend.com/emails",{method:"POST",headers:{authorization:`Bearer ${env.RESEND_API_KEY}`,"content-type":"application/json"},body:JSON.stringify({from:String(env.RESEND_FROM_ADDRESS||"ZEVANORY <contato@zevanory.api.br>"),to:[String(env.OWNER_ALERT_EMAIL||"zevanory@gmail.com")],subject:`ZEVANORY — alerta de autonomia: ${alert.type}`,text:`Canal: ${alert.channel}\nMotivo: ${alert.reason}\nGerado em: ${payload.generatedAt}`}),signal:AbortSignal.timeout(10000)}).catch(()=>null);
  if(response?.ok){await kv?.put?.(key,"1",{expirationTtl:6*3600});delivered.push(alert.type);}
 }
 return {sent:delivered.length,types:delivered};
}

export async function runAutonomyHealth(env={},now=new Date(),fetchImpl=fetch){const payload=await collectAutonomyHealth(env,now);const delivery=await deliverAutonomyAlerts(env,payload,fetchImpl);return {...payload,delivery};}
