import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

export const TIKTOK_REDIRECT_URI='https://zevanory.api.br/api/oauth/tiktok/callback';
const AUTH_URL='https://www.tiktok.com/v2/auth/authorize/';
const TOKEN_URL='https://open.tiktokapis.com/v2/oauth/token/';
const CREATOR_URL='https://open.tiktokapis.com/v2/post/publish/creator_info/query/';
const USER_INFO_URL='https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name';
const PRODUCTION_SCOPES='user.info.basic,video.publish';
const SANDBOX_SCOPES='user.info.basic';
const clean=(v,max=4000)=>String(v??'').trim().slice(0,max);
const b64u=(buf)=>Buffer.from(buf).toString('base64url');
const keyFrom=(env)=>{const raw=Buffer.from(clean(env.TIKTOK_TOKEN_ENCRYPTION_KEY,200),'base64');if(raw.length!==32)throw new Error('tiktok_encryption_key_invalid');return raw;};
const oauthMode=(value)=>String(value||'').toLowerCase()==='sandbox'?'sandbox':'production';
const credentialProvider=(mode)=>oauthMode(mode)==='sandbox'?'tiktok_sandbox':'tiktok';
const oauthClient=(env,mode)=>{const sandbox=oauthMode(mode)==='sandbox';return {mode:sandbox?'sandbox':'production',clientKey:clean(sandbox?env.TIKTOK_SANDBOX_CLIENT_KEY:env.TIKTOK_CLIENT_KEY,200),clientSecret:clean(sandbox?env.TIKTOK_SANDBOX_CLIENT_SECRET:env.TIKTOK_CLIENT_SECRET,1000)};};

