import { randomUUID, createHash } from 'node:crypto';
import { askGemini, deterministicDecision } from './aiProvider.mjs';
import { AGENT_SYSTEM_POLICY, authorizeTool } from './agentPolicy.mjs';
import { searchKnowledge, knowledgeContext } from './knowledgeEngine.mjs';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const terminalStages = new Set(['paid','delivered','refunded','unqualified','lost']);

export function chooseTool(decision = {}) {
  const action = String(decision.action || 'review');
  return ({ first_response:'schedule_follow_up', follow_up:'schedule_follow_up', qualify:'remember_fact', offer:'create_offer_draft' })[action] || 'get_command_center';
}

export async function buildAgentContext(sql, job) {
  let lead = null;
  if (job.lead_id) {
    const rows = await sql.query('select lead_id,channel,stage,touchpoints,last_contact_at,next_action_at,updated_at from sales_leads where lead_id=$1 limit 1',[job.lead_id]);
    lead = rows[0] || null;
  }
  const knowledge = await searchKnowledge(sql, `${job.job_type} ${lead?.stage || ''}`, 5);
  return Object.freeze({ job_type:job.job_type, lead, knowledge:knowledgeContext(knowledge) });
}

export async function decideRevenueAction(context, options = {}) {
  const input = { job_type:context.job_type, stage:context.lead?.stage || null, touchpoints:context.lead?.touchpoints || 0, knowledge:context.knowledge };
  if (terminalStages.has(String(input.stage))) return deterministicDecision({ ...input, stage:'terminal' });
  try { return await askGemini({ input, systemInstruction:AGENT_SYSTEM_POLICY, ...options }); }
  catch (error) { return Object.freeze({ ...deterministicDecision(input), fallback_reason:String(error?.message || 'ai_unavailable') }); }
}
