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
  const publicSafetyLocked = Object.values(switches).every((value) => value === false);
  const pilotSafetyLocked = enabled(env.CERTIFICATION_PILOT_ENABLED) && !switches.SALE_GLOBALLY_ENABLED && !switches.PRE_SALE_GATES_APPROVED && switches.CHECKOUT_ENABLED && !switches.WHATSAPP_SALES_ENABLED && switches.FINANCIAL_EVENTS_ENABLED;
  const commercialSafetyLocked = publicSafetyLocked || pilotSafetyLocked;
  const storageConfigured = Boolean(String(env.DATABASE_URL || '').trim());
  const ready = storageConfigured && databaseReachable && schemaReady && publicBaseUrlValid && commercialSafetyLocked;

  return Object.freeze({
    service: 'ZEVANORY',
    mode: pilotSafetyLocked ? 'certification-pilot' : 'structure-only',
    release_id: RELEASE.id,
    live: true,
    ready,
    checks: Object.freeze({
      storage_configured: storageConfigured,
      database_reachable: databaseReachable,
      schema_ready: schemaReady,
      public_base_url_valid: publicBaseUrlValid,
      commercial_safety_locked: commercialSafetyLocked,
      public_sales_locked: !switches.SALE_GLOBALLY_ENABLED,
      certification_pilot_safe: pilotSafetyLocked,
    }),
    commercial_switches: Object.freeze(switches),
  });
}
