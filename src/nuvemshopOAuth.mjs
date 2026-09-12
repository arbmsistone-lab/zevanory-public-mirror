import { encryptCommercialSecret, decryptCommercialSecret, newOAuthState, sealOAuthSession, openOAuthSession, assertOAuthState } from './commercialOAuthCrypto.mjs';
export const NUVEMSHOP_REDIRECT_URI='https://zevanory.api.br/api/oauth/nuvemshop/callback';
export const NUVEMSHOP_WEBHOOK_URI='https://zevanory.api.br/api/webhooks?provider=nuvemshop';
export const NUVEMSHOP_REQUIRED_WEBHOOKS=Object.freeze(['app/suspended','app/uninstalled','app/resumed','product/created','product/updated','order/created','order/paid']);
const TOKEN='https://www.tiendanube.com/apps/authorize/token';
export const NUVEMSHOP_API_BASE='https://api.nuvemshop.com.br/2025-03';
const API=NUVEMSHOP_API_BASE;
const clean=(v,max=4000)=>String(v??'').trim().slice(0,max);
const userAgent=appId=>`ZEVANORY (contato@zevanory.api.br; app ${clean(appId,200)})`;
export function createNuvemshopOAuthStart(env=process.env){const client=clean(env.NUVEMSHOP_APP_ID,200);if(!client)throw new Error('nuvemshop_app_id_missing');const state=newOAuthState();const url=new URL('https://www.tiendanube.com/apps/'+encodeURIComponent(client)+'/authorize');url.searchParams.set('state',state);return {url:url.toString(),cookie:sealOAuthSession({provider:'nuvemshop',state},env),state};}
export function readNuvemshopOAuthCookie(value,state,env=process.env){const p=openOAuthSession(value,env);if(p.provider!=='nuvemshop')throw new Error('nuvemshop_oauth_session_invalid');assertOAuthState(p.state,state);return p;}
export async function exchangeNuvemshopCode({code,env=process.env,fetchImpl=globalThis.fetch}={}){const client=clean(env.NUVEMSHOP_APP_ID,200),secret=clean(env.NUVEMSHOP_CLIENT_SECRET,1000);if(!client||!secret)throw new Error('nuvemshop_oauth_config_missing');const body=JSON.stringify({client_id:client,client_secret:secret,grant_type:'authorization_code',code:clean(code,2000)});const r=await fetchImpl(TOKEN,{method:'POST',headers:{'content-type':'application/json'},body,redirect:'error',signal:AbortSignal.timeout(10000)});const t=await r.json().catch(()=>({}));if(!r.ok||typeof t.access_token!=='string'||!t.access_token||!(typeof t.user_id!=='number'||Number.isSafeInteger(t.user_id))||! /^[1-9][0-9]{0,19}$/.test(String(t.user_id??'')))throw new Error(`nuvemshop_token_http_${r.status}`);return t;}
export async function persistNuvemshopCredential(sql,{token,env=process.env}={}){if(!sql?.query)throw new Error('nuvemshop_sql_required');const storeId=clean(token.user_id,300);const rows=await sql.query(`insert into provider_oauth_credentials(provider,account_id,access_token_enc,refresh_token_enc,token_type,scope,expires_at,updated_at) values('nuvemshop',$1,$2,$3,'Bearer',$4,NULL,now()) on conflict(provider) do update set account_id=excluded.account_id,access_token_enc=excluded.access_token_enc,refresh_token_enc=excluded.refresh_token_enc,token_type=excluded.token_type,scope=excluded.scope,expires_at=excluded.expires_at,updated_at=now() returning account_id,expires_at`,[storeId,encryptCommercialSecret(token.access_token,env),encryptCommercialSecret('',env),clean(token.scope,1000)]);return rows[0];}
export async function loadNuvemshopCredential(sql,env=process.env){if(!sql?.query)throw new Error('nuvemshop_sql_required');const rows=await sql.query("select account_id,access_token_enc,scope,expires_at from provider_oauth_credentials where provider='nuvemshop' limit 1");const r=rows[0];if(!r)throw new Error('nuvemshop_oauth_credential_missing');return {...r,access_token:decryptCommercialSecret(r.access_token_enc,env),store_id:String(r.account_id)};}
export async function ensureNuvemshopWebhooks({token,env=process.env,fetchImpl=globalThis.fetch}={}){
  const access=clean(token?.access_token,4000),storeId=clean(token?.user_id,300),appId=clean(env.NUVEMSHOP_APP_ID,200);
  if(!access||!/^\d+$/.test(storeId)||!appId)throw new Error('nuvemshop_webhook_config_missing');
  const headers={authorization:`Bearer ${access}`,'user-agent':userAgent(appId),'content-type':'application/json'};
  const base=`${API}/${encodeURIComponent(storeId)}/webhooks`;
  const listed=await fetchImpl(`${base}?per_page=200`,{headers,redirect:'error',signal:AbortSignal.timeout(10000)});
  const existing=listed.ok?await listed.json().catch(()=>[]):[];
  if(!listed.ok||!Array.isArray(existing))throw new Error(`nuvemshop_webhook_list_http_${listed.status}`);
  const present=new Set(existing.filter(x=>x?.url===NUVEMSHOP_WEBHOOK_URI).map(x=>String(x.event||'')));
  const created=[];
  for(const event of NUVEMSHOP_REQUIRED_WEBHOOKS){
    if(present.has(event))continue;
    const r=await fetchImpl(base,{method:'POST',headers,body:JSON.stringify({event,url:NUVEMSHOP_WEBHOOK_URI}),redirect:'error',signal:AbortSignal.timeout(10000)});
    if(![200,201].includes(r.status))throw new Error(`nuvemshop_webhook_create_${event.replace('/','_')}_http_${r.status}`);
    created.push(event);
  }
  const verifiedResponse=await fetchImpl(`${base}?per_page=200`,{headers,redirect:'error',signal:AbortSignal.timeout(10000)});
  const verified=verifiedResponse.ok?await verifiedResponse.json().catch(()=>null):null;
  if(!Array.isArray(verified)||!NUVEMSHOP_REQUIRED_WEBHOOKS.every(event=>verified.some(h=>h.event===event&&h.url===NUVEMSHOP_WEBHOOK_URI)))throw new Error('nuvemshop_required_webhooks_not_verified');
  return Object.freeze({ready:true,verified:true,required:[...NUVEMSHOP_REQUIRED_WEBHOOKS],created,endpoint:NUVEMSHOP_WEBHOOK_URI});
}
