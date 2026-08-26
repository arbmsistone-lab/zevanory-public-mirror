const money=(value)=>Number.isFinite(Number(value)) ? Number(value) : 0;

export function calculateUnitEconomics(input={}) {
  const grossRevenue=money(input.gross_revenue_brl);
  const refunds=money(input.refunds_brl);
  const paymentFees=money(input.payment_fees_brl);
  const variableCosts=money(input.variable_costs_brl);
  const acquisitionSpend=money(input.acquisition_spend_brl);
  const paidOrders=Math.max(0,Math.trunc(money(input.paid_orders)));
  const netRevenue=grossRevenue-refunds;
  const contributionMargin=netRevenue-paymentFees-variableCosts-acquisitionSpend;
  const contributionMarginPct=netRevenue>0 ? contributionMargin/netRevenue : null;
  const cac=paidOrders>0 ? acquisitionSpend/paidOrders : null;
  const roas=acquisitionSpend>0 ? grossRevenue/acquisitionSpend : null;
  return Object.freeze({
    gross_revenue_brl:grossRevenue,
    net_revenue_brl:netRevenue,
    contribution_margin_brl:contributionMargin,
    contribution_margin_pct:contributionMarginPct,
    cac_brl:cac,
    roas,
    paid_orders:paidOrders,
  });
}
export function evaluateEconomicReadiness(metrics={}) {
  const m=calculateUnitEconomics(metrics);
  const blockers=[];
  if (m.paid_orders < 1) blockers.push('no_paid_orders');
  if (!(m.net_revenue_brl > 0)) blockers.push('no_positive_net_revenue');
  if (!(m.contribution_margin_brl > 0)) blockers.push('non_positive_contribution_margin');
  if (m.cac_brl !== null && m.cac_brl >= m.net_revenue_brl/Math.max(1,m.paid_orders)) blockers.push('cac_not_recovered_by_order_value');
  return Object.freeze({
    ready:blockers.length===0,
    metrics:m,
    blockers:Object.freeze(blockers),
  });
}
