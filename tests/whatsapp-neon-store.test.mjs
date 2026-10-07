import test from "node:test";
import assert from "node:assert/strict";
import { getWhatsappOpsStore, resetWhatsappOpsStoreMemoForTest } from "../worker/whatsapp-neon-store.mjs";
import { readWhatsappAuditObserve } from "../worker/whatsapp-onboarding.mjs";

function fakeSql(){
 const calls=[], values=new Map();
 return {calls,values,async query(text,params=[]){
  text=String(text); calls.push({text,params});
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

test("memoizes one store and one DDL query per DATABASE_URL",async()=>{
 resetWhatsappOpsStoreMemoForTest();
 const sql=fakeSql(),kv=fakeKv(),factory=()=>sql;
 const a=getWhatsappOpsStore({DATABASE_URL:"postgres://one",ZEVANORY_PRIVATE_ARTIFACTS:kv},factory);
 const b=getWhatsappOpsStore({DATABASE_URL:"postgres://one",ZEVANORY_PRIVATE_ARTIFACTS:kv},factory);
 assert.equal(a,b);
 await a.put("whatsapp:instant:last",'{"stage":"received"}',{expirationTtl:60});
 await b.put("whatsapp:observation:wamid.1","{}",{expirationTtl:60});
 const ddl=sql.calls.filter(x=>/create table if not exists/i.test(x.text));
 assert.equal(ddl.length,1);
 for(const table of["whatsapp_stage_events","whatsapp_observations","whatsapp_evidence","whatsapp_history"]) assert.match(ddl[0].text,new RegExp("create table if not exists "+table));
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
 assert.equal(kv.puts.length,0);
 assert.deepEqual(await store.get("whatsapp:observation:old",{type:"json"}),{legacy:true});
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
