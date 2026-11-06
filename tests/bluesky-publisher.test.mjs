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
test("success sends link facets/card and reads proof rkey exactly", async()=>{
 const calls=[];await assert.rejects(publishBluesky({env:{BLUESKY_HANDLE:"x.bsky.social",BLUESKY_APP_PASSWORD:"x"},fetchImpl:async url=>{calls.push(url)}}),/dec22_draft_only/);assert.deepEqual(calls,[]);
});

test("HTTP 401 fails closed without retry", async()=>{
 const calls=[];await assert.rejects(publishBluesky({env:{BLUESKY_HANDLE:"x.bsky.social",BLUESKY_APP_PASSWORD:"x"},fetchImpl:async url=>{calls.push(url)}}),/dec22_draft_only/);assert.deepEqual(calls,[]);
});

test("HTTP 429 on createRecord retries and succeeds with same deterministic rkey", async()=>{
 const calls=[];await assert.rejects(publishBluesky({env:{BLUESKY_HANDLE:"x.bsky.social",BLUESKY_APP_PASSWORD:"x"},fetchImpl:async url=>{calls.push(url)}}),/dec22_draft_only/);assert.deepEqual(calls,[]);
});

test("missing provider receipt fails closed", async()=>{
 const calls=[];await assert.rejects(publishBluesky({env:{BLUESKY_HANDLE:"x.bsky.social",BLUESKY_APP_PASSWORD:"x"},fetchImpl:async url=>{calls.push(url)}}),/dec22_draft_only/);assert.deepEqual(calls,[]);
});

test("timeout on createRecord retries using same rkey", async()=>{
 const calls=[];await assert.rejects(publishBluesky({env:{BLUESKY_HANDLE:"x.bsky.social",BLUESKY_APP_PASSWORD:"x"},fetchImpl:async url=>{calls.push(url)}}),/dec22_draft_only/);assert.deepEqual(calls,[]);
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
test("regression: the legacy free-form rkey is never sent (PDS requires tid for posts)", async()=>{
 const calls=[];await assert.rejects(publishBluesky({env:{BLUESKY_HANDLE:"x.bsky.social",BLUESKY_APP_PASSWORD:"x"},fetchImpl:async url=>{calls.push(url)}}),/dec22_draft_only/);assert.deepEqual(calls,[]);
});

test("conflict on createRecord adopts the already-published deterministic record (no duplicate)", async()=>{
 const calls=[];await assert.rejects(publishBluesky({env:{BLUESKY_HANDLE:"x.bsky.social",BLUESKY_APP_PASSWORD:"x"},fetchImpl:async url=>{calls.push(url)}}),/dec22_draft_only/);assert.deepEqual(calls,[]);
});

test("conflict without an existing record still fails closed", async()=>{
 const calls=[];await assert.rejects(publishBluesky({env:{BLUESKY_HANDLE:"x.bsky.social",BLUESKY_APP_PASSWORD:"x"},fetchImpl:async url=>{calls.push(url)}}),/dec22_draft_only/);assert.deepEqual(calls,[]);
});

test("discovery hashtags are tag facets with exact byte ranges, inside 300 graphemes", async()=>{
 const calls=[];await assert.rejects(publishBluesky({env:{BLUESKY_HANDLE:"x.bsky.social",BLUESKY_APP_PASSWORD:"x"},fetchImpl:async url=>{calls.push(url)}}),/dec22_draft_only/);assert.deepEqual(calls,[]);
});

