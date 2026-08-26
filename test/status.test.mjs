import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOperationalStatus } from '../src/operationalStatus.mjs';

const status = buildOperationalStatus({
  telemetry: [
    { event_name: 'page_view', count: 12 },
    { event_name: 'lead_qualified', count: 2 },
    { event_name: 'checkout_started', count: 1 },
  ],
  orders: [{ status: 'created', count: 1 }],
  financial: [{ normalized_event: 'payment_confirmed', count: 0 }],
  pipeline: [],
  actions: [],
  lastEventAt: '2026-08-23T16:20:50.516Z',
});

test('operational status separates technical readiness from commercial approval', () => {
  assert.equal(status.gate, 'G2');
  assert.equal(status.engine.technical_infrastructure, 'approved');
  assert.equal(status.engine.commercial_autonomy, 'not_approved');
  assert.equal(status.sales_machine.structure_ready, true);
  assert.equal(status.sales_machine.outbound_execution, 'blocked');
});
test('operational status exposes only aggregate evidence counts', () => {
  assert.deepEqual(status.metrics, {
    page_views: 12,
    leads_qualified: 2,
    offers_sent: 0,
    checkouts_started: 1,
    orders: 1,
    payments_confirmed: 0,
    refunds_confirmed: 0,
    pipeline_open: 0,
    actions_scheduled: 0,
  });
  assert.equal(JSON.stringify(status).includes('phone'), false);
  assert.equal(JSON.stringify(status).includes('session_id'), false);
});
