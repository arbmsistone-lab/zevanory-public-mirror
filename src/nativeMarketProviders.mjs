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
  const u=new URL('https://api.mercadolibre.com/trends/MLB');
  const r=await fetchImpl(u,{headers:{authorization:`Bearer ${clean(credential.access_token,4000)}`,accept:'application/json'},signal:timeoutSignal(timeoutMs)});const body=await json(r);if(!r.ok)throw new Error(`mercadolivre_market_trends_http_${r.status}`);
  const rows=Array.isArray(body)?body:[],tokens=clean(subject,180).toLowerCase().split(/\s+/).filter(x=>x.length>2);
  const matches=rows.filter(x=>{const k=clean(x?.keyword,240).toLowerCase();return tokens.length&&tokens.every(t=>k.includes(t));});
  const rank=matches.length?rows.indexOf(matches[0])+1:null;const demand=rank?clamp(1-((rank-1)/Math.max(1,rows.length))):0;
  return Object.freeze({organization:'mercado-livre',ok:true,status:200,evidence:{source:'Mercado Livre Trends API',organization:'mercado-livre',source_url:'https://api.mercadolibre.com/trends/MLB',observed_at:new Date().toISOString(),verified:true,conflict:false,kind:'marketplace_search_trend'},metrics:{demand,trend:demand,competition:clamp(matches.length/Math.max(1,rows.length))},sample:{trend_rows:rows.length,matching_trends:matches.length,best_rank:rank}});
}

export async function collectGdeltMarketSignal(subject,{fetchImpl=globalThis.fetch,timeoutMs=6500}={}){
  const u=new URL('https://api.gdeltproject.org/api/v2/doc/doc');u.searchParams.set('query',`"${clean(subject,120).replaceAll('"','')}"`);u.searchParams.set('mode','artlist');u.searchParams.set('format','json');u.searchParams.set('timespan','7d');u.searchParams.set('maxrecords','75');
  const r=await fetchImpl(u,{headers:{accept:'application/json','user-agent':'ZEVANORY-Market-Intelligence/1.0'},signal:timeoutSignal(Math.max(timeoutMs,9000))});const body=await json(r);if(!r.ok)throw new Error(`gdelt_market_http_${r.status}`);
  const articles=Array.isArray(body?.articles)?body.articles:[];const ages=articles.map(x=>Date.parse(x?.seendate||x?.date||0)).filter(Number.isFinite).map(t=>(Date.now()-t)/86400000);
  const recent=ages.filter(d=>d<=2).length;const demand=clamp(articles.length/75);const trend=articles.length?clamp(recent/articles.length):0;
  return Object.freeze({organization:'gdelt-project',ok:true,status:200,evidence:{source:'GDELT DOC 2.0 API',organization:'gdelt-project',source_url:'https://api.gdeltproject.org/api/v2/doc/doc',observed_at:new Date().toISOString(),verified:true,conflict:false,kind:'media_attention'},metrics:{demand,trend},sample:{articles:articles.length,recent_48h:recent}});
}

export async function collectWikimediaMarketSignal(subject,{fetchImpl=globalThis.fetch,timeoutMs=5000}={}){
  const u=new URL('https://pt.wikipedia.org/w/api.php');Object.entries({action:'query',list:'search',srsearch:clean(subject,180),format:'json',utf8:'1',srlimit:'10',origin:'*'}).forEach(([k,v])=>u.searchParams.set(k,v));
  const r=await fetchImpl(u,{headers:{accept:'application/json','user-agent':'ZEVANORY-Market-Intelligence/1.0'},signal:timeoutSignal(timeoutMs)});const body=await json(r);if(!r.ok)throw new Error(`wikimedia_market_http_${r.status}`);
  const rows=Array.isArray(body?.query?.search)?body.query.search:[],total=num(body?.query?.searchinfo?.totalhits),top=rows[0]||null;
  return Object.freeze({organization:'wikimedia-foundation',ok:true,status:200,evidence:{source:'Wikimedia Search API',organization:'wikimedia-foundation',source_url:'https://pt.wikipedia.org/w/api.php',observed_at:new Date().toISOString(),verified:true,conflict:false,kind:'information_interest'},metrics:{demand:logNorm(total,100000),trend:rows.length?0.5:0,competition:clamp(rows.length/10)},sample:{total_hits:total,returned:rows.length,top_title:clean(top?.title,160)||null}});
}

export async function collectNativeMarketSignals(subject,options={}){
  const tasks=[collectMercadoLivreMarketSignal(subject,options),collectYouTubeMarketSignal(subject,options),collectWikimediaMarketSignal(subject,options),collectGdeltMarketSignal(subject,options)];
  const settled=await Promise.allSettled(tasks);const names=['mercado-livre','google-youtube','wikimedia-foundation','gdelt-project'];
  return Object.freeze(settled.map((x,i)=>x.status==='fulfilled'?x.value:{organization:names[i],ok:false,status:0,error:clean(x.reason?.message,160)}));
}
