import test from 'node:test';
import assert from 'node:assert/strict';
import { assessSchemaIntegrity, REQUIRED_TABLES, REQUIRED_MIGRATIONS } from '../src/schemaHealth.mjs';

test('schema integrity ready with all required objects', () => {
  const r = assessSchemaIntegrity({ tableNames: REQUIRED_TABLES, migrationIds: REQUIRED_MIGRATIONS });
  assert.equal(r.ready, true);
  assert.deepEqual(r.missing_tables, []);
  assert.deepEqual(r.missing_migrations, []);
});

test('schema integrity fails closed on missing table', () => {
  const r = assessSchemaIntegrity({ tableNames: REQUIRED_TABLES.filter(x => x !== 'orders'), migrationIds: REQUIRED_MIGRATIONS });
  assert.equal(r.ready, false);
  assert.deepEqual(r.missing_tables, ['orders']);
});

test('schema integrity fails closed on missing migration', () => {
  const r = assessSchemaIntegrity({ tableNames: REQUIRED_TABLES, migrationIds: REQUIRED_MIGRATIONS.filter(x => x !== '005_order_financial_states') });
  assert.equal(r.ready, false);
  assert.deepEqual(r.missing_migrations, ['005_order_financial_states']);
});
