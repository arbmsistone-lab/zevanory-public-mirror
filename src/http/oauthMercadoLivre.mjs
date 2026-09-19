import { Pool } from '@neondatabase/serverless';
import { createOAuthStart, exchangeAuthorizationCode, fetchMercadoLivreMe, persistMercadoLivreTokens, readOAuthCookie } from '../mercadoLivreOAuth.mjs';
import { preserveOAuthCredential } from '../oauthPersistenceFabric.mjs';

const json=(res,status,body)=>{res.statusCode=status;return res.end(JSON.stringify(body));};
const cookieValue=(req,name)=>String(req.headers?.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(`${name}=`))?.slice(name.length+1)||'';
const queryFrom=(req)=>{try{return new URL(req.url||'', 'https://zevanory.api.br').searchParams;}catch{return new URLSearchParams();}};
const COOKIE='zevanory_ml_oauth';

export function mercadoLivreOAuthCallbackReadiness(query={},env=process.env){
  const code=String(query.code||'').trim(),error=String(query.error||'').trim();
  if(code||error) return {status:503,body:{provider:'mercado_livre',ready:false,error:'oauth_exchange_not_enabled'}};
  return {status:200,body:{provider:'mercado_livre',ready:false,callback_registered:true,authorization_enabled:Boolean(env?.MERCADOLIVRE_CLIENT_SECRET)}};
}

export default async function handler(req,res){
  res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
  if(req.method!=='GET') return json(res,405,{error:'method_not_allowed'});
  const q=queryFrom(req),action=String(q.get('action')||req.query?.action||'').toLowerCase();
  if(action==='start'){
    try{const start=createOAuthStart(process.env);res.setHeader('set-cookie',`${COOKIE}=${start.cookie}; HttpOnly; Secure; SameSite=Lax; Path=/api/oauth/mercadolivre; Max-Age=600`);res.statusCode=302;res.setHeader('location',start.url);return res.end();}
    catch(error){return json(res,503,{provider:'mercado_livre',ready:false,error:String(error.message||'oauth_start_failed')});}
  }
  const code=String(q.get('code')||req.query?.code||'').trim(),state=String(q.get('state')||req.query?.state||'').trim(),providerError=String(q.get('error')||req.query?.error||'').trim();
  if(!code&&!providerError) return json(res,200,{provider:'mercado_livre',ready:false,callback_registered:true,authorization_enabled:Boolean(process.env.MERCADOLIVRE_CLIENT_SECRET)});
  if(providerError) return json(res,400,{provider:'mercado_livre',ready:false,error:'oauth_provider_denied'});
  let pool;
  try{
    const cookie=readOAuthCookie(cookieValue(req,COOKIE),state,process.env);
    const token=await exchangeAuthorizationCode({code,verifier:cookie.verifier,env:process.env});
    const me=await fetchMercadoLivreMe(token.access_token);
    const sellerId=String(me.id||'').trim();
    if(!process.env.DATABASE_URL){
      const recovery=await preserveOAuthCredential({provider:'mercado_livre',subjectRef:sellerId||'authorized',token,identity:{seller_id:sellerId}});
      res.setHeader('set-cookie',`${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/api/oauth/mercadolivre; Max-Age=0`);
      return json(res,recovery.preserved?202:503,{provider:'mercado_livre',connected:false,credential_preserved:recovery.preserved,reconciliation_required:true,seller_id:sellerId||null,commercial_enabled:false});
    }
    pool=new Pool({connectionString:process.env.DATABASE_URL});const client=await pool.connect();
    try{await persistMercadoLivreTokens({query:(text,args)=>client.query(text,args).then(r=>r.rows)},{sellerId:me.id,token,env:process.env});}
    catch{const recovery=await preserveOAuthCredential({provider:'mercado_livre',subjectRef:sellerId||'authorized',token,identity:{seller_id:sellerId}});res.setHeader('set-cookie',`${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/api/oauth/mercadolivre; Max-Age=0`);return json(res,recovery.preserved?202:503,{provider:'mercado_livre',connected:false,credential_preserved:recovery.preserved,reconciliation_required:true,error:recovery.preserved?undefined:'oauth_persistence_failed'});}
    finally{client.release();}
    res.setHeader('set-cookie',`${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/api/oauth/mercadolivre; Max-Age=0`);
    return json(res,200,{provider:'mercado_livre',connected:true,seller_id:me.id,tokens_stored_encrypted:true,commercial_enabled:false});
  }catch(error){return json(res,503,{provider:'mercado_livre',connected:false,error:String(error.message||'oauth_callback_failed')});}
  finally{if(pool)await pool.end().catch(()=>{});}
}