export function encryptTikTokSecret(value,env=process.env){
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',keyFrom(env),iv);
  const data=Buffer.concat([cipher.update(String(value),'utf8'),cipher.final()]);
  return [b64u(iv),b64u(cipher.getAuthTag()),b64u(data)].join('.');
}
export function decryptTikTokSecret(value,env=process.env){
  const parts=String(value||'').split('.');if(parts.length!==3)throw new Error('tiktok_ciphertext_invalid');
  const [iv,tag,data]=parts.map((x)=>Buffer.from(x,'base64url'));
  const decipher=createDecipheriv('aes-256-gcm',keyFrom(env),iv);decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data),decipher.final()]).toString('utf8');
}
export function createTikTokOAuthStart(env=process.env,{mode='production'}={}){
  const cfg=oauthClient(env,mode);if(!cfg.clientKey)throw new Error(cfg.mode==='sandbox'?'tiktok_sandbox_client_key_missing':'tiktok_client_key_missing');
  const state=b64u(randomBytes(24));
  const cookie=encryptTikTokSecret(JSON.stringify({state,iat:Date.now(),mode:cfg.mode}),env);
  const scopes=cfg.mode==='sandbox'?SANDBOX_SCOPES:PRODUCTION_SCOPES;
  const url=new URL(AUTH_URL);url.searchParams.set('client_key',cfg.clientKey);url.searchParams.set('scope',scopes);
  url.searchParams.set('response_type','code');url.searchParams.set('redirect_uri',TIKTOK_REDIRECT_URI);url.searchParams.set('state',state);
  return {url:url.toString(),cookie,mode:cfg.mode};
}
export function readTikTokOAuthCookie(value,expectedState,env=process.env){
  const parsed=JSON.parse(decryptTikTokSecret(value,env));
  const a=Buffer.from(clean(parsed.state,200)),b=Buffer.from(clean(expectedState,200));
  if(!a.length||a.length!==b.length||!timingSafeEqual(a,b))throw new Error('tiktok_oauth_state_invalid');
  if(Date.now()-Number(parsed.iat)>10*60*1000)throw new Error('tiktok_oauth_state_expired');
  return parsed;
}
export async function exchangeTikTokCode({code,env=process.env,fetchImpl=globalThis.fetch,mode='production'}={}){
  const cfg=oauthClient(env,mode),clientKey=cfg.clientKey,clientSecret=cfg.clientSecret;
  if(!clientKey||!clientSecret)throw new Error(cfg.mode==='sandbox'?'tiktok_sandbox_oauth_config_missing':'tiktok_oauth_config_missing');
  const body=new URLSearchParams({client_key:clientKey,client_secret:clientSecret,code:clean(code),grant_type:'authorization_code',redirect_uri:TIKTOK_REDIRECT_URI});
  const response=await fetchImpl(TOKEN_URL,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','cache-control':'no-cache'},body});
  const token=await response.json().catch(()=>({}));if(!response.ok)throw new Error(`tiktok_token_http_${response.status}`);
  if(!clean(token.access_token)||!clean(token.refresh_token)||!clean(token.open_id))throw new Error('tiktok_token_invalid');
  if(cfg.mode==='production'&&!String(token.scope||'').split(',').map(x=>x.trim()).includes('video.publish'))throw new Error('tiktok_video_publish_scope_missing');
  return token;
}
export async function fetchTikTokBasicUser(accessToken,fetchImpl=globalThis.fetch){
  const response=await fetchImpl(USER_INFO_URL,{headers:{authorization:`Bearer ${clean(accessToken)}`}});
  const body=await response.json().catch(()=>({}));if(!response.ok||body?.error?.code!=='ok')throw new Error(`tiktok_user_info_http_${response.status}`);
  const user=body?.data?.user||{};if(!clean(user.open_id))throw new Error('tiktok_user_open_id_missing');
  return {openId:clean(user.open_id,300),displayName:clean(user.display_name,200)};
}
export async function fetchTikTokCreator(accessToken,fetchImpl=globalThis.fetch){
  const response=await fetchImpl(CREATOR_URL,{method:'POST',headers:{authorization:`Bearer ${clean(accessToken)}`,'content-type':'application/json; charset=UTF-8'}});
  const body=await response.json().catch(()=>({}));if(!response.ok||body?.error?.code!=='ok')throw new Error(`tiktok_creator_http_${response.status}`);
  const username=clean(body?.data?.creator_username,200).replace(/^@/,'');if(!username)throw new Error('tiktok_creator_username_missing');
  return {username,nickname:clean(body?.data?.creator_nickname,200)};
}
export async function persistTikTokTokens(sql,{token,env=process.env,mode='production'}){
  if(!sql?.query)throw new Error('tiktok_sql_required');
  const provider=credentialProvider(mode),expires=Math.max(60,Number(token.expires_in)||86400);
  const rows=await sql.query(`insert into provider_oauth_credentials(provider,account_id,access_token_enc,refresh_token_enc,token_type,scope,expires_at,updated_at)
    values('${provider}',$1,$2,$3,$4,$5,now()+($6::text||' seconds')::interval,now())
    on conflict(provider) do update set account_id=excluded.account_id,access_token_enc=excluded.access_token_enc,refresh_token_enc=excluded.refresh_token_enc,token_type=excluded.token_type,scope=excluded.scope,expires_at=excluded.expires_at,updated_at=now()
    returning account_id,expires_at`,[clean(token.open_id,300),encryptTikTokSecret(token.access_token,env),encryptTikTokSecret(token.refresh_token,env),clean(token.token_type,40)||'Bearer',clean(token.scope,1000),expires]);
  return rows[0];
}
export async function loadTikTokCredential(sql,env=process.env,{mode='production'}={}){
  if(!sql?.query)throw new Error('tiktok_sql_required');
  const provider=credentialProvider(mode);
  const rows=await sql.query(`select account_id,access_token_enc,refresh_token_enc,token_type,scope,expires_at from provider_oauth_credentials where provider='${provider}' limit 1`);
  const row=rows[0];if(!row)throw new Error(mode==='sandbox'?'tiktok_sandbox_oauth_credential_missing':'tiktok_oauth_credential_missing');
  return {...row,access_token:decryptTikTokSecret(row.access_token_enc,env),refresh_token:decryptTikTokSecret(row.refresh_token_enc,env)};
}
export async function refreshTikTokCredential(sql,credential,{env=process.env,fetchImpl=globalThis.fetch,mode='production'}={}){
  const cfg=oauthClient(env,mode),clientKey=cfg.clientKey,clientSecret=cfg.clientSecret;
  if(!clientKey||!clientSecret)throw new Error(cfg.mode==='sandbox'?'tiktok_sandbox_oauth_refresh_config_missing':'tiktok_oauth_refresh_config_missing');
  const body=new URLSearchParams({client_key:clientKey,client_secret:clientSecret,grant_type:'refresh_token',refresh_token:clean(credential.refresh_token)});
  const response=await fetchImpl(TOKEN_URL,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','cache-control':'no-cache'},body});
  const token=await response.json().catch(()=>({}));if(!response.ok)throw new Error(`tiktok_refresh_http_${response.status}`);
  if(!clean(token.access_token))throw new Error('tiktok_refresh_token_invalid');
  token.refresh_token=clean(token.refresh_token)||credential.refresh_token;token.open_id=clean(token.open_id)||String(credential.account_id);
  await persistTikTokTokens(sql,{token,env,mode});return loadTikTokCredential(sql,env,{mode});
}
