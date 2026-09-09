import { randomUUID } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { safeBearerEqual } from '../src/security.mjs';
import { evaluateProductCandidate, investmentSummary } from '../src/productIntelligence.mjs';
import { collectMarketSignals, aggregateMarketSignals, marketResearchReadiness } from '../src/marketResearchFabric.mjs';
import { ZEVANORY_PRODUCTS } from '../src/offerCatalog.mjs';

const json=(res,status,body)=>{res.statusCode=status;res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');return res.end(JSON.stringify(body));};
const bearer=(req)=>String(req.headers?.authorization||'').replace(/^Bearer\s+/i,'');

async function readLatest(sql,limit=30){
  return sql.query(`select snapshot_id,snapshot_type,subject_ref,payload,evidence_count,organization_count,decision,score,observed_at,created_at
    from intelligence_snapshots order by created_at desc limit $1`,[Math.max(1,Math.min(100,Number(limit)||30))]);
}

export default async function handler(req,res){
  if(!process.env.DATABASE_URL)return json(res,503,{error:'intelligence_storage_unavailable'});
  const sql=neon(process.env.DATABASE_URL);
  if(req.method==='GET'){
    const stream=String(req.query?.stream||new URL(req.url||'/api/intelligence','https://zevanory.api.br').searchParams.get('stream')||'')==='1';
    if(stream){
      res.statusCode=200;res.setHeader('content-type','text/event-stream; charset=utf-8');res.setHeader('cache-control','no-store, no-transform');res.setHeader('x-content-type-options','nosniff');res.write('retry: 5000\n');
      try{const snapshots=await readLatest(sql,20);res.write(`event: intelligence\ndata: ${JSON.stringify({generated_at:new Date().toISOString(),snapshots})}\n\n`);return res.end();}
      catch{res.write(`event: unavailable\ndata: ${JSON.stringify({error:'intelligence_stream_unavailable'})}\n\n`);return res.end();}
    }
    try{return json(res,200,{generated_at:new Date().toISOString(),research_readiness:marketResearchReadiness(process.env),catalog:ZEVANORY_PRODUCTS.map(x=>({product_id:x.sku,name:x.product,category:x.offer_type,status:x.status,price_status:x.price_status})),snapshots:await readLatest(sql,req.query?.limit)});}
    catch{return json(res,503,{error:'intelligence_read_unavailable'});}
  }
  if(req.method!=='POST')return json(res,405,{error:'method_not_allowed'});
  const expected=String(process.env.AGENT_WORKER_TOKEN||'');
  if(!safeBearerEqual(expected,bearer(req)))return json(res,401,{error:'intelligence_auth_required'});
  let body={};try{body=typeof req.body==='object'&&req.body?req.body:JSON.parse(String(req.body||'{}'));}catch{return json(res,400,{error:'invalid_json'});}
  try{
    if(body.type==='market_research_run'){
      const subject=String(body.subject||'').trim().slice(0,180);if(!subject)return json(res,400,{error:'research_subject_required'});
      const collected=await collectMarketSignals(subject,{env:process.env});const aggregate=aggregateMarketSignals(subject,collected);
      await sql.query(`insert into intelligence_snapshots(snapshot_id,snapshot_type,subject_ref,payload,evidence_count,organization_count,decision,score,observed_at)
        values($1,'market_research',$2,$3::jsonb,$4,$5,$6,$7,now())`,[randomUUID(),subject,JSON.stringify(aggregate),aggregate.decision.readiness.verified_sources,aggregate.decision.readiness.independent_organizations,aggregate.decision.decision,aggregate.decision.opportunity.score]);
      return json(res,201,{ok:true,research:aggregate});
    }
    if(body.type==='product_candidate'){
      const evaluated=evaluateProductCandidate(body.candidate||{});
      const ref=evaluated.product.product_id||randomUUID();
      await sql.query(`insert into intelligence_snapshots(snapshot_id,snapshot_type,subject_ref,payload,evidence_count,organization_count,decision,score,observed_at)
        values($1,'market_research',$2,$3::jsonb,$4,$5,$6,$7,now())`,[
        randomUUID(),ref,JSON.stringify(evaluated),evaluated.market.readiness.verified_sources,evaluated.market.readiness.independent_organizations,
        evaluated.market.decision,evaluated.market.opportunity.score,
      ]);
      return json(res,201,{ok:true,evaluation:evaluated});
    }
    if(body.type==='product_ranking'){
      const summary=investmentSummary(body.candidates||[]);
      await sql.query(`insert into intelligence_snapshots(snapshot_id,snapshot_type,subject_ref,payload,evidence_count,organization_count,decision,score,observed_at)
        values($1,'product_ranking','portfolio',$2::jsonb,$3,$4,$5,$6,now())`,[
        randomUUID(),JSON.stringify(summary),Number(summary.top_candidate?.market?.readiness?.verified_sources||0),
        Number(summary.top_candidate?.market?.readiness?.independent_organizations||0),summary.top_candidate?.market?.decision||null,
        summary.top_candidate?.market?.opportunity?.score??null,
      ]);
      return json(res,201,{ok:true,summary});
    }
    return json(res,400,{error:'unsupported_intelligence_type'});
  }catch(error){return json(res,503,{error:'intelligence_write_unavailable',detail:String(error?.message||'unknown').slice(0,180)});}
}
