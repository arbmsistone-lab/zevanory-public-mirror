const clean=(v,max=4000)=>String(v??'').trim().slice(0,max);

const BUFFER_CHANNELS=Object.freeze({
  tiktok:'BUFFER_TIKTOK_CHANNEL_ID',
  linkedin:'BUFFER_LINKEDIN_CHANNEL_ID',
});

export function alternateAutomationReadiness(channel,env=process.env){
  const channelKey=BUFFER_CHANNELS[channel];
  if(!channelKey)return Object.freeze({supported:false,ready:false,provider:null,mode:null,blockers:Object.freeze([])});
  const blockers=[];
  if(!clean(env.BUFFER_API_KEY,4000))blockers.push('BUFFER_API_KEY');
  if(!clean(env[channelKey],300))blockers.push(channelKey);
  return Object.freeze({supported:true,ready:blockers.length===0,provider:'buffer',mode:'buffer_api',channel_id:blockers.length===0?clean(env[channelKey],300):null,blockers:Object.freeze(blockers)});
}

export function providerDiversityState(channel,env=process.env){
  const alternate=alternateAutomationReadiness(channel,env);
  return Object.freeze({channel,alternate,independent_provider:alternate.ready});
}
