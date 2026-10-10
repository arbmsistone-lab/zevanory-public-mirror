import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {updateBlueskyProfile,updateTelegramChannelPhoto,syncBrandProfiles,brandProfileSnapshot,OFFICIAL_SOCIAL_PROFILE} from "../worker/brand-profiles.mjs";
const pic=name=>new Response(readFileSync(new URL("../assets/brand/export/"+name,import.meta.url)),{status:200,headers:{"content-type":"image/png"}});
const kv=()=>{const m=new Map();return {get:async k=>m.get(k)||null,put:async(k,v)=>m.set(k,String(v)),m};};
test("empty channel credentials: no upload, no remote write, no invented profile_updated",async()=>{
 let remote=0;const env={ZEVANORY_PRIVATE_ARTIFACTS:kv()};
 const state=await syncBrandProfiles(env,async()=>{remote++;throw Error("never")});
 assert.equal(remote,0);assert.equal(state.profiles.length,8);
 assert.ok(state.profiles.every(x=>x.status==="depende_do_dono"));
 assert.deepEqual(state.profiles.map(x=>x.channel),["bluesky","telegram","instagram","facebook","youtube","pinterest","whatsapp","google"]);
 assert.ok(state.profiles.find(x=>x.channel==="youtube").edit_url.includes("studio.youtube.com"));
 const readback=await brandProfileSnapshot(env);assert.equal(readback.schema,"zevanory.brand-profiles.v1");
});
test("Bluesky avatar and banner uploaded from approved PNGs, updates official brand name/bio and verifies readback",async()=>{
 const steps=[],prior={$type:"app.bsky.actor.profile",description:"Biografia que não pode ser apagada",displayName:"ZEVANORY",createdAt:"2020-01-01T00:00:00Z"};
 let current=0,posted=null;
 const fetchImpl=async(url,options={})=>{
  steps.push(new URL(url).pathname.split("/").pop());
  if(url.endsWith("avatar-800.png"))return pic("avatar-800.png");
  if(url.endsWith("banner-bluesky.png"))return pic("banner-bluesky.png");
  if(url.endsWith("createSession"))return Response.json({did:"did:plc:zev",accessJwt:"token"});
  if(url.includes("getRecord"))return Response.json(current++===0?{value:prior,cid:"old-cid"}:{value:posted});
  if(url.endsWith("uploadBlob"))return Response.json({blob:{"$type":"blob",ref:{"$link":"cid-"+steps.filter(x=>x==="com.atproto.repo.uploadBlob").length},mimeType:"image/png",size:150}});
  if(url.endsWith("putRecord")){
    const b=JSON.parse(options.body);assert.equal(b.swapRecord,"old-cid");posted=b.record;
    assert.equal(posted.displayName,"ZEVANORY");assert.equal(posted.description,OFFICIAL_SOCIAL_PROFILE.bluesky.description);
    return Response.json({uri:"at://did:plc:zev/app.bsky.actor.profile/self",cid:"new-cid"});
  }
  throw new Error("unknown "+url);
 };
 const out=await updateBlueskyProfile({BLUESKY_HANDLE:"test.bsky.social",BLUESKY_APP_PASSWORD:"test"},fetchImpl);
 assert.equal(out.status,"atualizado");assert.equal(out.channel,"bluesky");
 assert.equal(steps.filter(x=>x==="com.atproto.repo.uploadBlob").length,2);
});
test("Telegram photo requires provider receipt AND changed getChat photo",async()=>{
 let reads=0,updates=0;
 const mock=async(url,opts={})=>{
  if(url.endsWith("avatar-800.png"))return pic("avatar-800.png");
  if(url.endsWith("/getChat"))return Response.json({ok:true,result:{title:OFFICIAL_SOCIAL_PROFILE.telegram.title,description:OFFICIAL_SOCIAL_PROFILE.telegram.description,photo:{big_file_id:reads++===0?"old":"new"}}});
  if(url.endsWith("/setChatPhoto")){updates++;assert.ok(opts.body instanceof FormData);return Response.json({ok:true,result:true});}
  throw Error("other request");
 };
 const out=await updateTelegramChannelPhoto({TELEGRAM_BOT_TOKEN:"fake",TELEGRAM_CHANNEL_ID:"@zevanory"},mock);
 assert.equal(out.status,"atualizado");assert.equal(updates,1);
});
test("Telegram refuses to certify unchanged profile photograph",async()=>{
 const mock=async url=>{
  if(url.endsWith("avatar-800.png"))return pic("avatar-800.png");
  if(url.endsWith("/getChat"))return Response.json({ok:true,result:{title:OFFICIAL_SOCIAL_PROFILE.telegram.title,description:OFFICIAL_SOCIAL_PROFILE.telegram.description,photo:{big_file_id:"same"}}});
  if(url.endsWith("/setChatPhoto"))return Response.json({ok:true,result:true});
 };
 await assert.rejects(updateTelegramChannelPhoto({TELEGRAM_BOT_TOKEN:"t",TELEGRAM_CHANNEL_ID:"@zevanory"},mock),/readback_unverified/);
});

test("Bluesky official identity never accepts a mismatched post-write biography",async()=>{
  const copy=OFFICIAL_SOCIAL_PROFILE.bluesky;
  assert.equal(copy.displayName,"ZEVANORY");
  assert.match(copy.description,/Renan Bitu, Várzea Alegre\/CE/);
  assert.match(copy.description,/utm_source=bluesky/);
});
test("Telegram channel official description names ZEVANORY and carries the channel UTM",()=>{
  assert.equal(OFFICIAL_SOCIAL_PROFILE.telegram.title,"ZEVANORY");
  assert.match(OFFICIAL_SOCIAL_PROFILE.telegram.description,/utm_source=telegram/);
  assert.ok(OFFICIAL_SOCIAL_PROFILE.telegram.description.length<=255);
});

