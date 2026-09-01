import { randomUUID, createHash } from 'node:crypto';
import { buildAgentContext, decideRevenueAction, chooseTool, decisionInputHash } from './revenueAgent.mjs';
import { authorizeTool } from './agentPolicy.mjs';
import { evaluateAgentDecision } from './agentEvals.mjs';
import { buildFollowUpPlan } from './salesPipeline.mjs';
import { enqueueOutbox } from './integrationOutbox.mjs';
import { assertChannelActionAllowed } from './channelAdapters.mjs';
import { getAgentControlState, requiresHumanApproval, findApprovedAction, requestApproval, consumeApproval } from './agentControl.mjs';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function claimAgentJob(sql) {
  const rows = await sql.query(`update agent_jobs set status='running',locked_at=now(),attempts=attempts+1
    where job_id=(select job_id from agent_jobs where status='queued' and available_at<=now()
      order by priority desc,available_at asc,created_at asc for update skip locked limit 1) returning *`);
  return rows[0] || null;
}

async function auditTool(sql, runId, tool, auth, input) {
  await sql.query(`insert into agent_tool_audit(audit_id,run_id,tool_name,risk_level,allowed,reason,input_hash)
    values($1,$2,$3,$4,$5,$6,$7)`,[randomUUID(),runId,tool,auth.risk_level,auth.allowed,auth.reason,digest(input)]);
}

