import { neon } from '@neondatabase/serverless';
import { salesGate } from '../src/salesGate.mjs';
import { isPublicDeploymentRequest } from '../src/security.mjs';
import { executeVerifiedRead } from '../src/databaseReadFabric.mjs';
import { autopilotHealthy, AUTOPILOT_POLICY } from '../src/nonCommercialAutopilot.mjs';

export default async function handler(req,res){
  res.setHeader('content-type','application/json; charset=utf-8'); res.setHeader('cache-control','no-store'); res.setHeader('x-content-type-options','nosniff');
  if(req.method!=='GET'){res.statusCode=405;return res.end(JSON.stringify({error:'method_not_allowed'}));}
  const readOutcome=await executeVerifiedRead({env:process.env,connect:neon,read:async(sql)=>{
    const [jobs,runs,autopilot,programs,latest,traces]=await Promise.all([
      sql.query('select status,count(*)::int as count from agent_jobs group by status'),
      sql.query("select mode,outcome,count(*)::int as count from agent_runs where provider<>'noncommercial-autopilot-trace' and created_at>=now()-interval '24 hours' group by mode,outcome"),
      sql.query("select count(*)::int cycles_24h,max(created_at) last_cycle_at from agent_runs where provider='noncommercial-autopilot' and created_at>=now()-interval '24 hours'"),
      sql.query("select count(*)::int program_drafts from knowledge_documents where namespace='program_drafts' and active=true"),
      sql.query("select subject_ref,decision,score,created_at,coalesce(payload->>'cycle_id',payload->'candidate'->>'cycle_id') cycle_id from intelligence_snapshots where payload->>'autopilot'='true' order by created_at desc limit 1"),
      sql.query("select run_id,trace_id,span_id,outcome,latency_ms,decision,created_at from agent_runs where provider='noncommercial-autopilot-trace' and created_at>=now()-interval '24 hours' order by created_at desc limit 180"),
    ]);
    return {jobs,runs,autopilot,programs,latest,traces};
  }});
  if(!readOutcome.ok){res.statusCode=503;return res.end(JSON.stringify({error:'agent_status_unavailable'}));}
  const {jobs,runs,autopilot,programs,latest,traces}=readOutcome.result;
  const count=(rows,key,value)=>Number(rows.find(x=>x[key]===value)?.count||0);
  res.statusCode=200;
  const body={engine:'autonomous-revenue-engine',ai_provider:process.env.GEMINI_API_KEY?'google-gemini':'deterministic-fallback',queued:count(jobs,'status','queued'),running:count(jobs,'status','running'),blocked:count(jobs,'status','blocked'),failed:count(jobs,'status','failed'),runs_24h:runs.reduce((sum,row)=>sum+Number(row.count||0),0),commercial_execution:salesGate().enabled?'enabled':'blocked',lifecycle_certified:salesGate().lifecycle_approved,autopilot:{enabled:true,health:autopilotHealthy(autopilot?.[0]?.last_cycle_at)?'HEALTHY':'DEGRADED',watchdog_minutes:AUTOPILOT_POLICY.watchdog_minutes,cycles_24h:Number(autopilot?.[0]?.cycles_24h||0),last_cycle_at:autopilot?.[0]?.last_cycle_at||null,program_drafts:Number(programs?.[0]?.program_drafts||0),latest:latest?.[0]||null,timeline:(traces||[]).map(x=>({run_id:x.run_id,trace_id:x.trace_id,span_id:x.span_id,outcome:x.outcome,latency_ms:Number(x.latency_ms||0),stage:x.decision?.stage||null,cycle_id:x.decision?.cycle_id||null,details:{subject:x.decision?.subject||null,candidate_id:x.decision?.candidate_id||null,market_decision:x.decision?.market_decision||null,market_score:x.decision?.market_score??null,verified_sources:x.decision?.verified_sources??null,independent_organizations:x.decision?.independent_organizations??null,candidate_count:x.decision?.candidate_count??null,best_channel:x.decision?.best_channel||null,quality_score:x.decision?.quality_score??null,perceptual_score:x.decision?.perceptual_score??null,creative_id:x.decision?.creative_id||null,elite_accepted:x.decision?.elite_accepted??null},created_at:x.created_at})),cadence_minutes:60,commercial_unlock:false},read_route:readOutcome.route,canonical_read:readOutcome.canonical};
  if(isPublicDeploymentRequest(req)){delete body.ai_provider;delete body.read_route;delete body.canonical_read;}
  return res.end(JSON.stringify(body));
}