test("historical v1 approval cannot skip the new official v2 profile readback", async () => {
 const store=kv();
 await store.put("zpc:brand:profile:bluesky:v1",JSON.stringify({channel:"bluesky",status:"atualizado",provider_record:"legacy"}));
 let reads=0,uploads=0,posted=null,sessions=0;
 const fake=async (url,opts={})=>{
   if(url.endsWith("avatar-800.png"))return pic("avatar-800.png");
   if(url.endsWith("banner-bluesky.png"))return pic("banner-bluesky.png");
   if(url.endsWith("createSession")){sessions++;return Response.json({did:"did:plc:brandv2",accessJwt:"token"});}
   if(url.includes("getRecord"))return Response.json(reads++===0
      ? {value:{$type:"app.bsky.actor.profile",description:"legacy bio",displayName:"old"},cid:"old-cid"}
      : {value:posted,cid:"new-cid"});
   if(url.endsWith("uploadBlob"))return Response.json({blob:{$type:"blob",ref:{$link:"cid-"+(++uploads)},mimeType:"image/png",size:120}});
   if(url.endsWith("putRecord")){posted=JSON.parse(opts.body).record;return Response.json({uri:"at://did:plc:brandv2/app.bsky.actor.profile/self",cid:"new-cid"});}
   throw Error("Unexpected profile request "+url);
 };
 const result=await syncBrandProfiles({
   ZEVANORY_PRIVATE_ARTIFACTS:store,BLUESKY_HANDLE:"official.bsky.social",BLUESKY_APP_PASSWORD:"test"
 },fake);
 assert.equal(sessions,1,"v1 marker must never skip a v2 reconciliation");
 assert.equal(result.profiles.find(x=>x.channel==="bluesky")?.status,"atualizado");
 assert.equal(posted.displayName,"ZEVANORY");
 assert.equal(posted.description,OFFICIAL_SOCIAL_PROFILE.bluesky.description);
 const v2=JSON.parse(await store.get("zpc:brand:profile:bluesky:v2"));
 assert.equal(v2.status,"atualizado");
 assert.equal(v2.provider_record,"at://did:plc:brandv2/app.bsky.actor.profile/self");
 assert.equal(JSON.parse(await store.get("zpc:brand:profile:bluesky:v1")).provider_record,"legacy");
});

test("hourly brand cycle is outside acquisition try/catch and has independent failure telemetry",()=>{
  const source=readFileSync(new URL("../worker/cloudflare-worker.compat.mjs",import.meta.url),"utf8");
  const start=source.indexOf('if (controller?.cron === "0 * * * *")');
  const end=source.indexOf('if (typeof worker.queue',start);
  assert.ok(start>=0&&end>start);
  const cron=source.slice(start,end);
  const acquisitionFailure=cron.indexOf('console.error("acquisition_cycle_failed")');
  const brandSync=cron.indexOf('await syncBrandProfiles(normalized)');
  const brandFailure=cron.indexOf('console.error("brand_profile_cycle_unverified")');
  assert.ok(acquisitionFailure>0&&brandSync>acquisitionFailure&&brandFailure>brandSync);
});

test("canonical brand PNGs are delegated to static assets despite run_worker_first",()=>{
  const source=readFileSync(new URL("../worker/cloudflare-worker.compat.mjs",import.meta.url),"utf8");
  assert.match(source,/url\.pathname\.startsWith\("\/brand\/export\/"\)/);
  assert.match(source,/Object\.prototype\.hasOwnProperty\.call\(BRAND_SIZES,name\)/);
  assert.match(source,/normalized\.ASSETS\.fetch\(request\)/);
  assert.match(source,/brand_assets_unavailable/);
});

test("pending brand profile is retried instead of being treated as a verified receipt",async()=>{
 const store=kv();
 await store.put("zpc:brand:profile:bluesky:v2",JSON.stringify({channel:"bluesky",status:"pendente_conciliacao"}));
 let attempts=0;
 const next=await syncBrandProfiles({
   ZEVANORY_PRIVATE_ARTIFACTS:store,BLUESKY_HANDLE:"official.bsky.social",BLUESKY_APP_PASSWORD:"dummy"
 },async()=>{attempts++;throw Error("simulated provider outage")});
 assert.ok(attempts>=1,"a previously pending profile must retry the next brand cycle");
 assert.equal(next.profiles.find(x=>x.channel==="bluesky")?.status,"pendente_conciliacao");
});
test("certified official v2 profile receipt remains idempotent",async()=>{
 const store=kv();
 const verified={channel:"bluesky",status:"atualizado",provider_record:"at://did:plc:verified/app.bsky.actor.profile/self",at:"2026-10-10T18:00:00Z"};
 await store.put("zpc:brand:profile:bluesky:v2",JSON.stringify(verified));
 let calls=0;
 const result=await syncBrandProfiles({
   ZEVANORY_PRIVATE_ARTIFACTS:store,BLUESKY_HANDLE:"official.bsky.social",BLUESKY_APP_PASSWORD:"dummy"
 },async()=>{calls++;throw Error("verified receipt should skip provider");});
 assert.equal(calls,0);
 assert.equal(result.profiles.find(x=>x.channel==="bluesky")?.status,"atualizado");
});
