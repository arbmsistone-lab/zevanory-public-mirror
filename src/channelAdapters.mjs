export const CHANNELS = Object.freeze({
  whatsapp: Object.freeze({ provider:'meta-whatsapp-cloud-api', env:['WHATSAPP_ACCESS_TOKEN','WHATSAPP_PHONE_NUMBER_ID'], commercial:true }),
  email: Object.freeze({ provider:'smtp-or-transactional-api', env:['EMAIL_PROVIDER','EMAIL_API_KEY'], commercial:true }),
  instagram: Object.freeze({ provider:'meta-graph-api', env:['META_ACCESS_TOKEN'], commercial:true }),
  facebook: Object.freeze({ provider:'meta-graph-api', env:['META_ACCESS_TOKEN'], commercial:true }),
  tiktok: Object.freeze({ provider:'tiktok-business-api', env:['TIKTOK_ACCESS_TOKEN'], commercial:true }),
  youtube: Object.freeze({ provider:'youtube-data-api', env:['YOUTUBE_API_KEY'], commercial:true }),
  affiliate: Object.freeze({ provider:'network-adapter', env:['AFFILIATE_PROVIDER'], commercial:true }),
});

export function channelReadiness(env = process.env) {
  return Object.fromEntries(Object.entries(CHANNELS).map(([name,def]) => {
    const missing=def.env.filter((key)=>!String(env[key]||'').trim());
    return [name,Object.freeze({ provider:def.provider, configured:missing.length===0, missing:Object.freeze(missing), commercial:def.commercial })];
  }));
}

export function assertChannelActionAllowed(channel, env = process.env) {
  const readiness=channelReadiness(env)[channel];
  if(!readiness) throw new Error('unknown_channel');
  if(!readiness.configured) throw new Error('channel_not_configured');
  if(env.SALE_GLOBALLY_ENABLED!=='true' || env.PRE_SALE_GATES_APPROVED!=='true') throw new Error('commercial_gates_closed');
  return true;
}
