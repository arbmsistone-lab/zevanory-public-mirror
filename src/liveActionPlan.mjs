import { randomUUID, createHash } from 'node:crypto';

const digest=(value)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const EXTERNAL_TOOLS=new Set(['send_message','publish_content','start_checkout','refund_payment']);
const FINANCIAL_TOOLS=new Set(['start_checkout','refund_payment']);
const safeText=(value,max=500)=>String(value||'').trim().slice(0,max);
const asObject=(value)=>{
  if(value&&typeof value==='object') return value;
  try{return JSON.parse(String(value||'{}'));}catch{return {};}
};

function inferWhere(tool,context,decision,env){
  const channel=safeText(decision?.channel||context?.lead?.channel||'',60).toLowerCase()||null;
  const paymentProvider=safeText(decision?.provider||decision?.payment_provider||context?.payment_provider||'',40).toLowerCase();
  if(tool==='start_checkout'||tool==='refund_payment') return paymentProvider?`payment:${paymentProvider}`:'capability:payment';
  if(tool==='send_message'||tool==='publish_content') return channel?`channel:${channel}`:'channel:unresolved';
  if(tool==='schedule_follow_up'||tool==='remember_fact'||tool==='create_offer_draft') return 'zevanory:internal';
  if(tool==='refresh_outcome_learning') return 'zevanory:learning';
  return 'zevanory:control';
}

function inferContent(tool,decision){
  if(tool==='send_message'||tool==='publish_content'){
    const raw=safeText(decision?.message||decision?.content||'',280);
    return raw?{kind:'content_preview',preview:raw,sha256:digest(raw)}:{kind:'content_preview',preview:null,sha256:null};
  }
  if(tool==='create_offer_draft') return {kind:'offer',offer_ref:safeText(decision?.offer_id||decision?.title||'draft',120)};
  if(tool==='refund_payment') return {kind:'refund',order_ref:safeText(decision?.order_id||'',80)||null};
  return {kind:'none'};
}

export function buildLiveActionPlan({job,runId,traceId,tool,auth,decision={},context={},env={}}={}){
  const existing=asObject(job?.payload)?.live_action_plan;
  const channel=safeText(decision?.channel||context?.lead?.channel||'',60).toLowerCase()||null;
  const paymentProvider=safeText(decision?.provider||decision?.payment_provider||context?.payment_provider||'',40).toLowerCase();
  const accountRef=FINANCIAL_TOOLS.has(tool)?(paymentProvider?`merchant:${paymentProvider}`:'merchant:unresolved'):(channel?`channel_account:${channel}`:'zevanory:internal');
  const external=EXTERNAL_TOOLS.has(tool);
  const estimatedCostUsd=decision?.estimated_cost_usd==null?null:Math.max(0,Number(decision.estimated_cost_usd)||0);
  const now=new Date().toISOString();
  return Object.freeze({
    manifest_id:existing?.manifest_id||randomUUID(),job_id:job?.job_id||null,run_id:runId||null,trace_id:traceId||null,
    state:'planned',created_at:existing?.created_at||now,updated_at:now,
    what:safeText(tool||'unknown_tool',100),where:inferWhere(tool,context,decision,env),
    why:safeText(decision?.rationale||auth?.reason||'agent_decision',500),objective:safeText(decision?.objective||decision?.action||job?.job_type||'execute_authorized_action',240),
    channel,account_ref:accountRef,content_or_offer:inferContent(tool,decision),risk:safeText(auth?.risk_level||'destructive',40),
    cost:Object.freeze({currency:'USD',estimated_amount:estimatedCostUsd,mode:estimatedCostUsd==null?'not_estimated':'decision_estimate'}),
    approval:Object.freeze({required:external||['financial','destructive'].includes(String(auth?.risk_level||'')),status:existing?.approval?.status||'not_requested'}),
    expected_result:safeText(decision?.expected_result||`${tool||'tool'} completes without bypassing gates`,500),
    external_effect_possible:external,result:null,evidence:null,
  });
}

export async function persistLiveActionPlan(sql,jobId,plan){
  const rows=await sql.query(`update agent_jobs set payload=jsonb_set(coalesce(payload,'{}'::jsonb),'{live_action_plan}',$2::jsonb,true)
    where job_id=$1 returning payload->'live_action_plan' live_action_plan`,[jobId,JSON.stringify(plan)]);
  if(rows.length!==1) throw new Error('live_action_plan_persist_failed');
  return asObject(rows[0].live_action_plan);
}

export async function transitionLiveActionPlan(sql,jobId,{state,result=null,evidence=null,approvalStatus=null}={}){
  const allowed=new Set(['planned','awaiting_approval','executed','failed','blocked','canceled']);
  if(!allowed.has(String(state))) throw new Error('live_action_plan_state_invalid');
  const rows=await sql.query(`update agent_jobs set payload=jsonb_set(
    payload,'{live_action_plan}',
    (payload->'live_action_plan') || $2::jsonb,true)
    where job_id=$1 and payload ? 'live_action_plan'
    returning payload->'live_action_plan' live_action_plan`,[
      jobId,JSON.stringify({state:String(state),updated_at:new Date().toISOString(),result,evidence,
        ...(approvalStatus?{approval:{required:true,status:String(approvalStatus)}}:{})}),
    ]);
  if(rows.length!==1) throw new Error('live_action_plan_transition_failed');
  return asObject(rows[0].live_action_plan);
}

export function summarizeLiveActionPlan(plan={}){
  const p=asObject(plan);
  return Object.freeze({
    manifest_id:p.manifest_id||null,job_id:p.job_id||null,run_id:p.run_id||null,trace_id:p.trace_id||null,
    state:p.state||null,created_at:p.created_at||null,updated_at:p.updated_at||null,
    what:p.what||null,where:p.where||null,why:safeText(p.why,500)||null,objective:safeText(p.objective,240)||null,
    channel:p.channel||null,account_ref:p.account_ref||null,content_or_offer:p.content_or_offer||{kind:'none'},risk:p.risk||null,
    cost:p.cost||{currency:'USD',estimated_amount:null,mode:'not_estimated'},approval:p.approval||{required:false,status:'not_requested'},
    expected_result:safeText(p.expected_result,500)||null,external_effect_possible:p.external_effect_possible===true,
    result:p.result||null,evidence:p.evidence||null,
  });
}
