export const REQUIRED_TABLES = Object.freeze([
  'schema_migrations',
  'telemetry_events',
  'financial_events',
  'orders',
]);

export const REQUIRED_MIGRATIONS = Object.freeze([
  '001_telemetry_events',
  '002_financial_events',
  '003_orders_checkout',
  '004_partial_refund_snapshots',
  '005_order_financial_states',
]);

export function assessSchemaIntegrity({ tableNames = [], migrationIds = [] } = {}) {
  const tables = new Set(tableNames.map(String));
  const migrations = new Set(migrationIds.map(String));
  const missingTables = REQUIRED_TABLES.filter((name) => !tables.has(name));
  const missingMigrations = REQUIRED_MIGRATIONS.filter((id) => !migrations.has(id));
  return Object.freeze({
    ready: missingTables.length === 0 && missingMigrations.length === 0,
    required_tables: REQUIRED_TABLES.length,
    required_migrations: REQUIRED_MIGRATIONS.length,
    missing_tables: Object.freeze(missingTables),
    missing_migrations: Object.freeze(missingMigrations),
  });
}