async function persistRunStart(sql,{runId,job,traceId,spanId,decision,context,tool}){
  await sql.query(`insert into agent_runs(run_id,job_id,provider,model,mode,outcome,input_hash,tool_calls,latency_ms,decision,trace_id,span_id)
    values($1,$2,$3,$4,$5,'running',$6,1,0,$7::jsonb,$8,$9)`,[
    runId,job.job_id,decision.provider||'deterministic',decision.model||'rules-v1',decision.mode||'deterministic',
    decision.input_hash||decisionInputHash(context),JSON.stringify({...decision,tool}),traceId,spanId,
  ]);
}
async function executeTool(sql,tool,context,decision,{runId,traceId,env}){
  const lead=context.lead||null; const leadId=lead?.lead_id||null;
  if(tool==='schedule_follow_up' && leadId){
    const plan=buildFollowUpPlan({stage:lead.stage,touchpoints:lead.touchpoints,lastContactAt:lead.last_contact_at});
    if(!plan.due_at) return {scheduled:false,reason:plan.reason||plan.action};
    const actionType=plan.action==='first_response'?'first_response':'follow_up';
    await sql.query(`insert into sales_actions(action_id,lead_id,action_type,channel,status,due_at,metadata)
      values($1,$2,$3,$4,'scheduled',$5,$6::jsonb)`,[randomUUID(),leadId,actionType,lead.channel,plan.due_at,JSON.stringify({source:'revenue_agent',benchmark:plan.benchmark||null,run_id:runId,trace_id:traceId})]);
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
  if(tool==='send_message'){
    if(!lead?.contact_ref) throw new Error('recipient_unavailable');
    assertChannelActionAllowed(lead.channel,env);
    const text=String(decision.message||decision.content||'').trim(); if(!text) throw new Error('message_content_required');
    return enqueueOutbox(sql,{aggregateType:'lead',aggregateId:leadId,eventType:'send_message',destination:`channel:${lead.channel}`,payload:{contact_ref:lead.contact_ref,text:text.slice(0,4000)},idempotencyKey:`agent:${runId}:send_message`,traceId,runId});
  }
  if(tool==='publish_content'){
    const channel=String(decision.channel||lead?.channel||'').toLowerCase();
    assertChannelActionAllowed(channel,env);
    const content=String(decision.content||decision.message||'').trim(); if(!content) throw new Error('publish_content_required');
    return enqueueOutbox(sql,{aggregateType:'content',aggregateId:runId,eventType:'publish_content',destination:`channel:${channel}`,payload:{content:content.slice(0,8000),title:String(decision.title||'').slice(0,240)},idempotencyKey:`agent:${runId}:publish_content`,traceId,runId});
  }
  if(tool==='start_checkout'){
    if(!lead?.session_id) throw new Error('checkout_session_unavailable');
    const provider=String(env.PAYMENT_PROVIDER||'').toLowerCase(); if(!['asaas','mercadopago'].includes(provider)) throw new Error('payment_provider_invalid');
    return enqueueOutbox(sql,{aggregateType:'lead',aggregateId:leadId,eventType:'start_checkout',destination:'payment:checkout',payload:{provider,session_id:lead.session_id,request_id:randomUUID()},idempotencyKey:`agent:${runId}:start_checkout`,traceId,runId});
  }
  if(tool==='refund_payment'){
    const orderRef=String(decision.order_id||'').trim(); if(!orderRef) throw new Error('refund_order_required');
    return enqueueOutbox(sql,{aggregateType:'order',aggregateId:orderRef,eventType:'refund_payment',destination:'payment:refund',payload:{order_id:orderRef,reason:String(decision.reason||decision.rationale||'operator_approved_refund').slice(0,500)},idempotencyKey:`agent:${runId}:refund_payment`,traceId,runId});
  }
  return {observed:true};
}

export async function runAgentOnce(sql, options = {}) {
  const env=options.env||process.env;
  const control=await getAgentControlState(sql);
  if(control.paused) return Object.freeze({ok:true,processed:false,reason:'agent_paused',control});
  const job=await claimAgentJob(sql);
  if(!job) return Object.freeze({ok:true,processed:false,reason:'queue_empty'});
  const runId=randomUUID(); const traceId=randomUUID(); const spanId=randomUUID(); const started=Date.now();
  let tool='get_command_center'; let decision={}; let evalResult={pass:false,score:0,issues:['not_evaluated']};
  try{
    const context=await buildAgentContext(sql,job);
    let apiKey=options.apiKey ?? env.GEMINI_API_KEY ?? null;
    if(env.AGENT_AI_ENABLED!=='true') apiKey=null;
    if(apiKey){
      const cap=Math.max(1,Math.min(10000,Number(env.AGENT_AI_MAX_RUNS_PER_HOUR)||100));
      const recent=await sql.query("select count(*)::int as count from agent_runs where mode='ai_assisted' and created_at>now()-interval '1 hour'");
      if(Number(recent[0]?.count||0)>=cap) apiKey=null;
    }
    decision=await decideRevenueAction(context,{...options,apiKey});
    tool=chooseTool(decision);
    const auth=authorizeTool(tool,env);
    evalResult=evaluateAgentDecision({decision,context,authorization:auth});
    const finalAuth=evalResult.pass?auth:Object.freeze({allowed:false,risk_level:auth.risk_level,reason:'agent_eval_failed'});
    await persistRunStart(sql,{runId,job,traceId,spanId,decision,context,tool});

    if(!finalAuth.allowed){
      const result={blocked:true,reason:finalAuth.reason};
      await sql.query("update agent_runs set outcome='blocked',latency_ms=$2,decision=$3::jsonb where run_id=$1",[runId,Date.now()-started,JSON.stringify({...decision,tool,result,eval:evalResult})]);
      await auditTool(sql,runId,tool,finalAuth,{job_id:job.job_id,decision,eval:evalResult,result});
      await sql.query("update agent_jobs set status='blocked',completed_at=now(),last_error=$2 where job_id=$1",[job.job_id,finalAuth.reason]);
      return Object.freeze({ok:true,processed:true,job_id:job.job_id,run_id:runId,trace_id:traceId,outcome:'blocked',tool,result,eval:evalResult});
    }
    let approval=null;
    if(requiresHumanApproval(tool,finalAuth.risk_level,env)){
      approval=await findApprovedAction(sql,job.job_id,tool);
      if(!approval){
        approval=await requestApproval(sql,{jobId:job.job_id,runId,traceId,toolName:tool,riskLevel:finalAuth.risk_level,reason:decision.rationale||'high_risk_action'});
        const result={blocked:true,reason:'human_approval_required',approval_id:approval.approval_id};
        await sql.query("update agent_runs set outcome='awaiting_approval',latency_ms=$2,decision=$3::jsonb where run_id=$1",[runId,Date.now()-started,JSON.stringify({...decision,tool,result,eval:evalResult})]);
        await auditTool(sql,runId,tool,{...finalAuth,allowed:false,reason:'human_approval_required'},{job_id:job.job_id,decision,eval:evalResult,result});
        await sql.query("update agent_jobs set status='blocked',completed_at=now(),last_error='human_approval_required' where job_id=$1",[job.job_id]);
        return Object.freeze({ok:true,processed:true,job_id:job.job_id,run_id:runId,trace_id:traceId,outcome:'awaiting_approval',tool,result,eval:evalResult});
      }
    }

    let result; let outcome='completed';
    try { result=await executeTool(sql,tool,context,decision,{runId,traceId,env}); }
    catch(error){ result={failed:true,reason:String(error?.message||'tool_execution_failed').slice(0,500)}; outcome='failed'; }
    if(approval?.approval_id) await consumeApproval(sql,approval.approval_id);
    await sql.query("update agent_runs set outcome=$2,latency_ms=$3,decision=$4::jsonb where run_id=$1",[runId,outcome,Date.now()-started,JSON.stringify({...decision,tool,result,eval:evalResult})]);
    await auditTool(sql,runId,tool,finalAuth,{job_id:job.job_id,decision,eval:evalResult,result});
    const jobStatus=outcome==='completed'?'completed':'failed';
    await sql.query('update agent_jobs set status=$2,completed_at=now(),last_error=$3 where job_id=$1',[job.job_id,jobStatus,outcome==='failed'?String(result.reason||'tool_execution_failed'):null]);
    return Object.freeze({ok:outcome==='completed',processed:true,job_id:job.job_id,run_id:runId,trace_id:traceId,outcome,tool,result,eval:evalResult});
  }catch(error){
    try{await sql.query("update agent_runs set outcome='failed',latency_ms=$2,decision=$3::jsonb where run_id=$1",[runId,Date.now()-started,JSON.stringify({...decision,tool,error:String(error?.message||'agent_failed').slice(0,500),eval:evalResult})]);}catch{}
    await sql.query("update agent_jobs set status='failed',completed_at=now(),last_error=$2 where job_id=$1",[job.job_id,String(error?.message||'agent_failed').slice(0,500)]);
    return Object.freeze({ok:false,processed:true,job_id:job.job_id,run_id:runId,trace_id:traceId,error:String(error?.message||'agent_failed')});
  }
}