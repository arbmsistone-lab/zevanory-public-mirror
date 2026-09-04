import { Pool } from '@neondatabase/serverless';
import { createTikTokOAuthStart, exchangeTikTokCode, fetchTikTokCreator, persistTikTokTokens, readTikTokOAuthCookie } from '../tiktokOAuth.mjs';

const json=(res,status,body)=>{res.statusCode=status;return res.end(JSON.stringify(body));};
const cookieValue=(req,name)=>String(req.headers?.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(`${name}=`))?.slice(name.length+1)||'';
const queryFrom=(req)=>{try{return new URL(req.url||'','https://zevanory.api.br').searchParams;}catch{return new URLSearchParams();}};
const COOKIE='zevanory_tiktok_oauth';

export default async function handler(req,res){
  res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
  if(req.method!=='GET')return json(res,405,{error:'method_not_allowed'});
  const q=queryFrom(req),action=String(q.get('action')||req.query?.action||'').toLowerCase();
  if(action==='start'){
    try{const start=createTikTokOAuthStart(process.env);res.setHeader('set-cookie',`${COOKIE}=${start.cookie}; HttpOnly; Secure; SameSite=Lax; Path=/api/oauth/tiktok; Max-Age=600`);res.statusCode=302;res.setHeader('location',start.url);return res.end();}
    catch(error){return json(res,503,{provider:'tiktok',ready:false,error:String(error.message||'oauth_start_failed')});}
  }
  const code=String(q.get('code')||req.query?.code||'').trim(),state=String(q.get('state')||req.query?.state||'').trim();
  const providerError=String(q.get('error')||req.query?.error||'').trim();
  if(!code&&!providerError)return json(res,200,{provider:'tiktok',ready:false,callback_registered:true,authorization_enabled:Boolean(process.env.TIKTOK_CLIENT_SECRET)});
  if(providerError)return json(res,400,{provider:'tiktok',ready:false,error:'oauth_provider_denied'});
  let pool;
  try{
    if(!process.env.DATABASE_URL)throw new Error('database_url_required');
    readTikTokOAuthCookie(cookieValue(req,COOKIE),state,process.env);
    const token=await exchangeTikTokCode({code,env:process.env});
    const creator=await fetchTikTokCreator(token.access_token);
    const expected=String(process.env.TIKTOK_EXPECTED_USERNAME||'').trim().replace(/^@/,'').toLowerCase();
    if(expected&&creator.username.toLowerCase()!==expected)throw new Error('tiktok_identity_mismatch');
    pool=new Pool({connectionString:process.env.DATABASE_URL});const client=await pool.connect();
    try{await persistTikTokTokens({query:(text,args)=>client.query(text,args).then(r=>r.rows)},{token,env:process.env});}finally{client.release();}
    res.setHeader('set-cookie',`${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/api/oauth/tiktok; Max-Age=0`);
    return json(res,200,{provider:'tiktok',connected:true,username:creator.username,nickname:creator.nickname,video_publish_authorized:true,tokens_stored_encrypted:true,identity_match:expected?true:null,commercial_enabled:false});
  }catch(error){return json(res,503,{provider:'tiktok',connected:false,error:String(error.message||'oauth_callback_failed')});}
  finally{if(pool)await pool.end().catch(()=>{});}
}
