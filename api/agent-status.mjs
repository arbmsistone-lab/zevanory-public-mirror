import { neon } from '@neondatabase/serverless';
import { salesGate } from '../src/salesGate.mjs';
import { isPublicDeploymentRequest } from '../src/security.mjs';
import { executeVerifiedRead } from '../src/databaseReadFabric.mjs';
import { autopilotHealthy, AUTOPILOT_POLICY } from '../src/nonCommercialAutopilot.mjs';

export default async function handler(req,res){
  res.setHeader('content-type','application/json; charset=utf-8'); res.setHeader('cache-control','no-store'); res.setHeader('x-content-type-options','nosniff');
  if(req.method!=='GET'){res.statusCode=405;return res.end(JSON.stringify({error:'method_not_allowed'}));}
  const owner=String(req.headers?.['x-zevanory-owner-authenticated']||'')==='1';
  const summaryOnly=new URL(req.url||'/api/agent/status','https://zevanory.api.br').searchParams.get('summary')==='1';
  const readOutcome=await executeVerifiedRead({env:process.env,connect:neon,read:async(sql)=>{
    const [jobs,runs,autopilot,programs,latest,traces,recentRuns,intelligence,outbox]=await Promise.all([
      sql.query('select status,count(*)::int as count from agent_jobs group by status'),
      sql.query("select mode,outcome,count(*)::int as count from agent_runs where provider<>'noncommercial-autopilot-trace' and created_at>=now()-interval '24 hours' group by mode,outcome"),
      sql.query("select count(*)::int cycles_24h,max(created_at) last_cycle_at from agent_runs where provider='noncommercial-autopilot' and created_at>=now()-interval '24 hours'"),
      sql.query("select count(*)::int program_drafts from knowledge_documents where namespace='program_drafts' and active=true"),
      sql.query("select subject_ref,decision,score,created_at,coalesce(payload->>'cycle_id',payload->'candidate'->>'cycle_id') cycle_id from intelligence_snapshots where payload->>'autopilot'='true' order by created_at desc limit 1"),
      sql.query("select run_id,trace_id,outcome,provider,model,mode,tool_calls,latency_ms,decision->>'action' action,created_at from agent_runs where provider<>'noncommercial-autopilot-trace' and created_at>=now()-interval '24 hours' order by created_at desc limit 60"),
      sql.query("select run_id,trace_id,span_id,outcome,latency_ms,decision,created_at from agent_runs where provider='noncommercial-autopilot-trace' and created_at>=now()-interval '24 hours' order by created_at desc limit 180"),
      sql.query("select snapshot_id,snapshot_type,subject_ref,payload,evidence_count,organization_count,decision,score,created_at from intelligence_snapshots where created_at>=now()-interval '24 hours' order by created_at desc limit 80"),
      sql.query("select event_id,destination,event_type,status,attempts,created_at,delivered_at,left(coalesce(last_error,''),160) last_error,headers->'provider_acceptance'->>'provider' provider,headers->'provider_confirmation'->>'status' confirmation_status from integration_outbox where created_at>=now()-interval '24 hours' order by created_at desc limit 80"),
    ]);
    return {jobs,runs,autopilot,programs,latest,traces,recentRuns,intelligence,outbox};
  }});
  if(!readOutcome.ok){res.statusCode=503;return res.end(JSON.stringify({error:'agent_status_unavailable'}));}
  const {jobs,runs,autopilot,programs,latest,traces,recentRuns,intelligence,outbox}=readOutcome.result;
  const count=(rows,key,value)=>Number(rows.find(x=>x[key]===value)?.count||0);
  const activity=[...(recentRuns||[]).map(x=>({kind:'agent_run',id:x.run_id,trace_id:x.trace_id||null,state:x.outcome,title:x.action||x.provider||'agent_run',provider:x.provider||null,model:x.model||null,mode:x.mode||null,tool_calls:Number(x.tool_calls||0),latency_ms:Number(x.latency_ms||0),created_at:x.created_at})),...(intelligence||[]).map(x=>({kind:'intelligence',id:x.snapshot_id,state:'completed',title:x.snapshot_type,subject:x.subject_ref,evidence_count:Number(x.evidence_count||0),organization_count:Number(x.organization_count||0),decision:x.decision||null,score:x.score==null?null:Number(x.score),...(owner?{evidence:x.payload?.input?.evidence||[],providers:x.payload?.providers||[],candidate:x.payload?.candidate||null,creative:x.payload?.creative||null,policy:x.payload?.policy||null}:{}),created_at:x.created_at})),...(outbox||[]).map(x=>({kind:'channel_outbox',id:x.event_id,state:x.status,title:x.event_type,destination:x.destination,attempts:Number(x.attempts||0),provider:x.provider||null,confirmation_status:x.confirmation_status||null,error:x.last_error||null,created_at:x.delivered_at||x.created_at}))].sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at)).slice(0,120);
  const outboxSummary=(outbox||[]).reduce((acc,x)=>{acc.total++;acc[x.status]=(acc[x.status]||0)+1;return acc;},{total:0,pending:0,processing:0,delivered:0,retry:0,dead_letter:0,canceled:0});
  const aiRuns=(recentRuns||[]).filter(x=>x.mode==='ai_assisted');
  const aiDomains=new Set(aiRuns.map(x=>String(x.provider||'').trim()).filter(Boolean));
  const latestAi=aiRuns[0]||null;
  res.statusCode=200;
  const body={engine:'autonomous-revenue-engine',ai_provider:latestAi?.provider||'deterministic-fallback',ai_mesh:{recent_ai_assisted_runs:aiRuns.length,recent_providers:[...aiDomains],minimum_independent_domains:3,free_only_required:true},queued:count(jobs,'status','queued'),running:count(jobs,'status','running'),blocked:count(jobs,'status','blocked'),failed:count(jobs,'status','failed'),runs_24h:runs.reduce((sum,row)=>sum+Number(row.count||0),0),commercial_execution:salesGate().enabled?'enabled':'blocked',lifecycle_certified:salesGate().lifecycle_approved,autopilot:{enabled:true,health:autopilotHealthy(autopilot?.[0]?.last_cycle_at)?'HEALTHY':'DEGRADED',watchdog_minutes:AUTOPILOT_POLICY.watchdog_minutes,cycles_24h:Number(autopilot?.[0]?.cycles_24h||0),last_cycle_at:autopilot?.[0]?.last_cycle_at||null,program_drafts:Number(programs?.[0]?.program_drafts||0),latest:latest?.[0]||null,timeline:(traces||[]).map(x=>({run_id:x.run_id,trace_id:x.trace_id,span_id:x.span_id,outcome:x.outcome,latency_ms:Number(x.latency_ms||0),stage:x.decision?.stage||null,cycle_id:x.decision?.cycle_id||null,details:{subject:x.decision?.subject||null,candidate_id:x.decision?.candidate_id||null,market_decision:x.decision?.market_decision||null,market_score:x.decision?.market_score??null,verified_sources:x.decision?.verified_sources??null,independent_organizations:x.decision?.independent_organizations??null,candidate_count:x.decision?.candidate_count??null,best_channel:x.decision?.best_channel||null,quality_score:x.decision?.quality_score??null,perceptual_score:x.decision?.perceptual_score??null,creative_id:x.decision?.creative_id||null,elite_accepted:x.decision?.elite_accepted??null,accepted_channels:x.decision?.accepted_channels??null,rejected_channels:x.decision?.rejected_channels??null},created_at:x.created_at})),cadence_minutes:60,commercial_unlock:false},activity_timeline:activity,outbox_24h:outboxSummary,read_route:readOutcome.route,canonical_read:readOutcome.canonical};
  if(summaryOnly){body.autopilot={...body.autopilot,timeline:[]};body.activity_timeline=[];}
  if(isPublicDeploymentRequest(req)){delete body.ai_provider;delete body.ai_mesh;delete body.read_route;delete body.canonical_read;}
  return res.end(JSON.stringify(body));
}
