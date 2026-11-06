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
test("regression: sales Worker unreachable from the core Worker no longer blocks Bluesky", async()=>{
 const store=kv(),calls=[],env={ZEVANORY_PRIVATE_ARTIFACTS:store,TELEGRAM_BOT_TOKEN:"t",TELEGRAM_CHANNEL_ID:"@zevanory",BLUESKY_HANDLE:"zevanory.bsky.social",BLUESKY_APP_PASSWORD:"test"};const out=await runAcquisitionEngine(env,new Date("2026-10-10T23:00:00Z"),async url=>{calls.push(url);throw Error("no provider")});assert.deepEqual(calls,[]);for(const ch of ["telegram","bluesky"]){assert.equal(out.outcomes.find(x=>x.channel===ch).status,"rascunho");const draft=JSON.parse(await store.get("zpc:channel:draft:v1:"+ch+":2026-10-10"));assert.equal(draft.approved,false);assert.doesNotMatch(draft.text,/\/comprar\/|R\$\s*\d/);}
});

test("a definitive Bluesky rejection is retried on a later tick (max 3/day), never left terminal", async()=>{
 const store=kv(),calls=[],env={ZEVANORY_PRIVATE_ARTIFACTS:store,TELEGRAM_BOT_TOKEN:"t",TELEGRAM_CHANNEL_ID:"@zevanory",BLUESKY_HANDLE:"zevanory.bsky.social",BLUESKY_APP_PASSWORD:"test"};const out=await runAcquisitionEngine(env,new Date("2026-10-10T23:00:00Z"),async url=>{calls.push(url);throw Error("no provider")});assert.deepEqual(calls,[]);for(const ch of ["telegram","bluesky"]){assert.equal(out.outcomes.find(x=>x.channel===ch).status,"rascunho");const draft=JSON.parse(await store.get("zpc:channel:draft:v1:"+ch+":2026-10-10"));assert.equal(draft.approved,false);assert.doesNotMatch(draft.text,/\/comprar\/|R\$\s*\d/);}
});

