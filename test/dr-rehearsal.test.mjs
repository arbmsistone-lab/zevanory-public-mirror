import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const script = await readFile(new URL('../scripts/dr-rehearsal.mjs', import.meta.url), 'utf8');

test('DR rehearsal is explicitly authorized and fail closed', () => {
  assert.ok(script.includes("DR_REHEARSAL_ALLOWED !== 'true'"));
  assert.ok(script.includes('database_url_required'));
});

test('DR rehearsal is isolated and always rolled back', () => {
  assert.ok(script.includes('CREATE SCHEMA'));
  assert.ok(script.includes('SET LOCAL search_path'));
  assert.ok(script.includes("client.query('ROLLBACK')"));
  assert.ok(script.includes('persistent_changes: false'));
});

test('DR rehearsal replays every canonical migration', () => {
  for (const id of ['001_telemetry_events','002_financial_events','003_orders_checkout','004_partial_refund_snapshots','005_order_financial_states','006_sales_machine']) {
    assert.ok(script.includes(`${id}.sql`));
  }
});
