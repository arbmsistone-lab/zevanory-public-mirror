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

export async function collectCrossrefMarketSignal(subject,{fetchImpl=globalThis.fetch,timeoutMs=5000}={}){
  const u=new URL('https://api.crossref.org/works');u.searchParams.set('query.bibliographic',clean(subject,180));u.searchParams.set('rows','50');u.searchParams.set('select','DOI,title,published,created,is-referenced-by-count');
  const r=await fetchImpl(u,{headers:{accept:'application/json','user-agent':'ZEVANORY-Market-Intelligence/1.0 (mailto:zevanory@gmail.com)'},signal:timeoutSignal(timeoutMs)});const body=await json(r);if(!r.ok)throw new Error(`crossref_market_http_${r.status}`);
  const rows=Array.isArray(body?.message?.items)?body.message.items:[],recent=rows.filter(x=>{const t=Date.parse(x?.created?.['date-time']||0);return Number.isFinite(t)&&Date.now()-t<=180*86400000;}).length,citations=rows.reduce((a,x)=>a+num(x?.['is-referenced-by-count']),0);
  return Object.freeze({organization:'crossref',ok:true,status:200,evidence:{source:'Crossref REST API',organization:'crossref',source_url:'https://api.crossref.org/works',observed_at:new Date().toISOString(),verified:true,conflict:false,kind:'research_attention'},metrics:{demand:logNorm(citations+rows.length,10000),trend:clamp(recent/Math.max(1,rows.length)),competition:clamp(rows.length/50)},sample:{works:rows.length,recent_180d:recent,citations}});
}

export async function collectDataCiteMarketSignal(subject,{fetchImpl=globalThis.fetch,timeoutMs=5000}={}){
  const u=new URL('https://api.datacite.org/dois');u.searchParams.set('query',clean(subject,180));u.searchParams.set('page[size]','50');
  const r=await fetchImpl(u,{headers:{accept:'application/vnd.api+json','user-agent':'ZEVANORY-Market-Intelligence/1.0 (mailto:zevanory@gmail.com)'},signal:timeoutSignal(timeoutMs)});const body=await json(r);if(!r.ok)throw new Error(`datacite_market_http_${r.status}`);
  const rows=Array.isArray(body?.data)?body.data:[],recent=rows.filter(x=>{const y=num(x?.attributes?.publicationYear);return y>=new Date().getUTCFullYear()-1;}).length,total=num(body?.meta?.total)||rows.length;
  return Object.freeze({organization:'datacite',ok:true,status:200,evidence:{source:'DataCite REST API',organization:'datacite',source_url:'https://api.datacite.org/dois',observed_at:new Date().toISOString(),verified:true,conflict:false,kind:'dataset_research_attention'},metrics:{demand:logNorm(total,100000),trend:clamp(recent/Math.max(1,rows.length)),competition:clamp(rows.length/50)},sample:{total,returned:rows.length,recent_publications:recent}});
}

export async function collectStackExchangeMarketSignal(subject,{fetchImpl=globalThis.fetch,timeoutMs=5000}={}){
  const u=new URL('https://api.stackexchange.com/2.3/search/advanced');u.searchParams.set('site','stackoverflow');u.searchParams.set('q',clean(subject,180));u.searchParams.set('pagesize','20');u.searchParams.set('sort','activity');u.searchParams.set('order','desc');
  const r=await fetchImpl(u,{headers:{accept:'application/json','user-agent':'ZEVANORY-Market-Intelligence/1.0'},signal:timeoutSignal(timeoutMs)});const body=await json(r);if(!r.ok)throw new Error(`stackexchange_market_http_${r.status}`);if(num(body?.backoff)>0)throw new Error('stackexchange_market_backoff');
  const rows=Array.isArray(body?.items)?body.items:[],recent=rows.filter(x=>Date.now()-num(x?.creation_date)*1000<=90*86400000).length,score=rows.reduce((a,x)=>a+Math.max(0,num(x?.score))+Math.max(0,num(x?.answer_count)),0);
  return Object.freeze({organization:'stack-exchange',ok:true,status:200,evidence:{source:'Stack Exchange API',organization:'stack-exchange',source_url:'https://api.stackexchange.com/2.3/search/advanced',observed_at:new Date().toISOString(),verified:true,conflict:false,kind:'developer_problem_attention'},metrics:{demand:logNorm(score+rows.length,5000),trend:clamp(recent/Math.max(1,rows.length)),competition:clamp(rows.length/20)},sample:{questions:rows.length,recent_90d:recent,engagement_score:score,quota_remaining:num(body?.quota_remaining)}});
}

export async function collectWorldBankMarketSignal(subject,{fetchImpl=globalThis.fetch,timeoutMs=5000}={}){
  const u=new URL('https://api.worldbank.org/v2/indicator');u.searchParams.set('format','json');u.searchParams.set('per_page','100');
  const r=await fetchImpl(u,{headers:{accept:'application/json','user-agent':'ZEVANORY-Market-Intelligence/1.0'},signal:timeoutSignal(timeoutMs)});const body=await json(r);if(!r.ok)throw new Error('worldbank_market_http_'+r.status);
  const rows=Array.isArray(body?.[1])?body[1]:[],tokens=clean(subject,180).toLowerCase().split(/\s+/).filter(x=>x.length>2);const matches=rows.filter(x=>{const text=(String(x?.name||'')+' '+String(x?.sourceNote||'')+' '+String(x?.sourceOrganization||'')).toLowerCase();return tokens.some(t=>text.includes(t));});
  return Object.freeze({organization:'world-bank',ok:true,status:200,evidence:{source:'World Bank Indicators API',organization:'world-bank',source_url:'https://api.worldbank.org/v2/indicator',observed_at:new Date().toISOString(),verified:true,conflict:false,kind:'economic_context'},metrics:{demand:clamp(matches.length/Math.max(1,rows.length)),trend:matches.length?0.5:0,competition:clamp(matches.length/25)},sample:{indicators_scanned:rows.length,matching_indicators:matches.length}});
}

