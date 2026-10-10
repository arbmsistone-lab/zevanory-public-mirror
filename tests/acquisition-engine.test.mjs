import test from "node:test";
import assert from "node:assert/strict";
import {calendarEntry,planCalendar,productLink,generateNative,validateDraft,textSimilarity,runAcquisitionEngine,acquisitionSnapshot,verifyProductLink} from "../worker/acquisition-engine.mjs";
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
test("HEAD verifies exact product HTTP 200; redirects and network failure fail closed",async()=>{
 const url=productLink(calendarEntry("2026-10-10"),"blog");
 assert.equal(await verifyProductLink(url,async()=>({status:200})),200);
 assert.equal(await verifyProductLink(url,async()=>({status:302})),302);
 assert.equal(await verifyProductLink(url,async()=>{throw Error("offline")}),0);
 assert.equal(await verifyProductLink("http://evil.example/",async()=>({status:200})),0);
});
test("one cycle publishes Telegram and Bluesky after peak, then never duplicates",async()=>{
 const store=kv(),counts={telegram:0,createRecord:0},env={ZEVANORY_PRIVATE_ARTIFACTS:store,TELEGRAM_BOT_TOKEN:"t",TELEGRAM_CHANNEL_ID:"@zevanory",BLUESKY_HANDLE:"zevanory.bsky.social",BLUESKY_APP_PASSWORD:"password"};
 const mock=async(url,req={})=>{
  if(req.method==="HEAD")return{status:200};
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
