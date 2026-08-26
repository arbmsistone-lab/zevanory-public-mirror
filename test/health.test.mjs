import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemHealth } from '../src/systemHealth.mjs';

test('structure health is ready only with storage, official URL and all commercial switches off', () => {
  const health = buildSystemHealth({
    env: {
      DATABASE_URL: 'postgres://configured',
      PUBLIC_BASE_URL: 'https://zevanory.api.br',
      SALE_GLOBALLY_ENABLED: 'false',
      PRE_SALE_GATES_APPROVED: 'false',
      CHECKOUT_ENABLED: 'false',
      WHATSAPP_SALES_ENABLED: 'false',
      FINANCIAL_EVENTS_ENABLED: 'false',
    },
    databaseReachable: true,
  });
  assert.equal(health.mode, 'structure-only');
  assert.equal(health.ready, true);
  assert.equal(health.checks.commercial_safety_locked, true);
});

test('structure health fails closed if any commercial switch is enabled', () => {
  const health = buildSystemHealth({ env: { DATABASE_URL:'x', PUBLIC_BASE_URL:'https://zevanory.api.br', CHECKOUT_ENABLED:'true' }, databaseReachable:true });
  assert.equal(health.ready, false);
  assert.equal(health.checks.commercial_safety_locked, false);
});
