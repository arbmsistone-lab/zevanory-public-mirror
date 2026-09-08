import { Pool } from '@neondatabase/serverless';
import { createLinkedInOAuthStart, readLinkedInOAuthCookie, exchangeLinkedInCode, fetchLinkedInMe, persistLinkedInCredential } from '../linkedinOAuth.mjs';
import { preserveOAuthCredential } from '../oauthPersistenceFabric.mjs';
const COOKIE='zevanory_linkedin_oauth';
const json=(res,status,body)=>{res.statusCode=status;res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');return res.end(JSON.stringify(body));};
const query=(req)=>{try{return new URL(req.url||'', 'https://zevanory.api.br').searchParams;}catch{return new URLSearchParams();}};
const cookie=(req,name)=>String(req.headers?.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(`${name}=`))?.slice(name.length+1)||'';
export default async function handler(req,res){if(req.method!=='GET')return json(res,405,{error:'method_not_allowed'});const q=query(req),action=String(q.get('action')||'').toLowerCase();if(action==='start'){try{const s=createLinkedInOAuthStart(process.env);res.setHeader('set-cookie',`${COOKIE}=${s.cookie}; HttpOnly; Secure; SameSite=Lax; Path=/api/oauth/linkedin; Max-Age=600`);res.statusCode=302;res.setHeader('location',s.url);return res.end();}catch(e){return json(res,503,{provider:'linkedin',connected:false,error:String(e.message||'oauth_start_failed')});}}
const code=String(q.get('code')||'').trim(),state=String(q.get('state')||'').trim(),providerError=String(q.get('error')||'').trim();if(!code&&!providerError)return json(res,200,{provider:'linkedin',connected:false,callback_registered:true,authorization_enabled:Boolean(process.env.LINKEDIN_CLIENT_ID&&process.env.LINKEDIN_CLIENT_SECRET)});if(providerError)return json(res,400,{provider:'linkedin',connected:false,error:'oauth_provider_denied'});
let pool;try{
  readLinkedInOAuthCookie(cookie(req,COOKIE),state,process.env);
  const token=await exchangeLinkedInCode({code,env:process.env});
  const me=await fetchLinkedInMe(token.access_token);
  if(!process.env.DATABASE_URL){
    const recovery=await preserveOAuthCredential({provider:'linkedin',subjectRef:me.id,token,identity:{person_id:me.id,author_urn:me.authorUrn}});
    res.setHeader('set-cookie',`${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/api/oauth/linkedin; Max-Age=0`);
    return json(res,recovery.preserved?202:503,{provider:'linkedin',connected:false,credential_preserved:recovery.preserved,reconciliation_required:true,author_urn:me.authorUrn,commercial_enabled:false});
  }
  pool=new Pool({connectionString:process.env.DATABASE_URL});const client=await pool.connect();
  try{await persistLinkedInCredential({query:(t,a)=>client.query(t,a).then(r=>r.rows)},{token,personId:me.id,env:process.env});}
  catch{const recovery=await preserveOAuthCredential({provider:'linkedin',subjectRef:me.id,token,identity:{person_id:me.id,author_urn:me.authorUrn}});res.setHeader('set-cookie',`${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/api/oauth/linkedin; Max-Age=0`);return json(res,recovery.preserved?202:503,{provider:'linkedin',connected:false,credential_preserved:recovery.preserved,reconciliation_required:true,error:recovery.preserved?undefined:'oauth_persistence_failed'});}
  finally{client.release();}
  res.setHeader('set-cookie',`${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/api/oauth/linkedin; Max-Age=0`);
  return json(res,200,{provider:'linkedin',connected:true,author_urn:me.authorUrn,tokens_stored_encrypted:true,commercial_enabled:false});
}catch(e){return json(res,503,{provider:'linkedin',connected:false,error:String(e.message||'oauth_callback_failed')});}finally{if(pool)await pool.end().catch(()=>{});}}
