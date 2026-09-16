import test from 'node:test';
import assert from 'node:assert/strict';
import {adviseMediaInvestment,MEDIA_INVESTMENT_POLICY} from '../src/mediaInvestmentAdvisor.mjs';

const winner={creative_id:'cr-1',variant_id:'v1',observed_ready:true,sessions:120,paid:12,gross_revenue_brl:1200,refunded_brl:0};

test('elite winner scales only with proven profitable economics',()=>{
  const r=adviseMediaInvestment({creative:winner,economics:{net_revenue_brl:1200,acquisition_spend_brl:300,payment_fees_brl:40,variable_costs_brl:60},current_daily_budget_brl:100});
  assert.equal(r.action,'ESCALAR');
  assert.ok(r.recommended_daily_budget_brl>100);
  assert.ok(r.recommended_daily_budget_brl<=130);
  assert.equal(r.auto_spend,false);
  assert.equal(r.human_approval_required,true);
  assert.equal(r.commercial_authorized,false);
  assert.equal(r.blockers.length,0);
});

test('insufficient evidence never receives investment recommendation',()=>{
  const r=adviseMediaInvestment({creative:{...winner,observed_ready:false,sessions:10,paid:1},economics:{net_revenue_brl:500,acquisition_spend_brl:100},current_daily_budget_brl:50});
  assert.equal(r.action,'AGUARDAR');
  assert.equal(r.recommended_daily_budget_brl,0);
  assert.ok(r.blockers.includes('insufficient_sessions'));
  assert.ok(r.blockers.includes('creative_not_observed_ready'));
});
test('bad ROAS reduces budget and protects downside',()=>{
  const r=adviseMediaInvestment({creative:winner,economics:{net_revenue_brl:500,acquisition_spend_brl:400,payment_fees_brl:20,variable_costs_brl:20},current_daily_budget_brl:100});
  assert.equal(r.action,'REDUZIR');
  assert.equal(r.recommended_daily_budget_brl,70);
  assert.equal(r.scale_change_rate,-0.3);
});

test('negative economics stop spend',()=>{
  const r=adviseMediaInvestment({creative:winner,economics:{net_revenue_brl:200,acquisition_spend_brl:300},current_daily_budget_brl:100});
  assert.equal(r.action,'PARAR');
  assert.equal(r.recommended_daily_budget_brl,0);
});

test('refund and margin gates fail closed',()=>{
  const r=adviseMediaInvestment({creative:{...winner,refunded_brl:240},economics:{net_revenue_brl:960,acquisition_spend_brl:300,payment_fees_brl:200,variable_costs_brl:400},current_daily_budget_brl:100});
  assert.equal(r.action,'AGUARDAR');
  assert.ok(r.blockers.includes('refund_rate_too_high'));
  assert.ok(r.blockers.includes('contribution_margin_too_low'));
});

test('policy caps scale step and daily budget',()=>{
  const r=adviseMediaInvestment({creative:winner,economics:{net_revenue_brl:10000,acquisition_spend_brl:100,payment_fees_brl:0,variable_costs_brl:0},current_daily_budget_brl:490});
  assert.equal(r.action,'ESCALAR');
  assert.ok(r.scale_change_rate<=MEDIA_INVESTMENT_POLICY.max_scale_step);
  assert.equal(r.recommended_daily_budget_brl,MEDIA_INVESTMENT_POLICY.max_daily_budget_brl);
});
