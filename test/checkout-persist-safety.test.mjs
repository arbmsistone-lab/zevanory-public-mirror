import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../api/checkout/asaas.mjs', import.meta.url), 'utf8');

test('checkout success requires persisted checkout_ready row', () => {
  assert.match(source, /UPDATE orders SET status='checkout_ready'/);
  assert.match(source, /RETURNING order_id/);
  assert.match(source, /persisted\.length!==1/);
  assert.match(source, /checkout_persist_failed/);
  const persistedCheck = source.indexOf('persisted.length!==1');
  const success = source.indexOf('return json(res,201');
  assert.ok(persistedCheck > 0 && success > persistedCheck);
});
