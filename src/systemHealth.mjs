import { RELEASE } from './release.mjs';

const SWITCHES = Object.freeze([
  'SALE_GLOBALLY_ENABLED',
  'PRE_SALE_GATES_APPROVED',
  'CHECKOUT_ENABLED',
  'WHATSAPP_SALES_ENABLED',
  'FINANCIAL_EVENTS_ENABLED',
]);

const enabled = (value) => String(value || '').toLowerCase() === 'true';

export function buildSystemHealth({ env = process.env, databaseReachable = false, schemaReady = false } = {}) {
  const publicBaseUrl = String(env.PUBLIC_BASE_URL || '').trim();
  const publicBaseUrlValid = /^https:\/\/zevanory\.api\.br\/?$/i.test(publicBaseUrl);
  const switches = Object.fromEntries(SWITCHES.map((key) => [key, enabled(env[key])]));
  const commercialSafetyLocked = Object.values(switches).every((value) => value === false);
  const storageConfigured = Boolean(String(env.DATABASE_URL || '').trim());
  const ready = storageConfigured && databaseReachable && schemaReady && publicBaseUrlValid && commercialSafetyLocked;

  return Object.freeze({
    service: 'ZEVANORY',
    mode: 'structure-only',
    release_id: RELEASE.id,
    live: true,
    ready,
    checks: Object.freeze({
      storage_configured: storageConfigured,
      database_reachable: databaseReachable,
      schema_ready: schemaReady,
      public_base_url_valid: publicBaseUrlValid,
      commercial_safety_locked: commercialSafetyLocked,
    }),
    commercial_switches: Object.freeze(switches),
  });
}
