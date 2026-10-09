import test from "node:test";
import assert from "node:assert/strict";
import { collectAutonomyHealth, deliverAutonomyAlerts, selectAutonomyAlerts } from "../worker/autonomy-health.mjs";
import { BLOG_INDEX_KEY, CHANNEL_STATE_KEY } from "../worker/multichannel-autonomy.mjs";
import { CREATIVE_AUTONOMY_FEED_KEY } from "../worker/creative-autonomy.mjs";

const kv=seed=>{const m=new Map(Object.entries(seed||{}));return{async get(k){return m.get(k)||null},async put(k,v){m.set(k,String(v))},m}};
test("evidence contains only provider accepted IDs and published https URLs",async()=>{const store=kv({[BLOG_INDEX_KEY]:JSON.stringify({articles:[{slug:"real-post",url:"https://zevanory.api.br/blog/real-post",publishedAt:"2026-10-07T20:00:00Z"}]}),[CHANNEL_STATE_KEY]:JSON.stringify({evidence:[{channel:"telegram",provider_post_id:"42",url:"https://t.me/zevanory/42",publishedAt:"2026-10-07T20:01:00Z"}]})});const out=await collectAutonomyHealth({ZEVANORY_PRIVATE_ARTIFACTS:store},new Date("2026-10-07T20:02:00Z"));assert.deepEqual(out.evidence.map(x=>[x.channel,x.provider_post_id,x.url]),[["blog","real-post","https://zevanory.api.br/blog/real-post"],["telegram","42","https://t.me/zevanory/42"]]);});
test("alerts are restricted to the four owner-worthy categories",()=>{const creativeFeed=[0,1,2].map(i=>({evaluated_at:`2026-10-07T20:0${i}:00Z`,compliance:80,status:"discarded",channel:"instagram"}));const out=selectAutonomyAlerts({channelState:{evidence:[{channel:"pinterest",error:"provider_http_503"}]},creativeFeed,events:[{type:"refund"},{type:"complaint"},{type:"ordinary_metric"}]});assert.deepEqual(new Set(out.map(x=>x.type)),new Set(["channel_down","compliance_rejected_3x","refund","complaint"]));});
test("delivery ignores every event outside the allowlist and deduplicates",async()=>{const store=kv(),calls=[];const env={ZEVANORY_PRIVATE_ARTIFACTS:store,RESEND_API_KEY:"secret"},payload={generatedAt:"2026-10-07T20:00:00Z",alerts:[{type:"refund",channel:"payments",reason:"confirmed"},{type:"ordinary_metric",channel:"blog",reason:"low reach"}]};const fetchImpl=async(_url,options)=>{calls.push(JSON.parse(options.body));return{ok:true}};assert.equal((await deliverAutonomyAlerts(env,payload,fetchImpl)).sent,1);assert.equal((await deliverAutonomyAlerts(env,payload,fetchImpl)).sent,0);assert.equal(calls.length,1);assert.match(calls[0].subject,/refund/);});

test("public evidence read does not write KV; the cron path still persists", async () => {
  const { collectAutonomyHealth, AUTONOMY_HEALTH_KEY } = await import("../worker/autonomy-health.mjs");
  const writes = [];
  const kv = { get: async () => null, put: async (k) => { writes.push(k); } };
  await collectAutonomyHealth({ ZEVANORY_PRIVATE_ARTIFACTS: kv }, new Date(), { persist: false });
  assert.deepEqual(writes, []);
  await collectAutonomyHealth({ ZEVANORY_PRIVATE_ARTIFACTS: kv }, new Date());
  assert.deepEqual(writes, [AUTONOMY_HEALTH_KEY]);
});
