export const REQUIRED_TABLES = Object.freeze([
  'schema_migrations','telemetry_events','financial_events','orders',
  'sales_leads','sales_actions','unit_economics_snapshots',
  'affiliate_commissions','service_fulfillment',
  'agent_jobs','agent_runs','knowledge_documents','agent_memory','agent_tool_audit',
  'integration_outbox','agent_control_state','agent_approvals',
  'customer_lifecycle_profiles','customer_lifecycle_events','attribution_touchpoints','lifecycle_evidence_events','lifecycle_certification_artifacts',
]);

export const REQUIRED_MIGRATIONS = Object.freeze([
  '001_telemetry_events','002_financial_events','003_orders_checkout',
  '004_partial_refund_snapshots','005_order_financial_states','006_sales_machine',
  '007_no_inventory_commerce','008_autonomous_revenue_engine','009_composable_infrastructure',
  '010_payment_provider_abstraction','011_agent_control_and_trace','012_sales_lifecycle_v2','013_lifecycle_evidence_certification','014_lifecycle_evidence_trust','015_lifecycle_certification_provenance',
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
