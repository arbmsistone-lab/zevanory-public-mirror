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
