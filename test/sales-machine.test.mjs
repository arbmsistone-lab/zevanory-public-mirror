import test from 'node:test';
import assert from 'node:assert/strict';
import { MARKET_PARAMETERS } from '../src/marketParameters.mjs';
import { canTransitionSalesStage, buildFollowUpPlan } from '../src/salesPipeline.mjs';
import { calculateUnitEconomics, evaluateEconomicReadiness } from '../src/unitEconomics.mjs';
import { evaluateExperimentLearning } from '../src/learningEngine.mjs';

test('market parameters are sourced and distinguish benchmark from operating target', () => {
  assert.equal(MARKET_PARAMETERS.lead_response.benchmark_max_minutes, 60);
  assert.equal(MARKET_PARAMETERS.lead_response.operating_target_minutes, 5);
  assert.equal(MARKET_PARAMETERS.prospecting.benchmark_touchpoints, 8);
  assert.equal(MARKET_PARAMETERS.checkout.cart_abandonment_market_percent, 70.22);
  assert.equal(MARKET_PARAMETERS.web_vitals.lcp_ms, 2500);
  assert.equal(MARKET_PARAMETERS.web_vitals.inp_ms, 200);
  assert.equal(MARKET_PARAMETERS.web_vitals.cls, 0.1);
  assert.match(MARKET_PARAMETERS.lead_response.source_url, /^https:\/\//);
});

test('sales pipeline allows only canonical forward transitions', () => {
  assert.equal(canTransitionSalesStage('new','contacted'), true);
  assert.equal(canTransitionSalesStage('qualified','offer_sent'), true);
  assert.equal(canTransitionSalesStage('offer_sent','paid'), false);
  assert.equal(canTransitionSalesStage('refunded','paid'), false);
});
test('follow-up plan enforces speed-to-lead and touchpoint ceiling', () => {
  const first=buildFollowUpPlan({stage:'new',touchpoints:0,lastContactAt:'2026-08-26T12:00:00.000Z'});
  assert.equal(first.action,'first_response');
  assert.equal(first.due_at,'2026-08-26T12:05:00.000Z');
  const capped=buildFollowUpPlan({stage:'contacted',touchpoints:8,lastContactAt:'2026-08-26T12:00:00.000Z'});
  assert.equal(capped.action,'close_or_recycle');
});

test('unit economics subtract refunds fees variable cost and acquisition', () => {
  const m=calculateUnitEconomics({gross_revenue_brl:1000,refunds_brl:100,payment_fees_brl:40,variable_costs_brl:200,acquisition_spend_brl:100,paid_orders:2});
  assert.equal(m.net_revenue_brl,900);
  assert.equal(m.contribution_margin_brl,560);
  assert.equal(m.cac_brl,50);
  assert.equal(m.roas,10);
  assert.equal(evaluateEconomicReadiness({gross_revenue_brl:1000,refunds_brl:100,payment_fees_brl:40,variable_costs_brl:200,acquisition_spend_brl:100,paid_orders:2}).ready,true);
});

test('learning remains blocked without real funnel and economics', () => {
  assert.equal(evaluateExperimentLearning({}).learnable,false);
  const ready=evaluateExperimentLearning({sessions:100,qualified_leads:10,paid_orders:2,gross_revenue_brl:994,refunds_brl:0,payment_fees_brl:30,variable_costs_brl:100,acquisition_spend_brl:100});
  assert.equal(ready.learnable,true);
  assert.equal(ready.baseline_only,true);
});
