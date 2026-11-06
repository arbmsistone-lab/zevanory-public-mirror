// ZEVANORY NC-014 L1: SQLite-backed campaign request/reminder/credit policy.
// Candidate only. No external email, refund, Cloudflare KV or production effects.
import {CONTEUDO_PRONTO} from "./politica-unica.mjs";
export class CpCampaignError extends Error{
 constructor(code,status=409){super(code);this.code=code;this.status=status}
}
const VALID_RECEIPT=/^[a-zA-Z0-9._:/-]{8,180}$/;
const REMINDER_DAYS=Object.freeze([3,7,14]);
export const CP_CAMPAIGN_REMINDER_DAYS=REMINDER_DAYS;
export const CP_CAMPAIGN_OWNER_ALERT_DAYS=Object.freeze([7,14]);
const DAY=86400000;
const intMs=v=>Number.isSafeInteger(v)&&v>0;
export function brasiliaCivilDate(ms){
 if(!intMs(ms))throw new CpCampaignError("invalid_campaign_clock",400);
 const p=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Sao_Paulo",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(ms);
 const m=Object.fromEntries(p.map(x=>[x.type,x.value]));
 return m.year+"-"+m.month+"-"+m.day;
}
export class CpCampaignLedger{
 constructor(storage,subscriber){
  this.storage=storage;this.sql=storage.sql;this.subscriber=subscriber;
  this.sql.exec("CREATE TABLE IF NOT EXISTS cp_monthly_campaigns(cycle INTEGER PRIMARY KEY CHECK(cycle>0),status TEXT NOT NULL CHECK(status IN ('awaiting_delivery','awaiting_campaign','submitted','stopped')),requested_at_ms INTEGER,request_provider_receipt TEXT,updated_at_ms INTEGER NOT NULL)");
  this.sql.exec("CREATE TABLE IF NOT EXISTS cp_campaign_reminder_outbox(cycle INTEGER NOT NULL,day INTEGER NOT NULL CHECK(day IN (3,7,14)),status TEXT NOT NULL CHECK(status IN ('pending','sent','canceled')),owner_alert INTEGER NOT NULL CHECK(owner_alert IN (0,1)),due_at_ms INTEGER NOT NULL,created_at_ms INTEGER NOT NULL,PRIMARY KEY(cycle,day))");
  this.sql.exec("CREATE TABLE IF NOT EXISTS cp_credit_refund_intents(cycle INTEGER PRIMARY KEY,reason TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','processed','rejected')),recorded_at_ms INTEGER NOT NULL)");
 }
 one(sql,...args){return this.sql.exec(sql,...args).toArray()[0]??null}
 onApproved(cycle,at){
  const ms=Date.parse(at);
  if(!intMs(ms))throw new CpCampaignError("invalid_approval_clock",400);
  // On a renewal, an approved previous cycle with no customer campaign or
  // provider-delivered package becomes a reserved credit. Never lose payment.
  const prior=cycle-1;
  if(prior>=1&&this.one("SELECT cycle FROM cp_cycles WHERE cycle=? AND status='approved'",prior)&&
     !this.one("SELECT cycle FROM cp_form_submissions WHERE cycle=?",prior)&&
     !this.one("SELECT cycle FROM cp_delivery_receipts WHERE cycle=? AND status='delivered'",prior)&&
     !this.one("SELECT cycle FROM cp_refunds WHERE cycle=?",prior)){
   this.sql.exec("INSERT OR IGNORE INTO cp_credits(cycle,source_event_key,status,updated_at) VALUES(?,?,'available',?)",prior,"credit:unfulfilled:"+prior,at);
  }
  const max=Number(CONTEUDO_PRONTO.creditos_max);
  if(!Number.isInteger(max)||max<1)throw new CpCampaignError("invalid_credit_policy",503);
  const credits=this.sql.exec("SELECT cycle FROM cp_credits WHERE status='available' ORDER BY cycle").toArray();
  for(const x of credits.slice(0,Math.max(0,credits.length-max))){
   this.sql.exec("INSERT OR IGNORE INTO cp_credit_refund_intents(cycle,reason,status,recorded_at_ms) VALUES(?,'credit_limit_exceeded','pending',?)",x.cycle,ms);
   // The refund remains pending. It is NOT marked processed or paid.
   this.sql.exec("DELETE FROM cp_credits WHERE cycle=? AND status='available'",x.cycle);
  }
  this.sql.exec("INSERT OR IGNORE INTO cp_monthly_campaigns(cycle,status,requested_at_ms,request_provider_receipt,updated_at_ms) VALUES(?,'awaiting_delivery',NULL,NULL,?)",cycle,ms);
 }
 onSubmitted(cycle,at){
  const ms=Date.parse(at);
  if(!intMs(ms))throw new CpCampaignError("invalid_submission_clock",400);
  const current=this.one("SELECT status FROM cp_monthly_campaigns WHERE cycle=?",cycle);
  if(!current||current.status==="stopped")throw new CpCampaignError("campaign_not_eligible",403);
  this.sql.exec("UPDATE cp_monthly_campaigns SET status='submitted',updated_at_ms=? WHERE cycle=?",ms,cycle);
  this.sql.exec("UPDATE cp_campaign_reminder_outbox SET status='canceled' WHERE cycle=? AND status='pending'",cycle);
 }
 onStopped(at){
  const ms=Date.parse(at);
  if(!intMs(ms))throw new CpCampaignError("invalid_stop_clock",400);
  this.sql.exec("UPDATE cp_monthly_campaigns SET status='stopped',updated_at_ms=? WHERE status IN ('awaiting_delivery','awaiting_campaign')",ms);
  this.sql.exec("UPDATE cp_campaign_reminder_outbox SET status='canceled' WHERE status='pending'");
 }
 // Must be invoked only after the email provider is independently checked
 // and this DO is reached through a trusted internal Worker binding.
 confirmRequest(cycle,providerReceipt,verified,ms){
  if(!Number.isInteger(cycle)||cycle<1||!VALID_RECEIPT.test(providerReceipt)||verified!=="provider-get-verified"||!intMs(ms))
   throw new CpCampaignError("request_proof_missing",403);
  return this.storage.transactionSync(()=>{
   const state=this.subscriber.current();
   const row=this.one("SELECT status,request_provider_receipt FROM cp_monthly_campaigns WHERE cycle=?",cycle);
   if(state.status!=="active"||state.cycle!==cycle||!row||row.status==="stopped"||row.status==="submitted")
    throw new CpCampaignError("campaign_request_not_eligible",403);
   if(row.status==="awaiting_campaign"){
    if(row.request_provider_receipt!==providerReceipt)throw new CpCampaignError("request_receipt_conflict",409);
    return {ok:true,code:"duplicate_proof"};
   }
   if(!this.one("SELECT cycle FROM cp_form_tokens WHERE cycle=? AND status='issued'",cycle))
    throw new CpCampaignError("form_token_not_issued",403);
   this.sql.exec("UPDATE cp_monthly_campaigns SET status='awaiting_campaign',request_provider_receipt=?,requested_at_ms=?,updated_at_ms=? WHERE cycle=?",providerReceipt,ms,ms,cycle);
   return {ok:true,code:"recorded",cycle};
  });
 }
 dueReminders(now){
  if(!intMs(now))throw new CpCampaignError("invalid_reminder_clock",400);
  return this.storage.transactionSync(()=>{
   const state=this.subscriber.current(),cycle=state.cycle;
   if(state.status!=="active")return {ok:true,pending:0};
   const row=this.one("SELECT status,requested_at_ms FROM cp_monthly_campaigns WHERE cycle=?",cycle);
   if(!row||row.status!=="awaiting_campaign"||!intMs(row.requested_at_ms))return {ok:true,pending:0};
   for(const day of REMINDER_DAYS){
    if(now<row.requested_at_ms+day*DAY)continue;
    this.sql.exec("INSERT OR IGNORE INTO cp_campaign_reminder_outbox(cycle,day,status,owner_alert,due_at_ms,created_at_ms) VALUES(?,?,'pending',?,?,?)",
     cycle,day,CP_CAMPAIGN_OWNER_ALERT_DAYS.includes(day)?1:0,row.requested_at_ms+day*DAY,now);
   }
   const pending=this.sql.exec("SELECT cycle,day,owner_alert,due_at_ms FROM cp_campaign_reminder_outbox WHERE cycle=? AND status='pending' ORDER BY day",cycle).toArray();
   return {ok:true,pending:pending.length,reminders:pending};
  });
 }
 snapshot(){
  return {requests:this.sql.exec("SELECT cycle,status,requested_at_ms FROM cp_monthly_campaigns ORDER BY cycle").toArray(),
   reminders:this.sql.exec("SELECT cycle,day,status,owner_alert FROM cp_campaign_reminder_outbox ORDER BY cycle,day").toArray(),
   credits:this.sql.exec("SELECT cycle,status FROM cp_credits ORDER BY cycle").toArray(),
   refund_intents:this.sql.exec("SELECT cycle,reason,status FROM cp_credit_refund_intents ORDER BY cycle").toArray()};
 }
}
