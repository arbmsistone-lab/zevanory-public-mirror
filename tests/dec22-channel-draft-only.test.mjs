import test from "node:test";
import assert from "node:assert/strict";
import { DEC22_DRAFT_ONLY } from "../worker/channel-dec22.mjs";
import { runAcquisitionEngine } from "../worker/acquisition-engine.mjs";
import { crosspost } from "../scripts/channels/short-crosspost.mjs";
import { sendDailyCreativeReport } from "../worker/creative-autonomy.mjs";
const kv=()=>{const m=new Map();return {m,get:async k=>m.get(k)||null,put:async(k,v)=>{m.set(k,String(v))}}};
test("DEC-22 acquisition saves Telegram/Bluesky drafts and calls no provider",async()=>{
 assert.equal(DEC22_DRAFT_ONLY,true);const store=kv(),urls=[];
 const env={ZEVANORY_PRIVATE_ARTIFACTS:store,TELEGRAM_BOT_TOKEN:"test",TELEGRAM_CHANNEL_ID:"@zevanory",BLUESKY_HANDLE:"zevanory.bsky.social",BLUESKY_APP_PASSWORD:"test"};
 const out=await runAcquisitionEngine(env,new Date("2026-11-06T23:00:00Z"),async url=>{urls.push(url);throw Error("outbound_forbidden")});
 assert.deepEqual(urls,[]);for(const channel of ["telegram","bluesky"]){assert.equal(out.outcomes.find(x=>x.channel===channel).status,"rascunho");const draft=JSON.parse(await store.get("zpc:channel:draft:v1:"+channel+":2026-11-06"));assert.equal(draft.approved,false);}
});
test("DEC-22 crosspost creates drafts without Meta, TikTok or Telegram calls",async()=>{
 const store=kv(),urls=[];const out=await crosspost({day:"2026-11-06",mp4:Buffer.from("x"),kv:store,env:{META_ACCESS_TOKEN:"test",INSTAGRAM_BUSINESS_ACCOUNT_ID:"ig",META_PAGE_ID:"pg",TELEGRAM_BOT_TOKEN:"test",TELEGRAM_CHANNEL_ID:"@zevanory"},salesOpen:false,fetchImpl:async url=>{urls.push(url);throw Error("outbound_forbidden")}});
 assert.deepEqual(urls,[]);for(const channel of ["tiktok","telegram_video","instagram","facebook"]){assert.equal(out[channel],"draft_only_dec22");assert.equal(JSON.parse(await store.get("zpc:channel:draft:v1:"+channel+":2026-11-06:oferta")).approved,false);}
});
test("DEC-22 owner email must not claim automatic publication active",async()=>{
 const store=kv();let body;await sendDailyCreativeReport({ZEVANORY_PRIVATE_ARTIFACTS:store,RESEND_API_KEY:"test",OWNER_ALERT_EMAIL:"owner@example.com"},{now:new Date("2026-11-06T23:00:00Z"),fetchImpl:async(url,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify({id:"mock"}),{status:200})}});
 assert.match(body.text,/Publicação automática: BLOQUEADA/);assert.doesNotMatch(body.text,/Publicação automática: ATIVA/);
});