export async function collectOpenAlexMarketSignal(subject,{fetchImpl=globalThis.fetch,timeoutMs=5000}={}){
  const u=new URL('https://api.openalex.org/works');u.searchParams.set('search',clean(subject,180));u.searchParams.set('per-page','50');u.searchParams.set('mailto','zevanory@gmail.com');
  const r=await fetchImpl(u,{headers:{accept:'application/json','user-agent':'ZEVANORY-Market-Intelligence/1.0'},signal:timeoutSignal(timeoutMs)});const body=await json(r);if(!r.ok)throw new Error('openalex_market_http_'+r.status);
  const rows=Array.isArray(body?.results)?body.results:[],recent=rows.filter(x=>{const y=num(x?.publication_year);return y>=new Date().getUTCFullYear()-1;}).length,total=num(body?.meta?.count)||rows.length,citations=rows.reduce((a,x)=>a+num(x?.cited_by_count),0);
  return Object.freeze({organization:'openalex',ok:true,status:200,evidence:{source:'OpenAlex API',organization:'openalex',source_url:'https://api.openalex.org/works',observed_at:new Date().toISOString(),verified:true,conflict:false,kind:'research_attention'},metrics:{demand:logNorm(total+citations,100000),trend:clamp(recent/Math.max(1,rows.length)),competition:clamp(rows.length/50)},sample:{total,returned:rows.length,recent_publications:recent,citations}});
}

export async function collectHackerNewsMarketSignal(subject,{fetchImpl=globalThis.fetch,timeoutMs=5000}={}){
  const u=new URL('https://hn.algolia.com/api/v1/search');u.searchParams.set('query',clean(subject,180));u.searchParams.set('hitsPerPage','25');
  const r=await fetchImpl(u,{headers:{accept:'application/json','user-agent':'ZEVANORY-Market-Intelligence/1.0'},signal:timeoutSignal(timeoutMs)});const body=await json(r);if(!r.ok)throw new Error('hackernews_market_http_'+r.status);
  const rows=Array.isArray(body?.hits)?body.hits:[],points=rows.reduce((a,x)=>a+num(x?.points)+num(x?.num_comments),0),recent=rows.filter(x=>Date.now()-Date.parse(x?.created_at||0)<=90*86400000).length;
  return Object.freeze({organization:'hacker-news',ok:true,status:200,evidence:{source:'Hacker News Algolia API',organization:'hacker-news',source_url:'https://hn.algolia.com/api/v1/search',observed_at:new Date().toISOString(),verified:true,conflict:false,kind:'technology_discussion_attention'},metrics:{demand:logNorm(points+rows.length,5000),trend:clamp(recent/Math.max(1,rows.length)),competition:clamp(rows.length/25)},sample:{hits:rows.length,engagement:points,recent_90d:recent}});
}

export async function collectGitHubMarketSignal(subject,{fetchImpl=globalThis.fetch,timeoutMs=5000}={}){
  const u=new URL('https://api.github.com/search/repositories');u.searchParams.set('q',clean(subject,180));u.searchParams.set('per_page','25');u.searchParams.set('sort','updated');u.searchParams.set('order','desc');
  const r=await fetchImpl(u,{headers:{accept:'application/vnd.github+json','user-agent':'ZEVANORY-Market-Intelligence/1.0','x-github-api-version':'2022-11-28'},signal:timeoutSignal(timeoutMs)});const body=await json(r);if(!r.ok)throw new Error('github_market_http_'+r.status);
  const rows=Array.isArray(body?.items)?body.items:[],stars=rows.reduce((a,x)=>a+num(x?.stargazers_count),0),recent=rows.filter(x=>Date.now()-Date.parse(x?.updated_at||0)<=90*86400000).length,total=num(body?.total_count)||rows.length;
  return Object.freeze({organization:'github',ok:true,status:200,evidence:{source:'GitHub Repository Search API',organization:'github',source_url:'https://api.github.com/search/repositories',observed_at:new Date().toISOString(),verified:true,conflict:false,kind:'software_ecosystem_attention'},metrics:{demand:logNorm(total+stars,100000),trend:clamp(recent/Math.max(1,rows.length)),competition:clamp(rows.length/25)},sample:{total,returned:rows.length,stars,recent_90d:recent}});
}

export async function collectNativeMarketSignals(subject,options={}){
  const tasks=[collectMercadoLivreMarketSignal(subject,options),collectYouTubeMarketSignal(subject,options),collectWikimediaMarketSignal(subject,options),collectGdeltMarketSignal(subject,options),collectCrossrefMarketSignal(subject,options),collectDataCiteMarketSignal(subject,options),collectStackExchangeMarketSignal(subject,options),collectWorldBankMarketSignal(subject,options),collectOpenAlexMarketSignal(subject,options),collectHackerNewsMarketSignal(subject,options),collectGitHubMarketSignal(subject,options)];
  const settled=await Promise.allSettled(tasks);const names=['mercado-livre','google-youtube','wikimedia-foundation','gdelt-project','crossref','datacite','stack-exchange','world-bank','openalex','hacker-news','github'];
  return Object.freeze(settled.map((x,i)=>x.status==='fulfilled'?x.value:{organization:names[i],ok:false,status:0,error:clean(x.reason?.message,160)}));
}
