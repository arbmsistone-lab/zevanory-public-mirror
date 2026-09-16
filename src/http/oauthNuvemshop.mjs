import { Pool } from '@neondatabase/serverless';
import { createNuvemshopOAuthStart, readNuvemshopOAuthCookie, exchangeNuvemshopCode } from '../nuvemshopOAuth.mjs';
import { preserveOAuthCredential } from '../oauthPersistenceFabric.mjs';
import { registerNuvemshopSession, consumeNuvemshopSession, stageNuvemshopCredential, reconcileNuvemshopCredential, maskedNuvemshopStoreId } from '../nuvemshopIntegrationSecurity.mjs';
import { safeBearerEqual } from '../security.mjs';
const COOKIE='zevanory_nuvemshop_oauth';
const json=(res,status,body)=>{res.statusCode=status;return res.end(JSON.stringify(body));};
const clearCookie=res=>res.setHeader('set-cookie',COOKIE+'=; HttpOnly; Secure; SameSite=Lax; Path=/api/oauth/nuvemshop; Max-Age=0');
const cookie=req=>String(req.headers?.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1)||'';
const safeError=error=>/^(nuvemshop|commercial_oauth)_[a-z0-9_]+$/.test(String(error?.message))?error.message:'nuvemshop_oauth_callback_failed';
async function connectDatabase(env){
 if(!env.DATABASE_URL)throw new Error('nuvemshop_database_unavailable');
 const pool=new Pool({connectionString:env.DATABASE_URL});
 try{const client=await pool.connect();return {query:(text,args)=>client.query(text,args).then(r=>r.rows),close:async()=>{client.release();await pool.end();}};}
 catch{await pool.end().catch(()=>{});throw new Error('nuvemshop_database_unavailable');}
}
export function createNuvemshopOAuthHandler({env=process.env,connect=()=>connectDatabase(env),exchange=exchangeNuvemshopCode,reconcile=reconcileNuvemshopCredential,preserve=preserveOAuthCredential}={}){
 return async function handler(req,res){
  res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.setHeader('referrer-policy','no-referrer');res.setHeader('x-content-type-options','nosniff');
  const q=new URL(req.url||'', 'https://zevanory.api.br').searchParams;
  if(['action','code','state','error'].some(key=>q.getAll(key).length>1))return json(res,400,{provider:'nuvemshop',connected:false,error:'nuvemshop_oauth_query_invalid'});
  const action=q.get('action')||'';
  const operatorAction=['reconcile','status'].includes(action);
  if(req.method!==(action==='reconcile'?'POST':'GET')){res.setHeader('allow',action==='reconcile'?'POST':'GET');return json(res,405,{error:'method_not_allowed'});}
  if(operatorAction){
   const supplied=String(req.headers?.authorization||'').replace(/^Bearer\s+/i,'');
   if(!safeBearerEqual(String(env.FULFILLMENT_OPERATOR_TOKEN||''),supplied))return json(res,401,{error:'operator_auth_required'});
  }
  let sql;
  try{
   if(action==='start'){
    if(!env.NUVEMSHOP_CLIENT_SECRET)throw new Error('nuvemshop_oauth_config_missing');
    const s=createNuvemshopOAuthStart(env);sql=await connect();await registerNuvemshopSession(sql,s);
    res.setHeader('set-cookie',COOKIE+'='+s.cookie+'; HttpOnly; Secure; SameSite=Lax; Path=/api/oauth/nuvemshop; Max-Age=600');res.statusCode=302;res.setHeader('location',s.url);return res.end();
   }
   if(action==='status'){
    sql=await connect();const rows=await sql.query('select store_id,storefront_host,status,read_only_api_verified_at,webhooks_registered_at from nuvemshop_connections order by updated_at desc limit 1');
    const pending=await sql.query('select count(*)::int as count from nuvemshop_pending_credentials');
    const deliveries=await sql.query('select event,count(*)::int as count from nuvemshop_webhook_receipts group by event');
    return json(res,200,{provider:'nuvemshop',connection:rows[0]?{...rows[0],store_id:maskedNuvemshopStoreId(rows[0].store_id)}:null,pending_credentials:pending[0]?.count||0,webhook_deliveries:deliveries,customer_payloads_stored:false,commercial_enabled:false});
   }
   if(action==='reconcile'){
    sql=await connect();const rows=await sql.query('select session_hash from nuvemshop_pending_credentials order by created_at desc limit 1');
    if(!rows.length)return json(res,409,{provider:'nuvemshop',connected:false,error:'nuvemshop_pending_credential_missing',commercial_enabled:false});
    const result=await reconcile(sql,{sessionHash:rows[0].session_hash,env});return json(res,200,result);
   }
   const code=q.get('code')||'',state=q.get('state')||'';
   if(q.has('error')){clearCookie(res);return json(res,400,{provider:'nuvemshop',connected:false,error:'oauth_provider_denied',commercial_enabled:false});}
   if(!code&&!state)return json(res,200,{provider:'nuvemshop',connected:false,callback_registered:true,authorization_enabled:Boolean(env.NUVEMSHOP_APP_ID&&env.NUVEMSHOP_CLIENT_SECRET&&env.COMMERCIAL_OAUTH_ENCRYPTION_KEY),commercial_enabled:false});
   if(!code||code.length>2000||!state||state.length>200||code.trim()!==code||state.trim()!==state){clearCookie(res);return json(res,400,{provider:'nuvemshop',connected:false,error:'nuvemshop_oauth_query_invalid',commercial_enabled:false});}
   const value=cookie(req);
   try{readNuvemshopOAuthCookie(value,state,env);}catch{clearCookie(res);return json(res,400,{provider:'nuvemshop',connected:false,error:'nuvemshop_oauth_session_invalid',commercial_enabled:false});}
   sql=await connect();const sessionHash=await consumeNuvemshopSession(sql,{cookie:value,state});clearCookie(res);
   const token=await exchange({code,env});
   try{await stageNuvemshopCredential(sql,{sessionHash,token,env});}
   catch{
    const recovery=await preserve({provider:'nuvemshop',subjectRef:String(token.user_id||'authorized'),token,identity:{store_id:String(token.user_id||'')}},{env});clearCookie(res);
    return json(res,recovery.preserved?202:503,{provider:'nuvemshop',connected:false,credential_preserved:recovery.preserved,reconciliation_required:true,error:recovery.preserved?undefined:'oauth_persistence_failed',commercial_enabled:false});
   }
   try{return json(res,200,await reconcile(sql,{sessionHash,env}));}
   catch(error){return json(res,202,{provider:'nuvemshop',connected:false,credential_preserved:true,tokens_stored_encrypted:true,reconciliation_required:true,error:safeError(error),commercial_enabled:false});}
  }catch(error){if(action!=='start'&&!operatorAction)clearCookie(res);const code=safeError(error);return json(res,/session|query|ciphertext/.test(code)?400:503,{provider:'nuvemshop',connected:false,error:code,commercial_enabled:false});}
  finally{if(sql)await sql.close?.().catch(()=>{});}
 };
}
export default createNuvemshopOAuthHandler();
