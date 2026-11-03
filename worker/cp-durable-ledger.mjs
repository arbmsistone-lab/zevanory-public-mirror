// ZEVANORY NC-007 / ADR-CP-001: DRAFT-only SQLite Durable Object ledger.
// NOT connected to the live webhook/cron/operator/refund paths. Do not deploy.
// The canonical key is resolved SERVER-SIDE by the Worker (never from request JSON).
const ALLOWED = new Set(["approved","queue_delivery","refund","operator_stop","provider_receipt","provider_uncertain"]);
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
    this.sql.exec("INSERT INTO cp_event_ledger(event_key,kind,cycle,version,created_at) VALUES(?,?,?,?,?)",eventKey,kind,cycle,state.version+1,at);
    if(kind==="approved"){
      this.sql.exec("UPDATE subscriber_state SET status='active', cycle=?,version=version+1,updated_at=? WHERE singleton=1",Math.max(state.cycle,cycle),at);
    }else if(kind==="queue_delivery"){
      this.sql.exec("INSERT OR IGNORE INTO cp_outbox(outbox_key,event_key,cycle,status,provider_idempotency_key,created_at,updated_at) VALUES(?,?,?,'pending',?,?,?)",
        "delivery:"+cycle,eventKey,cycle,this.canonicalId+"/delivery/"+cycle,at,at);
      this.sql.exec("UPDATE subscriber_state SET version=version+1,updated_at=? WHERE singleton=1",at);
    }else if(kind==="refund"){
      this.sql.exec("INSERT OR IGNORE INTO cp_refunds(cycle,event_key,refunded_at) VALUES(?,?,?)",cycle,eventKey,at);
      this.sql.exec("UPDATE cp_outbox SET status='canceled',updated_at=? WHERE cycle=? AND status='pending'",at,cycle);
      // Existing acknowledged delivery is immutable even after refund.
      this.sql.exec("UPDATE subscriber_state SET status=CASE WHEN cycle=? THEN 'refunded' ELSE status END,version=version+1,updated_at=? WHERE singleton=1",cycle,at);
    }else if(kind==="operator_stop"){
      this.sql.exec("UPDATE subscriber_state SET status='inactive',version=version+1,updated_at=? WHERE singleton=1",at);
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
 }
 async fetch(request){
  try{
   const path=new URL(request.url).pathname;
   if(path==="/internal/snapshot" && request.method==="GET")return Response.json(this.ledger.snapshot());
   if(path==="/internal/events" && request.method==="GET"){
    const from=Number(new URL(request.url).searchParams.get("after")||0);
    return Response.json({events:this.ledger.exportEvents(from)});
   }
   if(path!=="/internal/apply"||request.method!=="POST")return Response.json({error:"method_not_allowed"},{status:405});
   const input=await request.json();
   const answer=this.ledger.apply(input);
   return Response.json(answer);
  }catch(err){
   const e=err instanceof CpTransitionError?err:new CpTransitionError("unavailable",503);
   return Response.json({ok:false,error:e.code},{status:e.status});
  }
 }
}
