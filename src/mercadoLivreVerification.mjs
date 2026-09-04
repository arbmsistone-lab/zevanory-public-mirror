import { loadMercadoLivreCredential, fetchMercadoLivreMe } from './mercadoLivreOAuth.mjs';
const clean=(v,max=500)=>String(v??'').trim().slice(0,max);
const numeric=(v)=>/^\d+$/.test(clean(v,40));
const EXPECTED_NOTIFICATION_URL='https://zevanory.api.br/api/webhooks/mercadolivre';
function containsExactString(value,target){
  if(typeof value==='string') return value.replace(/\/$/,'')===target.replace(/\/$/,'');
  if(Array.isArray(value)) return value.some(v=>containsExactString(v,target));
  if(value&&typeof value==='object') return Object.values(value).some(v=>containsExactString(v,target));
  return false;
}
export function mercadoPagoClientIdFromAccessToken(token){
  const value=clean(token,5000); const match=/^APP_USR-(\d+)-/.exec(value); return match?.[1]||'';
}
export async function verifyMercadoLivreLive(sql,{env=process.env,fetchImpl=globalThis.fetch}={}){
  const appId=clean(env.MERCADOLIVRE_APP_ID,40);if(!numeric(appId))throw new Error('mercadolivre_app_id_missing');
  const credential=await loadMercadoLivreCredential(sql,env);
  const me=await fetchMercadoLivreMe(credential.access_token,fetchImpl);
  const identityVerified=String(me.id)===String(credential.account_id);
  const appRes=await fetchImpl(`https://api.mercadolibre.com/applications/${encodeURIComponent(appId)}`,{headers:{authorization:`Bearer ${credential.access_token}`,accept:'application/json'}});
  const app=await appRes.json().catch(()=>({}));
  const remoteAppId=clean(app?.id??app?.application_id,40); const appIdentityVerified=appRes.ok&&remoteAppId===appId;
  const notificationsVerified=appRes.ok&&containsExactString(app,EXPECTED_NOTIFICATION_URL);
  const mercadoPagoClientId=mercadoPagoClientIdFromAccessToken(env.MERCADOPAGO_ACCESS_TOKEN);
  const appSeparationVerified=numeric(mercadoPagoClientId)&&mercadoPagoClientId!==appId;
  return Object.freeze({provider:'mercado_livre',identity_verified:identityVerified&&appIdentityVerified,notifications_verified:notificationsVerified,app_separation_verified:appSeparationVerified,application_lookup_http:appRes.status,seller_id_match:identityVerified,application_id_match:appIdentityVerified,notification_url_match:notificationsVerified,mercadopago_distinct_application:appSeparationVerified,all_verified:identityVerified&&appIdentityVerified&&notificationsVerified&&appSeparationVerified});
}