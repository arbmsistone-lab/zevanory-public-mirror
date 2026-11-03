// NC-012: candidate SQLite DO fulfillment for CP families 4/5.
// Only durable local state. No KV, Resend, external AI, credentials or R2 writes.
export class CpWorkError extends Error {
 constructor(code,status=409){super(code);this.code=code;this.status=status;}
}
const keyOk=x=>typeof x==="string"&&/^[a-zA-Z0-9:_./-]{8,160}$/.test(x);
const cycleOk=x=>Number.isSafeInteger(x)&&x>=1&&x<=1200;
const hashOk=x=>typeof x==="string"&&/^[a-f0-9]{64}$/.test(x);
export class CpFulfillmentLedger {
 constructor(storage,ledger,canonicalId){
  this.storage=storage;this.sql=storage.sql;this.ledger=ledger;this.canonicalId=canonicalId;
  this.sql.exec("CREATE TABLE IF NOT EXISTS cp_work_events(event_key TEXT PRIMARY KEY,cycle INTEGER NOT NULL,kind TEXT NOT NULL,created_at_ms INTEGER NOT NULL)");
  this.sql.exec("CREATE TABLE IF NOT EXISTS cp_work_jobs(cycle INTEGER PRIMARY KEY,status TEXT NOT NULL CHECK(status IN ('queued','generating','retry','package_ready','dead')),attempts INTEGER NOT NULL CHECK(attempts>=0),due_at_ms INTEGER,lease_deadline_ms INTEGER,updated_at_ms INTEGER NOT NULL)");
  this.sql.exec("CREATE TABLE IF NOT EXISTS cp_package_objects(cycle INTEGER PRIMARY KEY,package_sha256 TEXT NOT NULL,blob_key TEXT NOT NULL UNIQUE,recorded_at_ms INTEGER NOT NULL)");
  this.sql.exec("CREATE TABLE IF NOT EXISTS cp_resend_outbox(cycle INTEGER PRIMARY KEY,provider_idempotency_key TEXT NOT NULL UNIQUE,status TEXT NOT NULL CHECK(status IN ('blocked','pending','uncertain','sent','canceled')),provider_receipt TEXT,created_at_ms INTEGER NOT NULL,CHECK(status!='sent' OR provider_receipt IS NOT NULL))");
  this.sql.exec("CREATE TABLE IF NOT EXISTS cp_owner_alert_outbox(cycle INTEGER PRIMARY KEY,status TEXT NOT NULL CHECK(status IN ('pending','sent')),reason TEXT NOT NULL,created_at_ms INTEGER NOT NULL)");
 }
 row(q,...params){return this.sql.exec(q,...params).toArray()[0]||null}
 current(cycle){return this.row("SELECT cycle,status,attempts,due_at_ms,lease_deadline_ms FROM cp_work_jobs WHERE cycle=?",cycle)}
 snapshot(){
  return {jobs:this.sql.exec("SELECT cycle,status,attempts,due_at_ms FROM cp_work_jobs ORDER BY cycle").toArray(),
   packages:this.sql.exec("SELECT cycle,package_sha256,blob_key FROM cp_package_objects ORDER BY cycle").toArray(),
   outbox:this.sql.exec("SELECT cycle,status,provider_idempotency_key,provider_receipt FROM cp_resend_outbox ORDER BY cycle").toArray(),
   alerts:this.sql.exec("SELECT cycle,status,reason FROM cp_owner_alert_outbox ORDER BY cycle").toArray()};
 }
 apply(input){
  if(!input||typeof input!=="object"||!cycleOk(input.cycle)||!keyOk(input.event_key)||
     !["enqueue","claim","failure","package_ready"].includes(input.kind)||
     ["email","buyer","subscriber_id","recipient","operator_id"].some(k=>k in input))
   throw new CpWorkError("invalid_work_intent",400);
  const now=input.now_ms??Date.now(),cycle=input.cycle;
  if(!Number.isSafeInteger(now)||now<=0)throw new CpWorkError("invalid_work_clock",400);
  return this.storage.transactionSync(()=>{
   const done=this.row("SELECT kind FROM cp_work_events WHERE event_key=?",input.event_key);
   if(done)return {ok:true,code:"duplicate_event",job:this.current(cycle)};
   const cur=this.ledger.current();
   if(cur.status!=="active"||cur.cycle!==cycle||
       !this.row("SELECT cycle FROM cp_cycles WHERE cycle=? AND status='approved'",cycle))
     throw new CpWorkError("payment_not_eligible",403);
   const state=this.current(cycle);
   if(input.kind==="enqueue"){
     if(state)return {ok:true,code:"already_queued",job:state};
     this.sql.exec("INSERT INTO cp_work_jobs(cycle,status,attempts,due_at_ms,lease_deadline_ms,updated_at_ms) VALUES(?,'queued',0,?,NULL,?)",cycle,now,now);
   }else if(input.kind==="claim"){
     if(!state||!["queued","retry"].includes(state.status)||state.due_at_ms>now)
       throw new CpWorkError("work_not_claimable");
     if(state.attempts>=12)throw new CpWorkError("work_retry_exhausted");
     this.sql.exec("UPDATE cp_work_jobs SET status='generating',attempts=attempts+1,due_at_ms=NULL,lease_deadline_ms=?,updated_at_ms=? WHERE cycle=?",now+300000,now,cycle);
   }else if(input.kind==="failure"){
     if(!state||state.status!=="generating"||state.lease_deadline_ms<now)
       throw new CpWorkError("work_lease_not_owned");
     if(state.attempts>=12){
       this.sql.exec("UPDATE cp_work_jobs SET status='dead',due_at_ms=NULL,lease_deadline_ms=NULL,updated_at_ms=? WHERE cycle=?",now,cycle);
       this.sql.exec("INSERT OR IGNORE INTO cp_owner_alert_outbox(cycle,status,reason,created_at_ms) VALUES(?,'pending','generation_retry_exhausted',?)",cycle,now);
     }else{
       const backoff=Math.min(21600000,Math.pow(2,Math.min(state.attempts-1,12))*300000);
       this.sql.exec("UPDATE cp_work_jobs SET status='retry',due_at_ms=?,lease_deadline_ms=NULL,updated_at_ms=? WHERE cycle=?",now+backoff,now,cycle);
     }
   }else if(input.kind==="package_ready"){
     // A second immutable version is a conflict, not an authorization failure.
     // The original checksum/outbox remain untouched and cannot be replaced.
     if(state?.status==="package_ready"||this.row("SELECT cycle FROM cp_package_objects WHERE cycle=?",cycle))
       throw new CpWorkError("package_already_recorded",409);
     if(!state||state.status!=="generating"||state.lease_deadline_ms<now||
         !hashOk(input.package_sha256)||!/^cp-pkg\/[a-f0-9]{64}\/[1-9]\d{0,3}\/[a-f0-9]{64}$/.test(input.blob_key)||
         !input.blob_key.endsWith(input.package_sha256))
       throw new CpWorkError("package_not_verified",403);
     // Worker must separately read back immutable blob before invoking this.
     this.sql.exec("INSERT INTO cp_package_objects(cycle,package_sha256,blob_key,recorded_at_ms) VALUES(?,?,?,?)",
       cycle,input.package_sha256,input.blob_key,now);
     this.sql.exec("UPDATE cp_work_jobs SET status='package_ready',due_at_ms=NULL,lease_deadline_ms=NULL,updated_at_ms=? WHERE cycle=?",now,cycle);
     this.sql.exec("INSERT OR IGNORE INTO cp_resend_outbox(cycle,provider_idempotency_key,status,created_at_ms) VALUES(?,?,'blocked',?)",
       cycle,this.canonicalId+"/cp-resend/"+cycle,now);
   }
   this.sql.exec("INSERT INTO cp_work_events(event_key,cycle,kind,created_at_ms) VALUES(?,?,?,?)",input.event_key,cycle,input.kind,now);
   return {ok:true,code:input.kind==="package_ready"?"OUTBOX_NOT_CONNECTED":"applied",job:this.current(cycle)};
  });
 }
}
