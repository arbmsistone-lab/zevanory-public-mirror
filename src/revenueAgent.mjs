import { createHash } from 'node:crypto';
import { decideWithAiProviders, deterministicDecision } from './aiProvider.mjs';
import { AGENT_SYSTEM_POLICY } from './agentPolicy.mjs';
import { searchKnowledge, knowledgeContext } from './knowledgeEngine.mjs';
import { loadOutcomeLearningMemory } from './outcomeLearning.mjs';
import { buildCommercialEngineContext } from './commercialEngineV2.mjs';
import { buildSupportKnowledgeQuery, decideEliteProductSupport } from './productSupport.mjs';

const digest=(value)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const terminalStages=new Set(['paid','delivered','refunded','unqualified','lost']);
const cleanMemory=(rows=[])=>rows.map(x=>({key:String(x.memory_key||''),value:x.memory_value,confidence:Number(x.confidence)||0})).slice(0,12);
const cleanRecent=(rows=[])=>rows.map(x=>String(x.text||'').trim()).filter(Boolean).slice(0,8);

export function chooseTool(decision={}){
  const action=String(decision.action||'review').toLowerCase();
  return ({first_response:'schedule_follow_up',follow_up:'schedule_follow_up',qualify:'remember_fact',offer:'create_offer_draft',message:'send_message',send_message:'send_message',respond:'send_message',creative:'create_creative',create_creative:'create_creative',publish:'publish_content',publish_content:'publish_content',checkout:'start_checkout',start_checkout:'start_checkout',refund:'refund_payment',refund_payment:'refund_payment',learn_outcomes:'refresh_outcome_learning',support_reply:'send_support_message',support_escalate:'send_support_message',support_request_context:'send_support_message'})[action]||'get_command_center';
}
export async function buildAgentContext(sql,job){
  let lead=null;
  if(job.lead_id){
    const rows=await sql.query('select lead_id,session_id,channel,stage,contact_ref,touchpoints,last_contact_at,next_action_at,updated_at from sales_leads where lead_id=$1 limit 1',[job.lead_id]);
    lead=rows[0]||null;
  }
  const [knowledge,outcomeLearning,customerRows,recentRows,memoryRows]=await Promise.all([
    searchKnowledge(sql,job.job_type==='product_support'?buildSupportKnowledgeQuery(job.payload||{}):`${job.job_type} ${lead?.stage||''} ${String(job.payload?.inbound_message||'').slice(0,350)}`,job.job_type==='product_support'?12:10),
    loadOutcomeLearningMemory(sql),
    lead?.lead_id?sql.query('select customer_id,purchase_count,adoption_score,satisfaction_score,support_risk,last_activity_at from customer_lifecycle_profiles where lead_id=$1 limit 1',[lead.lead_id]):Promise.resolve([]),
    lead?.lead_id?sql.query("select payload->>'text' text,created_at from integration_outbox where aggregate_type='lead' and aggregate_id=$1 and event_type='send_message' order by created_at desc limit 8",[String(lead.lead_id)]):Promise.resolve([]),
    lead?.lead_id?sql.query("select memory_key,memory_value,confidence from agent_memory where scope_type='lead' and scope_ref=$1 and (expires_at is null or expires_at>now()) order by updated_at desc limit 12",[String(lead.lead_id)]):Promise.resolve([]),
  ]);
  const commercialEngineV2=buildCommercialEngineContext({job,lead,customer:customerRows[0]||null,outcome_learning:outcomeLearning});
  return Object.freeze({job_type:job.job_type,job_payload:job.payload||{},lead,knowledge:knowledgeContext(knowledge),outcome_learning:outcomeLearning,commercial_engine_v2:commercialEngineV2,recent_conversation:Object.freeze(cleanRecent(recentRows)),lead_memory:Object.freeze(cleanMemory(memoryRows))});
}
export async function decideRevenueAction(context,options={}){
  if(context.job_type==='product_support')return decideEliteProductSupport({request:{...(context.job_payload||{}),channel:context.lead?.channel||context.job_payload?.channel,recent_conversation:context.recent_conversation},knowledge:context.knowledge,providers:options.aiProviders||[],apiKey:options.apiKey,model:options.model});
  const input={
    job_type:context.job_type,
    inbound_message:String(context.job_payload?.inbound_message||'').slice(0,5000),
    inbound_media_type:String(context.job_payload?.media_type||'text'),
    stage:context.lead?.stage||null,
    channel:context.lead?.channel||null,
    touchpoints:context.lead?.touchpoints||0,
    knowledge:context.knowledge,
    recent_conversation:context.recent_conversation||[],
    lead_memory:context.lead_memory||[],
    outcome_learning:context.outcome_learning||null,
    commercial_engine_v2:context.commercial_engine_v2||null,
  };
  if(terminalStages.has(String(input.stage)))return deterministicDecision({...input,stage:'terminal'});
  try{return await decideWithAiProviders({input,systemInstruction:AGENT_SYSTEM_POLICY,providers:options.aiProviders||[],apiKey:options.apiKey,model:options.model});}
  catch(error){return Object.freeze({...deterministicDecision(input),fallback_reason:String(error?.message||'ai_unavailable')});}
}

export function decisionInputHash(context){
  return digest({job_type:context.job_type,inbound_message:String(context.job_payload?.inbound_message||''),stage:context.lead?.stage||null,channel:context.lead?.channel||null,touchpoints:context.lead?.touchpoints||0,knowledge:context.knowledge,recent_conversation:context.recent_conversation||[],lead_memory:context.lead_memory||[],outcome_learning:context.outcome_learning||null,commercial_engine_v2:context.commercial_engine_v2||null});
}
