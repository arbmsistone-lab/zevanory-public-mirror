import test from "node:test";
import assert from "node:assert/strict";
import {ensureDailyBlog,BLOG_OWNER_APPROVAL_PREFIX,BLOG_PUBLICATION_STAGE_PREFIX} from "../worker/multichannel-autonomy.mjs";
const at=new Date("2026-11-05T12:35:00Z"),day="2026-11-05";
function fixture(){
 const store=new Map(),writes=[];
 let failKey="";
 const kv={get:async(k)=>store.get(k)||null,put:async(k,v)=>{writes.push(k);store.set(k,String(v));if(k===failKey){failKey="";throw Error("simulated_crash_after_write");}}};
 const lock={acquire:async()=>({owned:true,id:"synthetic"}),release:async()=>{}};
 return {store,writes,kv,lock,fail(k){failKey=k}};
}
async function prepare(f){
 const env={ZEVANORY_PRIVATE_ARTIFACTS:f.kv,BLOG_AUTOPUBLISH:"false",BLOG_PUBLICATION_LOCK:f.lock};
 const first=await ensureDailyBlog(env,at,async()=>({ok:true}));
 const a={schema:"zpc.blog.owner-approval.v1",day,slug:first.draft.slug,digest:first.draft.digest,source:"owner",approved:true,approvedAt:at.toISOString(),proof:"session-passphrase-csrf-v1"};
 await f.kv.put(BLOG_OWNER_APPROVAL_PREFIX+day,JSON.stringify(a));
 env.BLOG_AUTOPUBLISH="true";
 return {env,slug:first.draft.slug};
}
test("R122 unconfigured atomic lock blocks every public write",async()=>{
 const f=fixture();const {env,slug}=await prepare(f);
 delete env.BLOG_PUBLICATION_LOCK;
 const a=await ensureDailyBlog(env,at);
 assert.equal(a.reason,"publication_lock_unavailable");
 assert.equal(f.store.has("zpc:blog:article:"+slug),false);
 assert.equal(f.store.has("zpc:blog:index:v1"),false);
});
test("R122 injected locked day blocks publish without article or index",async()=>{
 const f=fixture();const {env,slug}=await prepare(f);
 env.BLOG_PUBLICATION_LOCK={acquire:async()=>({owned:false}),release:async()=>{}};
 const out=await ensureDailyBlog(env,at);
 assert.equal(out.reason,"publication_locked");assert.equal(f.store.has("zpc:blog:article:"+slug),false);
});
test("R122 interruption after stage, article or index resumes exact same digest without duplicates",async()=>{
 for(const target of ["stage","article","index"]){
   const f=fixture(),{env,slug}=await prepare(f);
   const key={stage:BLOG_PUBLICATION_STAGE_PREFIX+day,article:"zpc:blog:article:"+slug,index:"zpc:blog:index:v1"}[target];
   f.fail(key);
   await assert.rejects(()=>ensureDailyBlog(env,at),/simulated_crash/);
   const recovered=await ensureDailyBlog(env,new Date(at.getTime()+60000));
   assert.equal(recovered.created.length,1,target);
   const index=JSON.parse(f.store.get("zpc:blog:index:v1"));
   assert.equal(index.articles.filter(x=>x.slug===slug).length,1,target);
   assert.equal(JSON.parse(f.store.get(BLOG_PUBLICATION_STAGE_PREFIX+day)).phase,"committed",target);
   assert.equal(JSON.parse(f.store.get("zpc:blog:daily:"+day)).slug,slug,target);
 }
});
test("R122 crash after visibility marker retries without duplicating public article",async()=>{
 const f=fixture(),{env,slug}=await prepare(f);
 f.fail("zpc:blog:daily:"+day);
 await assert.rejects(()=>ensureDailyBlog(env,at),/simulated_crash/);
 const out=await ensureDailyBlog(env,new Date(at.getTime()+60000));
 assert.equal(out.reason,"already_published");
 assert.equal(JSON.parse(f.store.get("zpc:blog:index:v1")).articles.filter(x=>x.slug===slug).length,1);
});
