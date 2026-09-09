import { loadMercadoLivreCredential, refreshMercadoLivreCredential } from './mercadoLivreOAuth.mjs';

const clamp=(v,min=0,max=1)=>Math.max(min,Math.min(max,Number(v)||0));
const clean=(v,max=500)=>String(v??'').trim().slice(0,max);
const num=(v)=>Number.isFinite(Number(v))?Number(v):0;
const timeoutSignal=(ms)=>AbortSignal.timeout(Math.max(800,Math.min(10000,Number(ms)||5000)));
const logNorm=(value,scale)=>clamp(Math.log1p(Math.max(0,num(value)))/Math.log1p(scale));
const json=async(r)=>{try{return await r.json();}catch{return {};}};

async function youtubeAccessToken(env,fetchImpl,timeoutMs){
  const body=new URLSearchParams({client_id:clean(env.YOUTUBE_OAUTH_CLIENT_ID,500),client_secret:clean(env.YOUTUBE_OAUTH_CLIENT_SECRET,1000),refresh_token:clean(env.YOUTUBE_OAUTH_REFRESH_TOKEN,4000),grant_type:'refresh_token'});
  if(!body.get('client_id')||!body.get('client_secret')||!body.get('refresh_token'))throw new Error('youtube_market_credentials_missing');
  const r=await fetchImpl('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body,signal:timeoutSignal(timeoutMs)});
  const data=await json(r);if(!r.ok||!clean(data.access_token,4000))throw new Error(`youtube_market_token_http_${r.status}`);return data.access_token;
}

export async function collectYouTubeMarketSignal(subject,{env=process.env,fetchImpl=globalThis.fetch,timeoutMs=5000}={}){
  const token=await youtubeAccessToken(env,fetchImpl,timeoutMs),q=clean(subject,180);
  const u=new URL('https://www.googleapis.com/youtube/v3/search');
  Object.entries({part:'snippet',type:'video',q,maxResults:'25',order:'viewCount',regionCode:'BR',relevanceLanguage:'pt',safeSearch:'moderate'}).forEach(([k,v])=>u.searchParams.set(k,v));
  const r=await fetchImpl(u,{headers:{authorization:`Bearer ${token}`,accept:'application/json'},signal:timeoutSignal(timeoutMs)});const body=await json(r);
  if(!r.ok)throw new Error(`youtube_market_search_http_${r.status}`);const items=Array.isArray(body.items)?body.items:[];const ids=items.map(x=>x?.id?.videoId).filter(Boolean);
  if(!ids.length)throw new Error('youtube_market_no_results');
  const vu=new URL('https://www.googleapis.com/youtube/v3/videos');vu.searchParams.set('part','statistics,snippet');vu.searchParams.set('id',ids.join(','));
  const vr=await fetchImpl(vu,{headers:{authorization:`Bearer ${token}`,accept:'application/json'},signal:timeoutSignal(timeoutMs)});const vb=await json(vr);if(!vr.ok)throw new Error(`youtube_market_stats_http_${vr.status}`);
  const videos=Array.isArray(vb.items)?vb.items:[],views=videos.reduce((s,x)=>s+num(x?.statistics?.viewCount),0),channels=new Set(videos.map(x=>x?.snippet?.channelId).filter(Boolean));
  const recent=videos.filter(x=>Date.now()-Date.parse(x?.snippet?.publishedAt||0)<=90*86400000).length;
  return Object.freeze({organization:'google-youtube',ok:true,status:200,evidence:{source:'YouTube Data API',organization:'google-youtube',source_url:'https://www.googleapis.com/youtube/v3/search',observed_at:new Date().toISOString(),verified:true,conflict:false,kind:'audience_demand'},metrics:{demand:logNorm(views,50_000_000),trend:clamp(recent/Math.max(1,videos.length)),competition:clamp(channels.size/Math.max(1,videos.length))},sample:{videos:videos.length,total_views:views,unique_channels:channels.size}});
}export async function collectMercadoLivreMarketSignal(subject,{sql,env=process.env,fetchImpl=globalThis.fetch,timeoutMs=5000}={}){
  if(!sql?.query)throw new Error('mercadolivre_market_sql_required');let credential=await loadMercadoLivreCredential(sql,env);
  if(Date.parse(credential.expires_at||0)-Date.now()<120000)credential=await refreshMercadoLivreCredential(sql,credential,{env,fetchImpl});
  const u=new URL('https://api.mercadolibre.com/sites/MLB/search');u.searchParams.set('q',clean(subject,180));u.searchParams.set('limit','50');
  const r=await fetchImpl(u,{headers:{authorization:`Bearer ${clean(credential.access_token,4000)}`,accept:'application/json'},signal:timeoutSignal(timeoutMs)});const body=await json(r);if(!r.ok)throw new Error(`mercadolivre_market_search_http_${r.status}`);
  const items=Array.isArray(body.results)?body.results:[],total=num(body?.paging?.total),sold=items.reduce((s,x)=>s+num(x?.sold_quantity),0),prices=items.map(x=>num(x?.price)).filter(x=>x>0).sort((a,b)=>a-b);
  const median=prices.length?prices[Math.floor(prices.length/2)]:null;
  return Object.freeze({organization:'mercado-livre',ok:true,status:200,evidence:{source:'Mercado Livre Search API',organization:'mercado-livre',source_url:u.origin+u.pathname,observed_at:new Date().toISOString(),verified:true,conflict:false,kind:'marketplace_demand'},metrics:{demand:clamp((logNorm(sold,25000)*0.65)+(logNorm(total,250000)*0.35)),competition:logNorm(total,250000)},sample:{listings:items.length,total_results:total,sold_quantity_sample:sold,median_price_brl:median}});
}

export async function collectGdeltMarketSignal(subject,{fetchImpl=globalThis.fetch,timeoutMs=6500}={}){
  const u=new URL('https://api.gdeltproject.org/api/v2/doc/doc');u.searchParams.set('query',`"${clean(subject,120).replaceAll('"','')}"`);u.searchParams.set('mode','timelinevolraw');u.searchParams.set('format','json');u.searchParams.set('timespan','30d');
  const r=await fetchImpl(u,{headers:{accept:'application/json','user-agent':'ZEVANORY-Market-Intelligence/1.0'},signal:timeoutSignal(timeoutMs)});const body=await json(r);if(!r.ok)throw new Error(`gdelt_market_http_${r.status}`);
  const data=Array.isArray(body?.timeline?.[0]?.data)?body.timeline[0].data:[];if(!data.length)throw new Error('gdelt_market_no_results');
  const values=data.map(x=>num(x?.value)),total=values.reduce((a,b)=>a+b,0),cut=Math.max(1,Math.floor(values.length/2)),oldAvg=values.slice(0,cut).reduce((a,b)=>a+b,0)/cut,newPart=values.slice(cut),newAvg=newPart.reduce((a,b)=>a+b,0)/Math.max(1,newPart.length);
  const trend=oldAvg<=0?(newAvg>0?1:0.5):clamp(0.5+((newAvg-oldAvg)/(Math.abs(oldAvg)*2)));
  return Object.freeze({organization:'gdelt-project',ok:true,status:200,evidence:{source:'GDELT DOC 2.0 API',organization:'gdelt-project',source_url:'https://api.gdeltproject.org/api/v2/doc/doc',observed_at:new Date().toISOString(),verified:true,conflict:false,kind:'media_attention'},metrics:{demand:logNorm(total,5000),trend},sample:{timeline_points:values.length,article_mentions:total}});
}

export async function collectNativeMarketSignals(subject,options={}){
  const tasks=[collectMercadoLivreMarketSignal(subject,options),collectYouTubeMarketSignal(subject,options),collectGdeltMarketSignal(subject,options)];
  const settled=await Promise.allSettled(tasks);const names=['mercado-livre','google-youtube','gdelt-project'];
  return Object.freeze(settled.map((x,i)=>x.status==='fulfilled'?x.value:{organization:names[i],ok:false,status:0,error:clean(x.reason?.message,160)}));
}
