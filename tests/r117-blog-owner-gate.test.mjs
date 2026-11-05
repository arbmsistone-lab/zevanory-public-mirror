import test from "node:test";
import assert from "node:assert/strict";
import {readTextNormalized} from "./helpers/text.mjs";
import {ensureDailyBlog,BLOG_DRAFT_KEY_PREFIX,BLOG_OWNER_APPROVAL_PREFIX,BLOG_TABLE_C_PRICES,renderBlogIndex,renderBlogArticle} from "../worker/multichannel-autonomy.mjs";
import {runAcquisitionEngine} from "../worker/acquisition-engine.mjs";
const day="2026-11-05",at=new Date("2026-11-05T12:35:00Z");
function fixture(){const m=new Map(),calls=[];return {m,calls,kv:{get:async k=>m.get(k)||null,put:async(k,v)=>{calls.push(["put",k]);m.set(k,String(v))}},fetch:async(u)=>{calls.push(["fetch",String(u)]);return {ok:true,status:200,json:async()=>({})}}};}
function approval(draft,change={}){return {approved:true,source:"owner",day,slug:draft.slug,digest:draft.digest,approvedAt:at.toISOString(),...change};}
test("R117 default OFF creates only private draft: no public article, index, daily marker, sitemap or IndexNow",async()=>{
 const f=fixture(),env={ZEVANORY_PRIVATE_ARTIFACTS:f.kv,INDEXNOW_KEY:"fake-public-key"};
 const out=await ensureDailyBlog(env,at,f.fetch);
 assert.equal(out.reason,"owner_gate_disabled");assert.equal(out.created.length,0);assert.equal(out.latest,null);
 assert.equal(out.draft.day,day);assert.equal(out.draft.digest.length,64);
 assert.equal(f.m.has(BLOG_DRAFT_KEY_PREFIX+day),true);
 assert.equal(f.m.has("zpc:blog:article:"+out.draft.slug),false);
 assert.equal(f.m.has("zpc:blog:daily:"+day),false);
 assert.equal(f.m.has("zpc:blog:index:v1"),false);
 assert.equal(f.calls.filter(x=>x[0]==="fetch").length,0);
 const index=await renderBlogIndex(env);assert.doesNotMatch(index,new RegExp(out.draft.slug));
});
test("R117 flag ON without explicit owner approval still cannot publish",async()=>{
 const f=fixture(),env={ZEVANORY_PRIVATE_ARTIFACTS:f.kv,BLOG_AUTOPUBLISH:"true"};
 const out=await ensureDailyBlog(env,at,f.fetch);
 assert.equal(out.reason,"awaiting_owner_approval");assert.equal(f.m.has("zpc:blog:index:v1"),false);
});
test("R117 rejects stale, mismatched and non-owner approval",async()=>{
 for(const bad of [{digest:"0".repeat(64)},{source:"cron"},{approved:false},{slug:"different"}]){
  const f=fixture(),env={ZEVANORY_PRIVATE_ARTIFACTS:f.kv,BLOG_AUTOPUBLISH:"true"};
  const out=await ensureDailyBlog(env,at,f.fetch);
  await f.kv.put(BLOG_OWNER_APPROVAL_PREFIX+day,JSON.stringify(approval(out.draft,bad)));
  const denied=await ensureDailyBlog(env,at,f.fetch);
  assert.equal(denied.reason,"awaiting_owner_approval");
  assert.equal(f.m.has("zpc:blog:index:v1"),false);
 }
});
test("R117 exact owner approval publishes once with Table C price and no checkout when sales closed",async()=>{
 const f=fixture(),env={ZEVANORY_PRIVATE_ARTIFACTS:f.kv,BLOG_AUTOPUBLISH:"true"};
 const first=await ensureDailyBlog(env,at,f.fetch);
 const privateArticle=JSON.parse(f.m.get(BLOG_DRAFT_KEY_PREFIX+day)).article;
 assert.equal(privateArticle.cta_url,null);assert.equal(privateArticle.publishedAt,null);
 assert.equal(privateArticle.tableCPrice,BLOG_TABLE_C_PRICES[privateArticle.product]);
 await f.kv.put(BLOG_OWNER_APPROVAL_PREFIX+day,JSON.stringify(approval(first.draft)));
 const published=await ensureDailyBlog(env,at,f.fetch);
 assert.equal(published.created.length,1);
 assert.equal(published.latest.tableCPrice,BLOG_TABLE_C_PRICES[published.latest.product]);
 const html=await renderBlogArticle(env,published.latest.slug,{salesOpen:false});
 assert.doesNotMatch(html,/\/comprar\//);
 const again=await ensureDailyBlog(env,new Date("2026-11-05T16:35:00Z"),f.fetch);
 assert.equal(again.reason,"already_published");assert.equal(again.created.length,0);
});
test("R117 P18, alerts and heartbeat cron paths untouched while acquisition records blog draft",async()=>{
 const src=readTextNormalized(new URL("../worker/cloudflare-worker.compat.mjs",import.meta.url));
 assert.match(src,/controller\?\.cron === "5,35 \* \* \* \*"/);
 assert.match(src,/runAcquisitionEngine\(normalized,new Date\(\)\)/);
 assert.match(src,/await syncBrandProfiles\(normalized\)/);
 assert.match(src,/runOwnerAlertDigest\(normalized\)/);
 assert.match(src,/zpc:cron:v1:hourly/);
 assert.match(src,/worker\.scheduled\(controller, normalized, ctx\)/);
 const f=fixture(),env={ZEVANORY_PRIVATE_ARTIFACTS:f.kv};
 const result=await runAcquisitionEngine(env,new Date('2026-11-05T23:35:00Z'),f.fetch);
 assert.equal(result.ok,true);
 assert.equal(result.outcomes.find(x=>x.channel==="blog")?.status,"rascunho");
 assert.equal(result.outcomes.some(x=>x.channel==="telegram"),true);
 assert.equal(result.outcomes.some(x=>x.channel==="bluesky"),true);
 assert.equal(f.m.has("zpc:blog:index:v1"),false);
});
