import { randomUUID, createHash } from 'node:crypto';
import { buildAgentContext, decideRevenueAction, chooseTool, decisionInputHash } from './revenueAgent.mjs';
import { authorizeTool } from './agentPolicy.mjs';
import { evaluateAgentDecision } from './agentEvals.mjs';
import { buildFollowUpPlan } from './salesPipeline.mjs';
import { enqueueOutbox } from './integrationOutbox.mjs';
import { assertChannelActionAllowed } from './channelAdapters.mjs';
import { getAgentControlState, requiresHumanApproval, findApprovedAction, requestApproval, consumeApproval } from './agentControl.mjs';
import { refreshOutcomeLearning } from './outcomeLearning.mjs';
import { recordVerifiedLifecycleEvidence } from './lifecycleEvidenceRepository.mjs';
import { evaluateProgressiveAutonomy } from './autonomyPolicy.mjs';
import { evaluateContentNovelty } from './contentDedup.mjs';
import { buildLiveActionPlan, persistLiveActionPlan, transitionLiveActionPlan } from './liveActionPlan.mjs';
import { selectPaymentProvider } from './paymentProviders.mjs';
import { creativeAssetUrl } from './creativeEngine.mjs';
import { selectCreativeVariantWithEvidence, selectCreativeVariantWithVisualEvidence, chooseCreativeForOperation, CREATIVE_INTELLIGENCE_POLICY } from './creativeIntelligence.mjs';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const nbaExecutableTools=new Set(['schedule_follow_up','send_message','start_checkout']);
export function nbaExecutionConfirmed(tool,result={}){
  if(tool==='schedule_follow_up') return result?.scheduled===true;
  if(tool==='send_message'||tool==='start_checkout') return Boolean(result?.event_id)&&['pending','processing','delivered'].includes(String(result?.status||'pending'));
  return false;
}
export async function recordNextBestActionEvidence(sql,{runId,context,tool,result,decision}){
  const learning=context?.outcome_learning; const lead=context?.lead;
  if(!lead?.lead_id||!learning||!nbaExecutableTools.has(tool)||!nbaExecutionConfirmed(tool,result)) return null;
  return recordVerifiedLifecycleEvidence(sql,{dimension:'next_best_action',source_class:'canonical_database',source:'revenue_agent',subject_ref:String(lead.lead_id),idempotency_key:`next-best-action:${runId}`,metadata:{run_id:runId,tool,decision_action:String(decision?.action||''),learning_policy_version:String(learning?.policy_version||''),learning_total_matured:Number(learning?.total_matured)||0,learning_winner_key:String(learning?.winner?.key||'')}});
}

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

