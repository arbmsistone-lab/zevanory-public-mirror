import { isActiveCommercialFront } from './activeCommercialScope.mjs';
const PROVIDER_TO_CHANNEL=Object.freeze({youtube_identity:'youtube',tiktok:'tiktok',linkedin:'linkedin',nuvemshop:'nuvemshop'});
const scopeHas=(scope,value)=>String(scope||'').split(/[ ,]+/).includes(value);
export async function persistedOAuthReadiness(sql){
  if(!sql?.query)return Object.freeze({});
  const rows=await sql.query("select c.provider,c.scope,(access_token_enc is not null and length(access_token_enc)>0) as has_access,(refresh_token_enc is not null and length(refresh_token_enc)>0) as has_refresh,exists(select 1 from nuvemshop_connections n where n.store_id=c.account_id and n.status='connected' and n.read_only_api_verified_at is not null and n.webhooks_registered_at is not null and length(n.merchant_email_enc)>0) as integration_verified from provider_oauth_credentials c where c.provider in ('youtube_identity','tiktok','linkedin','nuvemshop','meta')");
  const out={};
  for(const r of rows||[]){
    const provider=String(r.provider||'');
    if(provider==='meta'){
      const ready=Boolean(r.has_access&&scopeHas(r.scope,'pages_manage_posts')&&scopeHas(r.scope,'instagram_content_publish'));
      out.facebook=ready;out.instagram=ready;continue;
    }
    const channel=PROVIDER_TO_CHANNEL[provider];if(!channel)continue;
    const ready=channel==='youtube'?Boolean(r.has_access&&r.has_refresh&&scopeHas(r.scope,'https://www.googleapis.com/auth/youtube.force-ssl')):
      channel==='tiktok'?Boolean(r.has_access&&scopeHas(r.scope,'video.publish')):
      channel==='linkedin'?Boolean(r.has_access&&scopeHas(r.scope,'w_member_social')):
      channel==='nuvemshop'?Boolean(isActiveCommercialFront('nuvemshop')&&r.has_access&&r.integration_verified&&['read_products','write_products'].some(scope=>scopeHas(r.scope,scope))&&['read_orders','write_orders'].some(scope=>scopeHas(r.scope,scope))):false;
    out[channel]=ready;
  }
  return Object.freeze(out);
}
export function overlayPersistedOAuth(base,persisted={}){
  return Object.freeze(Object.fromEntries(Object.entries(base||{}).map(([name,item])=>{
    if(!persisted[name])return [name,item];
    return [name,Object.freeze({...item,configured:true,api_configured:true,oauth_persisted:true,operational_ready:true,operational_mode:'provider_api_oauth',active_provider:item.provider||item.active_provider||null})];
  })));
}
