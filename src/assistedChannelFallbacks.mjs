const truthy=(v)=>String(v||'').toLowerCase()==='true';
const https=(v)=>{try{return new URL(String(v||'')).protocol==='https:'}catch{return false}};

const FALLBACKS=Object.freeze({
  tiktok:Object.freeze({
    mode:'operator_assisted',
    flags:['TIKTOK_PROFILE_VERIFIED','TIKTOK_OPERATOR_ASSISTED_PUBLISHING'],
    urlKey:'TIKTOK_PROFILE_URL',
    evidence:'verified_profile_plus_operator_publication',
  }),
  linkedin:Object.freeze({
    mode:'founder_led_operator_assisted',
    flags:['LINKEDIN_FOUNDER_PROFILE_VERIFIED','LINKEDIN_OPERATOR_ASSISTED_PUBLISHING'],
    urlKey:'LINKEDIN_FOUNDER_PROFILE_URL',
    evidence:'verified_founder_profile_plus_operator_publication',
  }),
  nuvemshop:Object.freeze({
    mode:'verified_storefront',
    flags:['NUVEMSHOP_STOREFRONT_VERIFIED'],
    urlKey:'NUVEMSHOP_STOREFRONT_URL',
    evidence:'verified_public_storefront',
  }),
});

export function assistedFallbackReadiness(channel,env=process.env){
  const def=FALLBACKS[channel];
  if(!def)return Object.freeze({supported:false,ready:false,mode:null,blockers:Object.freeze([])});
  const blockers=[];
  for(const key of def.flags)if(!truthy(env[key]))blockers.push(key);
  if(!https(env[def.urlKey]))blockers.push(def.urlKey);
  return Object.freeze({supported:true,ready:blockers.length===0,mode:def.mode,evidence:def.evidence,target_url:blockers.length===0?String(env[def.urlKey]):null,blockers:Object.freeze(blockers)});
}

export function buildAssistedPublicationTask(channel,{text='',media_url=null}={},env=process.env){
  const state=assistedFallbackReadiness(channel,env);
  if(!state.ready)throw new Error('assisted_channel_not_ready');
  if(!String(text).trim())throw new Error('assisted_content_required');
  return Object.freeze({channel,mode:state.mode,target_url:state.target_url,text:String(text).slice(0,5000),media_url:media_url&&https(media_url)?String(media_url):null,requires_operator_action:true,provider_api_claimed:false});
}
