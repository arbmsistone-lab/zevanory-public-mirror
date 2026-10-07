import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { whatsappInboundSafety } from "../worker/whatsapp-inbound-safety.mjs";
import { whatsappStageRecorder, latestWhatsappStage } from "../worker/whatsapp-background.mjs";
import { converse, loadHistory, saveHistory, speechText, voiceReplyBody } from "../worker/whatsapp-conversation.mjs";
import { saveWhatsappObservation } from "../worker/voice-operational-audit.mjs";
import { getWhatsappOpsStore, resetWhatsappOpsStoreMemoForTest } from "../worker/whatsapp-neon-store.mjs";

function fakeKv(){
 const values=new Map(),puts=[];
 return {puts,values,
  async put(k,v,o){puts.push({k,v,o});values.set(k,String(v));},
  async get(k,o){const v=values.get(k)??null;if(v==null)return null;if(o==="json"||o?.type==="json"){try{return JSON.parse(v)}catch{return null}}return v;},
  async list({prefix="",limit=1000}={}){return{keys:[...values.keys()].filter(k=>k.startsWith(prefix)).sort().slice(0,limit).map(name=>({name})),list_complete:true}}
 };
}
function fakeSql(){
 const calls=[],values=new Map();
 return {calls,values,async query(text,params=[]){
  text=String(text);calls.push({text,params});
  if(/^insert into /i.test(text.trim())){values.set(String(params[0]),String(params[1]));return[];}
  if(/^select store_value/i.test(text.trim()))return values.has(String(params[0]))?[{store_value:values.get(String(params[0]))}]:[];
  if(/^select store_key/i.test(text.trim())){
   const prefix=String(params[0]),cursor=String(params[1]||""),n=Number(params[2]||1001);
   return [...values.keys()].filter(k=>k.startsWith(prefix)&&k>cursor).sort().slice(0,n).map(store_key=>({store_key}));
  }
  if(/^delete from/i.test(text.trim()))return[];
  return[];
 }};
}

const workerSource=readFileSync(new URL("../worker/cloudflare-worker.recovered.mjs",import.meta.url),"utf8");
const start=workerSource.indexOf("function whatsappTransport(item = {}) {");
const end=workerSource.indexOf("function extractWhatsappInboundMessages",start);
assert.ok(start>=0&&end>start,"reply source slice missing");
const replySource=workerSource.slice(start,end);

async function runReply({database=true,messageId="wamid.behavior"}={}){
 resetWhatsappOpsStoreMemoForTest();
 const kv=fakeKv(),sql=fakeSql();
 const ops=getWhatsappOpsStore(database?{DATABASE_URL:"postgres://behavior-"+messageId,ZEVANORY_PRIVATE_ARTIFACTS:kv}:{ZEVANORY_PRIVATE_ARTIFACTS:kv},()=>sql);
 const sandbox={
  process:{env:{WHATSAPP_VOICE_REPLY:"false",SALE_GLOBALLY_ENABLED:"false"}},
  globalThis:{__ZEVANORY_PRIVATE_KV__:kv,__ZEVANORY_WHATSAPP_OPS_STORE__:ops,__ZEVANORY_WHATSAPP_E2E_STORE__:ops,__ZEVANORY_WHATSAPP_RUNTIME__:{identity_verified:true,access_token:"test-token",phone_number_id:"1300972319774588",graph_version:"v26.0"}},
  whatsappInboundSafety,whatsappStageRecorder,
  loadWhatsappHistory:loadHistory,saveWhatsappHistory:saveHistory,
  converseWhatsapp:converse,runtimeAi:()=>null,
  OWNER_ESCALATION_RE:/a^/,alertOwnerNow:async()=>null,
  whatsappSpeechText:speechText,voiceReplyBody,
  saveWhatsappObservation,
  recordWhatsappEvidence:async(type,payload)=>{await ops.put("whatsapp-e2e/"+Date.now()+"-"+type,JSON.stringify(payload),{expirationTtl:60});return true;},
  fetch:async()=>new Response(JSON.stringify({messages:[{id:"wamid.out"}]}),{status:200,headers:{"content-type":"application/json"}}),
  Response,AbortSignal,URL,encodeURIComponent,Date,console,
  __name:(fn)=>fn
 };
 vm.createContext(sandbox);
 vm.runInContext(replySource,sandbox);
 const result=await sandbox.replyWhatsappConversation({from:"5511999991234",phone_number_id:"1300972319774588",type:"text",message_id:messageId},"quanto custa o combo?");
 return {result,kv,sql,ops};
}

const live=await runReply({database:true});
assert.equal(live.result.sent,true);
assert.equal(live.kv.puts.length,1,"KV must receive exactly the dedup put");
const neonKeys=[...live.sql.values.keys()];
assert.ok(neonKeys.some(k=>k.startsWith("whatsapp:instant:stage:")),"Neon stages missing");
assert.ok(neonKeys.some(k=>k.startsWith("wa:conv:")),"Neon history missing");
assert.ok(neonKeys.some(k=>k.startsWith("whatsapp:observation:")),"Neon observation missing");
const last=await latestWhatsappStage(live.ops);
assert.ok(last?.stage,"instant-status source must resolve a Neon stage");

const noDb=await runReply({database:false,messageId:"wamid.nodb"});
assert.equal(noDb.result.sent,true,"missing DATABASE_URL must not break customer response");
assert.equal(noDb.kv.puts.length,1,"without DB, KV still only receives dedup");

const before=13,after=live.kv.puts.length;
console.log(JSON.stringify({
 WHATSAPP_KV_WRITE_BUDGET:"PASS",
 before_minimum_writes_per_text_message:before,
 after_writes_per_text_message:after,
 reduction_percent:Number((((before-after)/before)*100).toFixed(1)),
 kv_remaining:"dedup_only",
 neon_stage:true,
 neon_history:true,
 neon_observation:true,
 instant_status_reads_neon:true,
 no_database_url_response_ok:true
}));
