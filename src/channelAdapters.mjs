export const CHANNELS = Object.freeze({
  zevanory: Object.freeze({ provider:'owned-web', env:[], commercial:true, role:'conversion_hub' }),
  whatsapp: Object.freeze({ provider:'meta-whatsapp-cloud-api', env:['WHATSAPP_ACCESS_TOKEN','WHATSAPP_PHONE_NUMBER_ID','META_GRAPH_VERSION'], commercial:true, role:'conversation_support' }),
  email: Object.freeze({ provider:'resend', env:['RESEND_API_KEY'], commercial:true, role:'crm_nurture' }),
  instagram: Object.freeze({ provider:'meta-graph-api', env:['META_ACCESS_TOKEN','INSTAGRAM_BUSINESS_ACCOUNT_ID','META_GRAPH_VERSION'], commercial:true, role:'proof_reach' }),
  facebook: Object.freeze({ provider:'meta-graph-api', env:['META_ACCESS_TOKEN','META_PAGE_ID','META_GRAPH_VERSION'], commercial:true, role:'proof_retargeting' }),
  tiktok: Object.freeze({ provider:'tiktok-business-api', env:['TIKTOK_ACCESS_TOKEN'], commercial:true, role:'short_form_discovery', implemented:false }),
  youtube: Object.freeze({ provider:'youtube-data-api', env:[], credentialSets:[['YOUTUBE_OAUTH_ACCESS_TOKEN'],['YOUTUBE_OAUTH_CLIENT_ID','YOUTUBE_OAUTH_CLIENT_SECRET','YOUTUBE_OAUTH_REFRESH_TOKEN']], commercial:true, role:'demo_authority' }),
  linkedin: Object.freeze({ provider:'linkedin-api', env:['LINKEDIN_ACCESS_TOKEN'], commercial:true, role:'b2b_authority', implemented:false }),
  google: Object.freeze({ provider:'organic-search', env:[], commercial:false, role:'seo_discovery' }),
  affiliate: Object.freeze({ provider:'network-adapter', env:['AFFILIATE_PROVIDER'], commercial:true, role:'partner_distribution', implemented:false }),
});

export function channelReadiness(env = process.env) {
  return Object.fromEntries(Object.entries(CHANNELS).map(([name,def]) => {
    let missing=def.env.filter((key)=>!String(env[key]||'').trim());
    if(Array.isArray(def.credentialSets)){const ready=def.credentialSets.some(set=>set.every(key=>String(env[key]||'').trim()));if(!ready)missing=[...def.credentialSets[0]];}
    const implemented=def.implemented!==false;
    return [name,Object.freeze({ provider:def.provider, configured:implemented&&missing.length===0, implemented, missing:Object.freeze(missing), commercial:def.commercial, role:def.role })];
  }));
}

export function assertChannelActionAllowed(channel, env = process.env) {
  const readiness=channelReadiness(env)[channel];
  if(!readiness) throw new Error('unknown_channel');
  if(!readiness.configured) throw new Error('channel_not_configured');
  if(env.SALE_GLOBALLY_ENABLED!=='true' || env.PRE_SALE_GATES_APPROVED!=='true') throw new Error('commercial_gates_closed');
  return true;
}
