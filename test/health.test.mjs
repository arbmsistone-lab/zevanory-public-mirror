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
    schemaReady: true,
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

test('health recognizes only the bounded certification-pilot switch pattern', () => {
  const env={DATABASE_URL:'x',PUBLIC_BASE_URL:'https://zevanory.api.br',CERTIFICATION_PILOT_ENABLED:'true',
    SALE_GLOBALLY_ENABLED:'false',PRE_SALE_GATES_APPROVED:'false',CHECKOUT_ENABLED:'true',
    WHATSAPP_SALES_ENABLED:'false',FINANCIAL_EVENTS_ENABLED:'true'};
  const health=buildSystemHealth({env,databaseReachable:true,schemaReady:true});
  assert.equal(health.ready,true);
  assert.equal(health.mode,'certification-pilot');
  assert.equal(health.checks.public_sales_locked,true);
  assert.equal(health.checks.certification_pilot_safe,true);
  const unsafe=buildSystemHealth({env:{...env,SALE_GLOBALLY_ENABLED:'true'},databaseReachable:true,schemaReady:true});
  assert.equal(unsafe.ready,false);
  assert.equal(unsafe.checks.certification_pilot_safe,false);
});
