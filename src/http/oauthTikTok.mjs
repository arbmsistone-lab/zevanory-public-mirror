import { Pool } from '@neondatabase/serverless';
import { createTikTokOAuthStart, exchangeTikTokCode, fetchTikTokBasicUser, fetchTikTokCreator, persistTikTokTokens, readTikTokOAuthCookie } from '../tiktokOAuth.mjs';
import { preserveOAuthCredential } from '../oauthPersistenceFabric.mjs';

const json=(res,status,body)=>{res.statusCode=status;return res.end(JSON.stringify(body));};
const cookieValue=(req,name)=>String(req.headers?.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(`${name}=`))?.slice(name.length+1)||'';
const queryFrom=(req)=>{try{return new URL(req.url||'','https://zevanory.api.br').searchParams;}catch{return new URLSearchParams();}};
const COOKIE='zevanory_tiktok_oauth';
const oauthMode=(value)=>String(value||'').toLowerCase()==='sandbox'?'sandbox':'production';

export default async function handler(req,res){
  res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
  if(req.method!=='GET')return json(res,405,{error:'method_not_allowed'});
  const q=queryFrom(req),action=String(q.get('action')||req.query?.action||'').toLowerCase();
  if(action==='start'){
    const mode=oauthMode(q.get('mode')||req.query?.mode);
    try{const start=createTikTokOAuthStart(process.env,{mode});res.setHeader('set-cookie',`${COOKIE}=${start.cookie}; HttpOnly; Secure; SameSite=Lax; Path=/api/oauth/tiktok; Max-Age=600`);res.statusCode=302;res.setHeader('location',start.url);return res.end();}
    catch(error){return json(res,503,{provider:'tiktok',mode,ready:false,error:String(error.message||'oauth_start_failed')});}
  }
  const code=String(q.get('code')||req.query?.code||'').trim(),state=String(q.get('state')||req.query?.state||'').trim();
  const providerError=String(q.get('error')||req.query?.error||'').trim();
  if(!code&&!providerError)return json(res,200,{provider:'tiktok',ready:false,callback_registered:true,authorization_enabled:Boolean(process.env.TIKTOK_CLIENT_SECRET),sandbox_authorization_enabled:Boolean(process.env.TIKTOK_SANDBOX_CLIENT_KEY&&process.env.TIKTOK_SANDBOX_CLIENT_SECRET)});
  if(providerError)return json(res,400,{provider:'tiktok',ready:false,error:'oauth_provider_denied'});
  let pool;
  try{
    const session=readTikTokOAuthCookie(cookieValue(req,COOKIE),state,process.env);
    const mode=oauthMode(session.mode);
    const token=await exchangeTikTokCode({code,env:process.env,mode});
    const expected=String(process.env.TIKTOK_EXPECTED_USERNAME||'').trim().replace(/^@/,'').toLowerCase();
    let identity={username:null,nickname:null,identityMatch:null,videoPublishAuthorized:false};
    if(mode==='sandbox'){
      const basic=await fetchTikTokBasicUser(token.access_token);
      identity={username:null,nickname:basic.displayName,identityMatch:null,videoPublishAuthorized:false};
    }else{
      const creator=await fetchTikTokCreator(token.access_token);
      if(expected&&creator.username.toLowerCase()!==expected)throw new Error('tiktok_identity_mismatch');
      identity={username:creator.username,nickname:creator.nickname,identityMatch:expected?true:null,videoPublishAuthorized:true};
    }
    if(!process.env.DATABASE_URL){
      const recovery=await preserveOAuthCredential({provider:'tiktok',subjectRef:identity.username||identity.nickname||'authorized',token,identity,mode});
      res.setHeader('set-cookie',`${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/api/oauth/tiktok; Max-Age=0`);
      return json(res,recovery.preserved?202:503,{provider:'tiktok',mode,connected:false,credential_preserved:recovery.preserved,reconciliation_required:true,username:identity.username,nickname:identity.nickname,commercial_enabled:false});
    }
    pool=new Pool({connectionString:process.env.DATABASE_URL});const client=await pool.connect();
    try{await persistTikTokTokens({query:(text,args)=>client.query(text,args).then(r=>r.rows)},{token,env:process.env,mode});}
    catch(error){const recovery=await preserveOAuthCredential({provider:'tiktok',subjectRef:identity.username||identity.nickname||'authorized',token,identity,mode});res.setHeader('set-cookie',`${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/api/oauth/tiktok; Max-Age=0`);return json(res,recovery.preserved?202:503,{provider:'tiktok',mode,connected:false,credential_preserved:recovery.preserved,reconciliation_required:true,error:recovery.preserved?undefined:'oauth_persistence_failed'});}
    finally{client.release();}
    res.setHeader('set-cookie',`${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/api/oauth/tiktok; Max-Age=0`);
    return json(res,200,{provider:'tiktok',mode,connected:true,username:identity.username,nickname:identity.nickname,video_publish_authorized:identity.videoPublishAuthorized,tokens_stored_encrypted:true,identity_match:identity.identityMatch,commercial_enabled:false});
  }catch(error){return json(res,503,{provider:'tiktok',connected:false,error:String(error.message||'oauth_callback_failed')});}
  finally{if(pool)await pool.end().catch(()=>{});}
}
