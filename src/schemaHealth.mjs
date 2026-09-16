export const REQUIRED_TABLES = Object.freeze([
  'nuvemshop_oauth_sessions','nuvemshop_pending_credentials','nuvemshop_connections','nuvemshop_webhook_receipts','schema_migrations','telemetry_events','financial_events','orders',
  'sales_leads','sales_actions','unit_economics_snapshots',
  'affiliate_commissions','service_fulfillment','artifact_download_tokens',
  'agent_jobs','agent_runs','knowledge_documents','agent_memory','agent_tool_audit','product_support_cases',
  'integration_outbox','agent_control_state','agent_approvals',
  'customer_lifecycle_profiles','customer_lifecycle_events','attribution_touchpoints','lifecycle_evidence_events','lifecycle_certification_artifacts','certification_pilot_invites','provider_oauth_credentials','intelligence_snapshots','media_spend_events','tenants','tenant_memberships','customer_identities','customer_feature_snapshots','decision_experiments','decision_assignments','journey_instances',
]);

export const REQUIRED_MIGRATIONS = Object.freeze([
  '027_nuvemshop_integration_security','001_telemetry_events','002_financial_events','003_orders_checkout',
  '004_partial_refund_snapshots','005_order_financial_states','006_sales_machine',
  '007_no_inventory_commerce','008_autonomous_revenue_engine','009_composable_infrastructure',
  '010_payment_provider_abstraction','011_agent_control_and_trace','012_sales_lifecycle_v2','013_lifecycle_evidence_certification','014_lifecycle_evidence_trust','015_lifecycle_certification_provenance','016_certification_pilot','017_mercadolivre_oauth','018_tiktok_oauth','019_tiktok_sandbox_provider','020_private_artifact_delivery','021_linkedin_nuvemshop_oauth','022_nuvemshop_nonexpiring_token','023_youtube_identity_oauth','024_market_product_intelligence','025_commercial_engine_v2','026_media_investment_telemetry','028_elite_product_support',
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
