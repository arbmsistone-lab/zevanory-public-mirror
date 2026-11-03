import {CpFulfillmentLedger,CpWorkError} from "./cp-nc012-fulfillment.mjs";
import {CpCampaignLedger,CpCampaignError} from "./cp-nc014-campaign.mjs";
// ZEVANORY NC-007 / ADR-CP-001: DRAFT-only SQLite Durable Object ledger.
// NOT connected to the live webhook/cron/operator/refund paths. Do not deploy.
// The canonical key is resolved SERVER-SIDE by the Worker (never from request JSON).
const ALLOWED = new Set(["approved","queue_delivery","refund","operator_stop","provider_receipt","provider_uncertain","form_token_issued","form_submitted","refund_review"]);
const validEvent = s => typeof s==="string" && /^[a-zA-Z0-9:/._-]{12,180}$/.test(s);
const validCycle = n => Number.isInteger(n) && n>0 && n<=1200;
const validVersion = n => Number.isInteger(n) && n>=0 && n<=Number.MAX_SAFE_INTEGER-1;
export class CpTransitionError extends Error {
 constructor(code,status=409){super(code);this.code=code;this.status=status;}
}
// Storage needs sql.exec(query,...args) and transactionSync(()=>syncWrites).
// SQL never stores a buyer's email, name or plaintext transaction ID.
export class CpSubscriberLedger {
 constructor(storage,canonicalId) {
  if(!storage?.sql?.exec || !storage?.transactionSync)throw new Error("cp_sqlite_unavailable");
  if(typeof canonicalId!=="string"||!/^cp-do:[a-zA-Z0-9_-]{12,180}$/.test(canonicalId))throw new Error("cp_server_instance_required");
  this.storage=storage;this.sql=storage.sql;this.canonicalId=canonicalId;
  this.sql.exec(`CREATE TABLE IF NOT EXISTS subscriber_state(
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    version INTEGER NOT NULL CHECK(version>=0),
    status TEXT NOT NULL CHECK(status IN ('absent','active','inactive','refunded')),
    cycle INTEGER NOT NULL DEFAULT 0 CHECK(cycle>=0),
    delivered_cycle INTEGER NOT NULL DEFAULT 0 CHECK(delivered_cycle>=0),
    updated_at TEXT NOT NULL
   )`);
  this.sql.exec(`CREATE TABLE IF NOT EXISTS cp_event_ledger(
    event_key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    cycle INTEGER NOT NULL,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL
   )`);
  this.sql.exec(`CREATE TABLE IF NOT EXISTS cp_outbox(
    outbox_key TEXT PRIMARY KEY,
    event_key TEXT NOT NULL REFERENCES cp_event_ledger(event_key),
    cycle INTEGER NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK(status IN ('pending','uncertain','sent','canceled')),
    provider_idempotency_key TEXT NOT NULL UNIQUE,
    receipt TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
   )`);
  this.sql.exec(`CREATE TABLE IF NOT EXISTS cp_refunds(
    cycle INTEGER PRIMARY KEY,
    event_key TEXT NOT NULL,
    refunded_at TEXT NOT NULL
   )`);
  // G02: normalized records retained separately from customer identity/PII.
  this.sql.exec(`CREATE TABLE IF NOT EXISTS cp_cycles(
   cycle INTEGER PRIMARY KEY CHECK(cycle>0),
   approved_at_ms INTEGER,
   release_at_ms INTEGER,
   status TEXT NOT NULL CHECK(status IN ('approved','refunded','partially_refunded','canceled')),
   created_at TEXT NOT NULL,
   updated_at TEXT NOT NULL,
   CHECK(release_at_ms IS NULL OR (approved_at_ms IS NOT NULL AND release_at_ms>=approved_at_ms))
  )`);
  this.sql.exec(`CREATE TABLE IF NOT EXISTS cp_credits(
   cycle INTEGER PRIMARY KEY CHECK(cycle>0),
   source_event_key TEXT NOT NULL,
   status TEXT NOT NULL CHECK(status IN ('available','used','refunded')),
   updated_at TEXT NOT NULL
  )`);
  this.sql.exec(`CREATE TABLE IF NOT EXISTS cp_refund_events(
   event_key TEXT PRIMARY KEY,
   cycle INTEGER NOT NULL,
   refund_type TEXT NOT NULL CHECK(refund_type IN ('partial','total','chargeback','protest','requested')),
   state TEXT NOT NULL CHECK(state IN ('pending','confirmed','reversed')),
   created_at TEXT NOT NULL
  )`);
  this.sql.exec(`CREATE TABLE IF NOT EXISTS cp_regen_jobs(
   job_key TEXT PRIMARY KEY,
   cycle INTEGER NOT NULL,
   source_package_sha256 TEXT,
   candidate_sha256 TEXT,
   status TEXT NOT NULL CHECK(status IN ('blocked','queued','uncertain','accepted','delivered','dead')),
   updated_at TEXT NOT NULL
  )`);
  this.sql.exec(`CREATE TABLE IF NOT EXISTS cp_delivery_receipts(
   receipt_key TEXT PRIMARY KEY,
   cycle INTEGER NOT NULL,
   provider_receipt TEXT NOT NULL,
   package_sha256 TEXT,
   status TEXT NOT NULL CHECK(status IN ('accepted','sent','delivered','failed','revoked')),
   created_at TEXT NOT NULL
  )`);
  this.sql.exec(`CREATE TABLE IF NOT EXISTS cp_alarm_jobs(
   alarm_key TEXT PRIMARY KEY,
   due_at_ms INTEGER NOT NULL,
   kind TEXT NOT NULL CHECK(kind IN ('retry','reminder','monthly_delivery','release_192h','reconcile','owner_alert')),
   state TEXT NOT NULL CHECK(state IN ('scheduled','queued','canceled')),
   updated_at TEXT NOT NULL
  )`);
  this.sql.exec(`CREATE TABLE IF NOT EXISTS cp_form_tokens(
   cycle INTEGER PRIMARY KEY, token_sha256 TEXT NOT NULL, expires_at_ms INTEGER NOT NULL,
   status TEXT NOT NULL CHECK(status IN ('issued','consumed','revoked')))`);
  this.sql.exec(`CREATE TABLE IF NOT EXISTS cp_form_submissions(
   cycle INTEGER PRIMARY KEY, event_key TEXT NOT NULL UNIQUE,
   form_sha256 TEXT NOT NULL,form_json TEXT NOT NULL,submitted_at TEXT NOT NULL)`);
  this.sql.exec(`CREATE INDEX IF NOT EXISTS cp_alarm_due_idx ON cp_alarm_jobs(state,due_at_ms)`);
  this.sql.exec(`CREATE TABLE IF NOT EXISTS cp_alarm_outbox(
   alarm_key TEXT PRIMARY KEY,
   kind TEXT NOT NULL,
   due_at_ms INTEGER NOT NULL,
   enqueued_at_ms INTEGER NOT NULL,
   status TEXT NOT NULL CHECK(status IN ('pending','uncertain','done','canceled'))
  )`);
  this.sql.exec("INSERT OR IGNORE INTO subscriber_state(singleton,version,status,cycle,delivered_cycle,updated_at) VALUES (1,0,'absent',0,0,'1970-01-01T00:00:00Z')");
 }
 one(query,...args){return this.sql.exec(query,...args).toArray()[0]||null;}
 current(){return this.one("SELECT version,status,cycle,delivered_cycle,updated_at FROM subscriber_state WHERE singleton=1");}
 snapshot(){
  return {
   ...this.current(),
   outbox:this.sql.exec("SELECT outbox_key,cycle,status,provider_idempotency_key,receipt FROM cp_outbox ORDER BY cycle").toArray(),
   refunds:this.sql.exec("SELECT cycle,event_key FROM cp_refunds ORDER BY cycle").toArray(),
   event_count:Number(this.one("SELECT COUNT(*) AS n FROM cp_event_ledger")?.n||0),
  };
 }
 apply(intent){
  if(!intent||typeof intent!=="object"||!validEvent(intent.event_key)||!ALLOWED.has(intent.kind)||!validCycle(intent.cycle))
   throw new CpTransitionError("invalid_intent",400);
  if("subscriber_id" in intent || "subscriberId" in intent || "buyer_email" in intent || "email" in intent)
   throw new CpTransitionError("client_subscriber_forbidden",403);
  if(intent.expected_version!==undefined && !validVersion(intent.expected_version))throw new CpTransitionError("invalid_version",400);
  const at=typeof intent.at==="string" && /^\d{4}-\d\d-\d\dT/.test(intent.at) ? intent.at : new Date().toISOString();
  try{
   return this.storage.transactionSync(()=>{
    const eventKey=String(intent.event_key),cycle=intent.cycle,kind=intent.kind;
    if(this.one("SELECT event_key FROM cp_event_ledger WHERE event_key=?",eventKey))
      return {ok:true,code:"duplicate_event",...this.snapshot()};
    const state=this.current();
    if(intent.expected_version!==undefined && state.version!==intent.expected_version)
      throw new CpTransitionError("stale_version");
    if(kind==="approved"){
     if(state.status==="refunded" && cycle<=state.cycle)throw new CpTransitionError("terminal_refund");
     if(cycle<state.cycle)throw new CpTransitionError("stale_cycle");
    }
    if(kind==="queue_delivery" && (state.status!=="active"||cycle!==state.cycle||this.one("SELECT cycle FROM cp_refunds WHERE cycle=?",cycle)))
      throw new CpTransitionError("delivery_not_eligible");
    if(kind==="provider_receipt" && (typeof intent.receipt!=="string"||!/^[a-zA-Z0-9._:/-]{8,180}$/.test(intent.receipt)))
      throw new CpTransitionError("receipt_missing",400);
    if(kind==="provider_receipt" && !this.one("SELECT outbox_key FROM cp_outbox WHERE cycle=? AND status IN ('pending','uncertain','sent')",cycle))
      throw new CpTransitionError("outbox_not_found");
    if(kind==="provider_uncertain" && !this.one("SELECT outbox_key FROM cp_outbox WHERE cycle=? AND status='pending'",cycle))
      throw new CpTransitionError("outbox_not_pending");
    if(kind==="operator_stop" && state.status==="refunded")throw new CpTransitionError("terminal_refund");
    if(kind==="form_token_issued"||kind==="form_submitted"){
     if(state.status!=="active"||cycle!==state.cycle)throw new CpTransitionError("form_not_eligible");
     if(typeof intent.token_sha256!=="string"||!/^[a-f0-9]{64}$/.test(intent.token_sha256))
      throw new CpTransitionError("invalid_form_token",400);
    }
    if(kind==="form_token_issued"&&(!Number.isSafeInteger(intent.expires_at_ms)||intent.expires_at_ms<Date.parse(at)))
      throw new CpTransitionError("invalid_form_token_expiry",400);
    if(kind==="form_submitted"&&(typeof intent.form_json!=="string"||intent.form_json.length>8192||
      typeof intent.form_sha256!=="string"||!/^[a-f0-9]{64}$/.test(intent.form_sha256)))
      throw new CpTransitionError("invalid_form_content",400);
    if(kind==="form_submitted"){
     const token=this.one("SELECT token_sha256,expires_at_ms,status FROM cp_form_tokens WHERE cycle=?",cycle);
     if(!token||token.status!=="issued"||token.token_sha256!==intent.token_sha256||token.expires_at_ms<Date.parse(at))
      throw new CpTransitionError("form_token_expired_or_consumed",403);
    }
    this.sql.exec("INSERT INTO cp_event_ledger(event_key,kind,cycle,version,created_at) VALUES(?,?,?,?,?)",eventKey,kind,cycle,state.version+1,at);
    if(kind==="refund_review"){
      // No unverified partial/full refund can be blindly classified as terminal.
      // Stop fulfillment and queue owner reconciliation inside this DO.
      this.sql.exec("INSERT OR IGNORE INTO cp_refund_events(event_key,cycle,refund_type,state,created_at) VALUES(?,?,'requested','pending',?)",
        eventKey,cycle,at);
      this.sql.exec("UPDATE subscriber_state SET status='inactive',version=version+1,updated_at=? WHERE singleton=1",at);
      if(this.campaign)this.campaign.onStopped(at);
      this.sql.exec("INSERT OR IGNORE INTO cp_alarm_jobs(alarm_key,due_at_ms,kind,state,updated_at) VALUES(?,?, 'owner_alert','scheduled',?)",
       "refund-review:"+cycle,Date.parse(at)+1000,at);
    }else     if(kind==="form_token_issued"){
     const prior=this.one("SELECT token_sha256 FROM cp_form_tokens WHERE cycle=?",cycle);
     if(prior && prior.token_sha256!==intent.token_sha256)throw new CpTransitionError("form_token_conflict");
     this.sql.exec("INSERT OR IGNORE INTO cp_form_tokens(cycle,token_sha256,expires_at_ms,status) VALUES(?,?,?,'issued')",
       cycle,intent.token_sha256,intent.expires_at_ms);
     this.sql.exec("UPDATE subscriber_state SET version=version+1,updated_at=? WHERE singleton=1",at);
    }else if(kind==="form_submitted"){
     this.sql.exec("UPDATE cp_form_tokens SET status='consumed' WHERE cycle=? AND token_sha256=?",cycle,intent.token_sha256);
     this.sql.exec("INSERT OR IGNORE INTO cp_form_submissions(cycle,event_key,form_sha256,form_json,submitted_at) VALUES(?,?,?,?,?)",
       cycle,eventKey,intent.form_sha256,intent.form_json,at);
     this.sql.exec("UPDATE subscriber_state SET version=version+1,updated_at=? WHERE singleton=1",at);
     if(this.campaign)this.campaign.onSubmitted(cycle,at);
    }else if(kind==="approved"){
      this.sql.exec("INSERT OR IGNORE INTO cp_cycles(cycle,approved_at_ms,release_at_ms,status,created_at,updated_at) VALUES(?,NULL,NULL,'approved',?,?)",cycle,at,at);
      this.sql.exec("UPDATE subscriber_state SET status='active', cycle=?,version=version+1,updated_at=? WHERE singleton=1",Math.max(state.cycle,cycle),at);
      if(this.campaign)this.campaign.onApproved(cycle,at);
    }else if(kind==="queue_delivery"){
      this.sql.exec("INSERT OR IGNORE INTO cp_outbox(outbox_key,event_key,cycle,status,provider_idempotency_key,created_at,updated_at) VALUES(?,?,?,'pending',?,?,?)",
        "delivery:"+cycle,eventKey,cycle,this.canonicalId+"/delivery/"+cycle,at,at);
      this.sql.exec("UPDATE subscriber_state SET version=version+1,updated_at=? WHERE singleton=1",at);
    }else if(kind==="refund"){
      this.sql.exec("INSERT OR IGNORE INTO cp_refunds(cycle,event_key,refunded_at) VALUES(?,?,?)",cycle,eventKey,at);
      this.sql.exec("UPDATE cp_outbox SET status='canceled',updated_at=? WHERE cycle=? AND status='pending'",at,cycle);
      // Existing acknowledged delivery is immutable even after refund.
      this.sql.exec("UPDATE subscriber_state SET status=CASE WHEN cycle=? THEN 'refunded' ELSE status END,version=version+1,updated_at=? WHERE singleton=1",cycle,at);
      if(this.campaign&&cycle===state.cycle)this.campaign.onStopped(at);
    }else if(kind==="operator_stop"){
      this.sql.exec("UPDATE subscriber_state SET status='inactive',version=version+1,updated_at=? WHERE singleton=1",at);
      if(this.campaign)this.campaign.onStopped(at);
    }else if(kind==="provider_receipt"){
      const existing=this.one("SELECT status,receipt FROM cp_outbox WHERE cycle=?",cycle);
      if(existing.status==="sent" && existing.receipt!==intent.receipt)throw new CpTransitionError("receipt_conflict");
      this.sql.exec("UPDATE cp_outbox SET status='sent',receipt=?,updated_at=? WHERE cycle=?",intent.receipt,at,cycle);
      this.sql.exec("UPDATE subscriber_state SET delivered_cycle=MAX(delivered_cycle,?),version=version+1,updated_at=? WHERE singleton=1",cycle,at);
    }else if(kind==="provider_uncertain"){
      this.sql.exec("UPDATE cp_outbox SET status='uncertain',updated_at=? WHERE cycle=? AND status='pending'",at,cycle);
      this.sql.exec("UPDATE subscriber_state SET version=version+1,updated_at=? WHERE singleton=1",at);
    }
    return {ok:true,code:"applied",...this.snapshot()};
   });
  }catch(error){
   if(error instanceof CpTransitionError)throw error;
   throw new CpTransitionError("sqlite_unavailable",503);
  }
 }
 // M1: multiple jobs per subscriber DO, one Cloudflare alarm per object.
 // A real consumer must reconcile outbox and never send email from this method.
 scheduleAlarmJob({alarm_key,kind,due_at_ms},at=new Date().toISOString()){
  if(!validEvent(alarm_key)||!["retry","reminder","monthly_delivery","release_192h","reconcile","owner_alert"].includes(kind)||
    !Number.isSafeInteger(due_at_ms)||due_at_ms<1)
    throw new CpTransitionError("invalid_alarm_job",400);
  return this.storage.transactionSync(()=>{
   const prior=this.one("SELECT due_at_ms,kind,state FROM cp_alarm_jobs WHERE alarm_key=?",alarm_key);
   if(prior){
    if(prior.due_at_ms!==due_at_ms||prior.kind!==kind)throw new CpTransitionError("alarm_conflict");
    return {code:"duplicate_alarm",next:this.nextAlarmAt()};
   }
   this.sql.exec("INSERT INTO cp_alarm_jobs(alarm_key,due_at_ms,kind,state,updated_at) VALUES(?,?,?,'scheduled',?)",alarm_key,due_at_ms,kind,at);
   return {code:"scheduled",next:this.nextAlarmAt()};
  });
 }
 nextAlarmAt(){
  return this.one("SELECT MIN(due_at_ms) AS due FROM cp_alarm_jobs WHERE state='scheduled'")?.due??null;
 }
 claimDueAlarmJobs(now){
  if(!Number.isSafeInteger(now)||now<1)throw new CpTransitionError("invalid_clock",400);
  return this.storage.transactionSync(()=>{
   const due=this.sql.exec("SELECT alarm_key,kind,due_at_ms FROM cp_alarm_jobs WHERE state='scheduled' AND due_at_ms<=? ORDER BY due_at_ms LIMIT 50",now).toArray();
   for(const task of due){
    this.sql.exec("INSERT OR IGNORE INTO cp_alarm_outbox(alarm_key,kind,due_at_ms,enqueued_at_ms,status) VALUES(?,?,?,?,'pending')",
      task.alarm_key,task.kind,task.due_at_ms,now);
    this.sql.exec("UPDATE cp_alarm_jobs SET state='queued',updated_at=? WHERE alarm_key=?",new Date(now).toISOString(),task.alarm_key);
   }
   return {queued:due.length,next:this.nextAlarmAt()};
  });
 }
 // G02 schema never marks an external delivery as sent: receipt comes from the provider.
 // Append-only per-object export; an external aggregator must orchestrate daily
 // export and retention. No direct KV writes or external emails occur here.
 exportEvents(afterVersion=0){
  if(!validVersion(afterVersion))throw new CpTransitionError("invalid_cursor",400);
  return this.sql.exec("SELECT event_key,kind,cycle,version,created_at FROM cp_event_ledger WHERE version>? ORDER BY version",afterVersion).toArray();
 }
}

