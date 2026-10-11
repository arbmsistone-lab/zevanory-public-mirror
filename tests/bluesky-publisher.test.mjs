import test from "node:test";
import assert from "node:assert/strict";
import {publishBluesky,blueskyPostText,graphemeCount,blueskyReady,deterministicTid,isTid} from "../worker/bluesky-publisher.mjs";
const env={BLUESKY_HANDLE:"zevanory.bsky.social",BLUESKY_APP_PASSWORD:"app-only-secret"};
const args={env,day:"2026-10-10",topic:"ZEV-IA-011",title:"Atendimento claro",hook:"Atendimento claro",value:"Organize a rotina com revisão humana.",cta:"Veja o guia",productUrl:"https://vendas.zevanory.api.br/comprar/ZEV-IA-011"};
const rkey=deterministicTid("2026-10-10","ZEV-IA-011");
const receipt="at://did:plc:abc/app.bsky.feed.post/"+rkey;
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
 assert.equal(result.status,"publicado");assert.equal(result.provider_post_id,rkey);assert.ok(isTid(rkey));assert.equal(calls[1].body.rkey,result.provider_post_id);
 assert.equal(calls[1].body.record.embed.external.uri,result.landing_url);
 assert.equal(calls[1].body.record.facets.find(f=>f.features[0].$type==="app.bsky.richtext.facet#link").features[0].uri,result.landing_url);
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

test("record key is a valid, deterministic TID anchored at the day's 19:00 Sao Paulo slot",()=>{
 const a=deterministicTid("2026-10-10","ZEV-IA-011");
 assert.ok(isTid(a));assert.equal(a.length,13);
 assert.equal(deterministicTid("2026-10-10","ZEV-IA-011"),a);
 assert.notEqual(deterministicTid("2026-10-10","ZEV-VEN-011"),a);
 assert.notEqual(deterministicTid("2026-10-11","ZEV-IA-011"),a);
 // decode: 53-bit microseconds + 10-bit clock id
 const S="234567abcdefghijklmnopqrstuvwxyz";let v=0n;for(const c of a)v=v*32n+BigInt(S.indexOf(c));
 const ms=Number((v>>10n)/1000n);
 assert.ok(Math.abs(ms-Date.parse("2026-10-10T22:00:00Z"))<1000);
 assert.ok(deterministicTid("2026-10-11","x")>deterministicTid("2026-10-10","x"));
 assert.throws(()=>deterministicTid("10/10/2026","x"));
});
test("regression: the legacy free-form rkey is never sent (PDS requires tid for posts)",async()=>{
 const calls=[];const fetchImpl=async(url,o)=>{calls.push(JSON.parse(o.body));return{ok:true,json:async()=>url.endsWith("createSession")?{did:"did:plc:abc",accessJwt:"access"}:{uri:receipt,cid:"c"}};};
 await publishBluesky({...args,fetchImpl});
 assert.ok(isTid(calls[1].rkey));assert.doesNotMatch(calls[1].rkey,/^zev-/);
 assert.deepEqual(calls[1].record.langs,["pt"]);
});
test("conflict on createRecord adopts the already-published deterministic record (no duplicate)",async()=>{
 const seen=[];
 const fetchImpl=async(url,o={})=>{seen.push(String(url));
  if(url.endsWith("createSession"))return{ok:true,json:async()=>({did:"did:plc:abc",accessJwt:"access"})};
  if(url.endsWith("createRecord"))return{ok:false,status:400,headers:{get:()=>null}};
  if(String(url).includes("getRecord")){assert.equal(o.method,"GET");assert.match(String(url),new RegExp("rkey="+rkey));return{ok:true,json:async()=>({uri:receipt,cid:"cid-9"})};}
  throw new Error("unexpected");};
 const out=await publishBluesky({...args,fetchImpl,sleepImpl:async()=>{}});
 assert.equal(out.status,"publicado");assert.equal(out.adopted,true);assert.equal(out.provider_post_id,rkey);
 assert.equal(seen.filter(u=>u.endsWith("createRecord")).length,1);
});
test("conflict without an existing record still fails closed",async()=>{
 const fetchImpl=async(url)=>{if(url.endsWith("createSession"))return{ok:true,json:async()=>({did:"did:plc:abc",accessJwt:"access"})};if(url.endsWith("createRecord"))return{ok:false,status:400,headers:{get:()=>null}};return{ok:false,status:400};};
 await assert.rejects(publishBluesky({...args,fetchImpl,sleepImpl:async()=>{}}),/bluesky_http_400/);
});

test("discovery hashtags are tag facets with exact byte ranges, inside 300 graphemes",async()=>{
 const calls=[];const fetchImpl=async(url,o)=>{calls.push({url,body:JSON.parse(o.body)});return{ok:true,json:async()=>url.endsWith("createSession")?{did:"did:plc:abc",accessJwt:"access"}:{uri:receipt,cid:"cid-1"}};};
 await publishBluesky({...args,hook:"Ação rápida é útil 👩‍💻".repeat(10),value:"é".repeat(400),fetchImpl});
 const rec=calls[1].body.record,bytes=new TextEncoder().encode(rec.text);
 assert.ok(graphemeCount(rec.text)<=300);
 const tags=rec.facets.filter(f=>f.features[0].$type==="app.bsky.richtext.facet#tag");
 assert.deepEqual(tags.map(f=>f.features[0].tag),["empreendedorismo","pequenosnegocios","ia"]);
 for(const f of tags)assert.equal(new TextDecoder().decode(bytes.slice(f.index.byteStart,f.index.byteEnd)),"#"+f.features[0].tag);
 const link=rec.facets.find(f=>f.features[0].$type==="app.bsky.richtext.facet#link");
 assert.equal(new TextDecoder().decode(bytes.slice(link.index.byteStart,link.index.byteEnd)),link.features[0].uri);
});
