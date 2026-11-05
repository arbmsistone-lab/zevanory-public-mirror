import test from "node:test";
import assert from "node:assert/strict";
import {readTextNormalized} from "./helpers/text.mjs";
import {ensureDailyBlog,BLOG_DRAFT_KEY_PREFIX,BLOG_OWNER_APPROVAL_PREFIX,BLOG_TABLE_C_PRICES,renderBlogIndex} from "../worker/multichannel-autonomy.mjs";
import {runAcquisitionEngine} from "../worker/acquisition-engine.mjs";
const at=new Date("2026-11-05T12:35:00Z"),day="2026-11-05";
const f=()=>{const data=new Map(),calls=[];return {data,calls,kv:{get:async k=>data.get(k)||null,put:async(k,v)=>{calls.push(k);data.set(k,String(v))}},fetch:async()=>{calls.push("indexnow");return {ok:true}}}};
const allowed=k=>k.startsWith(BLOG_DRAFT_KEY_PREFIX);
test("R123 only saves private draft with OFF, never article/index/marker/IndexNow",async()=>{
 const x=f(),out=await ensureDailyBlog({ZEVANORY_PRIVATE_ARTIFACTS:x.kv,INDEXNOW_KEY:"simulated"},at,x.fetch);
 assert.equal(out.reason,"draft_only_publication_disabled");assert.equal(out.created.length,0);assert.equal(out.draft.digest.length,64);
 assert.ok(x.calls.length>0 && x.calls.every(allowed));assert.equal(x.data.has("zpc:blog:index:v1"),false);
 assert.equal(x.data.has("zpc:blog:article:"+out.draft.slug),false);assert.equal(x.data.has("zpc:blog:daily:"+day),false);
});
test("R123 BLOG_AUTOPUBLISH=true is powerless; forged owner approval is powerless",async()=>{
 const x=f(),env={ZEVANORY_PRIVATE_ARTIFACTS:x.kv,BLOG_AUTOPUBLISH:"true",INDEXNOW_KEY:"fake"};
 const draft=await ensureDailyBlog(env,at,x.fetch);
 await x.kv.put(BLOG_OWNER_APPROVAL_PREFIX+day,JSON.stringify({approved:true,source:"owner",proof:"session-passphrase-csrf-v1",digest:draft.draft.digest,day,slug:draft.draft.slug,approvedAt:at.toISOString()}));
 x.calls.length=0;const next=await ensureDailyBlog(env,at,x.fetch);
 assert.equal(next.reason,"draft_only_publication_disabled");assert.deepEqual(next.created,[]);
 assert.ok(x.calls.every(allowed),"no public writes, even with forged approval");
});
test("R123 existing public index never modified by draft-only path",async()=>{
 const x=f(),existing={schema:"zevanory.blog-daily/v1",articles:[{slug:"historical",body:"preserve"}]};
 x.data.set("zpc:blog:index:v1",JSON.stringify(existing));
 await ensureDailyBlog({ZEVANORY_PRIVATE_ARTIFACTS:x.kv,BLOG_AUTOPUBLISH:"true"},at,x.fetch);
 assert.deepEqual(JSON.parse(x.data.get("zpc:blog:index:v1")),existing);
 assert.doesNotMatch(await renderBlogIndex({ZEVANORY_PRIVATE_ARTIFACTS:x.kv}),/zpc:blog:draft:/);
});
test("R123 draft metadata preserves canonical Table C without checkout link",async()=>{
 const x=f(),out=await ensureDailyBlog({ZEVANORY_PRIVATE_ARTIFACTS:x.kv},at,x.fetch);
 const row=JSON.parse(x.data.get(BLOG_DRAFT_KEY_PREFIX+day));
 assert.equal(row.article.tableCPrice,BLOG_TABLE_C_PRICES[row.article.product]);
 assert.equal(row.article.cta_url,null);assert.equal(row.article.publishedAt,null);assert.equal(row.article.status,"pending_owner_approval");
});
test("R123 scheduled acquisition still creates draft and no published blog entry",async()=>{
 const x=f(),out=await runAcquisitionEngine({ZEVANORY_PRIVATE_ARTIFACTS:x.kv,BLOG_AUTOPUBLISH:"true"},new Date("2026-11-05T23:35:00Z"),x.fetch);
 assert.equal(out.ok,true);assert.equal(out.outcomes.find(o=>o.channel==="blog")?.status,"rascunho");
 assert.equal(x.calls.some(k=>k.startsWith("zpc:blog:article:")||k==="zpc:blog:index:v1"||k.startsWith("zpc:blog:daily:")||k==="indexnow"),false);
});