// Cloudflare binds this class through a SQLite-backed DO namespace once approved.
// It exposes only a stub.fetch() interface reachable from a TRUSTED Worker binding;
// no public HTTP route should be mounted to it. No subscriber ID is accepted in body.
export class ContentProntoSubscriberDO {
 constructor(ctx){
  this.ctx=ctx;
  this.ledger=new CpSubscriberLedger(ctx.storage,"cp-do:"+String(ctx.id));
  this.fulfillment=new CpFulfillmentLedger(ctx.storage,this.ledger,"cp-do:"+String(ctx.id));
  this.campaign=new CpCampaignLedger(ctx.storage,this.ledger);
  this.ledger.campaign=this.campaign;
 }
 async fetch(request){
  try{
   const path=new URL(request.url).pathname;
   if(path==="/internal/snapshot" && request.method==="GET")return Response.json(this.ledger.snapshot());
   if(path==="/internal/form-status" && request.method==="GET") {
    // Internal DO binding only. Return no PII, token or form fields.
    const qs=new URL(request.url).searchParams;
    const cycle=Number(qs.get("cycle")),hash=qs.get("sha256")||"";
    if(!Number.isInteger(cycle)||cycle<1||!/^[a-f0-9]{64}$/.test(hash))
     return Response.json({ok:false,valid:false},{status:400});
    const row=this.ledger.one("SELECT token_sha256,expires_at_ms,status FROM cp_form_tokens WHERE cycle=?",cycle);
    const state=this.ledger.current();
    const valid=Boolean(row&&state.status==="active"&&state.cycle===cycle&&row.status==="issued"&&row.token_sha256===hash&&row.expires_at_ms>=Date.now());
    return Response.json({ok:true,valid,cycle});
   }
   if(path==="/internal/fulfillment-snapshot" && request.method==="GET")return Response.json(this.fulfillment.snapshot());
   if(path==="/internal/fulfillment" && request.method==="POST"){
    const input=await request.json();
    const result=this.fulfillment.apply(input);
    if(["enqueue","failure"].includes(input.kind) && ["applied","already_queued","duplicate_event"].includes(result.code)){
      const job=result.job;
      if(job?.due_at_ms && ["queued","retry"].includes(job.status)){
        try{
          const key="fulfillment:"+input.cycle+":attempt:"+job.attempts;
          const alarm=this.ledger.scheduleAlarmJob({alarm_key:key,kind:"retry",due_at_ms:job.due_at_ms});
          if(alarm.next!==null)await this.ctx.storage.setAlarm(alarm.next);
        }catch{
          // Queue remains persisted. No success is claimed without an actual alarm.
          return Response.json({ok:false,error:"alarm_not_confirmed"},{status:503});
        }
      }
    }
    return Response.json(result);
   }
   if(path==="/internal/events" && request.method==="GET"){
    const from=Number(new URL(request.url).searchParams.get("after")||0);
    return Response.json({events:this.ledger.exportEvents(from)});
   }
   if(path==="/internal/schedule" && request.method==="POST"){
    const job=await request.json();
    const queued=this.ledger.scheduleAlarmJob(job);
    if(queued.next!==null){
      try { await this.ctx.storage.setAlarm(queued.next); }
      catch { return Response.json({ok:false,error:"alarm_unavailable"},{status:503}); }
    }
    return Response.json({ok:true,...queued});
  }
  if(path!=="/internal/apply"||request.method!=="POST")return Response.json({error:"method_not_allowed"},{status:405});
   const input=await request.json();
   const answer=this.ledger.apply(input);
   return Response.json(answer);
  }catch(err){
   const e=err instanceof CpTransitionError||err instanceof CpWorkError?err:new CpTransitionError("unavailable",503);
   return Response.json({ok:false,error:e.code},{status:e.status});
  }
 }
 async alarm(){
  // At-least-once Cloudflare alarm: atomically queue due events, NEVER send email here.
  const now=Date.now();
  const moved=this.ledger.claimDueAlarmJobs(now);
  if(moved.next!==null)await this.ctx.storage.setAlarm(Math.max(now+1,moved.next));
  // If a downstream consumer is absent, alarms remain durable as PENDING outbox.
 }
}
