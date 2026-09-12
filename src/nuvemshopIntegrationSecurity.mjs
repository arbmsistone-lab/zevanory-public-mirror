import { createHash, createHmac } from 'node:crypto';
import { validNuvemshopMerchantEmail } from './nuvemshopPrivacy.mjs';
import { encryptCommercialSecret, decryptCommercialSecret } from './commercialOAuthCrypto.mjs';
import { persistNuvemshopCredential, ensureNuvemshopWebhooks, NUVEMSHOP_REQUIRED_WEBHOOKS, NUVEMSHOP_WEBHOOK_URI, NUVEMSHOP_API_BASE } from './nuvemshopOAuth.mjs';

const sha=value=>createHash('sha256').update(String(value)).digest('hex');
const scopes=value=>String(value||'').split(/[\s,]+/).filter(Boolean);
export const numericNuvemshopId=value=>(typeof value!=='number'||Number.isSafeInteger(value))&&/^[1-9][0-9]{0,19}$/.test(String(value??''));
export const maskedNuvemshopStoreId=value=>String(value||'').replace(/.(?=.{3})/g,'*');
export const NUVEMSHOP_PRIVACY_URIS=Object.freeze({
 'app/store_redact':'https://zevanory.api.br/api/webhooks/nuvemshop/privacy/store-redact',
 'customer/redact':'https://zevanory.api.br/api/webhooks/nuvemshop/privacy/customer-redact',
 'customers/data_request':'https://zevanory.api.br/api/webhooks/nuvemshop/privacy/data-request',
});
export async function registerNuvemshopSession(sql,{cookie,state}){
 const rows=await sql.query('insert into nuvemshop_oauth_sessions(session_hash,state_hash,expires_at) values($1,$2,now()+interval \'10 minutes\') returning session_hash',[sha(cookie),sha(state)]);
 if(rows.length!==1)throw new Error('nuvemshop_oauth_session_registration_failed');
}
export async function consumeNuvemshopSession(sql,{cookie,state}){
 const rows=await sql.query('update nuvemshop_oauth_sessions set consumed_at=now() where session_hash=$1 and state_hash=$2 and consumed_at is null and expires_at>now() returning session_hash',[sha(cookie),sha(state)]);
 if(rows.length!==1)throw new Error('nuvemshop_oauth_session_used_or_expired');
 return rows[0].session_hash;
}
export async function stageNuvemshopCredential(sql,{sessionHash,token,env=process.env}){
 if(!numericNuvemshopId(token?.user_id)||!token?.access_token)throw new Error('nuvemshop_token_payload_invalid');
 const rows=await sql.query('insert into nuvemshop_pending_credentials(session_hash,account_id,access_token_enc,scope) values($1,$2,$3,$4) returning session_hash',[sessionHash,String(token.user_id),encryptCommercialSecret(token.access_token,env),String(token.scope||'').slice(0,1000)]);
 if(rows.length!==1)throw new Error('nuvemshop_token_staging_failed');
}
const host=value=>{try{return new URL(/^https?:\/\//.test(String(value))?String(value):'https://'+String(value)).hostname.toLowerCase();}catch{return '';}};
export async function validateNuvemshopReadOnlyApi({token,env=process.env,fetchImpl=globalThis.fetch,onVerifiedStore}={}){
 if(!numericNuvemshopId(token?.user_id)||!token?.access_token)throw new Error('nuvemshop_api_credential_invalid');
 const allowed=scopes(token.scope);
 if(!allowed.some(s=>['read_products','write_products'].includes(s))||!allowed.some(s=>['read_orders','write_orders'].includes(s)))throw new Error('nuvemshop_required_scopes_missing');
 const expected=host(env.NUVEMSHOP_STOREFRONT_URL);
 if(expected!=='zevanory.lojavirtualnuvem.com.br')throw new Error('nuvemshop_expected_identity_unconfigured');
 const base=NUVEMSHOP_API_BASE+'/'+String(token.user_id);
 const headers={authorization:'Bearer '+token.access_token,'user-agent':'ZEVANORY (contato@zevanory.api.br; app '+String(env.NUVEMSHOP_APP_ID||'')+')'};
 async function get(path){
  let response;
  try{response=await fetchImpl(base+path,{method:'GET',headers,redirect:'error',signal:AbortSignal.timeout(10000)});}catch{throw new Error('nuvemshop_api_transport_failed');}
  if(response.status!==200)throw new Error('nuvemshop_api_http_'+response.status);
  try{return await response.json();}catch{throw new Error('nuvemshop_api_response_invalid');}
 }
 const store=await get('/store');
 const domains=[store.original_domain,store.url,store.domain,...(Array.isArray(store.domains)?store.domains:[])].filter(Boolean).map(d=>typeof d==='object'?d.url||d.host||d.domain:d);
 if(String(store.id)!==String(token.user_id)||!domains.some(domain=>host(domain)===expected))throw new Error('nuvemshop_store_identity_mismatch');
 if(onVerifiedStore)onVerifiedStore(store);
 const products=await get('/products?per_page=1');
 if(!Array.isArray(products))throw new Error('nuvemshop_products_response_invalid');
 const hooks=await get('/webhooks?per_page=200');
 if(!Array.isArray(hooks))throw new Error('nuvemshop_webhooks_response_invalid');
 return Object.freeze({store_id:String(token.user_id),storefront_host:expected,scopes:allowed,store_api:true,products_api:true,webhooks_api:true,webhook_count:hooks.length,required_webhooks_present:NUVEMSHOP_REQUIRED_WEBHOOKS.every(event=>hooks.some(h=>h.event===event&&h.url===NUVEMSHOP_WEBHOOK_URI)),read_only:true});
}
export async function reconcileNuvemshopCredential(sql,{sessionHash,env=process.env,fetchImpl=globalThis.fetch}={}){
 await sql.query('begin');
 let proof;
 try{
  const pending=await sql.query('select session_hash,account_id,access_token_enc,scope from nuvemshop_pending_credentials where session_hash=$1 for update',[sessionHash]);
  if(pending.length!==1)throw new Error('nuvemshop_pending_credential_missing');
  const row=pending[0],token={user_id:row.account_id,access_token:decryptCommercialSecret(row.access_token_enc,env),scope:row.scope};
  await sql.query("select pg_advisory_xact_lock(hashtextextended('nuvemshop:'||$1,0))",[String(row.account_id)]);
  let merchantEmail='';
  await validateNuvemshopReadOnlyApi({token,env,fetchImpl,onVerifiedStore:store=>{merchantEmail=String(store.email||'');}});
  if(!validNuvemshopMerchantEmail(merchantEmail))throw new Error('nuvemshop_merchant_report_recipient_unverified');
  await ensureNuvemshopWebhooks({token,env,fetchImpl});
  proof=await validateNuvemshopReadOnlyApi({token,env,fetchImpl});
  if(!proof.required_webhooks_present)throw new Error('nuvemshop_required_webhooks_not_verified');
  await persistNuvemshopCredential(sql,{token,env});
  await sql.query("insert into nuvemshop_connections(store_id,storefront_host,status,read_only_api_verified_at,webhooks_registered_at,merchant_email_enc) values($1,$2,'connected',now(),now(),$3) on conflict(store_id) do update set storefront_host=excluded.storefront_host,status='connected',read_only_api_verified_at=now(),webhooks_registered_at=now(),merchant_email_enc=excluded.merchant_email_enc,updated_at=now()",[proof.store_id,proof.storefront_host,encryptCommercialSecret(merchantEmail,env)]);
  const storeRef=createHmac('sha256',env.NUVEMSHOP_CLIENT_SECRET).update('nuvemshop-store:'+proof.store_id).digest('hex');
  await sql.query("delete from nuvemshop_webhook_receipts where store_ref=$1 and event in ('app/suspended','app/uninstalled','app/resumed','app/store_redact')",[storeRef]);
  await sql.query('delete from nuvemshop_pending_credentials where session_hash=$1',[sessionHash]);
  await sql.query('commit');
 }catch(error){await sql.query('rollback').catch(()=>{});if(/^nuvemshop_[a-z0-9_]+$/.test(String(error?.message)))throw error;throw new Error('nuvemshop_canonical_persistence_failed');}
 return Object.freeze({provider:'nuvemshop',connected:true,store_id:maskedNuvemshopStoreId(proof.store_id),tokens_stored_encrypted:true,webhooks_ready:true,required_webhooks:NUVEMSHOP_REQUIRED_WEBHOOKS.length,merchant_report_recipient_verified:true,api:{...proof,store_id:maskedNuvemshopStoreId(proof.store_id)},commercial_enabled:false});
}
