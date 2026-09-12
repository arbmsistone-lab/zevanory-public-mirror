import { Pool } from '@neondatabase/serverless';
import { createNuvemshopOAuthStart, readNuvemshopOAuthCookie, exchangeNuvemshopCode, persistNuvemshopCredential, ensureNuvemshopWebhooks } from '../nuvemshopOAuth.mjs';
import { preserveOAuthCredential } from '../oauthPersistenceFabric.mjs';
const COOKIE='zevanory_nuvemshop_oauth';
const json=(res,status,body)=>{res.statusCode=status;res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');return res.end(JSON.stringify(body));};
const query=(req)=>{try{return new URL(req.url||'', 'https://zevanory.api.br').searchParams;}catch{return new URLSearchParams();}};
const cookie=(req,name)=>String(req.headers?.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(`${name}=`))?.slice(name.length+1)||'';
export default async function handler(req,res){if(req.method!=='GET')return json(res,405,{error:'method_not_allowed'});const q=query(req),action=String(q.get('action')||'').toLowerCase();if(action==='start'){try{const s=createNuvemshopOAuthStart(process.env);res.setHeader('set-cookie',`${COOKIE}=${s.cookie}; HttpOnly; Secure; SameSite=Lax; Path=/api/oauth/nuvemshop; Max-Age=600`);res.statusCode=302;res.setHeader('location',s.url);return res.end();}catch(e){return json(res,503,{provider:'nuvemshop',connected:false,error:String(e.message||'oauth_start_failed')});}}
const code=String(q.get('code')||'').trim(),state=String(q.get('state')||'').trim(),providerError=String(q.get('error')||'').trim();if(!code&&!providerError)return json(res,200,{provider:'nuvemshop',connected:false,callback_registered:true,authorization_enabled:Boolean(process.env.NUVEMSHOP_APP_ID&&process.env.NUVEMSHOP_CLIENT_SECRET)});if(providerError)return json(res,400,{provider:'nuvemshop',connected:false,error:'oauth_provider_denied'});
let pool;try{
  readNuvemshopOAuthCookie(cookie(req,COOKIE),state,process.env);
  const token=await exchangeNuvemshopCode({code,env:process.env});
  const storeId=String(token.user_id||'').trim();
  if(!process.env.DATABASE_URL){
    const recovery=await preserveOAuthCredential({provider:'nuvemshop',subjectRef:storeId||'authorized',token,identity:{store_id:storeId}});
    res.setHeader('set-cookie',`${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/api/oauth/nuvemshop; Max-Age=0`);
    return json(res,recovery.preserved?202:503,{provider:'nuvemshop',connected:false,credential_preserved:recovery.preserved,reconciliation_required:true,store_id:storeId||null,commercial_enabled:false});
  }
  pool=new Pool({connectionString:process.env.DATABASE_URL});const client=await pool.connect();
  try{await persistNuvemshopCredential({query:(t,a)=>client.query(t,a).then(r=>r.rows)},{token,env:process.env});}
  catch{const recovery=await preserveOAuthCredential({provider:'nuvemshop',subjectRef:storeId||'authorized',token,identity:{store_id:storeId}});res.setHeader('set-cookie',`${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/api/oauth/nuvemshop; Max-Age=0`);return json(res,recovery.preserved?202:503,{provider:'nuvemshop',connected:false,credential_preserved:recovery.preserved,reconciliation_required:true,error:recovery.preserved?undefined:'oauth_persistence_failed'});}
  finally{client.release();}
  try{
    const webhooks=await ensureNuvemshopWebhooks({token,env:process.env});
    res.setHeader('set-cookie',`${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/api/oauth/nuvemshop; Max-Age=0`);
    return json(res,200,{provider:'nuvemshop',connected:true,store_id:storeId,tokens_stored_encrypted:true,webhooks_ready:webhooks.ready,required_webhooks:webhooks.required.length,commercial_enabled:false});
  }catch(error){
    res.setHeader('set-cookie',`${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/api/oauth/nuvemshop; Max-Age=0`);
    return json(res,202,{provider:'nuvemshop',connected:true,store_id:storeId,tokens_stored_encrypted:true,webhooks_ready:false,reconciliation_required:true,error:String(error?.message||'nuvemshop_webhook_setup_failed').slice(0,120),commercial_enabled:false});
  }
}catch(e){return json(res,503,{provider:'nuvemshop',connected:false,error:String(e.message||'oauth_callback_failed')});}finally{if(pool)await pool.end().catch(()=>{});}}
