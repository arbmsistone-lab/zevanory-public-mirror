import {readFileSync} from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import {OWNER_DISABLED_CHANNELS,calendarEntry,planCalendar,productLink,generateNative,validateDraft,textSimilarity,runAcquisitionEngine,acquisitionSnapshot,verifyProductLink,runOwnerDailyDigest,CATALOG_SKUS,textVariant,DAILY_TIPS,recordBlueskyFailure,blueskyStatusKey,BLUESKY_STATUS_PREFIX,BLUESKY_STATUS_TTL} from "../worker/acquisition-engine.mjs";
import {blueskyPostText} from "../worker/bluesky-publisher.mjs";
import {CLOSED_LABEL} from "../worker/politica-unica.mjs";
import {hotmartKit,salesLockViolations} from "../worker/sales-lock-content.mjs";
const kv=()=>{const m=new Map();return{m,get:async k=>m.get(k)??null,put:async(k,v)=>{m.set(k,String(v))}}};
test("30-day calendar rotates five real SKUs, five niches, five angles",()=>{
 const c=planCalendar(new Date("2026-10-10T12:00:00Z"));
 assert.equal(c.length,30);assert.equal(new Set(c.map(x=>x.product.sku)).size,5);
 assert.equal(new Set(c.map(x=>x.niche)).size,5);assert.equal(new Set(c.map(x=>x.angle)).size,5);
 for(let i=0;i<c.length;i++)for(let j=i+1;j<Math.min(i+14,c.length);j++)assert.notEqual(c[i].theme_id,c[j].theme_id);
});
test("each generated native message has right purchase SKU and channel UTM",()=>{
 const c=calendarEntry("2026-10-10");
 // Vendas abertas: checkout /comprar/<SKU>. Fechadas (padrão): página do produto, sem /comprar.
 for(const ch of ["blog","telegram","bluesky"]){const d=generateNative(c,ch,{salesOpen:true});assert.match(d.link,new RegExp("/comprar/"+c.product.sku));assert.match(d.link,new RegExp("utm_source="+ch));assert.ok(d.text.includes(d.link));}
 for(const ch of ["blog","telegram","bluesky"]){const d=generateNative(c,ch);assert.match(d.link,/^https:\/\/vendas\.zevanory\.api\.br\/ia-na-pratica\?/);assert.doesNotMatch(d.link,/\/comprar/);assert.match(d.link,new RegExp("utm_source="+ch));assert.ok(d.text.includes(d.link));}
 assert.notEqual(generateNative(c,"telegram").text,generateNative(c,"bluesky").text);
});
test("gate rejects false claims, wrong link, lack of HTTP 200 and repeated content",()=>{
 const entry=calendarEntry("2026-10-10"),draft=generateNative(entry,"telegram");
 assert.equal(validateDraft({draft,entry}).ok,true);
 assert.ok(validateDraft({draft:{...draft,text:draft.text+" lucro garantido"},entry}).reasons.includes("claims"));
 assert.ok(validateDraft({draft,entry,linkHttpStatus:503}).reasons.includes("product_http_not_200"));
 assert.ok(validateDraft({draft:{...draft,link:"https://evil.example/"},entry}).reasons.includes("utm_or_sku"));
 assert.ok(validateDraft({draft,entry,priorPosts:[{text:draft.text}]}).reasons.includes("similarity"));
 assert.equal(textSimilarity(draft.text,draft.text),1);
});
test("product link is verified against the published catalog without a self-account subrequest",async()=>{
 const url=productLink(calendarEntry("2026-10-10"),"blog");
 assert.equal(await verifyProductLink(url),200);
 assert.equal(await verifyProductLink("https://vendas.zevanory.api.br/comprar/ZEV-XXX-999"),0);
 assert.equal(await verifyProductLink("http://vendas.zevanory.api.br/comprar/ZEV-IA-011"),0);
 assert.equal(await verifyProductLink("https://evil.example/comprar/ZEV-IA-011"),0);
 assert.equal(await verifyProductLink("not a url"),0);
});
test("every catalog SKU is routed by the public sales Worker (/comprar)",()=>{
 const sales=readFileSync(new URL("../worker/sales-public-worker.mjs",import.meta.url),"utf8");
 const routed=sales.slice(sales.indexOf("BUY_SKUS"),sales.indexOf("BUY_SKUS")+600);
 for(const sku of CATALOG_SKUS)assert.match(routed,new RegExp(sku.replaceAll("-","\\-")),sku);
});
test("regression: sales Worker unreachable from the core Worker no longer blocks Bluesky",async()=>{
 // Production KV 2026-10-10: bluesky status=erro code=product_http_not_200, feed empty.
 const store=kv(),seen=[],env={ZEVANORY_PRIVATE_ARTIFACTS:store,BLUESKY_HANDLE:"zevanoryoficial.bsky.social",BLUESKY_APP_PASSWORD:"app"};
 const mock=async(url,req={})=>{seen.push([req.method||"GET",String(url)]);
  if(String(url).startsWith("https://vendas.zevanory.api.br/"))return{status:522,ok:false};
  if(url.endsWith("createSession"))return{ok:true,json:async()=>({did:"did:plc:abc",accessJwt:"access"})};
  if(url.endsWith("createRecord")){const r=JSON.parse(req.body);return{ok:true,json:async()=>({uri:"at://did:plc:abc/app.bsky.feed.post/"+r.rkey,cid:"cid"})};}
  return{ok:true,status:200,json:async()=>({})};};
 const out=await runAcquisitionEngine(env,new Date("2026-10-10T22:30:00Z"),mock);
 assert.equal(out.outcomes.find(x=>x.channel==="bluesky").status,"publicado");
 assert.equal(seen.some(([,u])=>u.startsWith("https://vendas.zevanory.api.br/")),false);
});
test("a definitive Bluesky rejection is retried on a later tick (max 3/day), never left terminal",async()=>{
 const store=kv(),env={ZEVANORY_PRIVATE_ARTIFACTS:store,BLUESKY_HANDLE:"zevanoryoficial.bsky.social",BLUESKY_APP_PASSWORD:"app"};
 let createRecord=0,fail=true;
 const mock=async(url,req={})=>{
  if(url.endsWith("createSession"))return{ok:true,json:async()=>({did:"did:plc:abc",accessJwt:"access"})};
  if(url.endsWith("createRecord")){createRecord++;if(fail)return{ok:false,status:400,headers:{get:()=>null}};const r=JSON.parse(req.body);return{ok:true,json:async()=>({uri:"at://did:plc:abc/app.bsky.feed.post/"+r.rkey,cid:"cid"})};}
  if(url.includes("getRecord"))return{ok:false,status:400};
  return{ok:true,status:200,json:async()=>({})};};
 const t=new Date("2026-10-10T22:30:00Z");
 const a=await runAcquisitionEngine(env,t,mock);
 assert.equal(a.outcomes.find(x=>x.channel==="bluesky").status,"erro");
 assert.equal(a.outcomes.find(x=>x.channel==="bluesky").code,"bluesky_http_400");
 fail=false;
 const b=await runAcquisitionEngine(env,new Date(t.getTime()+1800000),mock);
 assert.equal(b.outcomes.find(x=>x.channel==="bluesky").status,"publicado");
 assert.equal(b.outcomes.find(x=>x.channel==="bluesky").attempts,2);
 await runAcquisitionEngine(env,new Date(t.getTime()+3600000),mock);
 assert.equal(createRecord,2);
 // Attempt cap
 const s2=kv(),e2={...env,ZEVANORY_PRIVATE_ARTIFACTS:s2};fail=true;createRecord=0;
 for(let i=0;i<5;i++)await runAcquisitionEngine(e2,new Date(t.getTime()+i*1800000),mock);
 assert.equal(createRecord,3);
});
// Decisão F0 nº 7 do proprietário (10/11/2026): Telegram de divulgação desligado no motor, sem flag que o religue.
async function telegramScenario(gen=runAcquisitionEngine){
 const store=kv(),puts=[],orig=store.put;store.put=async(k,v,o)=>{puts.push(k);return orig(k,v,o);};
 // Credenciais presentes, flags "de religar" plausíveis e um registro legado: nada disso pode religar o canal.
 const env={ZEVANORY_PRIVATE_ARTIFACTS:store,TELEGRAM_BOT_TOKEN:"t",TELEGRAM_CHANNEL_ID:"@zevanory",TELEGRAM_PROMO_ENABLED:"1",TELEGRAM_ENABLED:"true",ACQUISITION_TELEGRAM:"on"};
 await orig("zpc:telegram:enabled:v1","1");
 let sends=0;const mock=async(url)=>{if(String(url).includes("api.telegram.org")){sends++;return{status:200,json:async()=>({ok:true,result:{message_id:5}})};}
  if(String(url).endsWith("/brand/export/post-01.png"))return new Response(readFileSync(new URL("../assets/brand/export/post-01.png",import.meta.url)),{status:200});
  return{ok:true,status:200,json:async()=>({})};};
 const outs=[];
 for(const at of ["2026-11-10T15:35:00Z","2026-11-10T16:35:00Z","2026-11-10T22:35:00Z"])outs.push(await gen(env,new Date(at),mock));
 return {outs,sends,puts};
}
test("F0 nº 7: o motor não publica no Telegram (desligado, sem flag), sem chamada à API e sem chave do canal no KV",async()=>{
 const {outs,sends,puts}=await telegramScenario();
 assert.equal(sends,0,"nenhuma chamada à API do Telegram");
 for(const out of outs){const tg=out.outcomes.find(x=>x.channel==="telegram");assert.equal(tg.status,"desligado");assert.equal(tg.code,"canal_desligado_decisao_proprietario");}
 assert.equal(puts.some(k=>/telegram/.test(k)),false,"nenhuma chave do Telegram gravada: "+puts.filter(k=>/telegram/.test(k)));
 // O código de publicação do Telegram continua no módulo (não removido), apenas não é chamado.
 const src=readFileSync(new URL("../worker/acquisition-engine.mjs",import.meta.url),"utf8");
 assert.ok(src.includes("await publishTelegram({env,payload:{content:draft.text"));
 assert.deepEqual([...OWNER_DISABLED_CHANNELS],["telegram"]);
 assert.equal(/OWNER_DISABLED_CHANNELS[^\n]*(env\.|kv\.|process\.)/.test(src),false,"desligamento não pode depender de env/KV");
});
test("F0 nº 7 mutante: religar o Telegram (remover o desligamento) faz o teste falhar",async()=>{
 const base=new URL("../worker/",import.meta.url);
 const orig=readFileSync(new URL("acquisition-engine.mjs",base),"utf8");
 const target='  if(OWNER_DISABLED_CHANNELS.includes(channel)){outcomes.push({channel,status:"desligado",code:CHANNEL_DISABLED_CODE,day});continue;}\n';
 const variants=[orig.replace(target,""),orig.replace('export const OWNER_DISABLED_CHANNELS=Object.freeze(["telegram"]);','export const OWNER_DISABLED_CHANNELS=Object.freeze([]);')];
 for(const m of variants){
  assert.notEqual(m,orig,"alvo do mutante ausente");
  const mod=await import("data:text/javascript;base64,"+Buffer.from(m.replace(/from "\.\/([a-z0-9-]+\.mjs)"/g,(_,f)=>'from "'+new URL(f,base).href+'"')).toString("base64"));
  const {sends,outs}=await telegramScenario(mod.runAcquisitionEngine);
  assert.ok(sends>=1,"mutante sobreviveu: Telegram não publicou");
  assert.equal(outs[0].outcomes.find(x=>x.channel==="telegram").status,"publicado");
 }
});
test("acquisition runs only at the :35 tick of the isolated 5,35 cron (no new account cron)",()=>{
 const src=readFileSync(new URL("../worker/cloudflare-worker.compat.mjs",import.meta.url),"utf8");
 const start=src.indexOf('if (controller?.cron === "5,35 * * * *")');
 const end=src.indexOf('if (controller?.cron === "15,45 * * * *")',start);
 assert.ok(start>0&&end>start);
 const block=src.slice(start,end);
 const tick=block.indexOf("tickMinute >= 30"),acq=block.indexOf("runAcquisitionEngine(normalized,new Date())"),brand=block.indexOf("await syncBrandProfiles(normalized)");
 assert.ok(tick>0&&acq>tick&&brand>acq,"acquisition in the :35 branch, profiles in the :05 branch");
 assert.equal(src.split("runAcquisitionEngine(normalized").length-1,1);
 assert.equal(src.includes('"25,55 * * * *"'),false);
 const prep=readFileSync(new URL("../scripts/deploy/prepare-central-candidate.py",import.meta.url),"utf8");
 assert.equal(/crons\.append\("25,55/.test(prep),false);
});
test("one cycle publishes Bluesky after peak (Telegram desligado, F0 nº 7), then never duplicates",async()=>{
 const store=kv(),counts={telegram:0,createRecord:0},env={ZEVANORY_PRIVATE_ARTIFACTS:store,TELEGRAM_BOT_TOKEN:"t",TELEGRAM_CHANNEL_ID:"@zevanory",BLUESKY_HANDLE:"zevanory.bsky.social",BLUESKY_APP_PASSWORD:"password"};
 const mock=async(url,req={})=>{
  if(req.method==="HEAD")return{status:200};
  if(url.endsWith("/brand/export/post-01.png"))return new Response(readFileSync(new URL("../assets/brand/export/post-01.png",import.meta.url)),{status:200});
  if(url.includes("api.telegram.org")){counts.telegram++;return{status:200,json:async()=>({ok:true,result:{message_id:11}})};}
  if(url.endsWith("createSession"))return{ok:true,json:async()=>({did:"did:plc:abc",accessJwt:"access"})};
  if(url.endsWith("createRecord")){counts.createRecord++;const record=JSON.parse(req.body);return{ok:true,json:async()=>({uri:"at://did:plc:abc/app.bsky.feed.post/"+record.rkey,cid:"cid"})};}
  return{ok:true,status:200,json:async()=>({})};
 };
 const date=new Date("2026-10-10T23:00:00Z");
 const a=await runAcquisitionEngine(env,date,mock);
 assert.equal(a.ok,true);
 assert.deepEqual(a.outcomes.filter(x=>x.status==="publicado").map(x=>x.channel).sort(),["bluesky"]);
 assert.equal(a.outcomes.find(x=>x.channel==="telegram").status,"desligado");
 assert.equal(a.outcomes.find(x=>x.channel==="blog").status,"rascunho");
 assert.equal(await store.get("zpc:blog:index:v1"),null,"R117: acquisition cannot publish blog by default");
 const b=await runAcquisitionEngine(env,date,mock);
 assert.equal(counts.telegram,0);assert.equal(counts.createRecord,1);
 assert.ok(b.outcomes.some(x=>x.channel==="bluesky"&&x.url));
 const snapshot=await acquisitionSnapshot(env,date);
 assert.ok(snapshot.today.some(x=>x.channel==="bluesky"&&x.status==="publicado"&&x.link));
 assert.equal(snapshot.metrics.sales,null);
});
test("a failing Bluesky provider is reported; Telegram stays desligado (F0 nº 7)",async()=>{
 const store=kv(),env={ZEVANORY_PRIVATE_ARTIFACTS:store,TELEGRAM_BOT_TOKEN:"t",TELEGRAM_CHANNEL_ID:"@zevanory",BLUESKY_HANDLE:"zevanory.bsky.social",BLUESKY_APP_PASSWORD:"bad"};
 const mock=async(url,req={})=>{
  if(req.method==="HEAD")return{status:200};
  if(url.endsWith("/brand/export/post-01.png"))return new Response(readFileSync(new URL("../assets/brand/export/post-01.png",import.meta.url)),{status:200});
  if(url.includes("api.telegram.org"))return{status:200,json:async()=>({ok:true,result:{message_id:22}})};
  if(url.endsWith("createSession"))return{ok:false,status:401,headers:{get:()=>null}};
  return{status:200,ok:true,json:async()=>({})};
 };
 const result=await runAcquisitionEngine(env,new Date("2026-10-10T23:00:00Z"),mock);
 assert.equal(result.outcomes.find(x=>x.channel==="telegram").status,"desligado");
 assert.equal(result.outcomes.find(x=>x.channel==="bluesky").code,"credential_expired");
});
test("unconfigured external channel is waiting rather than a false error",async()=>{
 const env={ZEVANORY_PRIVATE_ARTIFACTS:kv()};
 const out=await runAcquisitionEngine(env,new Date("2026-10-10T23:00:00Z"),async()=>({status:200,ok:true,json:async()=>({})}));
 assert.equal(out.outcomes.find(x=>x.channel==="bluesky").status,"aguardando credencial");
 assert.equal(out.outcomes.find(x=>x.channel==="telegram").status,"desligado");
});
test("peak schedule delays Bluesky until 19:00 Sao Paulo",async()=>{
 const env={ZEVANORY_PRIVATE_ARTIFACTS:kv(),BLUESKY_HANDLE:"abc",BLUESKY_APP_PASSWORD:"xyz"};
 const out=await runAcquisitionEngine(env,new Date("2026-10-10T16:00:00Z"),async()=>({status:200,ok:true,json:async()=>({})}));
 assert.equal(out.outcomes.some(x=>x.channel==="bluesky"),false);
});

test("daily owner digest requires existing opt-in owner email and real receipts",async()=>{
 const store=kv(),now=new Date("2026-10-10T23:00:00Z"),env={ZEVANORY_PRIVATE_ARTIFACTS:store,RESEND_API_KEY:"resend-test",OWNER_ALERT_EMAIL:"owner@example.org"};
 await store.put("zpc:acquisition:daily:2026-10-10",JSON.stringify({outcomes:[{channel:"blog",status:"publicado",url:"https://zevanory.api.br/blog/verified"}]}));
 const sent=[];const mock=async(url,options)=>{assert.equal(url,"https://api.resend.com/emails");sent.push(JSON.parse(options.body));return{ok:true,json:async()=>({id:"email-123"})};};
 const receipt=await runOwnerDailyDigest(env,now,mock);
 assert.equal(receipt.status,"publicado");assert.equal(receipt.provider_post_id,"email-123");
 assert.match(sent[0].text,/https:\/\/zevanory.api.br\/blog\/verified/);assert.match(sent[0].text,/Vendas: sem dados/);
 assert.equal((await runOwnerDailyDigest(env,now,mock)).status,"publicado");assert.equal(sent.length,1);
});
test("owner digest waits until peak and does not send with missing credential",async()=>{
 const env={ZEVANORY_PRIVATE_ARTIFACTS:kv()};
 assert.equal((await runOwnerDailyDigest(env,new Date("2026-10-10T19:00:00Z"))).status,"agendado");
 assert.equal((await runOwnerDailyDigest(env,new Date("2026-10-10T23:00:00Z"))).status,"aguardando credencial");
});
test("legacy Telegram receipt does not relight the channel: desligado, no remote post (F0 nº 7)",async()=>{
 const store=kv(),day="2026-10-10";
 await store.put("zpc:multichannel:evidence:telegram:daily:"+day,JSON.stringify({channel:"telegram",provider_post_id:"17",url:"https://t.me/zevanory/17",publishedAt:"2026-10-10T14:00:00Z"}));
 const env={ZEVANORY_PRIVATE_ARTIFACTS:store,TELEGRAM_BOT_TOKEN:"secret",TELEGRAM_CHANNEL_ID:"@zevanory"};
 let requests=0;const mock=async(url,req)=>{if(url.includes("api.telegram.org"))requests++;return{ok:true,status:200,json:async()=>({})};};
 const result=await runAcquisitionEngine(env,new Date("2026-10-10T23:00:00Z"),mock);
 assert.equal(result.outcomes.find(x=>x.channel==="telegram").status,"desligado");
 assert.equal(await store.get("zpc:acquisition:daily:"+day+":telegram"),null);
 assert.equal(requests,0);
});

// ---- Plano Mestre F1: variação de texto contra o gate de similaridade + status de falha do Bluesky ----
const DAYMS=86400000;
const dayAt=(start,i)=>new Date(Date.parse(start+"T00:00:00Z")+i*DAYMS).toISOString().slice(0,10);
const MODES=[{},{hotmartOpen:true},{salesOpen:true}];
// Template fixo anterior (até 10/11/2026): um texto por ângulo, repetido a cada ciclo de 25 dias.
const LEGACY_GUIDANCE={"dor":"Identifique uma dúvida recorrente e registre o que precisa de confirmação antes de responder.","tutorial":"Escolha uma tarefa pequena, documente o processo e revise cada resultado com uma pessoa.","caso de uso":"Simule um atendimento com dados fictícios e confira informações antes de enviar.","objeção":"Compare o trabalho manual com uma rotina assistida, sem presumir economia ou faturamento.","comparação":"Avalie clareza, privacidade e possibilidade de desfazer cada automação antes de adotá-la."};
function legacyDraft(entry,channel,{salesOpen=false,hotmartOpen=false}={}){
 const open=salesOpen===true,kit=!open&&hotmartOpen===true?hotmartKit(entry.product.sku):null;
 const hook=(entry.angle==="tutorial"?"Passo a passo":entry.angle==="comparação"?"O que avaliar":"Uma ideia prática")+" para "+entry.niche;
 const value=entry.product.name+(kit?" (R$ "+kit.price+")":(open?"":" ("+CLOSED_LABEL+")"))+": "+LEGACY_GUIDANCE[entry.angle]+" Use o guia para organizar a rotina.";
 const cta="Veja o guia digital",link=productLink(entry,channel,{salesOpen:open,hotmartOpen:kit!=null});
 if(channel==="telegram")return {channel,hook,value,cta,link,text:hook+"\n\n"+value+"\n\n"+cta+": "+link+"\n#ZEVANORY #Negocios"};
 const g=blueskyPostText({hook,value,cta,productUrl:link,day:entry.day});return {channel,hook,value,cta,link:g.link,text:g.text};
}
// Mesma regra de produção: gate contra os 30 últimos posts publicados; só o publicado entra no histórico.
function simulate(gen,{start,days,channel,mode,seed=[]}){
 const hist=[...seed],rejected=[];let max=0;
 for(let i=0;i<days;i++){
  const entry=calendarEntry(dayAt(start,i)),draft=gen(entry,channel,mode);
  const gate=validateDraft({draft,entry,priorPosts:hist,...mode});max=Math.max(max,gate.similarity_max);
  if(gate.ok){hist.push({day:entry.day,text:draft.text});if(hist.length>30)hist.shift();}else rejected.push(entry.day+":"+gate.reasons.join(","));
 }
 return {rejected,max};
}
// Histórico real do ar: os 30 posts anteriores ainda são do template fixo.
const legacySeed=(channel,mode)=>Array.from({length:30},(_,i)=>{const e=calendarEntry(dayAt("2026-10-07",i));return {day:e.day,text:legacyDraft(e,channel,mode).text};});
test("F1: 60 dias seguidos com histórico, Bluesky e Telegram, 3 modos: 0 reprovações por similaridade",()=>{
 for(const mode of MODES)for(const channel of ["bluesky","telegram"]){
  const r=simulate(generateNative,{start:"2026-11-06",days:60,channel,mode,seed:legacySeed(channel,mode)});
  assert.deepEqual(r.rejected,[],JSON.stringify(mode)+" "+channel);
  assert.ok(r.max<0.5,JSON.stringify(mode)+" "+channel+" max="+r.max);
 }
 // O gate não foi afrouxado: continua reprovando >= 0,5 contra os 30 últimos.
 const src=readFileSync(new URL("../worker/acquisition-engine.mjs",import.meta.url),"utf8");
 assert.ok(src.includes('if(priorPosts.slice(-30).some(p=>textSimilarity(draft.text,p.text)>=0.5))reasons.push("similarity");'));
 const e=calendarEntry("2026-11-10"),d=generateNative(e,"bluesky");
 assert.deepEqual(validateDraft({draft:d,entry:e,priorPosts:[{text:d.text}]}).reasons,["similarity"]);
});
test("F1 mutante: template fixo (legado ou variante constante) volta a reprovar por similaridade",async()=>{
 for(const mode of MODES){
  const r=simulate(legacyDraft,{start:"2026-11-06",days:60,channel:"bluesky",mode,seed:legacySeed("bluesky",mode)});
  assert.ok(r.rejected.filter(x=>x.endsWith(":similarity")).length>=30,JSON.stringify(mode)+" legado reprovou só "+r.rejected.length);
 }
 // Mutante de fonte: textVariant constante (sem rotação de dica, gancho e chamada) tem de reprovar.
 const base=new URL("../worker/",import.meta.url);
 const orig=readFileSync(new URL("acquisition-engine.mjs",base),"utf8");
 const target=" return {tip:mod(n,DAILY_TIPS.length),hook:mod(Math.floor(n/25),4),cta:mod(n,CTAS.length)};";
 assert.ok(orig.includes(target),"alvo do mutante ausente");
 const mutated=orig.replace(target," return {tip:0,hook:0,cta:0};").replace(/from "\.\/([a-z0-9-]+\.mjs)"/g,(_,f)=>'from "'+new URL(f,base).href+'"');
 const mut=await import("data:text/javascript;base64,"+Buffer.from(mutated).toString("base64"));
 const r=simulate(mut.generateNative,{start:"2026-11-06",days:60,channel:"bluesky",mode:{}});
 assert.ok(r.rejected.length>=10,"mutante sobreviveu: "+r.rejected.length);
});
test("F1: banco de dicas, ganchos e chamadas sem promessa nem chamada de compra; rotação sem repetição em 30 dias",()=>{
 assert.equal(DAILY_TIPS.length,37);
 const opening=DAILY_TIPS.map(t=>t.toLocaleLowerCase("pt-BR").match(/[\p{L}\p{N}]+/gu).slice(0,2).join(" "));
 assert.equal(new Set(opening).size,DAILY_TIPS.length,"duas dicas abrem com as mesmas palavras");
 for(let i=0;i<120;i++){
  const w=Array.from({length:30},(_,k)=>textVariant(dayAt("2026-10-10",i+k)).tip);
  assert.equal(new Set(w).size,30);
 }
 assert.throws(()=>textVariant("10/11/2026"),/calendar_day_invalid/);
 for(let i=0;i<100;i++)for(const mode of MODES)for(const ch of ["bluesky","telegram"]){
  const e=calendarEntry(dayAt("2026-11-06",i)),d=generateNative(e,ch,mode);
  const gate=validateDraft({draft:d,entry:e,...mode});
  assert.ok(gate.ok,e.day+" "+ch+" "+JSON.stringify(mode)+" "+gate.reasons);
  assert.ok(d.text.includes(e.niche)&&d.text.includes(e.product.name));
  if(ch==="bluesky")assert.ok(!/\S…\S/.test(d.text)&&!/[^\s…]\n[A-Z]/.test(d.value||""),"corte no meio de palavra");
 }
 for(const t of DAILY_TIPS)assert.deepEqual(salesLockViolations(t),[],t);
});
test("F1: reprovação do gate grava UMA chave bluesky:status:AAAAMMDD com TTL; sucesso não grava",async()=>{
 const store=kv(),puts=[],orig=store.put;store.put=async(k,v,o)=>{puts.push([k,o]);return orig(k,v,o);};
 const env={ZEVANORY_PRIVATE_ARTIFACTS:store,BLUESKY_HANDLE:"zevanoryoficial.bsky.social",BLUESKY_APP_PASSWORD:"app"};
 const day="2026-11-10",entry=calendarEntry(day);
 // Histórico com o próprio texto do dia: colisão real, o gate tem de reprovar.
 await orig("zpc:acquisition:history:bluesky",JSON.stringify([{day:"2026-11-09",text:generateNative(entry,"bluesky").text}]));
 let network=0;const mock=async()=>{network++;return{ok:true,status:200,json:async()=>({})};};
 const t=new Date("2026-11-10T22:35:00Z");
 for(let i=0;i<5;i++){
  const out=await runAcquisitionEngine(env,new Date(t.getTime()+i*1800000),mock);
  const b=out.outcomes.find(x=>x.channel==="bluesky");
  assert.equal(b.status,"erro");assert.equal(b.code,"similarity");
 }
 assert.equal(network,0,"nada sai para a rede com o gate reprovado");
 assert.equal(blueskyStatusKey(day),"bluesky:status:20261110");
 const statusPuts=puts.filter(([k])=>k.startsWith(BLUESKY_STATUS_PREFIX));
 assert.equal(statusPuts.length,1,"no máximo 1 gravação por dia");
 assert.deepEqual(statusPuts[0],["bluesky:status:20261110",{expirationTtl:BLUESKY_STATUS_TTL}]);
 const st=JSON.parse(await store.get("bluesky:status:20261110"));
 assert.equal(st.ok,false);assert.equal(st.motivo,"similarity");assert.equal(st.similaridade,1);assert.equal(st.day,day);
 assert.equal(await store.get("zpc:acquisition:daily:"+day+":bluesky"),null,"a reprovação continua sem reservar o rkey");
 // Publicação bem-sucedida não grava status.
 const ok=kv(),okPuts=[],okOrig=ok.put;ok.put=async(k,v,o)=>{okPuts.push(k);return okOrig(k,v,o);};
 const pub=async(url,req={})=>{if(url.endsWith("createSession"))return{ok:true,json:async()=>({did:"did:plc:abc",accessJwt:"access"})};
  if(url.endsWith("createRecord")){const r=JSON.parse(req.body);return{ok:true,json:async()=>({uri:"at://did:plc:abc/app.bsky.feed.post/"+r.rkey,cid:"cid"})};}
  return{ok:true,status:200,json:async()=>({})};};
 const done=await runAcquisitionEngine({...env,ZEVANORY_PRIVATE_ARTIFACTS:ok},t,pub);
 assert.equal(done.outcomes.find(x=>x.channel==="bluesky").status,"publicado");
 assert.equal(okPuts.some(k=>k.startsWith(BLUESKY_STATUS_PREFIX)),false);
});
test("F1: falha de publicação também grava o status; regravação só quando o motivo muda",async()=>{
 const store=kv(),env={ZEVANORY_PRIVATE_ARTIFACTS:store,BLUESKY_HANDLE:"zevanoryoficial.bsky.social",BLUESKY_APP_PASSWORD:"app"};
 const mock=async(url)=>{if(url.endsWith("createSession"))return{ok:true,json:async()=>({did:"did:plc:abc",accessJwt:"access"})};
  if(url.endsWith("createRecord"))return{ok:false,status:400,headers:{get:()=>null}};
  if(url.includes("getRecord"))return{ok:false,status:400};return{ok:true,status:200,json:async()=>({})};};
 await runAcquisitionEngine(env,new Date("2026-11-10T22:35:00Z"),mock);
 const st=JSON.parse(await store.get("bluesky:status:20261110"));
 assert.deepEqual([st.ok,st.motivo,st.similaridade],[false,"bluesky_http_400",null]);
 const now=new Date("2026-11-10T23:00:00Z");
 assert.equal((await recordBlueskyFailure(store,"2026-11-10",now,{motivo:"bluesky_http_400"})).written,false);
 assert.equal((await recordBlueskyFailure(store,"2026-11-10",now,{motivo:"similarity",similaridade:0.61234})).written,true);
 assert.equal(JSON.parse(await store.get("bluesky:status:20261110")).similaridade,0.612);
 assert.equal((await recordBlueskyFailure(store,"2026-11-10",now,{motivo:"Texto Livre <x>"})).written,true);
 assert.equal(JSON.parse(await store.get("bluesky:status:20261110")).motivo,"desconhecido");
 const broken={get:async()=>null,put:async()=>{throw new Error("kv_quota");}};
 assert.equal((await recordBlueskyFailure(broken,"2026-11-10",now,{motivo:"similarity"})).written,false);
 assert.throws(()=>blueskyStatusKey("20261110"),/calendar_day_invalid/);
 // Exceção do motor também fica registrada.
 const s2=kv(),bad={get:s2.get,put:async(k,v,o)=>{if(k==="zpc:acquisition:daily:2026-11-10:bluesky")throw new Error("boom");return s2.put(k,v,o);}};
 const out=await runAcquisitionEngine({...env,ZEVANORY_PRIVATE_ARTIFACTS:bad},new Date("2026-11-10T22:35:00Z"),mock);
 assert.equal(out.outcomes.find(x=>x.channel==="bluesky").code,"engine_exception");
 assert.equal(JSON.parse(await s2.get("bluesky:status:20261110")).motivo,"engine_exception");
});
