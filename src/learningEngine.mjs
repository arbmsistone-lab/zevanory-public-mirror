import { evaluateEconomicReadiness } from './unitEconomics.mjs';

export function evaluateExperimentLearning(input={}) {
  const sessions=Math.max(0,Math.trunc(Number(input.sessions)||0));
  const qualifiedLeads=Math.max(0,Math.trunc(Number(input.qualified_leads)||0));
  const paidOrders=Math.max(0,Math.trunc(Number(input.paid_orders)||0));
  const economics=evaluateEconomicReadiness(input);
  const blockers=[];
  if (sessions < 1) blockers.push('no_observed_sessions');
  if (qualifiedLeads < 1) blockers.push('no_qualified_leads');
  if (paidOrders < 1) blockers.push('no_paid_orders');
  if (!economics.ready) blockers.push('economics_not_ready');
  const sessionToLead=sessions>0 ? qualifiedLeads/sessions : null;
  const leadToPaid=qualifiedLeads>0 ? paidOrders/qualifiedLeads : null;
  return Object.freeze({
    learnable:blockers.length===0,
    baseline_only:true,
    rates:Object.freeze({session_to_qualified:sessionToLead,qualified_to_paid:leadToPaid}),
    economics,
    blockers:Object.freeze(blockers),
  });
}
