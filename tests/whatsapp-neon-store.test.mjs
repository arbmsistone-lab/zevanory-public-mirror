import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { getWhatsappOpsStore, publishWhatsappOpsStats, resetWhatsappOpsStoreMemoForTest, WHATSAPP_OPS_STATS_KEY } from "../worker/whatsapp-neon-store.mjs";
import { readWhatsappAuditObserve } from "../worker/whatsapp-onboarding.mjs";

function fakeSql(statsRows=[]){
 const calls=[], values=new Map();
 return {calls,values,async query(text,params=[]){
  text=String(text); calls.push({text,params});
  if(/^select 'whatsapp_stage_events' as table_name/i.test(text.trim())) return statsRows;
  if(/^insert into /i.test(text.trim())){ values.set(String(params[0]),String(params[1])); return []; }
  if(/^select store_value/i.test(text.trim())) return values.has(String(params[0])) ? [{store_value:values.get(String(params[0]))}] : [];
  if(/^select store_key/i.test(text.trim())){
   const prefix=String(params[0]),cursor=String(params[1]||""),n=Number(params[2]||1001);
   return [...values.keys()].filter(k=>k.startsWith(prefix)&&k>cursor).sort().slice(0,n).map(store_key=>({store_key}));
  }
  if(/^delete from/i.test(text.trim())) return [];
  return [];
 }};
}
function fakeKv(seed={}){
 const values=new Map(Object.entries(seed)), puts=[];
 return {values,puts,
  async put(k,v,o){puts.push({k,v,o});values.set(k,String(v));},
  async get(k,o){const v=values.get(k)??null;if(v==null)return null;if(o==="json"||o?.type==="json"){try{return JSON.parse(v)}catch{return null}}return v;},
  async list({prefix="",limit=1000}={}){return{keys:[...values.keys()].filter(k=>k.startsWith(prefix)).sort().slice(0,limit).map(name=>({name})),list_complete:true}}
 };
}

test("memoizes one store and runs Neon-compatible single-statement DDL once per DATABASE_URL",async()=>{
 resetWhatsappOpsStoreMemoForTest();
 const sql=fakeSql(),kv=fakeKv(),factory=()=>sql;
 const a=getWhatsappOpsStore({DATABASE_URL:"postgres://one",ZEVANORY_PRIVATE_ARTIFACTS:kv},factory);
 const b=getWhatsappOpsStore({DATABASE_URL:"postgres://one",ZEVANORY_PRIVATE_ARTIFACTS:kv},factory);
 assert.equal(a,b);
 await a.put("whatsapp:instant:last",'{"stage":"received"}',{expirationTtl:60});
 await b.put("whatsapp:observation:wamid.1","{}",{expirationTtl:60});
 const ddl=sql.calls.filter(x=>/^(create table|create index) if not exists/i.test(x.text.trim()));
 assert.equal(ddl.length,12);
 assert.equal(ddl.every(x=>!x.text.includes(";")),true);
 for(const table of["whatsapp_stage_events","whatsapp_observations","whatsapp_evidence","whatsapp_history"]){
  assert.equal(ddl.filter(x=>x.text.includes(table)).length,3);
 }
 await a.get("whatsapp:instant:last");
 assert.equal(sql.calls.filter(x=>/^(create table|create index) if not exists/i.test(x.text.trim())).length,12);
});

test("writes operational records only to Neon and reads historical KV as fallback",async()=>{
 resetWhatsappOpsStoreMemoForTest();
 const legacy={stage:"legacy"},kv=fakeKv({"whatsapp:instant:last":JSON.stringify(legacy)}),sql=fakeSql();
 const store=getWhatsappOpsStore({DATABASE_URL:"postgres://two",ZEVANORY_PRIVATE_ARTIFACTS:kv},()=>sql);
 assert.deepEqual(await store.get("whatsapp:instant:last",{type:"json"}),legacy);
 await store.put("whatsapp:instant:last",'{"stage":"fresh"}',{expirationTtl:60});
 assert.deepEqual(await store.get("whatsapp:instant:last",{type:"json"}),{stage:"fresh"});
 assert.equal(kv.puts.length,0);
});

test("without DATABASE_URL operational writes are no-op and legacy reads remain available",async()=>{
 resetWhatsappOpsStoreMemoForTest();
 const kv=fakeKv({"whatsapp:observation:old":'{"legacy":true}'});
 const store=getWhatsappOpsStore({ZEVANORY_PRIVATE_ARTIFACTS:kv});
 await store.put("whatsapp:observation:new","{}",{expirationTtl:60});
 assert.equal(await publishWhatsappOpsStats(store,kv,"2026-10-07T17:01:00.000Z"),null);
 assert.equal(kv.puts.length,0);
 assert.deepEqual(await store.get("whatsapp:observation:old",{type:"json"}),{legacy:true});
});

