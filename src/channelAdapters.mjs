import { salesGate } from './salesGate.mjs';

export const CHANNELS = Object.freeze({
  zevanory: Object.freeze({ provider:'owned-web', env:[], commercial:true, role:'conversion_hub' }),
  whatsapp: Object.freeze({ provider:'meta-whatsapp-cloud-api', env:['WHATSAPP_ACCESS_TOKEN','WHATSAPP_PHONE_NUMBER_ID','META_APP_SECRET','META_GRAPH_VERSION'], anyEnv:[['META_VERIFY_TOKEN','META_WEBHOOK_VERIFY_TOKEN']], trueEnv:['META_WHATSAPP_IDENTITY_VERIFIED'], commercial:true, role:'conversation_support' }),
  email: Object.freeze({ provider:'resend', env:['RESEND_API_KEY'], commercial:true, role:'crm_nurture' }),
  instagram: Object.freeze({ provider:'meta-graph-api', env:['META_ACCESS_TOKEN','INSTAGRAM_BUSINESS_ACCOUNT_ID','META_GRAPH_VERSION'], trueEnv:['META_INSTAGRAM_IDENTITY_VERIFIED'], commercial:true, role:'proof_reach' }),
  facebook: Object.freeze({ provider:'meta-graph-api', env:['META_ACCESS_TOKEN','META_PAGE_ID','META_GRAPH_VERSION'], trueEnv:['META_FACEBOOK_IDENTITY_VERIFIED'], commercial:true, role:'proof_retargeting' }),
  tiktok: Object.freeze({ provider:'tiktok-content-posting-api', env:['TIKTOK_ACCESS_TOKEN','TIKTOK_EXPECTED_USERNAME'], trueEnv:['TIKTOK_CONTENT_SOURCE_VERIFIED','TIKTOK_IDENTITY_VERIFIED'], commercial:true, role:'short_form_discovery' }),
  youtube: Object.freeze({ provider:'youtube-data-api', env:[], trueEnv:['YOUTUBE_IDENTITY_VERIFIED'], credentialSets:[['YOUTUBE_OAUTH_ACCESS_TOKEN'],['YOUTUBE_OAUTH_CLIENT_ID','YOUTUBE_OAUTH_CLIENT_SECRET','YOUTUBE_OAUTH_REFRESH_TOKEN']], commercial:true, role:'demo_authority' }),
  linkedin: Object.freeze({ provider:'linkedin-posts-api', env:['LINKEDIN_ACCESS_TOKEN','LINKEDIN_AUTHOR_URN','LINKEDIN_VERSION'], trueEnv:['LINKEDIN_IDENTITY_VERIFIED'], commercial:true, role:'b2b_authority' }),
  google: Object.freeze({ provider:'organic-search', env:[], commercial:false, role:'seo_discovery' }),
  affiliate: Object.freeze({ provider:'network-webhook-adapter', env:['AFFILIATE_PROVIDER','AFFILIATE_WEBHOOK_URL','AFFILIATE_WEBHOOK_TOKEN'], commercial:true, role:'partner_distribution' }),
  nuvemshop: Object.freeze({ provider:'nuvemshop-api-v1', env:['NUVEMSHOP_ACCESS_TOKEN','NUVEMSHOP_STORE_ID','NUVEMSHOP_APP_ID'], trueEnv:['NUVEMSHOP_IDENTITY_VERIFIED','NUVEMSHOP_WEBHOOKS_VERIFIED'], commercial:true, role:'owned_store_distribution' }),
  mercado_livre: Object.freeze({ provider:'mercado-livre-api', env:['MERCADOLIVRE_ACCESS_TOKEN','MERCADOLIVRE_APP_ID','MERCADOLIVRE_SELLER_ID'], trueEnv:['MERCADOLIVRE_IDENTITY_VERIFIED','MERCADOLIVRE_NOTIFICATIONS_VERIFIED','MERCADOLIVRE_APP_SEPARATION_VERIFIED'], commercial:true, role:'marketplace_distribution' }),
});

export function channelReadiness(env = process.env) {
  return Object.fromEntries(Object.entries(CHANNELS).map(([name,def]) => {
    let missing=def.env.filter((key)=>!String(env[key]||'').trim());
    if(Array.isArray(def.trueEnv)) missing.push(...def.trueEnv.filter((key)=>env[key]!=='true'));
    if(Array.isArray(def.anyEnv)) for(const group of def.anyEnv) if(!group.some((key)=>String(env[key]||'').trim())) missing.push(group.join('|'));
    if(Array.isArray(def.credentialSets)){const ready=def.credentialSets.some(set=>set.every(key=>String(env[key]||'').trim()));if(!ready)missing=[...def.credentialSets[0]];}
    const implemented=def.implemented!==false;
    return [name,Object.freeze({ provider:def.provider, configured:implemented&&missing.length===0, implemented, missing:Object.freeze(missing), commercial:def.commercial, role:def.role })];
  }));
}
export function assertChannelActionAllowed(channel, env = process.env) {
  const readiness=channelReadiness(env)[channel];
  if(!readiness) throw new Error('unknown_channel');
  if(!readiness.configured) throw new Error('channel_not_configured');
  const gate=salesGate(env);
  if(!gate.enabled) throw new Error('commercial_gates_closed');
  return true;
}
