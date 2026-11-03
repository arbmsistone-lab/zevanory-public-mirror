// ZEVANORY NC-009 N3 (DEC-01 v3) | OFFLINE CANDIDATE / NOT BOUND OR DEPLOYED.
// One SQLite-backed Durable Object PER PURCHASE (not the monthly Content Pronto subscriber DO).
// The worker must validate Hotmart Hottok and route from a server-computed HMAC before calling this class.
// No actual Club, R2 or Resend integration is configured in this file.
export const RELEASE_HOURS=192;
export const RELEASE_DELAY_MS=192*60*60*1000;
const EVENTS=new Set(["PURCHASE_APPROVED","PURCHASE_REFUNDED","PURCHASE_CHARGEBACK","PURCHASE_PROTEST","PURCHASE_CANCELED","REFUND_REQUESTED"]);
const BLOCKING=new Set(["PURCHASE_REFUNDED","PURCHASE_CHARGEBACK","PURCHASE_PROTEST","PURCHASE_CANCELED","REFUND_REQUESTED"]);
const validKey=s=>typeof s==="string" && /^[a-zA-Z0-9:._/-]{12,180}$/.test(s);
const validMs=n=>Number.isSafeInteger(n)&&n>1577836800000&&n<4102444800000;
const utf8=new TextEncoder();
const toHex=a=>[...new Uint8Array(a)].map(b=>b.toString(16).padStart(2,"0")).join("");
export class KitReleaseError extends Error {constructor(code,status=409){super(code);this.code=code;this.status=status;}}
async function sha256(v){return toHex(await crypto.subtle.digest("SHA-256",utf8.encode(v)))}
function ctEq(a,b){
 const x=utf8.encode(String(a||"")),y=utf8.encode(String(b||""));
 if(x.length!==y.length||x.length===0)return false;
 let d=0;for(let i=0;i<x.length;i++)d|=x[i]^y[i];return d===0;
}
export class KitReleaseLedger {
 constructor(storage,orderOpaque){
  if(!storage?.sql?.exec||!storage?.transactionSync||!/^kr:[a-f0-9]{64}$/.test(orderOpaque))throw new KitReleaseError("kit_sqlite_or_identity_missing",503);
  this.storage=storage;this.sql=storage.sql;this.orderOpaque=orderOpaque;
  this.sql.exec(`CREATE TABLE IF NOT EXISTS kit_order(
   singleton INTEGER PRIMARY KEY CHECK(singleton=1),
   approved_at_ms INTEGER,
   release_at_ms INTEGER,
   state TEXT NOT NULL CHECK(state IN ('absent','waiting','ready','revoked')),
   revocation_event TEXT,
   token_hash TEXT,
   token_expires_at_ms INTEGER,
   updated_at_ms INTEGER NOT NULL,
   version INTEGER NOT NULL DEFAULT 0,
   CHECK(release_at_ms IS NULL OR release_at_ms=approved_at_ms+691200000),
   CHECK(token_expires_at_ms IS NULL OR token_expires_at_ms>=release_at_ms)
  )`);
  this.sql.exec(`CREATE TABLE IF NOT EXISTS kit_events(
   event_key TEXT PRIMARY KEY,
   event_type TEXT NOT NULL,
   seen_at_ms INTEGER NOT NULL
  )`);
  this.sql.exec(`CREATE TABLE IF NOT EXISTS kit_mail_outbox(
   message_key TEXT PRIMARY KEY,
   status TEXT NOT NULL CHECK(status IN ('pending','uncertain','accepted','revoked')),
   provider_receipt TEXT,
   created_at_ms INTEGER NOT NULL,
   updated_at_ms INTEGER NOT NULL
  )`);
  this.sql.exec(`CREATE TABLE IF NOT EXISTS kit_eligibility_outbox(
   message_key TEXT PRIMARY KEY,
   status TEXT NOT NULL CHECK(status IN ('pending','done','revoked')),
   proof_seen_at_ms INTEGER NOT NULL
  )`);
  this.sql.exec("INSERT OR IGNORE INTO kit_order(singleton,state,updated_at_ms,version) VALUES(1,'absent',0,0)");
 }
 one(q,...args){return this.sql.exec(q,...args).toArray()[0]||null}
 state(){return this.one("SELECT approved_at_ms,release_at_ms,state,revocation_event,token_hash,token_expires_at_ms,updated_at_ms,version FROM kit_order WHERE singleton=1")}
 eventCount(){return Number(this.one("SELECT COUNT(*) AS n FROM kit_events")?.n??0)}
 outbox(){return this.sql.exec("SELECT message_key,status,provider_receipt FROM kit_mail_outbox ORDER BY message_key").toArray()}
 acceptEvent({event_key,event_type,approved_at_ms},now=Date.now()){
  if(!validKey(event_key)||!EVENTS.has(event_type)||!validMs(now))throw new KitReleaseError("invalid_hotmart_event",400);
  if(event_type==="PURCHASE_APPROVED"&&!validMs(approved_at_ms))throw new KitReleaseError("approved_at_absent",422);
  if(event_type==="PURCHASE_APPROVED"&&approved_at_ms>now+5*60000)throw new KitReleaseError("approval_timestamp_in_future",422);
  return this.storage.transactionSync(()=>{
   if(this.one("SELECT event_key FROM kit_events WHERE event_key=?",event_key))return {code:"duplicate_event",...this.state()};
   const state=this.state();
   if(event_type==="PURCHASE_APPROVED" && state.approved_at_ms!==null && state.approved_at_ms!==approved_at_ms)
    throw new KitReleaseError("conflicting_approval_timestamp");
   this.sql.exec("INSERT INTO kit_events(event_key,event_type,seen_at_ms) VALUES(?,?,?)",event_key,event_type,now);
   if(BLOCKING.has(event_type)){
    this.sql.exec("UPDATE kit_order SET state='revoked',revocation_event=?,token_hash=NULL,token_expires_at_ms=NULL,updated_at_ms=?,version=version+1 WHERE singleton=1",event_type,now);
    this.sql.exec("UPDATE kit_mail_outbox SET status='revoked',updated_at_ms=? WHERE status IN ('pending','uncertain')",now);
   } else if(state.state==="absent"){
    this.sql.exec("UPDATE kit_order SET state='waiting',approved_at_ms=?,release_at_ms=?,updated_at_ms=?,version=version+1 WHERE singleton=1",
      approved_at_ms,approved_at_ms+RELEASE_DELAY_MS,now);
   } // revoked is terminal, late approval never unlocks
   return {code:"applied",...this.state()};
  });
 }
 // A release depends on a fresh provider-authoritative status, obtained by a
 // separate authenticated Hotmart readback. A boolean supplied by the buyer is invalid.
 authorizeRelease(now,proof){
  if(!validMs(now))throw new KitReleaseError("invalid_clock",400);
  const st=this.state();
  if(st.state!=="waiting"||!validMs(st.release_at_ms)||now<st.release_at_ms)return {code:"not_eligible",...st};
  if(!proof || proof.source!=="hotmart_authoritative_readback"||
    proof.state!=="APPROVED"||!validMs(proof.checked_at_ms)||
    proof.checked_at_ms>now||now-proof.checked_at_ms>5*60*1000)
   return {code:"verification_pending",...st};
  // The token is minted later in async prepareGrant() after state verification.
  return {code:"eligible",...st};
 }
 queueVerifiedEligibility(now,proof){
  const result=this.authorizeRelease(now,proof);
  if(result.code!=="eligible")return result;
  return this.storage.transactionSync(()=>{
   const state=this.state();
   if(state.state!=="waiting"||now<state.release_at_ms)return {code:"not_eligible"};
   this.sql.exec("INSERT OR IGNORE INTO kit_eligibility_outbox(message_key,status,proof_seen_at_ms) VALUES(?,'pending',?)",
      this.orderOpaque+":verified:v1",now);
   return {code:"verification_queued"};
  });
 }
 async prepareGrant(now,proof,{ttlMs=14*24*3600*1000,randomBytes}={}){
  const readiness=this.authorizeRelease(now,proof);
  if(readiness.code!=="eligible")return readiness;
  if(!Number.isSafeInteger(ttlMs)||ttlMs<60*1000||ttlMs>30*24*3600*1000)throw new KitReleaseError("invalid_ttl",400);
  const material=randomBytes?randomBytes():crypto.getRandomValues(new Uint8Array(32));
  if(!(material instanceof Uint8Array)||material.length!==32)throw new KitReleaseError("token_randomness_invalid",503);
  const token=toHex(material),tokenHash=await sha256(token),expires=now+ttlMs;
  return this.storage.transactionSync(()=>{
   const st=this.state();
   if(st.state!=="waiting"||now<st.release_at_ms)return {code:"no_longer_eligible"};
   this.sql.exec("UPDATE kit_order SET state='ready',token_hash=?,token_expires_at_ms=?,updated_at_ms=?,version=version+1 WHERE singleton=1",tokenHash,expires,now);
   this.sql.exec("INSERT OR IGNORE INTO kit_mail_outbox(message_key,status,created_at_ms,updated_at_ms) VALUES(?,'pending',?,?)",
    this.orderOpaque+":mail:v1",now,now);
   return {code:"grant_pending_email",token,release_at_ms:st.release_at_ms,expires_at_ms:expires};
  });
 }
 async canDownload(now,token){
  const st=this.state();
  if(st.state!=="ready"||!validMs(now)||now<st.release_at_ms||now>st.token_expires_at_ms||!st.token_hash||
     typeof token!=="string"||!/^[a-f0-9]{64}$/.test(token))return false;
  return ctEq(await sha256(token),st.token_hash);
 }
 markEmailUncertain(now){
  this.sql.exec("UPDATE kit_mail_outbox SET status='uncertain',updated_at_ms=? WHERE status='pending'",now);
 }
 acceptEmailReceipt(now,receipt){
  if(!validKey(receipt))throw new KitReleaseError("invalid_email_receipt",400);
  return this.storage.transactionSync(()=>{
   if(this.state().state!=="ready")throw new KitReleaseError("order_not_ready");
   const msg=this.one("SELECT status,provider_receipt FROM kit_mail_outbox WHERE message_key=?",this.orderOpaque+":mail:v1");
   if(!msg)throw new KitReleaseError("outbox_missing");
   if(msg.provider_receipt&&msg.provider_receipt!==receipt)throw new KitReleaseError("receipt_conflict");
   this.sql.exec("UPDATE kit_mail_outbox SET status='accepted',provider_receipt=?,updated_at_ms=? WHERE message_key=?",receipt,now,this.orderOpaque+":mail:v1");
   return {code:"accepted"};
  });
 }
}
export class KitReleaseOrderDO {
 constructor(ctx,env={}){
  this.ctx=ctx;this.env=env;
  // Identity is the DO id, chosen via HMAC by a trusted upstream Worker.
  const key=String(ctx.id).replace(/^kr:/,"");
  this.ledger=new KitReleaseLedger(ctx.storage,"kr:"+key);
 }
 // No public Worker route should proxy external HTTP directly to these endpoints.
 async fetch(request){
  if(!ctEq(request.headers.get("x-internal-do-key"),this.env.INTERNAL_DO_SIGNING_KEY))return Response.json({error:"not_authorized"},{status:403});
  try{
   const path=new URL(request.url).pathname;
   if(path==="/internal/event" && request.method==="POST"){
    const result=this.ledger.acceptEvent(await request.json());
    const current=this.ledger.state();
    // One order per DO: only one release alarm, no global cron.
    if(current.state==="waiting" && current.release_at_ms!==null)await this.ctx.storage.setAlarm(current.release_at_ms);
    return Response.json(result);
   }
   if(path==="/internal/status"&&request.method==="GET")return Response.json({order:this.ledger.state(),events:this.ledger.eventCount(),outbox:this.ledger.outbox()});
   return Response.json({error:"method_not_allowed"},{status:405});
  }catch(e){const err=e instanceof KitReleaseError?e:new KitReleaseError("unavailable",503);
   return Response.json({error:err.code},{status:err.status})}
 }
 async alarm(){
  const now=Date.now();
  const st=this.ledger.state();
  if(st.state!=="waiting")return;
  if(now<st.release_at_ms){await this.ctx.storage.setAlarm(st.release_at_ms);return;}
  // Do not invent 'APPROVED' proof on an alarm. Read the verified provider
  // status from an owner-approved authenticated service binding; without it
  // retain the order and retry. No real Hotmart network access in this draft.
  try{
   if(!this.env.HOTMART_STATUS_VERIFIER?.fetch)throw new Error("provider_status_verifier_missing");
   const response=await this.env.HOTMART_STATUS_VERIFIER.fetch("https://internal.hotmart/status",{method:"GET"});
   if(!response.ok)throw new Error("provider_status_unavailable");
   const proof=await response.json();
   // No token creation or access grant in an alarm: only enqueue a durable
   // eligibility claim for a *separate* audited mail sender with a fresh readback.
   const result=this.ledger.queueVerifiedEligibility(now,proof);
   if(result.code!=="verification_queued"){await this.ctx.storage.setAlarm(now+5*60000);return;}
   // This candidate has no sender integration. Keep waiting / no downloadable token.
   await this.ctx.storage.setAlarm(now+5*60000);
  }catch{
   await this.ctx.storage.setAlarm(now+5*60000);
  }
 }
}
