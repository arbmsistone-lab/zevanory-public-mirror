const forbiddenClaims = [
  /pagamento confirmado/i,/venda garantida/i,/estoque dispon[ií]vel/i,/convers[aã]o de \d/i,/roas de \d/i,
];
const toolByAction=Object.freeze({
  first_response:'schedule_follow_up',follow_up:'schedule_follow_up',qualify:'remember_fact',offer:'create_offer_draft',
  message:'send_message',send_message:'send_message',respond:'send_message',publish:'publish_content',publish_content:'publish_content',
  checkout:'start_checkout',start_checkout:'start_checkout',refund:'refund_payment',refund_payment:'refund_payment',learn_outcomes:'refresh_outcome_learning',review:'get_command_center',
});
const content=(decision)=>String(decision.message||decision.content||'').trim();

export function evaluateAgentDecision({ decision = {}, context = {}, authorization = null, tool = null } = {}) {
  const issues=[];const text=JSON.stringify(decision);const action=String(decision.action||'').trim().toLowerCase();
  const confidence=Number(decision.confidence);const expectedTool=toolByAction[action]||'get_command_center';
  if(forbiddenClaims.some((rx)=>rx.test(text))) issues.push('unsupported_commercial_claim');
  if(!action) issues.push('missing_action');
  if(!String(decision.rationale||'').trim()) issues.push('missing_rationale');
  if(!Number.isFinite(confidence)||confidence<0||confidence>1) issues.push('invalid_confidence');
  if(tool&&String(tool)!==expectedTool) issues.push('tool_selection_mismatch');
  if(authorization && !authorization.allowed && decision.execute===true) issues.push('blocked_tool_requested_execution');
  if(context?.lead?.stage && ['paid','delivered','refunded','unqualified','lost'].includes(context.lead.stage) && action!=='review') issues.push('terminal_stage_action');
  if(expectedTool==='send_message'&&!content(decision)) issues.push('message_content_missing');
  if(expectedTool==='send_message'&&!String(context?.lead?.contact_ref||'').trim()) issues.push('message_recipient_missing');
  if(expectedTool==='publish_content'&&!content(decision)) issues.push('publish_content_missing');
  if(expectedTool==='publish_content'&&!String(decision.channel||context?.lead?.channel||'').trim()) issues.push('publish_channel_missing');
  if(expectedTool==='publish_content'&&String(decision.channel||context?.lead?.channel||'').toLowerCase()==='instagram'&&!/^https:\/\//i.test(String(decision.media_url||''))) issues.push('instagram_media_missing');
  if(expectedTool==='publish_content'&&String(decision.channel||context?.lead?.channel||'').toLowerCase()==='youtube'&&!/^https:\/\//i.test(String(decision.media_url||''))) issues.push('youtube_media_missing');
  if(expectedTool==='publish_content'&&String(decision.channel||context?.lead?.channel||'').toLowerCase()==='youtube'&&!String(decision.title||'').trim()) issues.push('youtube_title_missing');
  if(expectedTool==='start_checkout'&&!String(context?.lead?.session_id||'').trim()) issues.push('checkout_session_missing');
  if(expectedTool==='refund_payment'&&!String(decision.order_id||'').trim()) issues.push('refund_order_missing');
  if(expectedTool==='refresh_outcome_learning'&&String(context?.job_type||'')!=='learning_review') issues.push('learning_job_required');
  if(String(context?.job_type||'')==='learning_review'&&expectedTool!=='refresh_outcome_learning') issues.push('learning_action_required');
  return Object.freeze({pass:issues.length===0,score:Math.max(0,1-(issues.length*0.125)),issues:Object.freeze(issues),expected_tool:expectedTool});
}

export function evalSuiteSummary(results = []) {
  const total=results.length; const passed=results.filter(x=>x.pass).length;
  return Object.freeze({ total, passed, failed:total-passed, pass_rate:total?passed/total:0 });
}
