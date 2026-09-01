import { randomUUID } from 'node:crypto';

export const OUTCOME_LEARNING_POLICY=Object.freeze({
  version:'outcome-policy-v1',
  window_days:90,
  min_matured_per_arm:20,
  min_paid_per_arm:3,
  min_total_matured:30,
  exploration_min_eligible_arms:2,
  exploration_min_total_matured:60,
  exploration_rate_cap:0.10,
  memory_ttl_hours:168,
});

const n=(value)=>Math.max(0,Number(value)||0);
const clamp=(value,min,max)=>Math.max(min,Math.min(max,Number(value)||0));
const armKey=(row)=>[row.experiment_id||'unknown',row.offer_id||'unknown',row.channel||'unknown'].map(String).join('|');

export function wilsonLowerBound(successes,total,z=1.96){
  const count=n(total),wins=Math.min(count,n(successes));
  if(!count)return 0;
  const p=wins/count,z2=z*z,den=1+z2/count;
  const centre=p+z2/(2*count);
  const margin=z*Math.sqrt((p*(1-p)+z2/(4*count))/count);
  return clamp((centre-margin)/den,0,1);
}
export function summarizeOutcomeArms(rows=[]){
  const arms=new Map();
  for(const row of rows){
    const key=armKey(row);
    const current=arms.get(key)||{key,experiment_id:String(row.experiment_id||''),offer_id:String(row.offer_id||''),channel:String(row.channel||''),sessions:0,qualified:0,checkout:0,paid:0,refunded:0,gross_revenue_brl:0};
    current.sessions+=n(row.sessions);current.qualified+=n(row.qualified);current.checkout+=n(row.checkout);current.paid+=n(row.paid);current.refunded+=n(row.refunded);current.gross_revenue_brl+=n(row.gross_revenue_brl);
    arms.set(key,current);
  }
  return [...arms.values()].map((arm)=>Object.freeze({...arm,
    matured:arm.paid,
    qualified_rate:arm.sessions?arm.qualified/arm.sessions:null,
    paid_rate:arm.sessions?arm.paid/arm.sessions:null,
    checkout_to_paid_rate:arm.checkout?arm.paid/arm.checkout:null,
    refund_rate:arm.paid?Math.min(1,arm.refunded/arm.paid):null,
    paid_wilson_lower:wilsonLowerBound(arm.paid,arm.sessions),
  }));
}

export function chooseLearnedArm(arms=[],policy=OUTCOME_LEARNING_POLICY){
  const totalMatured=arms.reduce((s,a)=>s+n(a.matured),0);
  const eligible=arms.filter((a)=>n(a.matured)>=policy.min_matured_per_arm&&n(a.paid)>=policy.min_paid_per_arm);
  if(totalMatured<policy.min_total_matured)return Object.freeze({ready:false,reason:'insufficient_total_matured',total_matured:totalMatured,eligible_arms:eligible.length});
  if(!eligible.length)return Object.freeze({ready:false,reason:'no_eligible_arm',total_matured:totalMatured,eligible_arms:0});
  const ranked=[...eligible].sort((a,b)=>(b.paid_wilson_lower-a.paid_wilson_lower)||(n(a.refund_rate)-n(b.refund_rate))||(b.sessions-a.sessions));
  const winner=ranked[0];
  const exploration=eligible.length>=policy.exploration_min_eligible_arms&&totalMatured>=policy.exploration_min_total_matured?policy.exploration_rate_cap:0;
  return Object.freeze({ready:true,reason:'observed_outcome_threshold_met',total_matured:totalMatured,eligible_arms:eligible.length,winner,exploration_rate:exploration,ranking:Object.freeze(ranked)});
}
export async function loadObservedOutcomeRows(sql,{windowDays=OUTCOME_LEARNING_POLICY.window_days}={}){
  const days=Math.max(7,Math.min(365,Math.trunc(Number(windowDays)||90)));
  return sql.query(`with sessions as (
    select experiment_id,offer_id,channel,session_id,
      bool_or(event_name='lead_qualified') qualified,
      bool_or(event_name='checkout_started') checkout
    from telemetry_events where occurred_at>=now()-($1::text||' days')::interval
    group by experiment_id,offer_id,channel,session_id
  ), paid as (
    select o.session_id,o.experiment_id,o.offer_id,
      count(*) filter(where fe.normalized_event='payment_confirmed')::int paid,
      count(*) filter(where fe.normalized_event='refund_confirmed')::int refunded,
      coalesce(sum(case when fe.normalized_event='payment_confirmed' then fe.amount else 0 end),0)::numeric gross_revenue_brl
    from orders o left join financial_events fe on fe.order_id=o.order_id
    where o.created_at>=now()-($1::text||' days')::interval
    group by o.session_id,o.experiment_id,o.offer_id
  )
  select s.experiment_id,s.offer_id,s.channel,count(*)::int sessions,
    count(*) filter(where s.qualified)::int qualified,count(*) filter(where s.checkout)::int checkout,
    coalesce(sum(p.paid),0)::int paid,coalesce(sum(p.refunded),0)::int refunded,coalesce(sum(p.gross_revenue_brl),0)::numeric gross_revenue_brl
  from sessions s left join paid p on p.session_id=s.session_id and p.experiment_id=s.experiment_id and p.offer_id=s.offer_id
  group by s.experiment_id,s.offer_id,s.channel`,[days]);
}

