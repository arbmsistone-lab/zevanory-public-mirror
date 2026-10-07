export const CREATIVE_AUTOPUBLISH_PAUSE_KEY="zpc:creative-autonomy:paused:v1";
export const CREATIVE_AUTONOMY_FEED_KEY="zpc:creative-autonomy:feed:v1";
export const CREATIVE_BANDIT_KEY="zpc:creative-autonomy:bandit:v1";
const DAY=86400;
const forbidden=/\b(gr[aá]tis|renda garantida|lucro garantido|ganhe dinheiro|resultado garantido|fature|enrique[cç]a|desconto de|economize \d+%)\b/i;
const personal=/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|\b\+?\d[\d ().-]{7,}\d\b|\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/i;
const metaRisk=/\b(voc[eê] sofre|voc[eê] tem|sua doen[cç]a|sua d[ií]vida|antes e depois|cura|milagre)\b/i;
const n=v=>Math.max(0,Math.min(100,Math.round(Number(v)||0)));
const words=v=>String(v||"").trim().split(/\s+/).filter(Boolean);
const textOf=s=>[s?.hook,s?.body,s?.cta].filter(Boolean).join(" ");
const money=v=>Number(Number(v||0).toFixed(2));

function mentionedPrices(text){
 return [...String(text||"").matchAll(/R\$\s*([0-9.]+(?:,[0-9]{2})?)/gi)].map(m=>Number(m[1].replaceAll(".","").replace(",","."))).filter(Number.isFinite);
}

