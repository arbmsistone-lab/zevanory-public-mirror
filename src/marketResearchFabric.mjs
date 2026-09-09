import { decideMarketOpportunity } from './marketIntelligence.mjs';

const clean=(v,max=500)=>String(v||'').trim().slice(0,max);
const https=(v)=>{try{const u=new URL(String(v||''));return u.protocol==='https:'?u.toString():null;}catch{return null;}};

export function marketResearchFeeds(env=process.env){
  let raw=[];try{raw=JSON.parse(String(env.MARKET_RESEARCH_FEEDS||'[]'));}catch{raw=[];}
  if(!Array.isArray(raw))return Object.freeze([]);
  const seen=new Set(),out=[];
  for(const item of raw){
    const url=https(item?.url),organization=clean(item?.organization,100).toLowerCase();
    if(!url||!organization||seen.has(organization))continue;
    seen.add(organization);out.push(Object.freeze({name:clean(item?.name||organization,100),organization,url}));
  }
  return Object.freeze(out.slice(0,12));
}

export function marketResearchReadiness(env=process.env){
  const feeds=marketResearchFeeds(env);
  return Object.freeze({configured:feeds.length,ready:feeds.length>=3,organizations:Object.freeze(feeds.map(x=>x.organization))});
}

const timeoutSignal=(ms)=>AbortSignal.timeout(Math.max(500,Math.min(10000,Number(ms)||5000)));
export async function collectMarketSignals(subject,{env=process.env,fetchImpl=globalThis.fetch,timeoutMs=5000}={}){
  const feeds=marketResearchFeeds(env),results=[];
  for(const feed of feeds){
    try{
      const u=new URL(feed.url);u.searchParams.set('subject',clean(subject,180));
      const r=await fetchImpl(u,{headers:{accept:'application/json'},signal:timeoutSignal(timeoutMs)});
      if(!r.ok){results.push({organization:feed.organization,ok:false,status:r.status});continue;}
      const body=await r.json();const signal=body?.result&&typeof body.result==='object'?body.result:body;
      results.push({organization:feed.organization,ok:true,status:r.status,evidence:{source:feed.name,organization:feed.organization,source_url:feed.url,observed_at:new Date().toISOString(),verified:signal?.verified===true,conflict:signal?.conflict===true,signal:signal?.signal,kind:signal?.kind||'market_signal'},metrics:signal?.metrics||{}});
    }catch(error){results.push({organization:feed.organization,ok:false,status:0,error:clean(error?.message,120)});}
  }
  return Object.freeze(results);
}

export function aggregateMarketSignals(subject,results=[]){
  const ok=results.filter(x=>x?.ok&&x.evidence?.verified===true);
  const metrics=['demand','trend','competition','margin','strategic_fit','execution_fit'];
  const aggregated={};
  for(const key of metrics){const values=ok.map(x=>Number(x.metrics?.[key])).filter(Number.isFinite);aggregated[key]=values.length?values.reduce((a,b)=>a+b,0)/values.length:null;}
  const input={subject,...aggregated,evidence:ok.map(x=>x.evidence)};
  return Object.freeze({subject:clean(subject,180),collected:results.length,verified:ok.length,input,decision:decideMarketOpportunity(input)});
}
