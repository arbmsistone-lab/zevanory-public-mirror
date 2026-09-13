import { isActiveCommercialFront } from './activeCommercialScope.mjs';
import { salesGate } from './salesGate.mjs';
import { organicPublicationAllowed } from './agentPolicy.mjs';

export const CHANNELS = Object.freeze({
  zevanory: Object.freeze({ provider:'owned-web', env:[], commercial:true, role:'conversion_hub' }),
  whatsapp: Object.freeze({ provider:'meta-whatsapp-cloud-api', env:['WHATSAPP_ACCESS_TOKEN','WHATSAPP_PHONE_NUMBER_ID','META_APP_SECRET','META_GRAPH_VERSION'], anyEnv:[['META_VERIFY_TOKEN','META_WEBHOOK_VERIFY_TOKEN']], trueEnv:['META_WHATSAPP_IDENTITY_VERIFIED'], commercial:true, role:'conversation_support' }),
  email: Object.freeze({ provider:'resend', env:['RESEND_API_KEY'], commercial:true, role:'crm_nurture' }),
  instagram: Object.freeze({ provider:'meta-graph-api', env:['META_ACCESS_TOKEN','INSTAGRAM_BUSINESS_ACCOUNT_ID','META_GRAPH_VERSION'], trueEnv:['META_INSTAGRAM_IDENTITY_VERIFIED'], commercial:true, role:'proof_reach' }),
  facebook: Object.freeze({ provider:'meta-graph-api', env:['META_ACCESS_TOKEN','META_PAGE_ID','META_GRAPH_VERSION'], trueEnv:['META_FACEBOOK_IDENTITY_VERIFIED'], commercial:true, role:'proof_retargeting' }),
  tiktok: Object.freeze({ provider:'tiktok-content-posting-api', env:['TIKTOK_CLIENT_KEY','TIKTOK_CLIENT_SECRET','TIKTOK_TOKEN_ENCRYPTION_KEY','TIKTOK_EXPECTED_USERNAME'], trueEnv:['TIKTOK_CONTENT_SOURCE_VERIFIED','TIKTOK_IDENTITY_VERIFIED','TIKTOK_CLIENT_AUDITED'], commercial:true, role:'short_form_discovery' }),
  youtube: Object.freeze({ provider:'youtube-data-api', env:[], trueEnv:['YOUTUBE_IDENTITY_VERIFIED'], credentialSets:[['YOUTUBE_OAUTH_ACCESS_TOKEN'],['YOUTUBE_OAUTH_CLIENT_ID','YOUTUBE_OAUTH_CLIENT_SECRET','YOUTUBE_OAUTH_REFRESH_TOKEN']], commercial:true, role:'demo_authority' }),
  linkedin: Object.freeze({ provider:'linkedin-posts-api', env:['LINKEDIN_CLIENT_ID','LINKEDIN_CLIENT_SECRET','COMMERCIAL_OAUTH_ENCRYPTION_KEY','LINKEDIN_VERSION'], trueEnv:['LINKEDIN_IDENTITY_VERIFIED'], commercial:true, role:'b2b_authority' }),
  google: Object.freeze({ provider:'organic-search', env:[], commercial:false, role:'seo_discovery' }),
  affiliate: Object.freeze({ provider:'affiliate-program', env:['AFFILIATE_PROVIDER'], commercial:true, role:'partner_distribution' }),
  nuvemshop: Object.freeze({ provider:'nuvemshop-api-v1', env:['NUVEMSHOP_APP_ID','NUVEMSHOP_CLIENT_SECRET','COMMERCIAL_OAUTH_ENCRYPTION_KEY'], trueEnv:['NUVEMSHOP_IDENTITY_VERIFIED','NUVEMSHOP_WEBHOOKS_VERIFIED','NUVEMSHOP_NUBESDK_VERIFIED'], commercial:true, role:'owned_store_distribution' }),
  mercado_livre: Object.freeze({ provider:'mercado-livre-api', env:['MERCADOLIVRE_APP_ID','MERCADOLIVRE_CLIENT_SECRET','MERCADOLIVRE_TOKEN_ENCRYPTION_KEY'], trueEnv:['MERCADOLIVRE_IDENTITY_VERIFIED','MERCADOLIVRE_NOTIFICATIONS_VERIFIED','MERCADOLIVRE_APP_SEPARATION_VERIFIED'], commercial:true, role:'marketplace_distribution' }),
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
const ORGANIC_PUBLICATION_CHANNELS=new Set(['facebook','instagram','youtube','tiktok','linkedin']);
export function assertChannelPublicationAllowed(channel,decision={},env=process.env,gateEvaluator=salesGate){const readiness=channelReadiness(env)[channel];if(!readiness)throw new Error('unknown_channel');const gate=gateEvaluator(env);if(gate.enabled)return Object.freeze({allowed:true,configured:readiness.configured,provider:readiness.provider,mode:'commercial'});if(!ORGANIC_PUBLICATION_CHANNELS.has(String(channel))||env.ORGANIC_PUBLISHING_ENABLED!=='true'||!organicPublicationAllowed(decision))throw new Error('organic_publication_not_authorized');return Object.freeze({allowed:true,configured:readiness.configured,provider:readiness.provider,mode:'organic_only'});}

export function assertChannelActionAllowed(channel, env = process.env, gateEvaluator=salesGate) {
  const readiness=channelReadiness(env)[channel];
  if(!readiness) throw new Error('unknown_channel');
  const gate=gateEvaluator(env);
  if(!gate.enabled) throw new Error('commercial_gates_closed');
  return Object.freeze({allowed:true,configured:readiness.configured,provider:readiness.provider});
}