async function persistRun(sql,{runId,job,traceId,spanId,decision,context,tool,outcome,result,evalResult,latencyMs}){
  await sql.query(`insert into agent_runs(run_id,job_id,provider,model,mode,outcome,input_hash,tool_calls,latency_ms,decision)
    values($1,$2,$3,$4,$5,$6,$7,1,$8,$9::jsonb)`,[
    runId,job.job_id,decision.provider||'deterministic',decision.model||'rules-v1',decision.mode||'deterministic',outcome,
    decision.input_hash||decisionInputHash(context),Math.max(0,Number(latencyMs)||0),
    JSON.stringify({...decision,tool,result,eval:evalResult,trace_id:traceId,span_id:spanId}),
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
  if(tool==='refresh_outcome_learning'){
    const learning=await refreshOutcomeLearning(sql);
    return {refreshed:true,learning_ready:Boolean(learning?.decision?.ready),reason:learning?.decision?.reason||'unknown',total_matured:Number(learning?.decision?.total_matured)||0};
  }
  if(tool==='create_creative'){
    const channel=String(decision.channel||lead?.channel||'instagram').toLowerCase();
    const intelligence=await selectCreativeVariantWithEvidence(sql,{offerId:decision.offer_id||'OFFER-0001',channel,hook:decision.hook||decision.title||decision.content||decision.message,body:decision.body||decision.content||decision.message,cta:decision.cta||'Saiba mais',objective:decision.objective||'awareness',campaignId:decision.campaign_id||''});
    const spec=intelligence.winner.spec,video=['youtube','tiktok'].includes(channel); if(intelligence.winner.quality_score<CREATIVE_INTELLIGENCE_POLICY.min_quality_score)throw new Error('creative_quality_below_threshold');
    return {creative_id:spec.creative_id,campaign_id:spec.campaign_id,variant_id:spec.variant_id,spec,image_url:creativeAssetUrl(spec,'png',env),video_url:video?creativeAssetUrl(spec,'webm',env):null,publishable:false,selection_basis:intelligence.selection_basis,quality_score:intelligence.winner.quality_score,variants:intelligence.ranking.map(x=>({creative_id:x.spec.creative_id,variant_id:x.variant_id,quality_score:x.quality_score,selection_score:x.selection_score,observed_ready:x.observed_ready}))};
  }
  if(tool==='create_offer_draft') return {draft_only:true,commercial_action:false};
  if(tool==='send_message'){
    if(!lead?.contact_ref) throw new Error('recipient_unavailable');
    assertChannelActionAllowed(lead.channel,env);
    const text=String(decision.message||decision.content||'').trim(); if(!text) throw new Error('message_content_required');
    const payload={contact_ref:lead.contact_ref,text:text.slice(0,4000),subject:String(decision.subject||decision.title||'ZEVANORY').slice(0,240)};
    if(decision.auto_creative===true&&['whatsapp','email'].includes(String(lead.channel).toLowerCase())){const intelligence=await selectCreativeVariantWithVisualEvidence(sql,{offerId:decision.offer_id||'OFFER-0001',channel:String(lead.channel).toLowerCase(),hook:decision.hook||decision.title||text,body:decision.body||text,cta:decision.cta||'Saiba mais',objective:decision.objective||'conversion',placement:decision.placement||'',campaignId:decision.campaign_id||''});const choice=chooseCreativeForOperation(intelligence,runId),spec=choice.selected.spec;if(choice.selected.quality_score<CREATIVE_INTELLIGENCE_POLICY.min_quality_score||choice.selected.perceptual_score<CREATIVE_INTELLIGENCE_POLICY.min_perceptual_score)throw new Error('creative_quality_below_threshold');payload.media_url=creativeAssetUrl(spec,'png',env);payload.creative_id=spec.creative_id;payload.campaign_id=spec.campaign_id;payload.variant_id=spec.variant_id;payload.creative_quality_score=choice.selected.quality_score;payload.creative_perceptual_score=choice.selected.perceptual_score;}
    return enqueueOutbox(sql,{aggregateType:'lead',aggregateId:leadId,eventType:'send_message',destination:`channel:${lead.channel}`,payload,idempotencyKey:`agent:${runId}:send_message`,traceId,runId});
  }
  if(tool==='publish_content'){
    const channel=String(decision.channel||lead?.channel||'').toLowerCase();
    assertChannelActionAllowed(channel,env);
    const content=String(decision.content||decision.message||'').trim(); if(!content) throw new Error('publish_content_required');
    const novelty=await evaluateContentNovelty(sql,{content,channel});
    if(!novelty.allowed) throw new Error(novelty.reason);
    let mediaUrl=String(decision.media_url||'').trim(),creativeId=null,campaignId=null,variantId=null,selectionBasis=null,qualityScore=null,perceptualScore=null,landingUrl=null;
    if(!mediaUrl&&decision.auto_creative===true){
      const intelligence=await selectCreativeVariantWithVisualEvidence(sql,{offerId:decision.offer_id||'OFFER-0001',channel,hook:decision.hook||decision.title||content,body:decision.body||content,cta:decision.cta||'Saiba mais',objective:decision.objective||'conversion',placement:decision.placement||'',campaignId:decision.campaign_id||''});
      const choice=chooseCreativeForOperation(intelligence,runId),spec=choice.selected.spec; if(choice.selected.quality_score<CREATIVE_INTELLIGENCE_POLICY.min_quality_score||choice.selected.perceptual_score<CREATIVE_INTELLIGENCE_POLICY.min_perceptual_score)throw new Error('creative_quality_below_threshold');
      creativeId=spec.creative_id;campaignId=spec.campaign_id;variantId=spec.variant_id;selectionBasis=choice.basis;qualityScore=choice.selected.quality_score;perceptualScore=choice.selected.perceptual_score;
      mediaUrl=creativeAssetUrl(spec,['youtube','tiktok'].includes(channel)?'webm':'png',env);
      const base=String(env.PUBLIC_BASE_URL||'https://zevanory.api.br').replace(/\/$/,''); landingUrl=`${base}/?zc=${encodeURIComponent(campaignId)}&zv=${encodeURIComponent(variantId)}&zi=${encodeURIComponent(creativeId)}`;
    }
    const title=String(decision.title||decision.hook||content).slice(0,240);
    return enqueueOutbox(sql,{aggregateType:'content',aggregateId:runId,eventType:'publish_content',destination:`channel:${channel}`,payload:{content:content.slice(0,8000),title,description:(landingUrl?`${String(decision.description||content).slice(0,4700)}\n\n${landingUrl}`:String(decision.description||content)).slice(0,5000),media_url:mediaUrl.slice(0,4000),creative_id:creativeId,campaign_id:campaignId,variant_id:variantId,landing_url:landingUrl,creative_selection_basis:selectionBasis,creative_quality_score:qualityScore,creative_perceptual_score:perceptualScore,privacy_status:String(decision.privacy_status||'private').slice(0,20),made_for_kids:decision.made_for_kids===true,dedup_fingerprint:novelty.fingerprint,dedup_policy:novelty.policy},idempotencyKey:`agent:${runId}:publish_content`,traceId,runId});
  }
  if(tool==='start_checkout'){
    if(!lead?.session_id) throw new Error('checkout_session_unavailable');
    const requestId=randomUUID();
    const selected=selectPaymentProvider(env,{operationKey:requestId});
    if(!selected.ready) throw new Error('payment_capacity_unavailable');
    return enqueueOutbox(sql,{aggregateType:'lead',aggregateId:leadId,eventType:'start_checkout',destination:'payment:checkout',payload:{provider:selected.provider,selection_reason:selected.reason,session_id:lead.session_id,request_id:requestId},idempotencyKey:`agent:${runId}:start_checkout`,traceId,runId});
  }
  if(tool==='refund_payment'){
    const orderRef=String(decision.order_id||'').trim(); if(!orderRef) throw new Error('refund_order_required');
    return enqueueOutbox(sql,{aggregateType:'order',aggregateId:orderRef,eventType:'refund_payment',destination:'payment:refund',payload:{order_id:orderRef,reason:String(decision.reason||decision.rationale||'operator_approved_refund').slice(0,500)},idempotencyKey:`agent:${runId}:refund_payment`,traceId,runId});
  }
  return {observed:true};
}

export async function runAgentOnce(sql,options={}){
  const env=options.env||process.env;
  const control=await getAgentControlState(sql);
  if(control.paused)return Object.freeze({ok:true,processed:false,reason:'agent_paused',control});
  const job=await claimAgentJob(sql);
  if(!job)return Object.freeze({ok:true,processed:false,reason:'queue_empty'});
  const runId=randomUUID(),traceId=randomUUID(),spanId=randomUUID(),started=Date.now();
  let tool='get_command_center',decision={},evalResult={pass:false,score:0,issues:['not_evaluated']};
  let context={job_type:job.job_type,lead:null,knowledge:[]};
  let runPersisted=false;
  try{
    context=await buildAgentContext(sql,job);
    let apiKey=options.apiKey??env.GEMINI_API_KEY??null;
    if(env.AGENT_AI_ENABLED!=='true')apiKey=null;
    if(apiKey){
      const cap=Math.max(1,Math.min(10000,Number(env.AGENT_AI_MAX_RUNS_PER_HOUR)||100));
      const recent=await sql.query("select count(*)::int as count from agent_runs where mode='ai_assisted' and created_at>now()-interval '1 hour'");
      if(Number(recent[0]?.count||0)>=cap)apiKey=null;
    }
    decision=await decideRevenueAction(context,{...options,apiKey});
    tool=chooseTool(decision);
    const auth=authorizeTool(tool,env);
    evalResult=evaluateAgentDecision({decision,context,authorization:auth,tool});
    let contentNovelty=null;
    if(evalResult.pass&&tool==='publish_content'){
      const dedupChannel=String(decision.channel||context.lead?.channel||'').toLowerCase();
      const dedupContent=String(decision.content||decision.message||'').trim();
      contentNovelty=await evaluateContentNovelty(sql,{content:dedupContent,channel:dedupChannel});
      if(!contentNovelty.allowed)evalResult=Object.freeze({...evalResult,pass:false,score:Math.max(0,Number(evalResult.score)-0.5),issues:Object.freeze([...evalResult.issues,contentNovelty.reason])});
    }
    const finalAuth=evalResult.pass?auth:Object.freeze({allowed:false,risk_level:auth.risk_level,reason:evalResult.issues?.find(x=>String(x).startsWith('content_duplicate_'))||'agent_eval_failed'});
    const livePlan=buildLiveActionPlan({job,runId,traceId,tool,auth:finalAuth,decision,context,env});
    await persistLiveActionPlan(sql,job.job_id,livePlan);
    const saveRun=async(outcome,result)=>{await persistRun(sql,{runId,job,traceId,spanId,decision,context,tool,outcome,result,evalResult,latencyMs:Date.now()-started});runPersisted=true;};
    if(!finalAuth.allowed){
      const result={blocked:true,reason:finalAuth.reason};
      await saveRun('blocked',result);
      await auditTool(sql,runId,tool,finalAuth,{job_id:job.job_id,decision,eval:evalResult,result});
      await transitionLiveActionPlan(sql,job.job_id,{state:'blocked',result,evidence:{run_id:runId,trace_id:traceId,authorization_reason:finalAuth.reason}});
      await sql.query("update agent_jobs set status='blocked',completed_at=now(),last_error=$2 where job_id=$1",[job.job_id,finalAuth.reason]);
      return Object.freeze({ok:true,processed:true,job_id:job.job_id,run_id:runId,trace_id:traceId,outcome:'blocked',tool,result,eval:evalResult});
    }
    let approval=null;let autonomy=Object.freeze({eligible:false,reason:'approval_not_applicable',mode:String(env.AGENT_AUTONOMY_MODE||'guarded')});
    if(requiresHumanApproval(tool,finalAuth.risk_level)){
      autonomy=await evaluateProgressiveAutonomy(sql,{tool,riskLevel:finalAuth.risk_level,env,evalResult,context});
      if(!autonomy.eligible){
        approval=await findApprovedAction(sql,job.job_id,tool);
        if(!approval){
          approval=await requestApproval(sql,{jobId:job.job_id,runId,traceId,toolName:tool,riskLevel:finalAuth.risk_level,reason:decision.rationale||'high_risk_action'});
          const result={blocked:true,reason:'human_approval_required',state:'awaiting_approval',approval_id:approval.approval_id,autonomy_reason:autonomy.reason};
          await saveRun('blocked',result);
          await auditTool(sql,runId,tool,{...finalAuth,allowed:false,reason:'human_approval_required'},{job_id:job.job_id,decision,eval:evalResult,autonomy,result});
          await transitionLiveActionPlan(sql,job.job_id,{state:'awaiting_approval',result,evidence:{run_id:runId,trace_id:traceId,approval_id:approval.approval_id},approvalStatus:'pending'});
          await sql.query("update agent_jobs set status='blocked',completed_at=now(),last_error='human_approval_required' where job_id=$1",[job.job_id]);
          return Object.freeze({ok:true,processed:true,job_id:job.job_id,run_id:runId,trace_id:traceId,outcome:'awaiting_approval',tool,result,eval:evalResult,autonomy});
        }
      }
    }
    let result,outcome='completed';
    try{result=await executeTool(sql,tool,context,decision,{runId,traceId,env});}
    catch(error){result={failed:true,reason:String(error?.message||'tool_execution_failed').slice(0,500)};outcome='failed';}
    if(autonomy.eligible)result={...result,autonomy_mode:autonomy.mode,autonomy_reason:autonomy.reason};
    if(approval?.approval_id)await consumeApproval(sql,approval.approval_id);
    await saveRun(outcome,result);
    await transitionLiveActionPlan(sql,job.job_id,{state:outcome==='completed'?'executed':'failed',result,evidence:{run_id:runId,trace_id:traceId,event_id:result?.event_id||null,status:result?.status||null},approvalStatus:approval?.approval_id?'consumed':undefined});
    if(outcome==='completed'){
      try{await recordNextBestActionEvidence(sql,{runId,context,tool,result,decision});}catch{}
    }
    await auditTool(sql,runId,tool,finalAuth,{job_id:job.job_id,decision,eval:evalResult,autonomy,result});
    const jobStatus=outcome==='completed'?'completed':'failed';
    await sql.query('update agent_jobs set status=$2,completed_at=now(),last_error=$3 where job_id=$1',[job.job_id,jobStatus,outcome==='failed'?String(result.reason||'tool_execution_failed'):null]);
    return Object.freeze({ok:outcome==='completed',processed:true,job_id:job.job_id,run_id:runId,trace_id:traceId,outcome,tool,result,eval:evalResult});
  }catch(error){
    const message=String(error?.message||'agent_failed').slice(0,500);
    try{if(!runPersisted){await persistRun(sql,{runId,job,traceId,spanId,decision,context,tool,outcome:'failed',result:{failed:true,reason:message},evalResult,latencyMs:Date.now()-started});runPersisted=true;}}catch{}
    try{await transitionLiveActionPlan(sql,job.job_id,{state:'failed',result:{failed:true,reason:message},evidence:{run_id:runId,trace_id:traceId}});}catch{}
    await sql.query("update agent_jobs set status='failed',completed_at=now(),last_error=$2 where job_id=$1",[job.job_id,message]);
    return Object.freeze({ok:false,processed:true,job_id:job.job_id,run_id:runId,trace_id:traceId,error:message});
  }
}
