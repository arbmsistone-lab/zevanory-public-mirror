import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const snapshot=fs.readFileSync('src/lifecycleEvidenceSnapshot.mjs','utf8');

test('reconciliation cannot be satisfied by refunds or unrelated financial events',()=>{
  assert.match(snapshot,/Math\.max\(financialMap\.payment_confirmed\|\|0,directEvidence\.reconciliation\|\|0\)/);
  assert.doesNotMatch(snapshot,/reconciled_payments:Object\.values\(financialMap\)/);
});

test('scale counts only paid orders from positive contribution snapshots',()=>{
  assert.match(snapshot,/gross_revenue_brl-refunds_brl-payment_fees_brl-variable_costs_brl-acquisition_spend_brl\)>0/);
  assert.match(snapshot,/profitable_paid_orders/);
  assert.doesNotMatch(snapshot,/profitable_paid_orders:0/);
});

test('paid-order certification cannot be inflated by overlapping economics snapshots',()=>{
  assert.match(snapshot,/const paidOrders=orderMap\.paid\|\|0/);
  assert.doesNotMatch(snapshot,/Math\.max\(orderMap\.paid/);
  assert.doesNotMatch(snapshot,/sum\(paid_orders\)/i);
  assert.match(snapshot,/max\(case when \(gross_revenue_brl-refunds_brl-payment_fees_brl-variable_costs_brl-acquisition_spend_brl\)>0 then paid_orders else 0 end\)/i);
});

test('fulfillment operator proof requires a paid provider-reconciled order',()=>{
  const operator=fs.readFileSync('api/events-operator.mjs','utf8');
  assert.match(operator,/name==='fulfillment_confirmed'/);
  assert.match(operator,/o\.status='paid'/);
  assert.match(operator,/f\.normalized_event='payment_confirmed'/);
  assert.match(operator,/paid_reconciled_order_required/);
});
test('historical qualification offer and checkout evidence survives pipeline advancement',()=>{
  assert.match(snapshot,/qualified_leads:Math\.max\(leadMap\.qualified\|\|0,directEvidence\.qualification\|\|0\)/);
  assert.match(snapshot,/offer_sent:Math\.max\(leadMap\.offer_sent\|\|0,directEvidence\.offer\|\|0\)/);
  assert.match(snapshot,/checkout_started:Math\.max\(leadMap\.checkout_started\|\|0,directEvidence\.checkout\|\|0\)/);
});
