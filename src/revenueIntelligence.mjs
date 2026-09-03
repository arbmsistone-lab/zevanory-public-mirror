const money=(v)=>Number.isFinite(Number(v))?Number(v):0;
const count=(v)=>Math.max(0,Math.trunc(Number(v)||0));
const ratio=(a,b)=>b>0?a/b:null;

export function revenueIntelligence(input={}){
  const customers=count(input.customers);
  const paidOrders=count(input.paid_orders);
  const repeatOrders=count(input.repeat_orders);
  const retainedCustomers=count(input.retained_customers);
  const churnedCustomers=count(input.churned_customers);
  const grossRevenue=money(input.gross_revenue_brl);
  const refunds=money(input.refunds_brl);
  const variableCosts=money(input.variable_costs_brl)+money(input.payment_fees_brl)+money(input.acquisition_spend_brl);
  const netRevenue=grossRevenue-refunds;
  const contribution=netRevenue-variableCosts;
  const aov=ratio(netRevenue,paidOrders);
  const purchaseFrequency=ratio(paidOrders,customers);
  const retentionRate=ratio(retainedCustomers,customers);
  const churnRate=ratio(churnedCustomers,customers);
  const repeatPurchaseRate=ratio(repeatOrders,paidOrders);
  const estimatedLtv=(aov!==null&&purchaseFrequency!==null&&retentionRate!==null&&retentionRate<1)
    ? aov*purchaseFrequency*(1/(1-retentionRate)) : null;
  return Object.freeze({customers,paid_orders:paidOrders,net_revenue_brl:netRevenue,contribution_margin_brl:contribution,
    aov_brl:aov,purchase_frequency:purchaseFrequency,retention_rate:retentionRate,churn_rate:churnRate,
    repeat_purchase_rate:repeatPurchaseRate,estimated_ltv_brl:estimatedLtv});
}
export function forecastRevenue(input={}){
  const history=Array.isArray(input.monthly_net_revenue_brl)?input.monthly_net_revenue_brl.map(money):[];
  const minPeriods=Math.max(3,count(input.minimum_periods)||6);
  if(history.length<minPeriods) return Object.freeze({available:false,mode:'baseline_required',forecast_brl:null,reason:'insufficient_history'});
  const recent=history.slice(-Math.min(6,history.length));
  const weighted=recent.reduce((sum,value,index)=>sum+value*(index+1),0);
  const denom=recent.reduce((sum,_v,index)=>sum+(index+1),0);
  return Object.freeze({available:true,mode:'weighted_recent_baseline',forecast_brl:weighted/denom,periods_used:recent.length});
}

export function nextBestRevenueAction(input={}){
  const metrics=revenueIntelligence(input);
  const candidates=[];
  if(metrics.churn_rate!==null&&metrics.churn_rate>0.1) candidates.push({action:'reduce_churn',priority:100,reason:'churn_rate'});
  if(metrics.repeat_purchase_rate!==null&&metrics.repeat_purchase_rate<0.2) candidates.push({action:'increase_repurchase',priority:80,reason:'repeat_purchase_rate'});
  if(metrics.contribution_margin_brl<=0) candidates.push({action:'protect_margin',priority:95,reason:'non_positive_contribution'});
  if(metrics.customers===0) candidates.push({action:'acquire_first_customers',priority:90,reason:'no_customers'});
  if(candidates.length===0) candidates.push({action:'optimize_best_channel',priority:50,reason:'stable_baseline'});
  candidates.sort((a,b)=>b.priority-a.priority);
  return Object.freeze({...candidates[0],metrics});
}
