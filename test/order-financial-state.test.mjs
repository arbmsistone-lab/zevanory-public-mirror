import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const webhook=await readFile(new URL('../src/http/webhookAsaas.mjs',import.meta.url),'utf8');
const migration=await readFile(new URL('../db/migrations/005_order_financial_states.sql',import.meta.url),'utf8');

test('financial event and order transition share one SQL statement',()=>{
  assert.match(webhook,/WITH target AS/);
  assert.match(webhook,/inserted AS/);
  assert.match(webhook,/updated AS/);
  assert.match(webhook,/UPDATE orders o SET status=CASE/);
});

test('order state transitions distinguish paid partial and full refund',()=>{
  assert.match(webhook,/THEN 'paid'/);
  assert.match(webhook,/THEN 'refunded'/);
  assert.match(webhook,/ELSE 'partially_refunded'/);
  assert.match(webhook,/order_state_invalid/);
});

test('migration 005 authorizes partial refund state and is ledgered',()=>{
  assert.match(migration,/partially_refunded/);
  assert.match(migration,/005_order_financial_states/);
  assert.match(migration,/COMMIT;/);
});
