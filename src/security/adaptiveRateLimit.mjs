const buckets=new Map();
const MAX_BUCKETS=2048;
const PERIOD_MS=60_000;

function prune(now){
  for(const [key,state] of buckets){if(state.resetAt<=now)buckets.delete(key);}
  if(buckets.size<=MAX_BUCKETS)return;
  let overflow=buckets.size-MAX_BUCKETS;
  for(const key of buckets.keys()){buckets.delete(key);if(--overflow<=0)break;}
}

export function webhookRateProfile(provider){
  const p=String(provider||'').toLowerCase();
  if(p==='meta')return {limit:180,burstPenalty:30};
  if(p==='resend')return {limit:120,burstPenalty:30};
  if(p==='mercadopago'||p==='asaas')return {limit:90,burstPenalty:45};
  if(p==='mercadolivre'||p==='mercadolivre_oauth')return {limit:90,burstPenalty:45};
  return {limit:30,burstPenalty:60};
}

export function consumeAdaptiveWebhookRate({key,provider,now=Date.now()}){
  prune(now);
  const profile=webhookRateProfile(provider);
  const normalized=String(key||'unknown').slice(0,240);
  let state=buckets.get(normalized);
  if(!state||state.resetAt<=now)state={count:0,strikes:0,resetAt:now+PERIOD_MS,blockedUntil:0};
  if(state.blockedUntil>now){
    return {ok:false,retryAfter:Math.max(1,Math.ceil((state.blockedUntil-now)/1000)),remaining:0};
  }
  state.count+=1;
  if(state.count>profile.limit){
    state.strikes+=1;
    const factor=Math.min(8,2**Math.min(3,Math.floor(state.strikes/3)));
    state.blockedUntil=now+profile.burstPenalty*factor*1000;
    buckets.set(normalized,state);
    return {ok:false,retryAfter:Math.max(1,Math.ceil((state.blockedUntil-now)/1000)),remaining:0};
  }
  state.strikes=Math.max(0,state.strikes-0.05);
  buckets.set(normalized,state);
  return {ok:true,retryAfter:0,remaining:Math.max(0,profile.limit-state.count)};
}

export function resetAdaptiveWebhookRateForTests(){buckets.clear();}
