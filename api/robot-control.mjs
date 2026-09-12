import {neon} from '@neondatabase/serverless';
import {safeBearerEqual} from '../src/security.mjs';
import {createOperatorSessionCookie,hasValidOperatorSession} from '../src/operatorSession.mjs';
import {channelReadiness} from '../src/channelAdapters.mjs';
import {decideApproval,getAgentControlState,setAgentPaused} from '../src/agentControl.mjs';
import {buildAgentObservability} from '../src/agentObservability.mjs';
import {salesGate} from '../src/salesGate.mjs';
import {summarizeLiveActionPlan} from '../src/liveActionPlan.mjs';
import {executeVerifiedRead} from '../src/databaseReadFabric.mjs';
import {preserveStorageOperation,storageOperation} from '../src/storageFabric.mjs';
import {queueOutcomeLearningReview} from '../src/outcomeLearning.mjs';
import {runAgentOnce} from '../src/agentWorker.mjs';

const json=(res,status,body)=>{res.statusCode=status;return res.end(JSON.stringify(body));};
const clamp=(v,min,max)=>Math.max(min,Math.min(max,Number(v)||min));
const cleanError=(v)=>String(v||'').slice(0,240);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function controlOperation(body={}){
  const command=String(body.command||'').toLowerCase();
  if(!['pause','resume','approval','certification_probe'].includes(command))throw Object.assign(new Error('control_command_invalid'),{statusCode:400});
  if(command==='certification_probe'){
    const requestId=String(body.request_id||'');
    if(!uuid.test(requestId))throw Object.assign(new Error('certification_probe_request_invalid'),{statusCode:400});
    return storageOperation({operationId:`robot-control:certification-probe:${requestId}`,operationType:'agent.control_certification_probe',subjectRef:requestId,payload:{command,request_id:requestId,executed:false}});
  }
  if(command==='approval'){
    const approvalId=String(body.approval_id||'');const decision=String(body.decision||'').toLowerCase();
    if(!uuid.test(approvalId)||!['approved','rejected'].includes(decision))throw Object.assign(new Error('approval_request_invalid'),{statusCode:400});
    return storageOperation({operationId:`robot-control:approval:${approvalId}:${decision}`,operationType:'agent.control_approval',subjectRef:approvalId,payload:{command,approval_id:approvalId,decision,reason:String(body.reason||'operator_decision').slice(0,240),executed:false}});
  }
  return storageOperation({operationId:`robot-control:${command}`,operationType:'agent.control_state',payload:{command,reason:String(body.reason||`operator_${command}`).slice(0,240),executed:false}});
}

