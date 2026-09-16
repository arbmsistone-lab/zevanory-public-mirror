import { createCipheriv,createDecipheriv,randomBytes,createHash,timingSafeEqual } from 'node:crypto';
const APP_ID='1071149631917061';
const CONFIG_ID='1138959298884634';
const REDIRECT_URI='https://zevanory.api.br/api/oauth/meta/callback';
const REQUIRED_SCOPES=['pages_show_list','pages_read_engagement','pages_manage_posts','instagram_basic','instagram_content_publish'];
const clean=(v,max=5000)=>String(v??'').trim().slice(0,max);
const keyFrom=(env)=>{const secret=clean(env.META_APP_SECRET||env.META_APP_SECRET01,4000);if(secret.length<16)throw new Error('meta_app_secret_missing');return createHash('sha256').update('zevanory:meta-oauth:v1:').update(secret).digest();};
const enc=(value,env)=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',keyFrom(env),iv);const d=Buffer.concat([c.update(String(value),'utf8'),c.final()]);return [iv,c.getAuthTag(),d].map(x=>x.toString('base64url')).join('.');};
const dec=(value,env)=>{const p=String(value||'').split('.').map(x=>Buffer.from(x,'base64url'));if(p.length!==3)throw new Error('meta_oauth_ciphertext_invalid');const d=createDecipheriv('aes-256-gcm',keyFrom(env),p[0]);d.setAuthTag(p[1]);return Buffer.concat([d.update(p[2]),d.final()]).toString('utf8');};
const eq=(a,b)=>{const x=Buffer.from(clean(a,200)),y=Buffer.from(clean(b,200));return x.length>0&&x.length===y.length&&timingSafeEqual(x,y);};
const json=async(r)=>{try{return await r.json();}catch{return {};}};
export const META_OAUTH_PUBLIC=Object.freeze({app_id:APP_ID,config_id:CONFIG_ID,redirect_uri:REDIRECT_URI});
export function createMetaOAuthStart(env=process.env){
  keyFrom(env);const state=randomBytes(24).toString('base64url');const cookie=enc(JSON.stringify({state,iat:Date.now()}),env);
  const u=new URL('https://www.facebook.com/v26.0/dialog/oauth');u.searchParams.set('client_id',APP_ID);u.searchParams.set('redirect_uri',REDIRECT_URI);u.searchParams.set('state',state);u.searchParams.set('response_type','code');u.searchParams.set('config_id',CONFIG_ID);u.searchParams.set('override_default_response_type','true');u.searchParams.set('scope',REQUIRED_SCOPES.join(','));
  return Object.freeze({url:u.toString(),cookie});
}
export function readMetaOAuthCookie(value,state,env=process.env){const p=JSON.parse(dec(value,env));if(Date.now()-Number(p.iat)>10*60*1000)throw new Error('meta_oauth_session_expired');if(!eq(p.state,state))throw new Error('meta_oauth_state_invalid');return p;}
export async function exchangeMetaCode({code,env=process.env,fetchImpl=globalThis.fetch}={}){
  const secret=clean(env.META_APP_SECRET||env.META_APP_SECRET01,4000);if(!secret)throw new Error('meta_app_secret_missing');
  const u=new URL('https://graph.facebook.com/v26.0/oauth/access_token');u.searchParams.set('client_id',APP_ID);u.searchParams.set('redirect_uri',REDIRECT_URI);u.searchParams.set('client_secret',secret);u.searchParams.set('code',clean(code,2000));
  const r=await fetchImpl(u,{signal:AbortSignal.timeout(15000)}),b=await json(r);if(!r.ok||!b.access_token)throw new Error(`meta_code_exchange_http_${r.status}`);
  const x=new URL('https://graph.facebook.com/v26.0/oauth/access_token');x.searchParams.set('grant_type','fb_exchange_token');x.searchParams.set('client_id',APP_ID);x.searchParams.set('client_secret',secret);x.searchParams.set('fb_exchange_token',b.access_token);
  const lr=await fetchImpl(x,{signal:AbortSignal.timeout(15000)}),lb=await json(lr);if(!lr.ok||!lb.access_token)throw new Error(`meta_long_token_http_${lr.status}`);return {access_token:lb.access_token,expires_in:Number(lb.expires_in||0)};
}
export async function fetchMetaPublishingIdentity(token,fetchImpl=globalThis.fetch){
  const h={authorization:`Bearer ${clean(token,6000)}`};
  const pr=await fetchImpl('https://graph.facebook.com/v26.0/me/permissions',{headers:h,signal:AbortSignal.timeout(15000)}),pb=await json(pr);if(!pr.ok)throw new Error(`meta_permissions_http_${pr.status}`);
  const granted=new Set((pb.data||[]).filter(x=>x.status==='granted').map(x=>String(x.permission)));for(const s of REQUIRED_SCOPES)if(!granted.has(s))throw new Error(`meta_permission_missing_${s}`);
  const ar=await fetchImpl('https://graph.facebook.com/v26.0/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}',{headers:h,signal:AbortSignal.timeout(15000)}),ab=await json(ar);if(!ar.ok)throw new Error(`meta_accounts_http_${ar.status}`);
  const page=(ab.data||[]).find(x=>String(x.name||'').trim().toUpperCase()==='ZEVANORY'&&x.access_token);if(!page)throw new Error('meta_zevanory_page_missing');const ig=page.instagram_business_account;if(!ig?.id)throw new Error('meta_instagram_business_account_missing');
  return Object.freeze({page_id:String(page.id),page_name:String(page.name),instagram_id:String(ig.id),instagram_username:String(ig.username||''),page_access_token:String(page.access_token),scope:[...granted].join(' ')});
}
export async function persistMetaCredential(sql,{identity,env=process.env}={}){if(!sql?.query)throw new Error('meta_sql_required');const account=`${identity.page_id}:${identity.instagram_id}`;const rows=await sql.query(`insert into provider_oauth_credentials(provider,account_id,access_token_enc,refresh_token_enc,token_type,scope,expires_at,updated_at) values('meta',$1,$2,$3,'Bearer',$4,NULL,now()) on conflict(provider) do update set account_id=excluded.account_id,access_token_enc=excluded.access_token_enc,refresh_token_enc=excluded.refresh_token_enc,token_type=excluded.token_type,scope=excluded.scope,expires_at=NULL,updated_at=now() returning account_id`,[account,enc(identity.page_access_token,env),enc('',env),clean(identity.scope,2000)]);return rows[0];}
export async function loadMetaCredential(sql,env=process.env){if(!sql?.query)throw new Error('meta_sql_required');const rows=await sql.query("select account_id,access_token_enc,scope from provider_oauth_credentials where provider='meta' limit 1");const r=rows[0];if(!r)throw new Error('meta_oauth_credential_missing');const [page_id,instagram_id]=String(r.account_id||'').split(':');if(!page_id||!instagram_id)throw new Error('meta_oauth_identity_invalid');return {...r,page_id,instagram_id,access_token:dec(r.access_token_enc,env)};}
export function metaCredentialFingerprint(token){return createHash('sha256').update(String(token||'')).digest('hex');}
