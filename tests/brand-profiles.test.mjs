import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {updateBlueskyProfile,updateTelegramChannelPhoto,syncBrandProfiles,brandProfileSnapshot} from "../worker/brand-profiles.mjs";
const pic=name=>new Response(readFileSync(new URL("../assets/brand/export/"+name,import.meta.url)),{status:200,headers:{"content-type":"image/png"}});
const kv=()=>{const m=new Map();return {get:async k=>m.get(k)||null,put:async(k,v)=>m.set(k,String(v)),m};};
test("empty channel credentials: no upload, no remote write, no invented profile_updated",async()=>{
 let remote=0;const env={ZEVANORY_PRIVATE_ARTIFACTS:kv()};
 const state=await syncBrandProfiles(env,async()=>{remote++;throw Error("never")});
 assert.equal(remote,0);assert.equal(state.profiles.length,2);
 assert.deepEqual(state.profiles.map(x=>x.status),["depende_do_dono","depende_do_dono"]);
 const readback=await brandProfileSnapshot(env);assert.equal(readback.schema,"zevanory.brand-profiles.v1");
});
test("Bluesky avatar and banner uploaded from approved PNGs, preserves biography and verifies readback",async()=>{
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
    assert.equal(posted.description,prior.description);
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
  if(url.endsWith("/getChat"))return Response.json({ok:true,result:{photo:{big_file_id:reads++===0?"old":"new"}}});
  if(url.endsWith("/setChatPhoto")){updates++;assert.ok(opts.body instanceof FormData);return Response.json({ok:true,result:true});}
  throw Error("other request");
 };
 const out=await updateTelegramChannelPhoto({TELEGRAM_BOT_TOKEN:"fake",TELEGRAM_CHANNEL_ID:"@zevanory"},mock);
 assert.equal(out.status,"atualizado");assert.equal(updates,1);
});
test("Telegram refuses to certify unchanged profile photograph",async()=>{
 const mock=async url=>{
  if(url.endsWith("avatar-800.png"))return pic("avatar-800.png");
  if(url.endsWith("/getChat"))return Response.json({ok:true,result:{photo:{big_file_id:"same"}}});
  if(url.endsWith("/setChatPhoto"))return Response.json({ok:true,result:true});
 };
 await assert.rejects(updateTelegramChannelPhoto({TELEGRAM_BOT_TOKEN:"t",TELEGRAM_CHANNEL_ID:"@zevanory"},mock),/readback_unverified/);
});
