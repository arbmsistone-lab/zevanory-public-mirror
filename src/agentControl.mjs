import { randomUUID } from 'node:crypto';

export const APPROVAL_TOOLS = Object.freeze(new Set(['send_message','publish_content','start_checkout','refund_payment']));
const CONTROL_REF='zevanory_robot';
const CONTROL_KEY='control';

const asObject=(value)=>{
  if(value&&typeof value==='object') return value;
  try{return JSON.parse(String(value||'{}'));}catch{return {};}
};
const controlFromRow=(row)=>{
  const value=asObject(row?.memory_value);
  return Object.freeze({
    paused:value.paused!==false,
    reason:String(value.reason||'safe_default'),
    changed_by:String(value.changed_by||'system'),
    changed_at:row?.updated_at||null,
  });
};
const approvalFromRow=(row)=>{
  const value=asObject(row?.approval);
  return value&&value.approval_id?Object.freeze({...value,job_id:row?.job_id||value.job_id||null}):null;
};

export async function getAgentControlState(sql){
  const rows=await sql.query(`select memory_value,updated_at from agent_memory
    where scope_type='global' and scope_ref=$1 and memory_key=$2 limit 1`,[CONTROL_REF,CONTROL_KEY]);
  if(rows.length!==1) return Object.freeze({paused:true,reason:'control_state_missing',changed_by:'system',changed_at:null});
  return controlFromRow(rows[0]);
}
export async function setAgentPaused(sql,{paused,reason,operator='operator'}={}){
  if(typeof paused!=='boolean') throw new Error('paused_boolean_required');
  const value={paused,reason:String(reason||'operator_request').trim().slice(0,500)||'operator_request',changed_by:String(operator||'operator').trim().slice(0,120)||'operator'};
  const rows=await sql.query(`insert into agent_memory(memory_id,scope_type,scope_ref,memory_key,memory_value,confidence)
    values($1,'global',$2,$3,$4::jsonb,1)
    on conflict(scope_type,scope_ref,memory_key) do update set memory_value=excluded.memory_value,confidence=1,updated_at=now()
    returning memory_value,updated_at`,[randomUUID(),CONTROL_REF,CONTROL_KEY,JSON.stringify(value)]);
  return controlFromRow(rows[0]);
}

export function requiresHumanApproval(toolName,riskLevel){
  return APPROVAL_TOOLS.has(String(toolName))||['financial','destructive'].includes(String(riskLevel));
}

export async function findApprovedAction(sql,jobId,toolName){
  const rows=await sql.query(`select job_id,payload->'approval' approval from agent_jobs
    where job_id=$1 and payload->'approval'->>'tool_name'=$2 and payload->'approval'->>'status'='approved' limit 1`,[jobId,toolName]);
  return approvalFromRow(rows[0]);
}

export async function requestApproval(sql,{jobId,runId,traceId,toolName,riskLevel,reason}={}){
  const existing=await sql.query(`select job_id,payload->'approval' approval from agent_jobs
    where job_id=$1 and payload->'approval'->>'tool_name'=$2 and payload->'approval'->>'status'='pending' limit 1`,[jobId,toolName]);
  const current=approvalFromRow(existing[0]);
  if(current) return current;
  const approval={approval_id:randomUUID(),job_id:jobId,run_id:runId||null,trace_id:traceId||null,tool_name:String(toolName),risk_level:String(riskLevel),status:'pending',request_reason:String(reason||'high_risk_action').slice(0,500),requested_at:new Date().toISOString()};
  const rows=await sql.query(`update agent_jobs set payload=jsonb_set(coalesce(payload,'{}'::jsonb),'{approval}',$2::jsonb,true)
    where job_id=$1 returning job_id,payload->'approval' approval`,[jobId,JSON.stringify(approval)]);
  if(rows.length!==1) throw new Error('approval_job_missing');
  return approvalFromRow(rows[0]);
}

export async function decideApproval(sql,{approvalId,decision,reason,operator='operator'}={}){
  if(!['approved','rejected'].includes(decision)) throw new Error('approval_decision_invalid');
  const decisionReason=String(reason||'operator_decision').slice(0,500);
  const decidedBy=String(operator||'operator').slice(0,120);
  const rows=await sql.query(`update agent_jobs set
    payload=jsonb_set(jsonb_set(jsonb_set(jsonb_set(payload,'{approval,status}',to_jsonb($2::text),true),'{approval,decision_reason}',to_jsonb($3::text),true),'{approval,decided_by}',to_jsonb($4::text),true),'{approval,decided_at}',to_jsonb(now()::text),true),
    status=case when $2='approved' then 'queued' else 'canceled' end,
    available_at=case when $2='approved' then now() else available_at end,
    completed_at=case when $2='approved' then null else now() end,
    last_error=case when $2='approved' then null else 'human_approval_rejected' end
    where payload->'approval'->>'approval_id'=$1 and payload->'approval'->>'status'='pending'
    returning job_id,payload->'approval' approval`,[approvalId,decision,decisionReason,decidedBy]);
  if(rows.length!==1) throw new Error('approval_not_pending');
  return approvalFromRow(rows[0]);
}

export async function consumeApproval(sql,approvalId){
  if(!approvalId) return false;
  const rows=await sql.query(`update agent_jobs set payload=jsonb_set(payload,'{approval,status}','"consumed"'::jsonb,true)
    where payload->'approval'->>'approval_id'=$1 and payload->'approval'->>'status'='approved' returning job_id`,[approvalId]);
  return rows.length===1;
}