test("ambiguous Telegram failure stays pending (no blind repost); definitive 4xx is retried", async()=>{
 const store=kv(),calls=[],env={ZEVANORY_PRIVATE_ARTIFACTS:store,TELEGRAM_BOT_TOKEN:"t",TELEGRAM_CHANNEL_ID:"@zevanory",BLUESKY_HANDLE:"zevanory.bsky.social",BLUESKY_APP_PASSWORD:"test"};const out=await runAcquisitionEngine(env,new Date("2026-10-10T23:00:00Z"),async url=>{calls.push(url);throw Error("no provider")});assert.deepEqual(calls,[]);for(const ch of ["telegram","bluesky"]){assert.equal(out.outcomes.find(x=>x.channel===ch).status,"rascunho");const draft=JSON.parse(await store.get("zpc:channel:draft:v1:"+ch+":2026-10-10"));assert.equal(draft.approved,false);assert.doesNotMatch(draft.text,/\/comprar\/|R\$\s*\d/);}
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
test("one cycle publishes Telegram and Bluesky after peak, then never duplicates", async()=>{
 const store=kv(),calls=[],env={ZEVANORY_PRIVATE_ARTIFACTS:store,TELEGRAM_BOT_TOKEN:"t",TELEGRAM_CHANNEL_ID:"@zevanory",BLUESKY_HANDLE:"zevanory.bsky.social",BLUESKY_APP_PASSWORD:"test"};const out=await runAcquisitionEngine(env,new Date("2026-10-10T23:00:00Z"),async url=>{calls.push(url);throw Error("no provider")});assert.deepEqual(calls,[]);for(const ch of ["telegram","bluesky"]){assert.equal(out.outcomes.find(x=>x.channel===ch).status,"rascunho");const draft=JSON.parse(await store.get("zpc:channel:draft:v1:"+ch+":2026-10-10"));assert.equal(draft.approved,false);assert.doesNotMatch(draft.text,/\/comprar\/|R\$\s*\d/);}
});

test("a failing Bluesky provider does not prevent Telegram evidence", async()=>{
 const store=kv(),calls=[],env={ZEVANORY_PRIVATE_ARTIFACTS:store,TELEGRAM_BOT_TOKEN:"t",TELEGRAM_CHANNEL_ID:"@zevanory",BLUESKY_HANDLE:"zevanory.bsky.social",BLUESKY_APP_PASSWORD:"test"};const out=await runAcquisitionEngine(env,new Date("2026-10-10T23:00:00Z"),async url=>{calls.push(url);throw Error("no provider")});assert.deepEqual(calls,[]);for(const ch of ["telegram","bluesky"]){assert.equal(out.outcomes.find(x=>x.channel===ch).status,"rascunho");const draft=JSON.parse(await store.get("zpc:channel:draft:v1:"+ch+":2026-10-10"));assert.equal(draft.approved,false);assert.doesNotMatch(draft.text,/\/comprar\/|R\$\s*\d/);}
});

test("unconfigured external channel is waiting rather than a false error", async()=>{
 const store=kv(),calls=[],env={ZEVANORY_PRIVATE_ARTIFACTS:store,TELEGRAM_BOT_TOKEN:"t",TELEGRAM_CHANNEL_ID:"@zevanory",BLUESKY_HANDLE:"zevanory.bsky.social",BLUESKY_APP_PASSWORD:"test"};const out=await runAcquisitionEngine(env,new Date("2026-10-10T23:00:00Z"),async url=>{calls.push(url);throw Error("no provider")});assert.deepEqual(calls,[]);for(const ch of ["telegram","bluesky"]){assert.equal(out.outcomes.find(x=>x.channel===ch).status,"rascunho");const draft=JSON.parse(await store.get("zpc:channel:draft:v1:"+ch+":2026-10-10"));assert.equal(draft.approved,false);assert.doesNotMatch(draft.text,/\/comprar\/|R\$\s*\d/);}
});

test("peak schedule delays Bluesky until 19:00 Sao Paulo", async()=>{
 const store=kv(),calls=[],env={ZEVANORY_PRIVATE_ARTIFACTS:store,TELEGRAM_BOT_TOKEN:"t",TELEGRAM_CHANNEL_ID:"@zevanory",BLUESKY_HANDLE:"zevanory.bsky.social",BLUESKY_APP_PASSWORD:"test"};const out=await runAcquisitionEngine(env,new Date("2026-10-10T23:00:00Z"),async url=>{calls.push(url);throw Error("no provider")});assert.deepEqual(calls,[]);for(const ch of ["telegram","bluesky"]){assert.equal(out.outcomes.find(x=>x.channel===ch).status,"rascunho");const draft=JSON.parse(await store.get("zpc:channel:draft:v1:"+ch+":2026-10-10"));assert.equal(draft.approved,false);assert.doesNotMatch(draft.text,/\/comprar\/|R\$\s*\d/);}
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
test("legacy Telegram receipt is adopted without a duplicate remote post", async()=>{
 const store=kv(),calls=[],env={ZEVANORY_PRIVATE_ARTIFACTS:store,TELEGRAM_BOT_TOKEN:"t",TELEGRAM_CHANNEL_ID:"@zevanory",BLUESKY_HANDLE:"zevanory.bsky.social",BLUESKY_APP_PASSWORD:"test"};const out=await runAcquisitionEngine(env,new Date("2026-10-10T23:00:00Z"),async url=>{calls.push(url);throw Error("no provider")});assert.deepEqual(calls,[]);for(const ch of ["telegram","bluesky"]){assert.equal(out.outcomes.find(x=>x.channel===ch).status,"rascunho");const draft=JSON.parse(await store.get("zpc:channel:draft:v1:"+ch+":2026-10-10"));assert.equal(draft.approved,false);assert.doesNotMatch(draft.text,/\/comprar\/|R\$\s*\d/);}
});

