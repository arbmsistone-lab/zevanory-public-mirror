import {grantPreparedKitToken} from "./kit-nc015-token.mjs";
import {kitDeferred192hEnabled,kitDeferred192hDisabledResponse} from "./kit-deferred-192h-flag.mjs";
// DEC-06: INACTIVE in phase 1 (immediate full download at Hotmart). Every DO entry point is fail-closed behind
// KIT_DEFERRED_192H_ENABLED (worker/kit-deferred-192h-flag.mjs, default off); the ledger logic is kept intact.
// ZEVANORY NC-009 N3 (DEC-01 v3) | OFFLINE CANDIDATE / NOT BOUND OR DEPLOYED.
// One SQLite-backed Durable Object PER PURCHASE (not the monthly Content Pronto subscriber DO).
// The worker must validate Hotmart Hottok and route from a server-computed HMAC before calling this class.
// No actual Club, R2 or Resend integration is configured in this file.
export const RELEASE_HOURS=192;
export const RELEASE_DELAY_MS=192*60*60*1000;
const EVENTS=new Set(["PURCHASE_APPROVED","PURCHASE_REFUNDED","PURCHASE_CHARGEBACK","PURCHASE_PROTEST","PURCHASE_CANCELED","REFUND_REQUESTED"]);
const BLOCKING=new Set(["PURCHASE_REFUNDED","PURCHASE_CHARGEBACK","PURCHASE_PROTEST","PURCHASE_CANCELED"]);
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
   state TEXT NOT NULL CHECK(state IN ('absent','waiting','ready','held_refund_request','revoked','stalled')),
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
  this.sql.exec(`CREATE TABLE IF NOT EXISTS kit_alarm_policy(
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0 AND attempts<=48),
    status TEXT NOT NULL CHECK(status IN ('idle','retrying','queued','stalled')),
    next_retry_at_ms INTEGER
  )`);
  this.sql.exec(`CREATE TABLE IF NOT EXISTS kit_owner_alert_outbox(
    alert_key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','sent')),
    created_at_ms INTEGER NOT NULL
  )`);
  this.sql.exec("CREATE TABLE IF NOT EXISTS kit_download_usage(singleton INTEGER PRIMARY KEY CHECK(singleton=1),used INTEGER NOT NULL DEFAULT 0 CHECK(used BETWEEN 0 AND 5))");
  this.sql.exec("INSERT OR IGNORE INTO kit_download_usage(singleton,used) VALUES(1,0)");
  this.sql.exec("CREATE TABLE IF NOT EXISTS kit_private_reference(singleton INTEGER PRIMARY KEY CHECK(singleton=1),provider_txn TEXT NOT NULL,product_id TEXT NOT NULL)");
  this.sql.exec("INSERT OR IGNORE INTO kit_alarm_policy(singleton,attempts,status) VALUES(1,0,'idle')");
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
    this.sql.exec("UPDATE kit_eligibility_outbox SET status='revoked' WHERE status='pending'");
   } else if(event_type==="REFUND_REQUESTED" && state.state!=="revoked" && state.state!=="stalled"){
    this.sql.exec("UPDATE kit_order SET state='held_refund_request',revocation_event=?,token_hash=NULL,token_expires_at_ms=NULL,updated_at_ms=?,version=version+1 WHERE singleton=1",event_type,now);
    this.sql.exec("UPDATE kit_mail_outbox SET status='revoked',updated_at_ms=? WHERE status IN ('pending','uncertain')",now);
    this.sql.exec("UPDATE kit_eligibility_outbox SET status='revoked' WHERE status='pending'");
   } else if(state.state==="absent"){
    this.sql.exec("UPDATE kit_order SET state='waiting',approved_at_ms=?,release_at_ms=?,updated_at_ms=?,version=version+1 WHERE singleton=1",
      approved_at_ms,approved_at_ms+RELEASE_DELAY_MS,now);
   } // revoked is terminal, late approval never unlocks
   return {code:"applied",...this.state()};
  });
 }
 alarmPolicy(){return this.one("SELECT attempts,status,next_retry_at_ms FROM kit_alarm_policy WHERE singleton=1");}
 failAlarm(now){
  if(!validMs(now))throw new KitReleaseError("invalid_clock",400);
  return this.storage.transactionSync(()=>{
   if(this.state().state!=="waiting")return {code:"not_waiting"};
   const a=this.alarmPolicy();
   if(a.status==="queued"||a.status==="stalled")return {code:"already_done"};
   const attempt=Math.min(48,a.attempts+1);
   if(attempt>=48){
    this.sql.exec("UPDATE kit_alarm_policy SET attempts=48,status='stalled',next_retry_at_ms=NULL WHERE singleton=1");
    this.sql.exec("UPDATE kit_order SET state='stalled',updated_at_ms=?,version=version+1 WHERE singleton=1",now);
    this.sql.exec("INSERT OR IGNORE INTO kit_owner_alert_outbox(alert_key,kind,status,created_at_ms) VALUES(?,'release_verification_stalled','pending',?)",
      this.orderOpaque+":alarm-stalled:v1",now);
    return {code:"stalled",attempts:48};
   }
   const delay=Math.min(6*60*60*1000,5*60*1000*2**(attempt-1));
   const next=now+delay;
   this.sql.exec("UPDATE kit_alarm_policy SET attempts=?,status='retrying',next_retry_at_ms=? WHERE singleton=1",attempt,next);
   return {code:"retry",attempts:attempt,next};
  });
 }
 validApprovedProof(now,proof){
  return Boolean(proof && proof.source==="hotmart_authoritative_readback" && proof.state==="APPROVED" &&
   proof.refund_request_open===false && proof.order_opaque===this.orderOpaque &&
   validMs(proof.checked_at_ms) && proof.checked_at_ms<=now && now-proof.checked_at_ms<=5*60*1000);
 }
 resumeRefundRequest({event_key,expected_version},now,proof){
  if(!validKey(event_key)||!Number.isSafeInteger(expected_version)||!validMs(now))
   throw new KitReleaseError("invalid_operator_command",400);
  if(!this.validApprovedProof(now,proof))throw new KitReleaseError("refund_resolution_not_verified",503);
  return this.storage.transactionSync(()=>{
   if(this.one("SELECT event_key FROM kit_events WHERE event_key=?",event_key))return {code:"duplicate_event",...this.state()};
   const st=this.state();
   if(st.version!==expected_version)throw new KitReleaseError("stale_version");
   if(st.state!=="held_refund_request")throw new KitReleaseError("not_held_refund");
   this.sql.exec("INSERT INTO kit_events(event_key,event_type,seen_at_ms) VALUES(?,'OPERATOR_REFUND_REQUEST_WITHDRAWN',?)",event_key,now);
   this.sql.exec("UPDATE kit_order SET state='waiting',revocation_event=NULL,updated_at_ms=?,version=version+1 WHERE singleton=1",now);
   this.sql.exec("DELETE FROM kit_eligibility_outbox WHERE status='revoked'");
   this.sql.exec("UPDATE kit_alarm_policy SET attempts=0,status='idle',next_retry_at_ms=NULL WHERE singleton=1");
   return {code:"resumed",...this.state()};
  });
 }
 // A release depends on a fresh provider-authoritative status, obtained by a
 // separate authenticated Hotmart readback. A boolean supplied by the buyer is invalid.
 authorizeRelease(now,proof){
  if(!validMs(now))throw new KitReleaseError("invalid_clock",400);
  const st=this.state();
  if(st.state!=="waiting"||!validMs(st.release_at_ms)||now<st.release_at_ms)return {code:"not_eligible",...st};
  if(!this.validApprovedProof(now,proof))
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
   const prior=this.one("SELECT status FROM kit_eligibility_outbox WHERE message_key=?",this.orderOpaque+":verified:v1");
   if(prior?.status==="pending"||prior?.status==="done")return {code:"already_queued"};
   this.sql.exec("INSERT OR REPLACE INTO kit_eligibility_outbox(message_key,status,proof_seen_at_ms) VALUES(?,'pending',?)",
      this.orderOpaque+":verified:v1",now);
   this.sql.exec("UPDATE kit_alarm_policy SET status='queued',next_retry_at_ms=NULL WHERE singleton=1");
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
 async canDownload(now,token,proof){
   if(!this.validApprovedProof(now,proof))return false;
  const st=this.state();
  if(st.state!=="ready"||!validMs(now)||now<st.release_at_ms||now>st.token_expires_at_ms||!st.token_hash||
     typeof token!=="string"||!/^[a-f0-9]{64}$/.test(token))return false;
  return ctEq(await sha256(token),st.token_hash);
 }
 recordReference({transaction,product_id}){
  if(typeof transaction!=="string"||!/^[A-Za-z0-9_.:-]{10,100}$/.test(transaction)||
     !/^[0-9]{6,12}$/.test(String(product_id)))throw new KitReleaseError("invalid_purchase_reference",400);
  return this.storage.transactionSync(()=>{
   const old=this.one("SELECT provider_txn,product_id FROM kit_private_reference WHERE singleton=1");
   if(old && (old.provider_txn!==transaction||old.product_id!==String(product_id)))
    throw new KitReleaseError("purchase_reference_conflict",409);
   if(!old)this.sql.exec("INSERT INTO kit_private_reference(singleton,provider_txn,product_id) VALUES(1,?,?)",transaction,String(product_id));
   return {ok:true};
  });
 }
 purchaseReference(){
  const row=this.one("SELECT provider_txn,product_id FROM kit_private_reference WHERE singleton=1");
   return row?{transaction:row.provider_txn,product_id:row.product_id}:null;
 }
 async claimDownload(now,token,proof){
  if(!await this.canDownload(now,token,proof))return {ok:false,code:"download_not_eligible"};
  const digest=await sha256(token);
  return this.storage.transactionSync(()=>{
   const st=this.state();
   const usage=this.one("SELECT used FROM kit_download_usage WHERE singleton=1");
   if(st.state!=="ready"||now<st.release_at_ms||now>st.token_expires_at_ms||
      !ctEq(st.token_hash,digest)||!this.validApprovedProof(now,proof))
    return {ok:false,code:"download_revoked"};
   if(usage.used>=5)return {ok:false,code:"download_limit_reached"};
   this.sql.exec("UPDATE kit_download_usage SET used=used+1 WHERE singleton=1 AND used<5");
   return {ok:true,remaining:4-usage.used};
  });
 }
 downloadCount(){return this.one("SELECT used FROM kit_download_usage WHERE singleton=1")?.used??0;}
 claimEmailSend(now){
  if(!validMs(now))throw new KitReleaseError("invalid_clock",400);
  return this.storage.transactionSync(()=>{
   if(this.state().state!=="ready")return {ok:false,code:"purchase_not_ready"};
   const key=this.orderOpaque+":mail:v1";
   const msg=this.one("SELECT status FROM kit_mail_outbox WHERE message_key=?",key);
   if(!msg||msg.status!=="pending")return {ok:false,code:"mail_not_claimable"};
   this.sql.exec("UPDATE kit_mail_outbox SET status='uncertain',updated_at_ms=? WHERE message_key=? AND status='pending'",now,key);
   return {ok:true,message_key:key};
  });
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
  if(!kitDeferred192hEnabled(this.env))return kitDeferred192hDisabledResponse();
  if(!ctEq(request.headers.get("x-internal-do-key"),this.env.INTERNAL_DO_SIGNING_KEY))return Response.json({error:"not_authorized"},{status:403});
  try{
   const path=new URL(request.url).pathname;
   if(path==="/internal/event" && request.method==="POST"){
    const event=await request.json();
    if(event?.private_reference)this.ledger.recordReference(event.private_reference);
    const result=this.ledger.acceptEvent(event);
    const current=this.ledger.state();
    // One order per DO: only one release alarm, no global cron.
    if(current.state==="waiting" && current.release_at_ms!==null)await this.ctx.storage.setAlarm(current.release_at_ms);
    return Response.json(result);
   }
   if(path==="/internal/reference"&&request.method==="GET"){
    const ref=this.ledger.purchaseReference();
    if(!ref)return Response.json({error:"reference_missing"},{status:503});
    return Response.json({reference:ref,state:this.ledger.state()});
   }
   if(path==="/internal/grant"&&request.method==="POST"){
    const {now_ms,proof}=await request.json();
    const grant=await grantPreparedKitToken(this.ledger,now_ms,proof,this.env.KIT_DOWNLOAD_SIGNING_KEY);
    return Response.json({code:grant.code,release_at_ms:grant.release_at_ms??null});
   }
   if(path==="/internal/download-claim"&&request.method==="POST"){
    const {now_ms,raw_token,proof}=await request.json();
    const claim=await this.ledger.claimDownload(now_ms,raw_token,proof);
    return Response.json(claim,{status:claim.ok?200:403});
   }
   if(path==="/internal/email-claim"&&request.method==="POST"){
    const claim=this.ledger.claimEmailSend(Date.now());
    return Response.json(claim,{status:claim.ok?200:409});
   }
   if(path==="/internal/email-receipt"&&request.method==="POST"){
    const {receipt}=await request.json();
    return Response.json(this.ledger.acceptEmailReceipt(Date.now(),receipt));
   }
   if(path==="/internal/operator/resume-refund"&&request.method==="POST"){
    if(!ctEq(request.headers.get("x-operator-key"),this.env.AUTHENTICATED_OWNER_OPERATOR_KEY))
     return Response.json({error:"operator_not_authorized"},{status:403});
    if(!this.env.HOTMART_STATUS_VERIFIER?.fetch)
     return Response.json({error:"provider_readback_unavailable"},{status:503});
    const checked=await this.env.HOTMART_STATUS_VERIFIER.fetch("https://internal.hotmart/status",{method:"GET"});
    if(!checked.ok)return Response.json({error:"provider_readback_failed"},{status:503});
    const output=this.ledger.resumeRefundRequest(await request.json(),Date.now(),await checked.json());
    if(output.code==="resumed")await this.ctx.storage.setAlarm(Math.max(Date.now()+1,output.release_at_ms));
    return Response.json(output);
   }
   if(path==="/internal/status"&&request.method==="GET")return Response.json({order:this.ledger.state(),events:this.ledger.eventCount(),outbox:this.ledger.outbox()});
   return Response.json({error:"method_not_allowed"},{status:405});
  }catch(e){const err=e instanceof KitReleaseError?e:new KitReleaseError("unavailable",503);
   return Response.json({error:err.code},{status:err.status})}
 }
 async alarm(now=Date.now()){
  if(!kitDeferred192hEnabled(this.env))return;  // DEC-06: no deferred release while the flag is off
  const st=this.ledger.state();
  if(st.state!=="waiting")return;
  const policy=this.ledger.alarmPolicy();
  if(policy.status==="queued"||policy.status==="stalled")return;
  if(now<st.release_at_ms){await this.ctx.storage.setAlarm(st.release_at_ms);return;}
  if(policy.next_retry_at_ms && now<policy.next_retry_at_ms){
   await this.ctx.storage.setAlarm(policy.next_retry_at_ms);return;
  }
  try{
   if(!this.env.HOTMART_STATUS_VERIFIER?.fetch)throw new Error("provider_status_verifier_missing");
   const response=await this.env.HOTMART_STATUS_VERIFIER.fetch("https://internal.hotmart/status",{method:"GET"});
   if(!response.ok)throw new Error("provider_status_unavailable");
   const proof=await response.json();
   const result=this.ledger.queueVerifiedEligibility(now,proof);
   // F2: durable eligibility outbox is the handoff: stop scheduling.
   if(result.code==="verification_queued"||result.code==="already_queued")return;
  }catch{
   // Provider unavailable: fail closed, backoff below.
  }
  const result=this.ledger.failAlarm(now);
  if(result.code==="retry")await this.ctx.storage.setAlarm(result.next);
  // 48 failures => stalled and owner-alert outbox, no infinite polling.
 }
}
