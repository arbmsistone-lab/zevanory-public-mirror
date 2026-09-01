export const TOOL_RISK = Object.freeze({
  get_command_center: 'read',
  search_knowledge: 'read',
  read_lead_context: 'read',
  remember_fact: 'write',
  schedule_follow_up: 'write',
  create_offer_draft: 'write',
  refresh_outcome_learning: 'write',
  send_message: 'commercial',
  publish_content: 'commercial',
  start_checkout: 'financial',
  refund_payment: 'financial',
});

export function authorizeTool(toolName, env = process.env) {
  const risk = TOOL_RISK[toolName];
  if (!risk) return Object.freeze({ allowed:false, risk_level:'destructive', reason:'unknown_tool' });
  if (risk === 'read') return Object.freeze({ allowed:true, risk_level:risk, reason:'read_only' });
  if (risk === 'write') return Object.freeze({ allowed:true, risk_level:risk, reason:'internal_reversible_write' });
  const commercial = env.SALE_GLOBALLY_ENABLED === 'true' && env.PRE_SALE_GATES_APPROVED === 'true';
  if (risk === 'commercial') return Object.freeze({ allowed:commercial, risk_level:risk, reason:commercial?'commercial_gates_open':'commercial_gates_closed' });
  const financial = commercial && env.FINANCIAL_EVENTS_ENABLED === 'true' && env.CHECKOUT_ENABLED === 'true';
  if (risk === 'financial') return Object.freeze({ allowed:financial, risk_level:risk, reason:financial?'financial_gates_open':'financial_gates_closed' });
  return Object.freeze({ allowed:false, risk_level:risk, reason:'deny_by_default' });
}

export const AGENT_SYSTEM_POLICY = `You are the ZEVANORY revenue agent. Use only supplied facts. Never invent sales, revenue, conversion, customer identity, legal status, prices, inventory, payment status or performance. Prefer reversible actions. Commercial and financial actions require explicit runtime gates. If evidence is insufficient, return action=review and explain the missing evidence. Output strict JSON.`;
