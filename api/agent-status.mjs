import { neon } from '@neondatabase/serverless';
import { salesGate } from '../src/salesGate.mjs';

export default async function handler(req,res){
  res.setHeader('content-type','application/json; charset=utf-8'); res.setHeader('cache-control','no-store'); res.setHeader('x-content-type-options','nosniff');
  if(req.method!=='GET'){res.statusCode=405;return res.end(JSON.stringify({error:'method_not_allowed'}));}
  if(!process.env.DATABASE_URL){res.statusCode=503;return res.end(JSON.stringify({error:'agent_storage_unavailable'}));}
  try{
    const sql=neon(process.env.DATABASE_URL);
    const [jobs,runs]=await Promise.all([
      sql.query('select status,count(*)::int as count from agent_jobs group by status'),
      sql.query("select mode,outcome,count(*)::int as count from agent_runs where created_at>=now()-interval '24 hours' group by mode,outcome"),
    ]);
    const count=(rows,key,value)=>Number(rows.find(x=>x[key]===value)?.count||0);
    res.statusCode=200;
    return res.end(JSON.stringify({
      engine:'autonomous-revenue-engine', ai_provider:process.env.GEMINI_API_KEY?'google-gemini':'deterministic-fallback',
      queued:count(jobs,'status','queued'), running:count(jobs,'status','running'), blocked:count(jobs,'status','blocked'), failed:count(jobs,'status','failed'),
      runs_24h:runs.reduce((sum,row)=>sum+Number(row.count||0),0), commercial_execution:salesGate().enabled?'enabled':'blocked', lifecycle_certified:salesGate().lifecycle_approved,
    }));
  }catch{res.statusCode=503;return res.end(JSON.stringify({error:'agent_status_unavailable'}));}
}
