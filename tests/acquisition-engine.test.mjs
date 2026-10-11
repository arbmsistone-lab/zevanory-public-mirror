import {readFileSync} from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import {calendarEntry,planCalendar,productLink,generateNative,validateDraft,textSimilarity,runAcquisitionEngine,acquisitionSnapshot,verifyProductLink,runOwnerDailyDigest,CATALOG_SKUS} from "../worker/acquisition-engine.mjs";
const kv=()=>{const m=new Map();return{m,get:async k=>m.get(k)??null,put:async(k,v)=>{m.set(k,String(v))}}};
test("30-day calendar rotates five real SKUs, five niches, five angles",()=>{
 const c=planCalendar(new Date("2026-10-10T12:00:00Z"));
 assert.equal(c.length,30);assert.equal(new Set(c.map(x=>x.product.sku)).size,5);
 assert.equal(new Set(c.map(x=>x.niche)).size,5);assert.equal(new Set(c.map(x=>x.angle)).size,5);
 for(let i=0;i<c.length;i++)for(let j=i+1;j<Math.min(i+14,c.length);j++)assert.notEqual(c[i].theme_id,c[j].theme_id);
});
test("each generated native message has right purchase SKU and channel UTM",()=>{
 const c=calendarEntry("2026-10-10");
 for(const ch of ["blog","telegram","bluesky"]){const d=generateNative(c,ch);assert.match(d.link,new RegExp(c.product.sku));assert.match(d.link,new RegExp("utm_source="+ch));assert.ok(d.text.includes(d.link));}
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
test("ambiguous Telegram failure stays pending (no blind repost); definitive 4xx is retried",async()=>{
 const brand=()=>new Response(readFileSync(new URL("../assets/brand/export/post-01.png",import.meta.url)),{status:200});
 const run=async(mode)=>{
  const store=kv(),env={ZEVANORY_PRIVATE_ARTIFACTS:store,TELEGRAM_BOT_TOKEN:"t",TELEGRAM_CHANNEL_ID:"@zevanory"};let sends=0,first=true;
  const mock=async(url)=>{if(url.endsWith("/brand/export/post-01.png"))return brand();
   if(url.includes("api.telegram.org")){sends++;if(mode==="timeout"&&first){first=false;const e=new Error("timed out");e.name="TimeoutError";throw e;}if(mode==="400"&&sends<=2)return{status:400,json:async()=>({ok:false})};return{status:200,json:async()=>({ok:true,result:{message_id:5}})};}
   return{ok:true,status:200,json:async()=>({})};};
  const t=new Date("2026-10-10T15:30:00Z");
  await runAcquisitionEngine(env,t,mock);const b=await runAcquisitionEngine(env,new Date(t.getTime()+1800000),mock);
  return {sends,status:b.outcomes.find(x=>x.channel==="telegram").status};
 };
 const amb=await run("timeout");assert.equal(amb.status,"pending");
 assert.equal(amb.sends,1);
 const def=await run("400");assert.equal(def.status,"publicado");assert.equal(def.sends,3);
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
test("one cycle publishes Telegram and Bluesky after peak, then never duplicates",async()=>{
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
 assert.deepEqual(a.outcomes.filter(x=>x.status==="publicado").map(x=>x.channel).sort(),["blog","bluesky","telegram"]);
 const b=await runAcquisitionEngine(env,date,mock);
 assert.equal(counts.telegram,1);assert.equal(counts.createRecord,1);
 assert.ok(b.outcomes.some(x=>x.channel==="bluesky"&&x.url));
 const snapshot=await acquisitionSnapshot(env,date);
 assert.ok(snapshot.today.some(x=>x.channel==="bluesky"&&x.status==="publicado"&&x.link));
 assert.equal(snapshot.metrics.sales,null);
});
test("a failing Bluesky provider does not prevent Telegram evidence",async()=>{
 const store=kv(),env={ZEVANORY_PRIVATE_ARTIFACTS:store,TELEGRAM_BOT_TOKEN:"t",TELEGRAM_CHANNEL_ID:"@zevanory",BLUESKY_HANDLE:"zevanory.bsky.social",BLUESKY_APP_PASSWORD:"bad"};
 const mock=async(url,req={})=>{
  if(req.method==="HEAD")return{status:200};
  if(url.endsWith("/brand/export/post-01.png"))return new Response(readFileSync(new URL("../assets/brand/export/post-01.png",import.meta.url)),{status:200});
  if(url.includes("api.telegram.org"))return{status:200,json:async()=>({ok:true,result:{message_id:22}})};
  if(url.endsWith("createSession"))return{ok:false,status:401,headers:{get:()=>null}};
  return{status:200,ok:true,json:async()=>({})};
 };
 const result=await runAcquisitionEngine(env,new Date("2026-10-10T23:00:00Z"),mock);
 assert.equal(result.outcomes.find(x=>x.channel==="telegram").status,"publicado");
 assert.equal(result.outcomes.find(x=>x.channel==="bluesky").code,"credential_expired");
});
test("unconfigured external channel is waiting rather than a false error",async()=>{
 const env={ZEVANORY_PRIVATE_ARTIFACTS:kv()};
 const out=await runAcquisitionEngine(env,new Date("2026-10-10T23:00:00Z"),async()=>({status:200,ok:true,json:async()=>({})}));
 assert.equal(out.outcomes.find(x=>x.channel==="bluesky").status,"aguardando credencial");
 assert.equal(out.outcomes.find(x=>x.channel==="telegram").status,"aguardando credencial");
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
test("legacy Telegram receipt is adopted without a duplicate remote post",async()=>{
 const store=kv(),day="2026-10-10";
 await store.put("zpc:multichannel:evidence:telegram:daily:"+day,JSON.stringify({channel:"telegram",provider_post_id:"17",url:"https://t.me/zevanory/17",publishedAt:"2026-10-10T14:00:00Z"}));
 const env={ZEVANORY_PRIVATE_ARTIFACTS:store,TELEGRAM_BOT_TOKEN:"secret",TELEGRAM_CHANNEL_ID:"@zevanory"};
 let requests=0;const mock=async(url,req)=>{if(url.includes("api.telegram.org"))requests++;return{ok:true,status:200,json:async()=>({})};};
 const result=await runAcquisitionEngine(env,new Date("2026-10-10T23:00:00Z"),mock);
 assert.equal(result.outcomes.find(x=>x.channel==="telegram").status,"publicado");
 assert.equal(result.outcomes.find(x=>x.channel==="telegram").provenance,"legacy");
 assert.equal(requests,0);
});
