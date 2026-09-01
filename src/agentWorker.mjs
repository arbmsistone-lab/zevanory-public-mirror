import { randomUUID, createHash } from 'node:crypto';
import { buildAgentContext, decideRevenueAction, chooseTool } from './revenueAgent.mjs';
import { authorizeTool } from './agentPolicy.mjs';
import { evaluateAgentDecision } from './agentEvals.mjs';
import { buildFollowUpPlan } from './salesPipeline.mjs';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function claimAgentJob(sql) {
  const rows = await sql.query(`
    update agent_jobs set status='running',locked_at=now(),attempts=attempts+1
    where job_id=(
      select job_id from agent_jobs where status='queued' and available_at<=now()
      order by priority desc,available_at asc,created_at asc
      for update skip locked limit 1
    )
    returning *
  `);
  return rows[0] || null;
}

async function auditTool(sql, runId, tool, auth, input) {
  await sql.query(`insert into agent_tool_audit(audit_id,run_id,tool_name,risk_level,allowed,reason,input_hash)
    values($1,$2,$3,$4,$5,$6,$7)`,[randomUUID(),runId,tool,auth.risk_level,auth.allowed,auth.reason,digest(input)]);
}
async function executeSafeTool(sql, tool, context, decision) {
  const leadId=context.lead?.lead_id || null;
  if(tool==='schedule_follow_up' && leadId){
    const plan=buildFollowUpPlan({stage:context.lead.stage,touchpoints:context.lead.touchpoints,lastContactAt:context.lead.last_contact_at});
    if(!plan.due_at) return {scheduled:false,reason:plan.reason||plan.action};
    const actionType=plan.action==='first_response'?'first_response':'follow_up';
    await sql.query(`insert into sales_actions(action_id,lead_id,action_type,channel,status,due_at,metadata)
      values($1,$2,$3,$4,'scheduled',$5,$6::jsonb)`,[randomUUID(),leadId,actionType,context.lead.channel,plan.due_at,JSON.stringify({source:'revenue_agent',benchmark:plan.benchmark||null,decision:String(decision.rationale||'')})]);
    await sql.query('update sales_leads set next_action_at=$2,updated_at=now() where lead_id=$1',[leadId,plan.due_at]);
    return {scheduled:true,due_at:plan.due_at,action_type:actionType};
  }
  if(tool==='remember_fact' && leadId){
    await sql.query(`insert into agent_memory(memory_id,scope_type,scope_ref,memory_key,memory_value,confidence)
      values($1,'lead',$2,'agent_last_decision',$3::jsonb,$4)
      on conflict(scope_type,scope_ref,memory_key) do update set memory_value=excluded.memory_value,confidence=excluded.confidence,updated_at=now()`,
      [randomUUID(),String(leadId),JSON.stringify({action:decision.action,rationale:decision.rationale||null}),Math.max(0,Math.min(1,Number(decision.confidence)||0.5))]);
    return {remembered:true};
  }
  if(tool==='create_offer_draft') return {draft_only:true,commercial_action:false};
  return {observed:true};
}
export async function runAgentOnce(sql, options = {}) {
  const job=await claimAgentJob(sql);
  if(!job) return Object.freeze({ok:true,processed:false,reason:'queue_empty'});
  const runId=randomUUID(); const started=Date.now();
  let tool='get_command_center'; let finalAuth={allowed:false,risk_level:'read',reason:'not_evaluated'}; let decision={}; let evalResult={pass:false,score:0,issues:['not_evaluated']};
  try{
    const context=await buildAgentContext(sql,job);
    const env=options.env || process.env; let apiKey=options.apiKey ?? env.GEMINI_API_KEY ?? null;
    if(env.AGENT_AI_ENABLED!=='true') apiKey=null;
    if(apiKey){ const cap=Math.max(1,Math.min(10000,Number(env.AGENT_AI_MAX_RUNS_PER_HOUR)||100)); const recent=await sql.query("select count(*)::int as count from agent_runs where mode='ai_assisted' and created_at>now()-interval '1 hour'"); if(Number(recent[0]?.count||0)>=cap) apiKey=null; }
    decision=await decideRevenueAction(context,{...options,apiKey});
    tool=chooseTool(decision); const auth=authorizeTool(tool,env);
    evalResult=evaluateAgentDecision({decision,context,authorization:auth});
    finalAuth=evalResult.pass?auth:Object.freeze({allowed:false,risk_level:auth.risk_level,reason:'agent_eval_failed'});
    let result; let outcome;
    try { result=finalAuth.allowed ? await executeSafeTool(sql,tool,context,decision) : {blocked:true,reason:finalAuth.reason}; outcome=finalAuth.allowed?'completed':'blocked'; }
    catch(error){ result={failed:true,reason:String(error?.message||'tool_execution_failed').slice(0,500)}; outcome='failed'; }
    await sql.query(`insert into agent_runs(run_id,job_id,provider,model,mode,outcome,input_hash,tool_calls,latency_ms,decision)
      values($1,$2,$3,$4,$5,$6,$7,1,$8,$9::jsonb)`,[runId,job.job_id,decision.provider||'deterministic',decision.model||'rules-v1',decision.mode||'deterministic',outcome,decision.input_hash||digest(context),Date.now()-started,JSON.stringify({...decision,tool,result,eval:evalResult})]);
    await auditTool(sql,runId,tool,finalAuth,{job_id:job.job_id,decision,eval:evalResult,result});
    const jobStatus=outcome==='completed'?'completed':outcome==='blocked'?'blocked':'failed';
    await sql.query('update agent_jobs set status=$2,completed_at=now(),last_error=$3 where job_id=$1',[job.job_id,jobStatus,outcome==='failed'?String(result.reason||'tool_execution_failed'):null]);
    return Object.freeze({ok:outcome!=='failed',processed:true,job_id:job.job_id,run_id:runId,outcome,tool,result,eval:evalResult});
  }catch(error){
    await sql.query("update agent_jobs set status='failed',completed_at=now(),last_error=$2 where job_id=$1",[job.job_id,String(error?.message||'agent_failed').slice(0,500)]);
    return Object.freeze({ok:false,processed:true,job_id:job.job_id,run_id:runId,error:String(error?.message||'agent_failed')});
  }
}
