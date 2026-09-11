const PROVIDER_TO_CHANNEL=Object.freeze({youtube_identity:'youtube',tiktok:'tiktok',linkedin:'linkedin',nuvemshop:'nuvemshop'});
const scopeHas=(scope,value)=>String(scope||'').split(/[ ,]+/).includes(value);
export async function persistedOAuthReadiness(sql){
  if(!sql?.query)return Object.freeze({});
  const rows=await sql.query("select provider,scope,(access_token_enc is not null and length(access_token_enc)>0) as has_access,(refresh_token_enc is not null and length(refresh_token_enc)>0) as has_refresh from provider_oauth_credentials where provider in ('youtube_identity','tiktok','linkedin','nuvemshop')");
  const out={};
  for(const r of rows||[]){
    const channel=PROVIDER_TO_CHANNEL[String(r.provider||'')];if(!channel)continue;
    const ready=channel==='youtube'?Boolean(r.has_access&&r.has_refresh&&scopeHas(r.scope,'https://www.googleapis.com/auth/youtube.force-ssl')):
      channel==='tiktok'?Boolean(r.has_access&&scopeHas(r.scope,'video.publish')):
      channel==='linkedin'?Boolean(r.has_access&&scopeHas(r.scope,'w_member_social')):
      channel==='nuvemshop'?Boolean(r.has_access):false;
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