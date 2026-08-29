export const SERVICE_OBJECTIVES=Object.freeze({
  availability_ratio:0.999,
  error_ratio_max:0.001,
  p95_latency_ms:1500,
  p99_latency_ms:3000,
  outbox_oldest_pending_seconds:300,
  outbox_dead_letter_max:0,
  agent_failed_runs_ratio_max:0.01,
});

const percentile=(values,p)=>{
  const xs=values.map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
  if(!xs.length) return null;
  return xs[Math.min(xs.length-1,Math.ceil(xs.length*p)-1)];
};

export function assessServiceLevel(samples=[],objectives=SERVICE_OBJECTIVES){
  const total=samples.length;
  const ok=samples.filter(x=>Number(x.status)>=200&&Number(x.status)<400).length;
  const errors=samples.filter(x=>Number(x.status)>=500).length;
  const latencies=samples.map(x=>Number(x.duration_ms)).filter(Number.isFinite);
  const availability=total?ok/total:null; const errorRatio=total?errors/total:null;
  return Object.freeze({
    evidence_samples:total, availability_ratio:availability, error_ratio:errorRatio,
    p95_latency_ms:percentile(latencies,0.95), p99_latency_ms:percentile(latencies,0.99),
    objectives, historical_slo_proven:false,
  });
}

export function assessOutboxHealth({pending=0,retry=0,deadLetter=0,oldestPendingSeconds=0}={}){
  const backlog=Number(pending)+Number(retry);
  return Object.freeze({backlog,dead_letter:Number(deadLetter),oldest_pending_seconds:Number(oldestPendingSeconds)||0,
    healthy:Number(deadLetter)===0&&(Number(oldestPendingSeconds)||0)<=SERVICE_OBJECTIVES.outbox_oldest_pending_seconds});
}

export function assessAgentHealth({runs=0,failed=0,fallback=0,blocked=0}={}){
  const n=Number(runs)||0; const failedRatio=n?Number(failed||0)/n:0;
  return Object.freeze({runs:n,failed:Number(failed)||0,blocked:Number(blocked)||0,fallback:Number(fallback)||0,
    failed_ratio:failedRatio,healthy:failedRatio<=SERVICE_OBJECTIVES.agent_failed_runs_ratio_max});
}