export function scoreCreative(spec={}, {serverPrice=spec.price_brl,visualScore=null}={}){
 const all=textOf(spec),hook=words(spec.hook),body=words(spec.body),cta=words(spec.cta);
 const clarity=n(100-Math.max(0,hook.length-16)*5-Math.max(0,3-hook.length)*20-Math.max(0,body.length-38)*3);
 const single_cta=n(cta.length>=1&&cta.length<=7&&!/https?:\/\//i.test(String(spec.body||""))?100:45);
 const brand=n(spec.brand==="ZEVANORY"&&spec.site==="zevanory.api.br"?100:0);
 const visual=visualScore==null?null:Number(visualScore);
 const referenceSize=Number(spec.width)>=1080&&Number(spec.height)>=1080;
 const legibility=n((referenceSize?55:25)+(hook.length<=16?15:5)+(body.length<=38?15:5)+(cta.length<=7?15:5)+(visual==null?0:Math.max(-20,Math.min(0,(visual-.85)*100))));
 const prices=mentionedPrices(all),priceOk=Number.isFinite(Number(serverPrice))&&Number(serverPrice)>0&&prices.every(p=>money(p)===money(serverPrice));
 const checks={
  server_price:priceOk,
  guarantee_7_days:/\b7\s*dias\b/i.test(all),
  no_free_or_fake_discount:!forbidden.test(all),
  no_financial_result_claim:!forbidden.test(all),
  no_personal_data:!personal.test(all),
  meta_ads_policy:!metaRisk.test(all)
 };
 const failures=Object.entries(checks).filter(([,ok])=>!ok).map(([id])=>id);
 const compliance=n(Object.values(checks).filter(Boolean).length/Object.keys(checks).length*100);
 const criteria={clarity,single_cta,brand,legibility};
 const score=n(Object.values(criteria).reduce((a,b)=>a+b,0)/4);
 return Object.freeze({score,criteria:Object.freeze(criteria),compliance,compliance_checks:Object.freeze(checks),failures:Object.freeze(failures)});
}

export function rewriteCreative(spec={}, {serverPrice=spec.price_brl}={}){
 const scrub=v=>String(v||"").replace(forbidden,"").replace(metaRisk,"").replace(personal,"").replace(/\s{2,}/g," ").trim();
 const price=Number(serverPrice)>0?` por R$ ${money(serverPrice).toFixed(2).replace(".",",")}`:"";
 const body=scrub(spec.body).replace(/\bgarantia\s+de\s+\d+\s+dias\b/ig,"").replace(/[. ]+$/,"");
 return Object.freeze({...spec,hook:scrub(spec.hook),body:`${body}${price}. Garantia de 7 dias.`.trim(),cta:words(scrub(spec.cta)).slice(0,7).join(" ")||"Conheça a ZEVANORY"});
}

export function evaluateCreativeWithRewrites(spec={},options={}){
 let current=Object.freeze({...spec}),rubric=scoreCreative(current,options),rewrites=0;
 while(rewrites<2&&rubric.score>=70&&(rubric.compliance<100||rubric.score<85)){
  current=rewriteCreative(current,options); rewrites+=1; rubric=scoreCreative(current,options);
 }
 const action=rubric.score>=85&&rubric.compliance===100?"publish":"discard";
 const reason=action==="publish"?"score_and_compliance_approved":rubric.score<70?"score_below_70":rubric.failures.join(",")||"score_below_85_after_rewrites";
 return Object.freeze({action,reason,rewrites,spec:current,...rubric});
}

export async function creativeAutopublishPaused(env={}){
 return String(await env.ZEVANORY_PRIVATE_ARTIFACTS?.get?.(CREATIVE_AUTOPUBLISH_PAUSE_KEY)||"")==="1";
}

export async function setCreativeAutopublishPaused(env={},paused=true){
 if(!env.ZEVANORY_PRIVATE_ARTIFACTS?.put)throw new Error("creative_kv_unavailable");
 await env.ZEVANORY_PRIVATE_ARTIFACTS.put(CREATIVE_AUTOPUBLISH_PAUSE_KEY,paused?"1":"0");
 return Boolean(paused);
}

export async function recordCreativeEvaluation(env={},record={}){
 const kv=env.ZEVANORY_PRIVATE_ARTIFACTS;if(!kv?.put)return false;
 let feed=[];try{feed=JSON.parse(String(await kv.get(CREATIVE_AUTONOMY_FEED_KEY)||"[]"));}catch{}
 const safe={creative_id:String(record.creative_id||"").slice(0,80),channel:String(record.channel||"").slice(0,40),angle:String(record.angle||"default").slice(0,60),format:String(record.format||"default").slice(0,40),hour:Number(record.hour)||0,score:n(record.score),criteria:record.criteria||{},compliance:n(record.compliance),reason:String(record.reason||"").slice(0,240),status:String(record.status||"discarded").slice(0,40),rewrites:Number(record.rewrites)||0,title:String(record.title||"").slice(0,240),content:String(record.content||"").slice(0,4000),asset_url:String(record.asset_url||"").slice(0,4000),landing_url:String(record.landing_url||"").slice(0,4000),performance:record.performance||null,evaluated_at:String(record.evaluated_at||new Date().toISOString())};
 feed=[safe,...(Array.isArray(feed)?feed:[]).filter(x=>x?.creative_id!==safe.creative_id)].slice(0,100);
 await kv.put(CREATIVE_AUTONOMY_FEED_KEY,JSON.stringify(feed),{expirationTtl:90*DAY});return true;
}

const armKey=m=>[m.angle||"default",m.format||"default",Number(m.hour)||0].join("|");
export function updateThompsonState(state={},metrics={}){
 const key=armKey(metrics),arms={...(state.arms||{})},old=arms[key]||{alpha:1,beta:1,observations:0};
 const positive=Math.max(0,Number(metrics.saves)||0)+Math.max(0,Number(metrics.clicks)||0)+Math.max(0,Number(metrics.sales)||0)*4;
 const reach=Math.max(0,Number(metrics.reach)||0),negative=Math.max(1,Math.min(100,reach-positive));
 arms[key]={alpha:Number(old.alpha)+positive,beta:Number(old.beta)+negative,observations:Number(old.observations)+1,updated_at:new Date().toISOString()};
 return Object.freeze({version:1,arms:Object.freeze(arms)});
}

function gamma(shape,random){
 if(shape<1)return gamma(shape+1,random)*Math.pow(Math.max(random(),1e-9),1/shape);
 const d=shape-1/3,c=1/Math.sqrt(9*d);for(;;){let x,v;do{x=Math.sqrt(-2*Math.log(Math.max(random(),1e-9)))*Math.cos(2*Math.PI*random());v=1+c*x;}while(v<=0);v=v*v*v;const u=random();if(u<1-.0331*x*x*x*x||Math.log(u)<.5*x*x+d*(1-v+Math.log(v)))return d*v;}
}
export function chooseThompsonArm(state={},candidates=[],random=Math.random){
 return [...candidates].map(candidate=>{const arm=state.arms?.[armKey(candidate)]||{alpha:1,beta:1};const a=gamma(Number(arm.alpha)||1,random),b=gamma(Number(arm.beta)||1,random);return {candidate,sample:a/(a+b)};}).sort((a,b)=>b.sample-a.sample)[0]?.candidate||null;
}

export async function recordMatureCreativeMetrics(env={},metrics={}){
 const publishedAt=Date.parse(String(metrics.published_at||"")),creativeId=String(metrics.creative_id||"").slice(0,80);
 if(!Number.isFinite(publishedAt)||Date.now()-publishedAt<48*3600e3)return {learned:false,reason:"awaiting_48h"};
 const kv=env.ZEVANORY_PRIVATE_ARTIFACTS;if(!kv?.put)return {learned:false,reason:"kv_unavailable"};
 const learnedKey=`zpc:creative-autonomy:learned:${creativeId}`;
 if(!creativeId)return {learned:false,reason:"creative_id_required"};
 if(await kv.get(learnedKey))return {learned:false,reason:"already_learned"};
 let state={};try{state=JSON.parse(String(await kv.get(CREATIVE_BANDIT_KEY)||"{}"));}catch{}
 state=updateThompsonState(state,metrics);await kv.put(CREATIVE_BANDIT_KEY,JSON.stringify(state),{expirationTtl:365*DAY});
 await kv.put(learnedKey,"1",{expirationTtl:365*DAY});
 try{
  const feed=JSON.parse(String(await kv.get(CREATIVE_AUTONOMY_FEED_KEY)||"[]"));
  const updated=(Array.isArray(feed)?feed:[]).map(x=>x?.creative_id===creativeId?{...x,performance:{reach:Number(metrics.reach)||0,saves:Number(metrics.saves)||0,clicks:Number(metrics.clicks)||0,sales:Number(metrics.sales)||0,observed_at:new Date().toISOString()}}:x);
  await kv.put(CREATIVE_AUTONOMY_FEED_KEY,JSON.stringify(updated),{expirationTtl:90*DAY});
 }catch{}
 return {learned:true,arm:armKey(metrics)};
}

export async function creativeAutonomyDashboard(env={}){
 const kv=env.ZEVANORY_PRIVATE_ARTIFACTS;let feed=[],bandit={};
 try{feed=JSON.parse(String(await kv?.get?.(CREATIVE_AUTONOMY_FEED_KEY)||"[]"));}catch{}
 try{bandit=JSON.parse(String(await kv?.get?.(CREATIVE_BANDIT_KEY)||"{}"));}catch{}
 return {paused:await creativeAutopublishPaused(env),evaluations:Array.isArray(feed)?feed:[],bandit};
}

export function readDailyCreativeReportMarker(raw,date=null){
 const text=String(raw??"").trim();if(!text)return null;
 if(text==="1")return {sent:true,sentAt:null,provider_message_id:null,date,legacy_marker:true};
 try{const parsed=JSON.parse(text);if(!parsed||typeof parsed!=="object")return null;return {sent:parsed.sent===true,sentAt:typeof parsed.sentAt==="string"?parsed.sentAt:null,provider_message_id:typeof parsed.provider_message_id==="string"?parsed.provider_message_id:null,date:parsed.date||date,legacy_marker:false};}catch{return null;}
}

export async function sendDailyCreativeReport(env={},options={}){
 const now=options.now instanceof Date?options.now:new Date(),kv=env.ZEVANORY_PRIVATE_ARTIFACTS,date=now.toISOString().slice(0,10),key=`zpc:creative-autonomy:daily:${date}`;
 if(!kv?.put)return {sent:false,reason:"state_unavailable"};
 const existing=readDailyCreativeReportMarker(await kv.get(key),date);
 if(existing)return {sent:false,reason:"already_sent",evidence:existing};
 const data=await creativeAutonomyDashboard(env),to=String(env.OWNER_ALERT_EMAIL||"zevanory@gmail.com");
 if(!env.RESEND_API_KEY)return {sent:false,reason:"mailer_unavailable"};
 const lines=data.evaluations.slice(0,30).map(x=>`${x.channel} | ${x.score}/100 | compliance ${x.compliance}% | ${x.status} | ${x.reason}`);
 const fetchImpl=options.fetchImpl||fetch,r=await fetchImpl("https://api.resend.com/emails",{method:"POST",headers:{authorization:`Bearer ${env.RESEND_API_KEY}`,"content-type":"application/json"},body:JSON.stringify({from:String(env.RESEND_FROM_ADDRESS||"ZEVANORY <contato@zevanory.api.br>"),to:[to],subject:`ZEVANORY — relatório diário de conteúdo ${date}`,text:[`Publicação automática: ${data.paused?"PAUSADA":"ATIVA"}`,"",...lines].join("\n")}),signal:AbortSignal.timeout(10000)}).catch(()=>null);
 if(!r?.ok)return {sent:false};
 const provider=await r.json().catch(()=>({})),evidence={sent:true,sentAt:now.toISOString(),provider_message_id:String(provider?.id||"").slice(0,200)||null,date};
 await Promise.all([kv.put(key,JSON.stringify(evidence),{expirationTtl:8*DAY}),kv.put("zpc:creative-autonomy:daily:last",JSON.stringify(evidence),{expirationTtl:30*DAY})]);
 return evidence;
}

const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
export async function renderCreativeAutonomyPage(env={}){
 const d=await creativeAutonomyDashboard(env),rows=d.evaluations.map(x=>`<tr><td>${esc(x.channel)}</td><td>${x.score}</td><td>${x.compliance}%</td><td>${esc(x.reason)}</td><td>${esc(x.status)}</td><td>${esc(x.performance?JSON.stringify(x.performance):"aguardando 48h")}</td></tr>`).join("");
 return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex"><title>Conteúdo · ZEVANORY</title><link rel="stylesheet" href="/admin.css"></head><body><main><h1>Conteúdo</h1><p>Analista autônomo de criativos · rubrica e compliance antes de publicar.</p><form method="post" action="/private-api/creative-autonomy/pause"><input type="hidden" name="paused" value="${d.paused?"0":"1"}"><button type="submit">${d.paused?"Retomar publicação automática":"Pausar publicação automática"}</button></form><table><thead><tr><th>Canal</th><th>Nota</th><th>Compliance</th><th>Motivo</th><th>Resultado</th><th>Desempenho</th></tr></thead><tbody>${rows||"<tr><td colspan=6>Nenhum criativo avaliado.</td></tr>"}</tbody></table></main></body></html>`;
}
