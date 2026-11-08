import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {ContentProntoSubscriberDO} from "../worker/cp-durable-ledger.mjs";
import {routeHotmartNc011,routeBriefingNc011,routePackageNc011,routeOperatorNc011} from "../worker/cp-nc011-routing.mjs";
import {issueCpFormTokenCandidate} from "../worker/cp-g03-g04-candidate.mjs";
import {CAMPANHA_CAMPOS,CP_BRIEFING_FIELDS} from "../worker/content-service.mjs";

const CP_ID="8704905",SECRET="synthetic-hottok-1234567890-valid";
function setup(){
 const db=new DatabaseSync(":memory:");
 const sql={exec(query,...args){
   const s=query.trim();
   if(/^SELECT\b/i.test(s))return {toArray:()=>db.prepare(s).all(...args)};
   if(/^CREATE\s+(TABLE|INDEX)\b/i.test(s)){db.exec(s);return {toArray:()=>[]}};
   db.prepare(s).run(...args);return {toArray:()=>[]};
 }};
 const alarm=[];
 const storage={sql,setAlarm:async at=>alarm.push(at),transactionSync(fn){db.exec("BEGIN IMMEDIATE");try{const value=fn();db.exec("COMMIT");return value}catch(error){db.exec("ROLLBACK");throw error}}};
 const obj=new ContentProntoSubscriberDO({id:{toString:()=>("ab".repeat(32))},storage});
 const writes=[];
 // NC-989-04: o postback recalcula o balde de vendas pela listagem do KV (API real do Workers KV).
 const kv={get:async k=>null,put:async(k,v)=>{if(k.startsWith("zpc:cp:"))throw Error("CP_KV_WRITE");writes.push(k)},delete:async(k)=>{throw Error("KV_DELETE_FORBIDDEN")},list:async()=>({keys:[],list_complete:true})};
 const env={HOTMART_HOTTOK:SECRET,HOTMART_SERVICE_PRODUCT_IDS:CP_ID,CP_FORM_SIGNING_KEY:"synthetic-form-signing-key-123456789",CP_DO_ROUTING_KEY:"synthetic-do-routing-key-123456789",ZEVANORY_PRIVATE_ARTIFACTS:kv,
   CP_SUBSCRIBER_DO:{idFromName:name=>name,get:()=>({fetch:(url,init)=>obj.fetch(new Request(url,init))})}};
 const post=(productId,txn,event="PURCHASE_APPROVED")=>new Request("https://zevanory.api.br/api/webhooks/hotmart",{method:"POST",headers:{"x-hotmart-hottok":SECRET,"content-type":"application/json"},body:JSON.stringify({event,version:"2.0.0",data:{
  product:{id:productId,name:productId===CP_ID?"ZEVANORY Conteúdo Pronto":"ZEVANORY IA na Prática"},
  subscription:{subscriber:{code:"subscriber-valid-123456"}},
  purchase:{transaction:txn,recurrence_number:1,status:"APPROVED",price:{value:97}}}})});
 return {db,obj,env,post,writes,alarm};
}
test("NC013 C1 genuine digital event remains readable once and never creates CP keys",async()=>{
 const h=setup(),r=await routeHotmartNc011(h.post("8704733","DIGITAL-001"),h.env);
 assert.equal(r.status,200);
 const body=await r.json();
 assert.equal(body.scope,"digital_product");
 assert.ok(h.writes.some(k=>k.startsWith("zpc:sales:v1:ev:"))); // NC-989-01: evento imutável (fonte); o resumo é projeção
 assert.equal(h.writes.some(k=>k.startsWith("zpc:cp:")),false);
});
test("NC013 C1 malformed Hotmart body and missing valid Hottok cannot reach digital ledger",async()=>{
 const h=setup();
 const bad=new Request("https://zevanory.api.br/api/webhooks/hotmart",{method:"POST",headers:{"x-hotmart-hottok":SECRET},body:"{bad"});
 assert.equal((await routeHotmartNc011(bad,h.env)).status,400);
 const unauthorized=h.post("8704733","DIGITAL-002");unauthorized.headers.set("x-hotmart-hottok","wrong");
 assert.equal((await routeHotmartNc011(unauthorized,h.env)).status,401);
 assert.equal(h.writes.length,0);
});
test("NC013 C3 form missing campaign returns 400 without consuming token or enqueuing work",async()=>{
 const h=setup();
 assert.equal((await routeHotmartNc011(h.post(CP_ID,"CP-001"),h.env)).status,202);
 const issued=await issueCpFormTokenCandidate({opaqueRoutingId:"a".repeat(64),cycle:1,expires_at_ms:Date.now()+600000,env:h.env,event_key:"form:issued:nc013-001"});
 assert.ok(issued.token);
 const url="https://zevanory.api.br/conteudo-pronto/briefing?t="+encodeURIComponent(issued.token);
 const fields=new URLSearchParams();
 for(const [id] of CP_BRIEFING_FIELDS)fields.set(id,"atendimento comprovado e local");
 const response=await routeBriefingNc011(new Request(url,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:fields}),h.env);
 assert.equal(response.status,400);
 assert.equal(h.obj.fulfillment.snapshot().jobs.length,0);
 assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM cp_form_submissions").get().n,0);
 const validLink=await routeBriefingNc011(new Request(url),h.env);
 assert.equal(validLink.status,200);
});
test("NC013 C3 renewed cycle requires a new campaign and cannot auto-send a package",async()=>{
 const h=setup();
 h.obj.ledger.apply({kind:"approved",cycle:1,event_key:"approved:nc013:001"});
 h.obj.ledger.apply({kind:"approved",cycle:2,event_key:"approved:nc013:002"});
 assert.equal(h.obj.ledger.current().cycle,2);
 assert.equal(h.obj.fulfillment.snapshot().jobs.length,0);
 assert.equal(h.obj.fulfillment.snapshot().outbox.length,0);
 const token=await issueCpFormTokenCandidate({opaqueRoutingId:"b".repeat(64),cycle:2,expires_at_ms:Date.now()+600000,env:h.env,event_key:"form:issued:nc013-002"});
 assert.ok(token.token);
 assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM cp_form_submissions WHERE cycle=2").get().n,0);
});
test("NC013 C3 packages and operator endpoints remain blocked before Resend/R2 integration",()=>{
 const h=setup();
 assert.equal(routePackageNc011().status,503);
 assert.equal(routeOperatorNc011().status,503);
 assert.equal(h.obj.fulfillment.snapshot().outbox.length,0);
 assert.equal(h.writes.length,0);
});
