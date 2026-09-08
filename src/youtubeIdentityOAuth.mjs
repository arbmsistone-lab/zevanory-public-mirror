import {newOAuthState,sealOAuthSession,openOAuthSession,assertOAuthState,encryptCommercialSecret,decryptCommercialSecret} from './commercialOAuthCrypto.mjs';
export const YOUTUBE_IDENTITY_REDIRECT_URI='https://zevanory.api.br/api/oauth/youtube/callback';
const AUTH='https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN='https://oauth2.googleapis.com/token';
const SCOPE='https://www.googleapis.com/auth/youtube.force-ssl';
const clean=(v,max=4000)=>String(v??'').trim().slice(0,max);
const json=async r=>{try{return await r.json()}catch{return {}}};
export function createYouTubeIdentityOAuthStart(env=process.env){
 const id=clean(env.YOUTUBE_OAUTH_CLIENT_ID,500);if(!id)throw new Error('youtube_oauth_client_id_missing');
 const state=newOAuthState(),cookie=sealOAuthSession({state,provider:'youtube_identity'},env);
 const u=new URL(AUTH);u.searchParams.set('client_id',id);u.searchParams.set('redirect_uri',YOUTUBE_IDENTITY_REDIRECT_URI);u.searchParams.set('response_type','code');
 u.searchParams.set('scope',SCOPE);u.searchParams.set('access_type','offline');u.searchParams.set('prompt','consent');u.searchParams.set('include_granted_scopes','true');u.searchParams.set('state',state);
 return {url:u.toString(),cookie,state};
}
export function readYouTubeIdentityOAuthCookie(value,state,env=process.env){const p=openOAuthSession(value,env);if(p.provider!=='youtube_identity')throw new Error('youtube_oauth_session_invalid');assertOAuthState(p.state,state);return p;}
export async function exchangeYouTubeIdentityCode({code,env=process.env,fetchImpl=globalThis.fetch}={}){
 const body=new URLSearchParams({client_id:clean(env.YOUTUBE_OAUTH_CLIENT_ID,500),client_secret:clean(env.YOUTUBE_OAUTH_CLIENT_SECRET,1000),code:clean(code,1000),grant_type:'authorization_code',redirect_uri:YOUTUBE_IDENTITY_REDIRECT_URI});
 const r=await fetchImpl(TOKEN,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});const b=await json(r);if(!r.ok)throw new Error(`youtube_identity_token_http_${r.status}`);
 if(!clean(b.access_token)||!clean(b.refresh_token))throw new Error('youtube_identity_refresh_token_missing');
 const scopes=clean(b.scope,2000).split(' ').filter(Boolean);if(!scopes.includes(SCOPE))throw new Error('youtube_identity_scope_missing');return b;
}export async function fetchYouTubeIdentity(accessToken,fetchImpl=globalThis.fetch){
 const r=await fetchImpl('https://www.googleapis.com/youtube/v3/channels?part=id,snippet,brandingSettings&mine=true',{headers:{authorization:`Bearer ${clean(accessToken)}`}});const b=await json(r);if(!r.ok)throw new Error(`youtube_identity_http_${r.status}`);
 const x=(b.items||[]).find(i=>clean(i.id)==='UCMl8-SxMVv77S2tz2H63P3A');if(!x)throw new Error('youtube_identity_mismatch');return x;
}
export async function persistYouTubeIdentityCredential(sql,{token,channelId,env=process.env}={}){
 if(!sql?.query)throw new Error('youtube_identity_sql_required');const expires=Math.max(60,Number(token.expires_in)||3600);
 const rows=await sql.query(`insert into provider_oauth_credentials(provider,account_id,access_token_enc,refresh_token_enc,token_type,scope,expires_at,updated_at) values('youtube_identity',$1,$2,$3,$4,$5,now()+($6::text||' seconds')::interval,now()) on conflict(provider) do update set account_id=excluded.account_id,access_token_enc=excluded.access_token_enc,refresh_token_enc=excluded.refresh_token_enc,token_type=excluded.token_type,scope=excluded.scope,expires_at=excluded.expires_at,updated_at=now() returning account_id,expires_at`,[clean(channelId,300),encryptCommercialSecret(token.access_token,env),encryptCommercialSecret(token.refresh_token,env),clean(token.token_type,40)||'Bearer',clean(token.scope,2000),String(expires)]);return rows[0];
}
export async function updateYouTubeCanonicalDescription({accessToken,channel,description,fetchImpl=globalThis.fetch}={}){
 const branding={...(channel?.brandingSettings||{}),channel:{...(channel?.brandingSettings?.channel||{}),description:clean(description,1000)}};
 const r=await fetchImpl('https://www.googleapis.com/youtube/v3/channels?part=brandingSettings',{method:'PUT',headers:{authorization:`Bearer ${clean(accessToken)}`,'content-type':'application/json'},body:JSON.stringify({id:clean(channel?.id,300),brandingSettings:branding})});const b=await json(r);if(!r.ok)throw new Error(`youtube_identity_update_http_${r.status}`);return b;
}
export function decryptYouTubeIdentityRefreshToken(value,env=process.env){return decryptCommercialSecret(value,env);}