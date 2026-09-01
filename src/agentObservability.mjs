const EXTERNAL_TOOLS = new Set(['send_message','publish_content','start_checkout','refund_payment']);

const asObject=(value)=>{
  if(value&&typeof value==='object') return value;
  try{return JSON.parse(String(value||'{}'));}catch{return {};}
};
const percentile=(values,p)=>{
  const nums=values.map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
  if(!nums.length)return null;
  const index=Math.max(0,Math.min(nums.length-1,Math.ceil((p/100)*nums.length)-1));
  return nums[index];
};
const latestOutboxByRun=(rows=[])=>{
  const map=new Map();
  for(const row of rows){
    const runId=String(row.run_id||row.headers?.run_id||'');
    if(runId&&!map.has(runId))map.set(runId,row);
  }
  return map;
};

export function deriveExecutionState(run={},outboxEvent=null){
  const result=asObject(run.result);
  if(run.outcome==='failed') return 'failed';
  if(run.outcome==='blocked') return result.state==='awaiting_approval'?'awaiting_approval':'blocked';
  if(!EXTERNAL_TOOLS.has(String(run.tool||''))) return 'internal_completed';
  if(!outboxEvent) return 'external_request_unobserved';
  if(outboxEvent.status==='delivered') return 'external_request_delivered';
  if(outboxEvent.status==='retry') return 'external_request_retry';
  if(outboxEvent.status==='dead_letter') return 'external_request_failed';
  return 'external_request_pending';
}
export function buildAgentObservability({runs=[],outbox=[],approvals=[]}={}){
  const byRun=latestOutboxByRun(outbox);
  const enriched=runs.map((run)=>Object.freeze({...run,execution_state:deriveExecutionState(run,byRun.get(String(run.run_id||''))||null)}));
  const total=enriched.length;
  const traced=enriched.filter((x)=>x.trace_id&&x.span_id).length;
  const failed=enriched.filter((x)=>x.execution_state==='failed'||x.execution_state==='external_request_failed').length;
  const blocked=enriched.filter((x)=>['blocked','awaiting_approval'].includes(x.execution_state)).length;
  const externalPending=enriched.filter((x)=>['external_request_pending','external_request_retry','external_request_unobserved'].includes(x.execution_state)).length;
  const externalDelivered=enriched.filter((x)=>x.execution_state==='external_request_delivered').length;
  const pendingApprovals=approvals.filter((x)=>x.status==='pending').length;
  const evals=enriched.map((x)=>asObject(x.eval)).filter((x)=>typeof x.pass==='boolean');
  const evalPassed=evals.filter((x)=>x.pass===true).length;
  const latencies=enriched.map((x)=>Number(x.latency_ms)).filter(Number.isFinite);
  return Object.freeze({
    runs:Object.freeze(enriched),
    metrics:Object.freeze({
      total_runs:total,
      trace_coverage:total?traced/total:null,
      failed_runs:failed,
      blocked_runs:blocked,
      pending_approvals:pendingApprovals,
      external_requests_pending:externalPending,
      external_requests_delivered:externalDelivered,
      eval_coverage:total?evals.length/total:null,
      eval_pass_rate:evals.length?evalPassed/evals.length:null,
      latency_p50_ms:percentile(latencies,50),
      latency_p95_ms:percentile(latencies,95),
      business_truth_mode:'provider_reconciliation_required',
    }),
  });
}
