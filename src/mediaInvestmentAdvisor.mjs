const clamp=(v,min=0,max=1)=>Math.max(min,Math.min(max,Number(v)||0));
const money=v=>Number.isFinite(Number(v))?Math.max(0,Number(v)):0;
const round=(v,d=2)=>Number(Number(v||0).toFixed(d));

export const MEDIA_INVESTMENT_POLICY=Object.freeze({
  version:'media-investment-advisor-v1',
  min_sessions:30,min_paid_orders:3,min_roas:1.8,target_roas:2.5,
  min_contribution_margin_rate:0.20,max_refund_rate:0.12,
  max_daily_budget_brl:500,max_scale_step:0.30,min_test_budget_brl:20,
});

function evidenceOf(row={}){
  const sessions=Math.max(0,Math.trunc(Number(row.sessions)||0));
  const paid=Math.max(0,Math.trunc(Number(row.paid)||0));
  const gross=money(row.gross_revenue_brl),refunds=money(row.refunded_brl);
  const spend=money(row.acquisition_spend_brl),fees=money(row.payment_fees_brl),costs=money(row.variable_costs_brl);
  const net=Math.max(0,money(row.net_revenue_brl)||gross-refunds);
  const contribution=net-spend-fees-costs;
  const roas=spend>0?net/spend:null;
  return Object.freeze({sessions,paid,gross_revenue_brl:gross,net_revenue_brl:net,spend_brl:spend,
    paid_rate:sessions?paid/sessions:0,refund_rate:gross?refunds/gross:0,contribution_brl:contribution,
    contribution_margin_rate:net>0?contribution/net:null,roas});
}

export function adviseMediaInvestment({creative={},economics={},current_daily_budget_brl=0,policy=MEDIA_INVESTMENT_POLICY}={}){
  const evidence=evidenceOf({...creative,...economics});
  const current=money(current_daily_budget_brl),blockers=[],riskFlags=[];
  if(evidence.sessions<policy.min_sessions)blockers.push('insufficient_sessions');
  if(evidence.paid<policy.min_paid_orders)blockers.push('insufficient_paid_orders');
  if(!creative.observed_ready)blockers.push('creative_not_observed_ready');
  if(evidence.roas===null)blockers.push('paid_spend_not_observed');
  if(evidence.refund_rate>policy.max_refund_rate)riskFlags.push('refund_rate_too_high');
  if(evidence.contribution_margin_rate!==null&&evidence.contribution_margin_rate<policy.min_contribution_margin_rate)riskFlags.push('contribution_margin_too_low');
  let action='AGUARDAR',reason='evidence_gate_not_met',recommended=0,scale=0;
  if(blockers.length===0){
    if(evidence.roas<1){action='PARAR';reason='roas_below_break_even';}
    else if(evidence.roas<policy.min_roas){action='REDUZIR';reason='roas_below_minimum';recommended=round(current*.7);scale=-.30;}
    else if(riskFlags.length){action='AGUARDAR';reason='risk_gate_blocks_scale';}
    else if(evidence.roas<policy.target_roas){action='MANTER';reason='profitable_but_below_scale_target';recommended=current||policy.min_test_budget_brl;}
    else {action='ESCALAR';reason='elite_scale_gate_met';scale=Math.min(policy.max_scale_step,.10+clamp((evidence.roas-policy.target_roas)/policy.target_roas)*.20);recommended=round(Math.min(policy.max_daily_budget_brl,Math.max(policy.min_test_budget_brl,(current||policy.min_test_budget_brl)*(1+scale))));}
  }
  return Object.freeze({policy_version:policy.version,creative_id:creative.creative_id||creative.spec?.creative_id||'',variant_id:creative.variant_id||creative.spec?.variant_id||'',
    action,reason,recommended_daily_budget_brl:recommended,current_daily_budget_brl:current,scale_change_rate:round(scale,4),
    stop_loss:Object.freeze({roas_floor:policy.min_roas,refund_rate_ceiling:policy.max_refund_rate,contribution_margin_rate_floor:policy.min_contribution_margin_rate}),
    evidence,confidence:round(clamp(Math.min(1,evidence.sessions/120)*.45+Math.min(1,evidence.paid/12)*.35+(creative.observed_ready?.20:0)),4),
    blockers:Object.freeze([...blockers,...riskFlags]),commercial_authorized:false,auto_spend:false,human_approval_required:true});
}
