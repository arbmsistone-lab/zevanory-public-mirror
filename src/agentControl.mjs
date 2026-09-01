import { randomUUID } from 'node:crypto';

export const APPROVAL_TOOLS = Object.freeze(new Set(['send_message','publish_content','start_checkout','refund_payment']));

export async function getAgentControlState(sql){
  const rows=await sql.query("select paused,reason,changed_by,changed_at from agent_control_state where control_id='global' limit 1");
  if(rows.length!==1) return Object.freeze({paused:true,reason:'control_state_missing',changed_by:'system',changed_at:null});
  return Object.freeze({paused:rows[0].paused===true,reason:String(rows[0].reason||''),changed_by:String(rows[0].changed_by||''),changed_at:rows[0].changed_at||null});
}

export async function setAgentPaused(sql,{paused,reason,operator='operator'}={}){
  if(typeof paused!=='boolean') throw new Error('paused_boolean_required');
  const cleanReason=String(reason||'operator_request').trim().slice(0,500)||'operator_request';
  const cleanOperator=String(operator||'operator').trim().slice(0,120)||'operator';
  const rows=await sql.query(`insert into agent_control_state(control_id,paused,reason,changed_by,changed_at)
    values('global',$1,$2,$3,now()) on conflict(control_id) do update set paused=excluded.paused,reason=excluded.reason,changed_by=excluded.changed_by,changed_at=now()
    returning paused,reason,changed_by,changed_at`,[paused,cleanReason,cleanOperator]);
  return Object.freeze(rows[0]);
}

export function requiresHumanApproval(toolName,riskLevel,env=process.env){
  if(env.AGENT_HUMAN_APPROVAL_REQUIRED==='false' && riskLevel!=='financial') return false;
  return APPROVAL_TOOLS.has(String(toolName)) || ['financial','destructive'].includes(String(riskLevel));
}
export async function findApprovedAction(sql,jobId,toolName){
  const rows=await sql.query(`select approval_id,status from agent_approvals
    where job_id=$1 and tool_name=$2 and status='approved' order by decided_at desc limit 1`,[jobId,toolName]);
  return rows[0]||null;
}

export async function requestApproval(sql,{jobId,runId,traceId,toolName,riskLevel,reason}={}){
  const existing=await sql.query(`select approval_id,status from agent_approvals where job_id=$1 and tool_name=$2 and status='pending' limit 1`,[jobId,toolName]);
  if(existing[0]) return existing[0];
  const rows=await sql.query(`insert into agent_approvals(approval_id,job_id,run_id,trace_id,tool_name,risk_level,status,request_reason)
    values($1,$2,$3,$4,$5,$6,'pending',$7) returning approval_id,status`,
    [randomUUID(),jobId,runId,traceId,toolName,riskLevel,String(reason||'high_risk_action').slice(0,500)]);
  return rows[0];
}

export async function decideApproval(sql,{approvalId,decision,reason,operator='operator'}={}){
  if(!['approved','rejected'].includes(decision)) throw new Error('approval_decision_invalid');
  const rows=await sql.query(`update agent_approvals set status=$2,decision_reason=$3,decided_by=$4,decided_at=now()
    where approval_id=$1 and status='pending' returning approval_id,job_id,tool_name,status`,
    [approvalId,decision,String(reason||'operator_decision').slice(0,500),String(operator||'operator').slice(0,120)]);
  if(rows.length!==1) throw new Error('approval_not_pending');
  if(decision==='approved') await sql.query("update agent_jobs set status='queued',available_at=now(),completed_at=null,last_error=null where job_id=$1 and status='blocked'",[rows[0].job_id]);
  return Object.freeze(rows[0]);
}

export async function consumeApproval(sql,approvalId){
  if(!approvalId) return false;
  const rows=await sql.query("update agent_approvals set status='consumed',consumed_at=now() where approval_id=$1 and status='approved' returning approval_id",[approvalId]);
  return rows.length===1;
}
