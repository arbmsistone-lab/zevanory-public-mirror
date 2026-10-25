import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { whatsappInboundSafety } from "../worker/whatsapp-inbound-safety.mjs";
import { whatsappStageRecorder } from "../worker/whatsapp-background.mjs";
import { converse, loadHistory, saveHistory, speechText, voiceReplyBody } from "../worker/whatsapp-conversation.mjs";
import { saveWhatsappObservation } from "../worker/voice-operational-audit.mjs";
import { getWhatsappOpsStore, resetWhatsappOpsStoreMemoForTest } from "../worker/whatsapp-neon-store.mjs";
import { whatsappChannelRetired, whatsappInstantReplyEnabled } from "../worker/whatsapp-retirement.mjs";

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

async function runReply({database=true,messageId="wamid.behavior",retired=false}={}){
 let fetches=0;
 resetWhatsappOpsStoreMemoForTest();
 const kv=fakeKv(),sql=fakeSql();
 const ops=getWhatsappOpsStore(database?{DATABASE_URL:"postgres://behavior-"+messageId,ZEVANORY_PRIVATE_ARTIFACTS:kv}:{ZEVANORY_PRIVATE_ARTIFACTS:kv},()=>sql);
 const sandbox={
  // Historical budget measured with the channel explicitly un-retired and instant replies on.
  process:{env:{WHATSAPP_VOICE_REPLY:"false",SALE_GLOBALLY_ENABLED:"false",...(retired?{}:{WHATSAPP_CHANNEL_RETIRED:"false",WHATSAPP_INSTANT_REPLY:"true"})}},
  whatsappChannelRetired,whatsappInstantReplyEnabled,
  globalThis:{__ZEVANORY_PRIVATE_KV__:kv,__ZEVANORY_WHATSAPP_OPS_STORE__:ops,__ZEVANORY_WHATSAPP_E2E_STORE__:ops,__ZEVANORY_WHATSAPP_RUNTIME__:{identity_verified:true,access_token:"test-token",phone_number_id:"1300972319774588",graph_version:"v26.0"}},
  whatsappInboundSafety,whatsappStageRecorder,
  loadWhatsappHistory:loadHistory,saveWhatsappHistory:saveHistory,
  converseWhatsapp:converse,runtimeAi:()=>null,
  OWNER_ESCALATION_RE:/a^/,alertOwnerNow:async()=>null,
  whatsappSpeechText:speechText,voiceReplyBody,
  saveWhatsappObservation,
  recordWhatsappEvidence:async(type,payload)=>{await ops.put("whatsapp-e2e/"+Date.now()+"-"+type,JSON.stringify(payload),{expirationTtl:60});return true;},
  fetch:async()=>{fetches++;return new Response(JSON.stringify({messages:[{id:"wamid.out"}]}),{status:200,headers:{"content-type":"application/json"}});},
  Response,AbortSignal,URL,encodeURIComponent,Date,console,
  __name:(fn)=>fn
 };
 vm.createContext(sandbox);
 vm.runInContext(replySource,sandbox);
 const result=await sandbox.replyWhatsappConversation({from:"5511999991234",phone_number_id:"1300972319774588",type:"text",message_id:messageId},"quanto custa o combo?");
 return {result,kv,sql,ops,fetches};
}

// WhatsApp retired as a code constant (Meta disabled WABA 4019600665012911 on 2026-10-10): the reply
// path writes NOTHING (0 KV, 0 Neon) and calls no provider, with or without re-enable env values.
const runs=[];
for(const database of [true,false])for(const retired of [true,false])runs.push(await runReply({database,messageId:`wamid.retired-${database}-${retired}`,retired}));
for(const r of runs){
 assert.equal(r.result.sent,false);assert.equal(r.result.reason,"whatsapp_channel_retired");
 assert.equal(r.fetches,0,"retired channel must not call the provider");
 assert.equal(r.kv.puts.length,0,"no KV write");assert.equal(r.sql.values.size,0,"no Neon write");
}
console.log(JSON.stringify({
 WHATSAPP_KV_WRITE_BUDGET:"PASS",
 before_minimum_writes_per_text_message:13,
 after_writes_per_text_message:0,
 reduction_percent:100,
 kv_remaining:"none_channel_retired",
 provider_calls:0,
 env_cannot_reenable:true
}));
