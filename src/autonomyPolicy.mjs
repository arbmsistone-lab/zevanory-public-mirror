import { salesGate } from './salesGate.mjs';

export const AUTONOMY_POLICY=Object.freeze({
  version:'progressive-autonomy-v1',
  min_runs_24h:50,
  min_eval_pass_rate:0.99,
  min_eval_coverage:0.99,
  max_failed_run_ratio:0.01,
  max_dead_letters_24h:0,
  max_retry_24h:0,
  min_learning_confidence:0.70,
  min_learning_matured:60,
  never_autonomous:Object.freeze(['refund_payment']),
});

const num=(v)=>Math.max(0,Number(v)||0);
const ratio=(a,b)=>b>0?num(a)/num(b):null;

export function assessAutonomy({tool,riskLevel,env={},evalResult={},context={},health={},gateEvaluator=salesGate}={}){
  const mode=String(env.AGENT_AUTONOMY_MODE||'guarded').toLowerCase();
  if(['read','write'].includes(String(riskLevel)))return Object.freeze({eligible:true,reason:'internal_reversible',mode});
  if(mode!=='progressive')return Object.freeze({eligible:false,reason:'guarded_mode',mode});
  if(env.AGENT_HUMAN_APPROVAL_REQUIRED!=='false')return Object.freeze({eligible:false,reason:'human_approval_policy_enabled',mode});
  if(AUTONOMY_POLICY.never_autonomous.includes(String(tool))||riskLevel==='destructive')return Object.freeze({eligible:false,reason:'never_autonomous_tool',mode});
  const commercial=gateEvaluator(env);
  if(!commercial.enabled)return Object.freeze({eligible:false,reason:'commercial_gates_closed',mode});
  if(riskLevel==='financial'&&tool!=='start_checkout')return Object.freeze({eligible:false,reason:'financial_not_whitelisted',mode});
  if(riskLevel==='financial'&&(env.CHECKOUT_ENABLED!=='true'||env.FINANCIAL_EVENTS_ENABLED!=='true'||env.PAYMENT_MERCHANT_IDENTITY_VERIFIED!=='true'))return Object.freeze({eligible:false,reason:'financial_preconditions_closed',mode});
  if(evalResult.pass!==true||num(evalResult.score)<0.95)return Object.freeze({eligible:false,reason:'eval_quality_insufficient',mode});
  const learning=context.outcome_learning;
  if(!learning||num(learning.confidence)<AUTONOMY_POLICY.min_learning_confidence||num(learning.total_matured)<AUTONOMY_POLICY.min_learning_matured)return Object.freeze({eligible:false,reason:'learning_evidence_insufficient',mode});
  const learnedChannel=String(learning?.winner?.channel||'').toLowerCase();const currentChannel=String(context?.lead?.channel||'').toLowerCase();
  if(learnedChannel&&currentChannel&&learnedChannel!==currentChannel)return Object.freeze({eligible:false,reason:'learning_channel_mismatch',mode});
  const runs=num(health.runs_24h),failed=num(health.failed_24h),evalPassed=num(health.eval_passed_24h),evalTotal=num(health.eval_total_24h);
  const failedRatio=ratio(failed,runs),evalPassRate=ratio(evalPassed,evalTotal),evalCoverage=ratio(evalTotal,runs);
  if(runs<AUTONOMY_POLICY.min_runs_24h)return Object.freeze({eligible:false,reason:'runtime_sample_insufficient',mode});
  if(evalCoverage===null||evalCoverage<AUTONOMY_POLICY.min_eval_coverage)return Object.freeze({eligible:false,reason:'runtime_eval_coverage_insufficient',mode});
  if(evalPassRate===null||evalPassRate<AUTONOMY_POLICY.min_eval_pass_rate)return Object.freeze({eligible:false,reason:'runtime_eval_rate_insufficient',mode});
  if(failedRatio===null||failedRatio>AUTONOMY_POLICY.max_failed_run_ratio)return Object.freeze({eligible:false,reason:'runtime_failure_rate_high',mode});
  if(num(health.dead_letter_24h)>AUTONOMY_POLICY.max_dead_letters_24h||num(health.retry_24h)>AUTONOMY_POLICY.max_retry_24h)return Object.freeze({eligible:false,reason:'integration_health_not_clean',mode});
  return Object.freeze({eligible:true,reason:'progressive_thresholds_met',mode,metrics:Object.freeze({runs_24h:runs,eval_coverage:evalCoverage,eval_pass_rate:evalPassRate,failed_run_ratio:failedRatio,learning_confidence:num(learning.confidence),learning_matured:num(learning.total_matured)})});
}

export async function loadAutonomyHealth(sql){
  const [runs,outbox]=await Promise.all([
    sql.query(`select count(*)::int runs_24h,count(*) filter(where outcome='failed')::int failed_24h,
      count(*) filter(where decision->'eval'->>'pass' in ('true','false'))::int eval_total_24h,
      count(*) filter(where decision->'eval'->>'pass'='true')::int eval_passed_24h
      from agent_runs where created_at>=now()-interval '24 hours'`),
    sql.query(`select count(*) filter(where status='dead_letter')::int dead_letter_24h,count(*) filter(where status='retry')::int retry_24h
      from integration_outbox where created_at>=now()-interval '24 hours'`),
  ]);
  return Object.freeze({...runs[0],...outbox[0]});
}

export async function evaluateProgressiveAutonomy(sql,input={}){
  const staticAssessment=assessAutonomy({...input,health:{}});
  if(['internal_reversible','guarded_mode','human_approval_policy_enabled','never_autonomous_tool','commercial_gates_closed','financial_not_whitelisted','financial_preconditions_closed','eval_quality_insufficient','learning_evidence_insufficient','learning_channel_mismatch'].includes(staticAssessment.reason))return staticAssessment;
  const health=await loadAutonomyHealth(sql);
  return assessAutonomy({...input,health});
}
