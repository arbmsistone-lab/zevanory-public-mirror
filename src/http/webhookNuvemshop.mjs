import { createHmac, timingSafeEqual } from 'node:crypto';
import { sendNuvemshopPrivacyReport } from '../nuvemshopPrivacy.mjs';
import { Pool } from '@neondatabase/serverless';
import { NUVEMSHOP_REQUIRED_WEBHOOKS } from '../nuvemshopOAuth.mjs';
import { numericNuvemshopId } from '../nuvemshopIntegrationSecurity.mjs';
const privacy=['app/store_redact','customer/redact','customers/data_request'];
const allowed=new Set([...NUVEMSHOP_REQUIRED_WEBHOOKS,...privacy]);
const json=(res,status,body)=>{res.statusCode=status;return res.end(JSON.stringify(body));};
const hmac=(secret,value)=>createHmac('sha256',String(secret)).update(value).digest('hex');
export function verifyNuvemshopWebhook(rawBody,signature,secret){
 if(!secret||typeof signature!=='string'||!/^[a-f0-9]{64}$/i.test(signature)||!Buffer.isBuffer(rawBody))return false;
 return timingSafeEqual(Buffer.from(hmac(secret,rawBody),'hex'),Buffer.from(signature,'hex'));
}
export function validateNuvemshopWebhookPayload(payload,{privacyEvent='',env=process.env}={}){
 if(!payload||typeof payload!=='object'||Array.isArray(payload)||!numericNuvemshopId(payload.store_id))throw new Error('nuvemshop_webhook_payload_invalid');
 let event=payload.event;
 if(!event&&!privacyEvent&&!payload.customer&&!payload.data_request&&Object.keys(payload).some(key=>!['store_id','retry_count','attempt','attempts','delivery_attempt','retry_attempt','delivery_attempts'].includes(key)))throw new Error('nuvemshop_privacy_store_invalid');
 if(!event)event=privacyEvent||(payload.data_request?'customers/data_request':payload.customer?'customer/redact':'app/store_redact');
 if(!allowed.has(event)||(privacyEvent&&event!==privacyEvent))throw new Error('nuvemshop_webhook_event_invalid');
 if(env.NUVEMSHOP_STORE_ID&&String(payload.store_id)!==String(env.NUVEMSHOP_STORE_ID))throw new Error('nuvemshop_store_identity_mismatch');
 if(event==='app/uninstalled'&&String(payload.id)!==String(env.NUVEMSHOP_APP_ID))throw new Error('nuvemshop_app_identity_mismatch');
 if(['customer/redact','customers/data_request'].includes(event)&&!numericNuvemshopId(payload.customer?.id))throw new Error('nuvemshop_privacy_customer_invalid');
 if(event==='customers/data_request'&&!numericNuvemshopId(payload.data_request?.id))throw new Error('nuvemshop_privacy_request_invalid');
 if(event==='app/store_redact'&&(payload.customer||payload.data_request||payload.orders_requested||payload.orders_to_redact))throw new Error('nuvemshop_privacy_store_invalid');
 if((event.startsWith('product/')||event.startsWith('order/'))&&!numericNuvemshopId(payload.id))throw new Error('nuvemshop_webhook_resource_invalid');
 return {storeId:String(payload.store_id),event};
}
function canonical(value){
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).filter(key=>!['retry_count','attempt','attempts','delivery_attempt','retry_attempt','delivery_attempts'].includes(key)).sort().map(key=>[key,canonical(value[key])]));
 return value;
}
export function nuvemshopWebhookDeliveryKey(payload,event,secret){
 // A privacy request is identified by its provider request ID, even if retried customer metadata changes.
 const identity=event==='customers/data_request'?{event,store_id:String(payload.store_id),data_request_id:String(payload.data_request.id)}:canonical({...payload,event});
 return hmac(secret,JSON.stringify(identity));
}
export async function applyNuvemshopLifecycleEvent(sql,payload){
 const storeId=String(payload?.store_id??''),event=payload?.event;
 if(!numericNuvemshopId(payload?.store_id))throw new Error('nuvemshop_store_id_invalid');
 if(['app/uninstalled','app/suspended','app/store_redact'].includes(event)){
  if(!sql?.query)throw new Error('nuvemshop_sql_required');
  const rows=await sql.query("delete from provider_oauth_credentials where provider='nuvemshop' and account_id=$1 returning account_id",[storeId]);
  return {credential_revoked:Array.isArray(rows)&&rows.length>0};
 }
 return {credential_revoked:false};
}
export async function processNuvemshopWebhook(sql,{payload,event,storeId,secret,env=process.env,sendPrivacyReport=sendNuvemshopPrivacyReport}){
 const deliveryKey=nuvemshopWebhookDeliveryKey(payload,event,secret),storeRef=hmac(secret,'nuvemshop-store:'+storeId);
 await sql.query('begin');
 try{
  await sql.query("select pg_advisory_xact_lock(hashtextextended('nuvemshop:'||$1,0))",[storeId]);
  const prior=await sql.query('select outcome from nuvemshop_webhook_receipts where delivery_key=$1',[deliveryKey]);
  if(prior.length){await sql.query('commit');return {...prior[0].outcome,duplicate:true};}
  const known=await sql.query('select store_id from nuvemshop_connections where store_id=$1 union select $1::text as store_id from nuvemshop_webhook_receipts where store_ref=$2 limit 1',[storeId,storeRef]);
  if(!known.length)throw new Error('nuvemshop_store_identity_mismatch');
  const claimed=await sql.query('insert into nuvemshop_webhook_receipts(delivery_key,store_ref,event) values($1,$2,$3) on conflict(delivery_key) do nothing returning delivery_key',[deliveryKey,storeRef,event]);
  if(!claimed.length){const duplicate=await sql.query('select outcome from nuvemshop_webhook_receipts where delivery_key=$1',[deliveryKey]);if(!duplicate.length)throw new Error('nuvemshop_webhook_dedup_failed');await sql.query('commit');return {...duplicate[0].outcome,duplicate:true};}
  const lifecycle=await applyNuvemshopLifecycleEvent(sql,{...payload,event});
  if(event==='app/store_redact'){
   await sql.query('delete from nuvemshop_pending_credentials where account_id=$1',[storeId]);
   await sql.query('delete from nuvemshop_connections where store_id=$1',[storeId]);
   await sql.query('delete from nuvemshop_webhook_receipts where store_ref=$1 and delivery_key<>$2',[storeRef,deliveryKey]);
  }else if(['app/suspended','app/uninstalled','app/resumed'].includes(event)){
   const status=event==='app/suspended'?'suspended':event==='app/uninstalled'?'uninstalled':'authorization_required';
   await sql.query('update nuvemshop_connections set status=$2,updated_at=now() where store_id=$1',[storeId,status]);
  }
  const report=event==='customers/data_request'?await sendPrivacyReport(sql,{storeId,requestId:String(payload.data_request.id),deliveryKey,env}):{};
  const outcome={...lifecycle,...report,...(privacy.includes(event)?{privacy_processed:true,customer_payloads_stored:false,customer_data:[],store_data_redacted:event==='app/store_redact'}:{})};
  await sql.query('update nuvemshop_webhook_receipts set outcome=$2::jsonb where delivery_key=$1',[deliveryKey,JSON.stringify(outcome)]);
  await sql.query('commit');return {...outcome,duplicate:false};
 }catch(error){await sql.query('rollback').catch(()=>{});throw error;}
}
async function connectDatabase(env){
 if(!env.DATABASE_URL)throw new Error('database_required');const pool=new Pool({connectionString:env.DATABASE_URL});
 try{const client=await pool.connect();return {query:(t,a)=>client.query(t,a).then(r=>r.rows),close:async()=>{client.release();await pool.end();}};}
 catch{await pool.end().catch(()=>{});throw new Error('database_required');}
}
export function createNuvemshopWebhookHandler({env=process.env,connect=()=>connectDatabase(env),sendPrivacyReport=sendNuvemshopPrivacyReport}={}){
 return async function handler(req,res){
  res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
  if(req.method!=='POST'){res.setHeader('allow','POST');return json(res,405,{error:'method_not_allowed',accepted:false});}
  if(!env.NUVEMSHOP_CLIENT_SECRET)return json(res,503,{error:'nuvemshop_webhook_secret_missing',accepted:false});
  const raw=req.rawBody;
  if(!verifyNuvemshopWebhook(raw,req.headers?.['x-linkedstore-hmac-sha256'],env.NUVEMSHOP_CLIENT_SECRET))return json(res,401,{error:'nuvemshop_webhook_signature_invalid',accepted:false});
  let payload,identity;
  try{payload=JSON.parse(raw.toString('utf8'));const q=new URL(req.url||'', 'https://zevanory.api.br').searchParams;identity=validateNuvemshopWebhookPayload(payload,{privacyEvent:q.get('privacy_event')||'',env});}
  catch(error){return json(res,400,{error:/^nuvemshop_[a-z_]+$/.test(String(error?.message))?error.message:'nuvemshop_webhook_payload_invalid',accepted:false});}
  let sql;
  try{sql=await connect();const result=await processNuvemshopWebhook(sql,{payload,...identity,secret:env.NUVEMSHOP_CLIENT_SECRET,env,sendPrivacyReport});return json(res,200,{provider:'nuvemshop',accepted:true,event:identity.event,commercial_enabled:false,...result});}
  catch(error){return json(res,error?.message==='nuvemshop_store_identity_mismatch'?401:503,{provider:'nuvemshop',accepted:false,error:error?.message==='nuvemshop_store_identity_mismatch'?error.message:'nuvemshop_webhook_processing_failed',commercial_enabled:false});}
  finally{if(sql)await sql.close?.().catch(()=>{});}
 };
}
export default createNuvemshopWebhookHandler();
