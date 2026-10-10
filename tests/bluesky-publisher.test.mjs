import test from "node:test";
import assert from "node:assert/strict";
import {publishBluesky,blueskyPostText,graphemeCount,blueskyReady} from "../worker/bluesky-publisher.mjs";
const env={BLUESKY_HANDLE:"zevanory.bsky.social",BLUESKY_APP_PASSWORD:"app-only-secret"};
const args={env,day:"2026-10-10",topic:"ZEV-IA-011",title:"Atendimento claro",hook:"Atendimento claro",value:"Organize a rotina com revisão humana.",cta:"Veja o guia",productUrl:"https://vendas.zevanory.api.br/comprar/ZEV-IA-011"};
const receipt="at://did:plc:abc/app.bsky.feed.post/zev-20261010-zev-ia-011";
test("missing application credentials causes pause, not an error",async()=>{assert.equal(blueskyReady({}),false);assert.deepEqual(await publishBluesky({env:{}}),{status:"aguardando credencial"});});
test("reject external domains and invalid SKU",()=>{assert.throws(()=>blueskyPostText({...args,productUrl:"https://evil.example.com/comprar/ZEV-IA-011"}));assert.throws(()=>blueskyPostText({...args,productUrl:"https://vendas.zevanory.api.br/comprar/not-a-sku"}));});
test("native text counts grapheme clusters not JS UTF-16 units",()=>{
 const g="👩‍💻";assert.equal(graphemeCount(g),1);
 const generated=blueskyPostText({...args,hook:g.repeat(120),value:"📈".repeat(150)});
 assert.ok(graphemeCount(generated.text)<=300);assert.match(generated.link,/utm_source=bluesky/);
});
test("success sends link facets/card and reads proof rkey exactly",async()=>{
 const calls=[];const fetchImpl=async(url,o)=>{calls.push({url,body:JSON.parse(o.body)});return{ok:true,json:async()=>url.endsWith("createSession")?{did:"did:plc:abc",accessJwt:"access"}:{uri:receipt,cid:"cid-1"}};};
 const result=await publishBluesky({...args,fetchImpl});
 assert.equal(result.status,"publicado");assert.equal(result.provider_post_id,"zev-20261010-zev-ia-011");assert.equal(calls[1].body.rkey,result.provider_post_id);
 assert.equal(calls[1].body.record.embed.external.uri,result.landing_url);
 assert.equal(calls[1].body.record.facets[0].features[0].uri,result.landing_url);
});
test("HTTP 401 fails closed without retry",async()=>{
 let calls=0;
 const fetchImpl=async()=>{calls++;return{ok:false,status:401,headers:{get:()=>null}};};
 await assert.rejects(publishBluesky({...args,fetchImpl,sleepImpl:async()=>{}}),/bluesky_http_401/);assert.equal(calls,1);
});
test("HTTP 429 on createRecord retries and succeeds with same deterministic rkey",async()=>{
 const records=[];let posts=0;
 const fetchImpl=async(url,o)=>{
  if(url.endsWith("createSession"))return{ok:true,json:async()=>({did:"did:plc:abc",accessJwt:"access"})};
  records.push(JSON.parse(o.body).rkey);posts++;
  if(posts===1)return{ok:false,status:429,headers:{get:()=>null}};
  return{ok:true,json:async()=>({uri:receipt,cid:"cid-1"})};
 };
 const out=await publishBluesky({...args,fetchImpl,sleepImpl:async()=>{}});
 assert.equal(out.status,"publicado");assert.deepEqual(records,[records[0],records[0]]);
});
test("missing provider receipt fails closed",async()=>{
 const fetchImpl=async(url)=>({ok:true,json:async()=>url.endsWith("createSession")?{did:"did:plc:abc",accessJwt:"access"}:{uri:receipt}});
 await assert.rejects(publishBluesky({...args,fetchImpl}),/bluesky_receipt_missing/);
});
test("timeout on createRecord retries using same rkey",async()=>{
 let posts=0;const fetchImpl=async(url)=>{if(url.endsWith("createSession"))return{ok:true,json:async()=>({did:"did:plc:abc",accessJwt:"access"})};posts++;if(posts===1){let e=new Error("timed out");e.name="TimeoutError";throw e;}return{ok:true,json:async()=>({uri:receipt,cid:"cid"})};};
 const out=await publishBluesky({...args,fetchImpl,sleepImpl:async()=>{}});
 assert.equal(out.status,"publicado");assert.equal(posts,2);
});
