import test from 'node:test';import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {CpSubscriberLedger} from '../worker/cp-durable-ledger.mjs';
import {handleCpDoWebhookCandidate,issueCpFormTokenCandidate,submitCpFormCandidate} from '../worker/cp-g03-g04-candidate.mjs';
function harness(){
 const db=new DatabaseSync(':memory:'),sql={exec(q,...args){
  const s=q.trim();
  if(/^SELECT\b/i.test(s))return {toArray:()=>db.prepare(s).all(...args)};
  if(/^CREATE\s+(?:TABLE|INDEX)/i.test(s)){db.exec(s);return {toArray:()=>[]}};
  db.prepare(s).run(...args);return {toArray:[]};
 }};
 const storage={sql,transactionSync(fn){db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}};
 const ledger=new CpSubscriberLedger(storage,'cp-do:synthetic-subscriber-abcdef');
 const hits=[];
 const stub={async fetch(url,init){hits.push({url,method:init.method});try{return Response.json(ledger.apply(JSON.parse(init.body)))}
 catch(e){return Response.json({error:e.code||'fail'},{status:e.status||503})}}};
 const env={HOTMART_HOTTOK:'TEST_TEST_TEST_HOTTOK_SECRET_123456',
  HOTMART_SERVICE_PRODUCT_IDS:'8704905',CP_DO_ROUTING_KEY:'TEST_TEST_TEST_CP_DO_ROUTING_KEY_123456789',
  CP_FORM_SIGNING_KEY:'TEST_TEST_TEST_CP_FORM_SIGNING_KEY_123456789',
  CP_SUBSCRIBER_DO:{idFromName(name){return name},get(){return stub}}};
 const data={version:'2.0.0',event:'PURCHASE_APPROVED',data:{product:{id:8704905},
  subscription:{subscriber:{code:'sub-000000001'}},purchase:{transaction:'HP-00000000001',recurrence_number:1,status:'APPROVED'},
  buyer:{email:'nobody@test.invalid'}}};
 function req({tok=env.HOTMART_HOTTOK,event=data.event,sub='sub-000000001',product=8704905}={}){
  return new Request('https://internal.example/hotmart?subscriber_id=attacker',{method:'POST',
   headers:{'x-hotmart-hottok':tok,'content-type':'application/json'},
   body:JSON.stringify({...data,event,data:{...data.data,product:{id:product},
    subscription:{subscriber:{code:sub}}}})});
 }
 return {db,ledger,env,hits,req};
}
test('G03 valid Hottok commits service invoice to a single DO and never uses KV',async()=>{
 const h=harness();
 const response=await handleCpDoWebhookCandidate(h.req(),h.env);
 assert.equal(response.status,202,await response.text());
 assert.equal(h.ledger.snapshot().event_count,1);
 assert.equal(h.ledger.snapshot().status,'active');
 assert.equal(h.ledger.snapshot().cycle,1);
 assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM cp_cycles").get().n,1);
 assert.equal(h.hits.length,1);
 assert.equal(h.hits[0].method,'POST');
});
test('G03 duplicate identical Hotmart event is idempotent: event ledger count unchanged',async()=>{
 const h=harness();await handleCpDoWebhookCandidate(h.req(),h.env);
 const x=await handleCpDoWebhookCandidate(h.req(),h.env);
 assert.equal(x.status,202);
 assert.equal((await x.json()).code,'duplicate_event');
 assert.equal(h.ledger.snapshot().event_count,1);
});
test('G03 bad Hottok and wrong product never open DO or send mail',async()=>{
 const h=harness();
 const r=await handleCpDoWebhookCandidate(h.req({tok:'bad'}),h.env);
 assert.equal(r.status,401);assert.equal(h.hits.length,0);
 const p=await handleCpDoWebhookCandidate(h.req({product:123}),h.env);
 assert.equal(p.status,403);assert.equal(h.hits.length,0);
});
test('G03 refund branch holds service pending reconciliation, never infers total',async()=>{
 const h=harness();
 await handleCpDoWebhookCandidate(h.req(),h.env);
 const r=await handleCpDoWebhookCandidate(h.req({event:'PURCHASE_REFUNDED'}),h.env);
 assert.equal(r.status,202);assert.equal(h.ledger.snapshot().status,'inactive');
 assert.equal(h.db.prepare("SELECT refund_type,state FROM cp_refund_events").get().refund_type,'requested');
});
test('G04 form token issued and consumed once atomically, no public KV index',async()=>{
 const h=harness();await handleCpDoWebhookCandidate(h.req(),h.env);
 const s='a'.repeat(64),exp=Date.now()+3600000;
 const issued=await issueCpFormTokenCandidate({opaqueRoutingId:s,cycle:1,expires_at_ms:exp,env:h.env,event_key:'form:issued-00000000001'});
 assert.equal(issued.delivery,'OUTBOX_NOT_CONNECTED');
 const sent=await submitCpFormCandidate({token:issued.token,env:h.env,form:{negocio:'Oficina',oferta:'revisao',periodo:'2026-11'},now:Date.now()});
 assert.equal(sent.status,202,await sent.text());
 assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM cp_form_submissions").get().n,1);
 const replay=await submitCpFormCandidate({token:issued.token,env:h.env,form:{negocio:'Changed'},now:Date.now()});
 assert.equal(replay.status,202);assert.equal((await replay.json()).code,'duplicate_event');
 assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM cp_form_submissions").get().n,1);
});
test('G04 corrupted signed token or expired must fail closed',async()=>{
 const h=harness();await handleCpDoWebhookCandidate(h.req(),h.env);
 const issued=await issueCpFormTokenCandidate({opaqueRoutingId:'a'.repeat(64),cycle:1,
  expires_at_ms:Date.now()+3600000,env:h.env,event_key:'form:issued-00000000001'});
 const bad=issued.token.slice(0,-2)+'aa';
 assert.equal((await submitCpFormCandidate({token:bad,env:h.env,form:{x:'a'}})).status,403);
 assert.equal((await submitCpFormCandidate({token:issued.token,env:h.env,form:{x:'a'},now:Date.now()+24*3600000})).status,403);
 assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM cp_form_submissions").get().n,0);
});