export async function refreshOutcomeLearning(sql,{now=new Date(),policy=OUTCOME_LEARNING_POLICY}={}){
  const rows=await loadObservedOutcomeRows(sql,{windowDays:policy.window_days});
  const arms=summarizeOutcomeArms(rows);const decision=chooseLearnedArm(arms,policy);
  const learnedAt=new Date(now).toISOString();const expiresAt=new Date(new Date(now).getTime()+policy.memory_ttl_hours*3600000).toISOString();
  const value={policy_version:policy.version,learned_at:learnedAt,source:'reconciled_telemetry_and_financial_events',decision,arms};
  await sql.query(`insert into agent_memory(memory_id,scope_type,scope_ref,memory_key,memory_value,confidence,expires_at)
    values($1,'global','revenue','outcome_learning_v1',$2::jsonb,$3,$4)
    on conflict(scope_type,scope_ref,memory_key) do update set memory_value=excluded.memory_value,confidence=excluded.confidence,expires_at=excluded.expires_at,updated_at=now()`,
    [randomUUID(),JSON.stringify(value),decision.ready?Math.min(0.99,0.5+Math.min(0.49,decision.total_matured/1000)):0,expiresAt]);
  return Object.freeze(value);
}
export async function loadOutcomeLearningMemory(sql){
  const rows=await sql.query(`select memory_value,confidence,updated_at,expires_at from agent_memory
    where scope_type='global' and scope_ref='revenue' and memory_key='outcome_learning_v1'
      and (expires_at is null or expires_at>now()) limit 1`);
  const row=rows[0];if(!row)return null;
  const value=row.memory_value&&typeof row.memory_value==='object'?row.memory_value:{};
  if(value?.decision?.ready!==true)return null;
  return Object.freeze({
    policy_version:String(value.policy_version||''),
    learned_at:value.learned_at||row.updated_at||null,
    confidence:Number(row.confidence)||0,
    winner:value.decision.winner||null,
    exploration_rate:Number(value.decision.exploration_rate)||0,
    total_matured:Number(value.decision.total_matured)||0,
    source:String(value.source||'observed_outcomes'),
  });
}
export async function queueOutcomeLearningReview(sql,{idempotencyKey,priority=70,source='observed_outcome'}={}){
  const key=String(idempotencyKey||'').trim();if(!key)throw new Error('learning_idempotency_key_required');
  const rows=await sql.query(`insert into agent_jobs(job_id,job_type,status,priority,lead_id,idempotency_key,payload,available_at)
    values($1,'learning_review','queued',$2,null,$3,$4::jsonb,now())
    on conflict(idempotency_key) do nothing returning job_id`,[
    randomUUID(),Math.max(0,Math.min(100,Number(priority)||70)),key,JSON.stringify({source})
  ]);
  return Object.freeze({queued:rows.length>0,job_id:rows[0]?.job_id||null});
}
