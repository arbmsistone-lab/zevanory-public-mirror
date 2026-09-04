import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const REDIRECT_URI='https://zevanory.api.br/api/oauth/mercadolivre/callback';
const AUTH_URL='https://auth.mercadolivre.com.br/authorization';
const TOKEN_URL='https://api.mercadolibre.com/oauth/token';
const ME_URL='https://api.mercadolibre.com/users/me';

const clean=(v,max=2000)=>String(v??'').trim().slice(0,max);
const b64u=(buf)=>Buffer.from(buf).toString('base64url');
const keyFrom=(env)=>{const raw=Buffer.from(clean(env.MERCADOLIVRE_TOKEN_ENCRYPTION_KEY,200),'base64');if(raw.length!==32)throw new Error('mercadolivre_encryption_key_invalid');return raw;};

export function encryptSecret(value,env=process.env){
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',keyFrom(env),iv);
  const data=Buffer.concat([cipher.update(String(value),'utf8'),cipher.final()]);
  return [b64u(iv),b64u(cipher.getAuthTag()),b64u(data)].join('.');
}

export function decryptSecret(value,env=process.env){
  const [iv,tag,data]=String(value||'').split('.').map((x)=>Buffer.from(x,'base64url'));
  const decipher=createDecipheriv('aes-256-gcm',keyFrom(env),iv);decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data),decipher.final()]).toString('utf8');
}

export function createOAuthStart(env=process.env){
  const clientId=clean(env.MERCADOLIVRE_APP_ID,40);if(!/^\d+$/.test(clientId))throw new Error('mercadolivre_app_id_missing');
  const state=b64u(randomBytes(24)),verifier=b64u(randomBytes(48));
  const challenge=b64u(createHash('sha256').update(verifier).digest());
  const payload=encryptSecret(JSON.stringify({state,verifier,iat:Date.now()}),env);
  const url=new URL(AUTH_URL);url.searchParams.set('response_type','code');url.searchParams.set('client_id',clientId);url.searchParams.set('redirect_uri',REDIRECT_URI);url.searchParams.set('state',state);url.searchParams.set('code_challenge',challenge);url.searchParams.set('code_challenge_method','S256');
  return {url:url.toString(),cookie:payload};
}

export function readOAuthCookie(value,expectedState,env=process.env){
  const parsed=JSON.parse(decryptSecret(value,env));
  const state=Buffer.from(clean(parsed.state,200)),expected=Buffer.from(clean(expectedState,200));
  if(state.length!==expected.length||!timingSafeEqual(state,expected))throw new Error('mercadolivre_oauth_state_invalid');
  if(Date.now()-Number(parsed.iat)>10*60*1000)throw new Error('mercadolivre_oauth_state_expired');
  if(!clean(parsed.verifier,200))throw new Error('mercadolivre_pkce_verifier_missing');
  return parsed;
}

export async function exchangeAuthorizationCode({code,verifier,env=process.env,fetchImpl=globalThis.fetch}={}){
  const body=new URLSearchParams({grant_type:'authorization_code',client_id:clean(env.MERCADOLIVRE_APP_ID,40),client_secret:clean(env.MERCADOLIVRE_CLIENT_SECRET,500),code:clean(code,2000),redirect_uri:REDIRECT_URI,code_verifier:clean(verifier,200)});
  if(!body.get('client_secret'))throw new Error('mercadolivre_client_secret_missing');
  const response=await fetchImpl(TOKEN_URL,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','accept':'application/json'},body});
  const token=await response.json().catch(()=>({}));if(!response.ok)throw new Error(`mercadolivre_token_http_${response.status}`);
  if(!clean(token.access_token)||!clean(token.refresh_token))throw new Error('mercadolivre_token_invalid');
  return token;
}

export async function fetchMercadoLivreMe(accessToken,fetchImpl=globalThis.fetch){
  const response=await fetchImpl(ME_URL,{headers:{authorization:`Bearer ${clean(accessToken,4000)}`,'accept':'application/json'}});
  const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(`mercadolivre_me_http_${response.status}`);
  const id=clean(body.id,40);if(!/^\d+$/.test(id))throw new Error('mercadolivre_seller_id_invalid');
  return {id,body};
}

export async function persistMercadoLivreTokens(sql,{sellerId,token,env=process.env}){
  const expires=Math.max(60,Number(token.expires_in)||21600);
  const rows=await sql.query(`insert into provider_oauth_credentials(provider,account_id,access_token_enc,refresh_token_enc,token_type,scope,expires_at,updated_at)
    values('mercado_livre',$1,$2,$3,$4,$5,now()+($6::text||' seconds')::interval,now())
    on conflict(provider) do update set account_id=excluded.account_id,access_token_enc=excluded.access_token_enc,refresh_token_enc=excluded.refresh_token_enc,token_type=excluded.token_type,scope=excluded.scope,expires_at=excluded.expires_at,updated_at=now()
    returning account_id,expires_at`,[sellerId,encryptSecret(token.access_token,env),encryptSecret(token.refresh_token,env),clean(token.token_type,40)||'Bearer',clean(token.scope,1000),expires]);
  return rows[0];
}
