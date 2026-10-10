import test from "node:test";
import assert from "node:assert/strict";
import {publishBluesky,blueskyReady,blueskyPostText} from "../worker/bluesky-publisher.mjs";
test("no credential is a paused state, not an error",async()=>{assert.equal(blueskyReady({}),false);assert.deepEqual(await publishBluesky({env:{}}),{status:"aguardando credencial"});});
test("rejects off-domain purchase links",()=>assert.throws(()=>blueskyPostText({title:"a",productUrl:"https://example.com/comprar/a",day:"2026-10-10"})));
test("posts AT Protocol with UTM and external card",async()=>{
 const calls=[];const fetchImpl=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>url.endsWith("createSession")?{did:"did:plc:abc",accessJwt:"token"}:{uri:"at://did:plc:abc/app.bsky.feed.post/xyz",cid:"bafyabc"}}};
 const out=await publishBluesky({env:{BLUESKY_HANDLE:"zevanory.bsky.social",BLUESKY_APP_PASSWORD:"app-pass"},title:"Atendimento seguro",productUrl:"https://vendas.zevanory.api.br/comprar/ZEV-IA-011",day:"2026-10-10",fetchImpl});
 assert.equal(out.status,"publicado");assert.match(out.landing_url,/utm_source=bluesky/);assert.match(out.url,/bsky.app\/profile/);
 assert.equal(calls.length,2);assert.equal(calls[1].body.record.embed.external.uri,out.landing_url);assert.equal(calls[1].body.record.facets[0].features[0].uri,out.landing_url);
});