async function mutate(sql,body={}){
  const command=String(body.command||'').toLowerCase();
  if(command==='certification_probe'){
    const requestId=String(body.request_id||'');
    if(!uuid.test(requestId))throw Object.assign(new Error('certification_probe_request_invalid'),{statusCode:400});
    const queued=await queueOutcomeLearningReview(sql,{idempotencyKey:`certification-probe:${requestId}`,priority:100,source:'operator_certification_probe'});
    if(!queued.job_id)return {accepted:true,command,duplicate:true,request_id:requestId,commercial_unlock:false};
    const agent=await runAgentOnce(sql,{jobId:queued.job_id,ignorePause:true,env:{...process.env,AGENT_AI_ENABLED:'false'}});
    return {accepted:true,command,request_id:requestId,job_id:queued.job_id,run_id:agent.run_id||null,outcome:agent.outcome||agent.reason||null,processed:agent.processed===true,commercial_unlock:false};
  }
  if(['pause','resume'].includes(command)){
    const control=await setAgentPaused(sql,{paused:command==='pause',reason:body.reason||`operator_${command}`,operator:'operator'});
    return {accepted:true,command,control};
  }
  if(command==='approval'){
    const approvalId=String(body.approval_id||'');
    const decision=String(body.decision||'').toLowerCase();
    if(!uuid.test(approvalId)||!['approved','rejected'].includes(decision)) throw Object.assign(new Error('approval_request_invalid'),{statusCode:400});
    const approval=await decideApproval(sql,{approvalId,decision,reason:body.reason||'operator_decision',operator:'operator'});
    return {accepted:true,command,approval};
  }
  throw Object.assign(new Error('control_command_invalid'),{statusCode:400});
}
export default async function handler(req,res){
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control','no-store');
  res.setHeader('x-content-type-options','nosniff');
  if(!['GET','POST'].includes(req.method)) return json(res,405,{error:'method_not_allowed'});
  const expected=String(process.env.OPERATOR_TOKEN||'');
  const secondary=String(process.env.OPERATOR_TOKEN_SECONDARY||'');
  const provided=String(req.headers?.authorization||'').replace(/^Bearer\s+/i,'');
  const authorized=safeBearerEqual(expected,provided)||(secondary&&safeBearerEqual(secondary,provided));
  if(!authorized) return json(res,401,{error:'operator_auth_required'});
  if(req.method==='POST'){
    let operation;try{operation=controlOperation(req.body||{});}catch(error){return json(res,error?.statusCode||400,{error:String(error?.message||'robot_control_action_invalid').slice(0,120)});}
    if(!process.env.DATABASE_URL){
      const preserved=await preserveStorageOperation(operation);
      return json(res,preserved.preserved?202:503,{accepted:preserved.preserved,preserved:preserved.preserved,pending_storage:preserved.preserved,executed:false,error:preserved.preserved?undefined:'robot_control_storage_unavailable'});
    }
    const sql=neon(process.env.DATABASE_URL);
    try{return json(res,200,await mutate(sql,req.body||{}));}
    catch(error){
      if(error?.statusCode)return json(res,error.statusCode,{error:String(error?.message||'robot_control_action_failed').slice(0,120)});
      const preserved=await preserveStorageOperation(storageOperation({operationId:`${operation.operation_id}:reconcile`,operationType:'agent.control_reconciliation',subjectRef:operation.subject_ref,payload:{...operation.payload,executed:null,reconciliation_required:true}}));
      return json(res,503,{error:'robot_control_action_failed',preserved:preserved.preserved,reconciliation_required:true});
    }
  }
  const limit=clamp(req.query?.limit||30,10,100);
  const readOutcome=await executeVerifiedRead({env:process.env,connect:neon,read:async(sql)=>{
    const [runs,tools,jobs,outbox,actions,approvals,control]=await Promise.all([
      sql.query(`select r.run_id,r.job_id,r.decision->>'trace_id' trace_id,r.decision->>'span_id' span_id,j.job_type,r.provider,r.model,r.mode,r.outcome,r.latency_ms,null::integer input_tokens,null::integer output_tokens,null::numeric estimated_cost_usd,r.created_at,r.decision->>'action' action,r.decision->>'rationale' rationale,r.decision->>'confidence' confidence,r.decision->>'tool' tool,r.decision->'result' result,r.decision->'eval' eval from agent_runs r left join agent_jobs j on j.job_id=r.job_id order by r.created_at desc limit $1`,[limit]),
      sql.query(`select run_id,tool_name,risk_level,allowed,reason,created_at from agent_tool_audit order by created_at desc limit $1`,[limit]),
      sql.query(`select job_id,job_type,status,priority,attempts,available_at,locked_at,completed_at,last_error,created_at,payload->'live_action_plan' live_action_plan from agent_jobs order by created_at desc limit $1`,[limit]),
      sql.query(`select event_id,headers->>'run_id' run_id,headers->>'trace_id' trace_id,headers->'provider_acceptance' provider_acceptance,headers->'provider_confirmation' provider_confirmation,aggregate_type,event_type,destination,status,attempts,available_at,locked_at,delivered_at,last_error,created_at from integration_outbox order by created_at desc limit $1`,[limit]),
      sql.query(`select action_type,channel,status,count(*)::int count from sales_actions group by action_type,channel,status order by count desc`),
      sql.query(`select job_id,payload->'approval'->>'approval_id' approval_id,payload->'approval'->>'run_id' run_id,payload->'approval'->>'trace_id' trace_id,payload->'approval'->>'tool_name' tool_name,payload->'approval'->>'risk_level' risk_level,payload->'approval'->>'status' status,payload->'approval'->>'request_reason' request_reason,payload->'approval'->>'decision_reason' decision_reason,payload->'approval'->>'decided_by' decided_by,payload->'approval'->>'requested_at' requested_at,payload->'approval'->>'decided_at' decided_at from agent_jobs where payload ? 'approval' order by created_at desc limit $1`,[limit]),
      getAgentControlState(sql),
    ]);
    return {runs,tools,jobs,outbox,actions,approvals,control};
  }});
  if(!readOutcome.ok)return json(res,503,{error:'robot_control_unavailable'});
  const {runs,tools,jobs,outbox,actions,approvals,control}=readOutcome.result;
  const canonicalGate=salesGate();
  const gates={sale:canonicalGate.enabled,pre_sale:canonicalGate.pre_sale_gates_approved,lifecycle:canonicalGate.lifecycle_approved,checkout:canonicalGate.enabled&&process.env.CHECKOUT_ENABLED==='true',financial:canonicalGate.enabled&&process.env.FINANCIAL_EVENTS_ENABLED==='true',whatsapp:canonicalGate.enabled&&process.env.WHATSAPP_SALES_ENABLED==='true'};
  const channels=Object.fromEntries(Object.entries(channelReadiness()).map(([k,v])=>[k,{configured:v.configured,role:v.role,commercial:v.commercial}]));
  const safeRuns=runs.map(x=>({...x,rationale:String(x.rationale||'').slice(0,500)}));
  const safeOutbox=outbox.map(x=>({...x,last_error:cleanError(x.last_error)}));
  const observability=buildAgentObservability({runs:safeRuns,outbox:safeOutbox,approvals});
  return json(res,200,{mode:'operator',generated_at:new Date().toISOString(),control,gates,channels,runs:observability.runs,metrics:observability.metrics,tools,jobs:jobs.map(x=>({...x,last_error:cleanError(x.last_error),live_action_plan:x.live_action_plan?summarizeLiveActionPlan(x.live_action_plan):null})),live_action_plans:jobs.filter(x=>x.live_action_plan).map(x=>summarizeLiveActionPlan(x.live_action_plan)),outbox:safeOutbox,actions,approvals,canonical_read:readOutcome.canonical});
}