test("hourly stats publish only counts and timestamps to KV for three days",async()=>{
 resetWhatsappOpsStoreMemoForTest();
 const sql=fakeSql([
  {table_name:"whatsapp_stage_events",row_count:"4",max_updated_at:"2026-10-07T17:00:00.000Z"},
  {table_name:"whatsapp_history",row_count:"3",max_updated_at:"2026-10-07T16:59:00.000Z"},
  {table_name:"whatsapp_observations",row_count:"2",max_updated_at:null},
  {table_name:"whatsapp_evidence",row_count:"1",max_updated_at:"2026-10-07T16:58:00.000Z"}
 ]),kv=fakeKv();
 const store=getWhatsappOpsStore({DATABASE_URL:"postgres://stats",ZEVANORY_PRIVATE_ARTIFACTS:kv},()=>sql);
 await store.cleanupExpired();
 const payload=await publishWhatsappOpsStats(store,kv,"2026-10-07T17:01:00.000Z");
 assert.deepEqual(payload,{
  generatedAt:"2026-10-07T17:01:00.000Z",
  tables:{
   whatsapp_stage_events:{count:4,max_updated_at:"2026-10-07T17:00:00.000Z"},
   whatsapp_observations:{count:2,max_updated_at:null},
   whatsapp_evidence:{count:1,max_updated_at:"2026-10-07T16:58:00.000Z"},
   whatsapp_history:{count:3,max_updated_at:"2026-10-07T16:59:00.000Z"}
  }
 });
 assert.equal(kv.puts.length,1);
 assert.equal(kv.puts[0].k,WHATSAPP_OPS_STATS_KEY);
 assert.deepEqual(kv.puts[0].o,{expirationTtl:259200});
 assert.deepEqual(JSON.parse(kv.puts[0].v),payload);
 assert.equal(sql.calls.filter(call=>/^select 'whatsapp_stage_events' as table_name/i.test(call.text.trim())).length,1);
 for(const table of["whatsapp_stage_events","whatsapp_history","whatsapp_observations","whatsapp_evidence"]) assert.match(sql.calls.at(-1).text,new RegExp(table));
});

test("audit-observe reads observation and history from Neon",async()=>{
 resetWhatsappOpsStoreMemoForTest();
 const recipient="5511999991234",sql=fakeSql(),kv=fakeKv();
 const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(recipient));
 const hash=[...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,"0")).join("");
 const env={DATABASE_URL:"postgres://audit-observe",ZEVANORY_PRIVATE_ARTIFACTS:kv};
 const store=getWhatsappOpsStore(env,()=>sql);
 await store.put("whatsapp:observation:wamid.audit",JSON.stringify({inbound_message_id:"wamid.audit",contact_hash:hash,at:"2026-10-07T15:00:00Z"}),{expirationTtl:60});
 await store.put("wa:conv:"+hash,JSON.stringify([{r:"u",t:"teste"}]),{expirationTtl:60});
 const body=await readWhatsappAuditObserve(env,()=>sql,{recipient,recipient_suffix:"1234"});
 assert.equal(body.observations[0].inbound_message_id,"wamid.audit");
 assert.deepEqual(body.history,[{r:"u",t:"teste"}]);
 assert.equal(kv.puts.length,0);
});

test("live proof refreshes stats through a private token and then reads the KV artifact",async()=>{
 const worker=await readFile(new URL("../worker/cloudflare-worker.recovered.mjs",import.meta.url),"utf8");
 const workflow=await readFile(new URL("../.github/workflows/whatsapp-neon-live-proof.yml",import.meta.url),"utf8");
 assert.match(worker,/POST[\s\S]*\/api\/internal\/whatsapp\/stats-refresh/);
 assert.match(worker,/x-certification-e2e-token/);
 assert.match(worker,/publishWhatsappOpsStats\(globalThis\.__ZEVANORY_WHATSAPP_OPS_STORE__, env\.ZEVANORY_PRIVATE_ARTIFACTS\)/);
 assert.match(workflow,/secrets\.CERTIFICATION_E2E_TOKEN/);
 assert.match(workflow,/POST https:\/\/zevanory\.api\.br\/api\/internal\/whatsapp\/stats-refresh/);
 assert.match(workflow,/storage\/kv\/namespaces\/\$KV_NAMESPACE_ID\/values\/zpc-whatsapp-ops:v1:stats/);
 assert.doesNotMatch(workflow,/DATABASE_URL/);
});
