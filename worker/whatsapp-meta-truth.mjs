// ZEVANORY | WhatsApp readiness only from FRESH Meta truth (fail-closed).
//
// Before: whatsapp.operational_ready (=> /api/release whatsapp_mode, /api/status runtime.whatsapp)
// came from isolate-local globals (__ZEVANORY_WHATSAPP_RUNTIME__.identity_verified, a one-shot flag
// stored at onboarding time, and __ZEVANORY_WHATSAPP_BROKER_STATE__) that are only loaded by some
// routes. A warm isolate answered "enabled" while Meta said name_status=DECLINED and
// code_verification_status=EXPIRED; a cold isolate answered "disabled".
//
// Now: the only accepted source is a persisted snapshot of the Meta phone-number node (read by the
// credential broker through the Graph API), stored in KV with observed_at. It is ready only when the
// snapshot is recent (<= 15 min), the token is valid, the number/display name match, the name is
// approved, the code verification is VERIFIED and the quality rating is acceptable. Anything else is
// "disabled" with an explicit, non-sensitive reason code. No token, PIN or secret is ever stored here.

export const WHATSAPP_META_STATUS_KV_KEY = "whatsapp:meta-status:v1";
export const WHATSAPP_META_STATUS_ENV_KEY = "WHATSAPP_META_STATUS_SNAPSHOT";
export const WHATSAPP_META_STATUS_SCHEMA = "zevanory.whatsapp-meta-status.v1";
export const WHATSAPP_META_STATUS_MAX_AGE_MS = 15 * 60 * 1000;
export const WHATSAPP_META_STATUS_REFRESH_AFTER_MS = 10 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 2 * 60 * 1000;
const KV_EXPIRATION_S = 60 * 60;
const BROKER_STATUS_URL = "https://whatsapp-broker.internal/broker/status";

export const ACCEPTED_NAME_STATUS = Object.freeze(["APPROVED", "AVAILABLE_WITHOUT_REVIEW"]);
export const ACCEPTED_CODE_VERIFICATION = Object.freeze(["VERIFIED"]);
// "NA" = not yet rated (low-volume/new number, a normal Meta value); RED/UNKNOWN/empty fail closed.
export const ACCEPTED_QUALITY = Object.freeze(["GREEN", "YELLOW", "NA"]);
export const ACCEPTED_PHONE_STATUS = Object.freeze(["CONNECTED"]);

const upper = (v, max = 60) => String(v ?? "").trim().slice(0, max).toUpperCase().replace(/[^A-Z0-9_]/g, "");
const reasonCode = (v) => {
  const s = String(v ?? "").trim().toLowerCase();
  return /^[a-z0-9_]{1,80}$/.test(s) ? s : (s ? "provider_error" : "");
};

// Sanitize the broker's /broker/status body (live Graph read) into a secret-free snapshot.
export function buildMetaStatusSnapshot(brokerStatus, now = Date.now()) {
  const s = brokerStatus && typeof brokerStatus === "object" ? brokerStatus : {};
  const perms = s.permissions && typeof s.permissions === "object" ? s.permissions : {};
  const live = s.broker === true;
  return Object.freeze({
    schema: WHATSAPP_META_STATUS_SCHEMA,
    observed_at: new Date(now).toISOString(),
    source: live ? "broker_live_graph" : "unavailable",
    token_valid: live && Boolean(String(s.token_app_id || "").trim())
      && perms.whatsapp_business_messaging === true && perms.whatsapp_business_management === true,
    number_verified: s.number_verified === true,
    brand_name_verified: s.brand_name_verified === true,
    name_status: upper(s.name_status),
    new_name_status: upper(s.new_name_status),
    code_verification_status: upper(s.code_verification_status),
    quality_rating: upper(s.quality_rating),
    phone_status: upper(s.phone_status ?? s.status) || null,
    messaging_limit_tier: upper(s.messaging_limit_tier) || null,
    broker_reason: reasonCode(s.reason) || null,
  });
}

function parse(raw) {
  if (raw && typeof raw === "object") return raw;
  const text = String(raw ?? "").trim();
  if (!text || text === "false" || text === "null") return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

// Pure verdict. `raw` is the KV string (or object). Unknown/missing/stale => not ready.
export function evaluateMetaStatusSnapshot(raw, { now = Date.now(), maxAgeMs = WHATSAPP_META_STATUS_MAX_AGE_MS } = {}) {
  const snap = parse(raw);
  const verdict = (ready, reason, extra = {}) => Object.freeze({
    ready,
    reason,
    source: "persisted_meta_snapshot",
    max_age_seconds: Math.round(maxAgeMs / 1000),
    observed_at: null,
    age_seconds: null,
    name_status: null,
    code_verification_status: null,
    quality_rating: null,
    ...extra,
  });
  if (snap === null) return verdict(false, "meta_snapshot_missing");
  if (snap === undefined || snap.schema !== WHATSAPP_META_STATUS_SCHEMA) return verdict(false, "meta_snapshot_invalid");
  const at = Date.parse(String(snap.observed_at || ""));
  if (!Number.isFinite(at)) return verdict(false, "meta_snapshot_invalid");
  const facts = {
    observed_at: new Date(at).toISOString(),
    age_seconds: Math.round((now - at) / 1000),
    name_status: upper(snap.name_status) || null,
    code_verification_status: upper(snap.code_verification_status) || null,
    quality_rating: upper(snap.quality_rating) || null,
  };
  if (at - now > MAX_FUTURE_SKEW_MS) return verdict(false, "meta_snapshot_from_future", facts);
  if (now - at > maxAgeMs) return verdict(false, "meta_snapshot_stale", facts);
  if (snap.source !== "broker_live_graph") return verdict(false, "meta_snapshot_unavailable", facts);
  if (snap.token_valid !== true) return verdict(false, "meta_token_invalid", facts);
  if (snap.number_verified !== true) return verdict(false, "meta_number_not_official", facts);
  if (snap.brand_name_verified !== true) return verdict(false, "meta_display_name_mismatch", facts);
  const name = upper(snap.name_status);
  if (!ACCEPTED_NAME_STATUS.includes(name)) return verdict(false, name === "DECLINED" ? "meta_name_declined" : "meta_name_not_approved", facts);
  const code = upper(snap.code_verification_status);
  if (!ACCEPTED_CODE_VERIFICATION.includes(code)) return verdict(false, code === "EXPIRED" ? "meta_code_verification_expired" : "meta_code_verification_not_verified", facts);
  if (!ACCEPTED_QUALITY.includes(upper(snap.quality_rating))) return verdict(false, "meta_quality_not_ok", facts);
  const phoneStatus = upper(snap.phone_status);
  if (phoneStatus && !ACCEPTED_PHONE_STATUS.includes(phoneStatus)) return verdict(false, "meta_phone_status_not_connected", facts);
  return verdict(true, "meta_truth_fresh_healthy", facts);
}

export async function readMetaStatusSnapshotRaw(kv) {
  if (!kv?.get) return "";
  try {
    return String((await kv.get(WHATSAPP_META_STATUS_KV_KEY, { cacheTtl: 60 })) ?? "");
  } catch {
    return "";
  }
}

async function fetchBrokerStatus(binding) {
  if (!binding?.fetch) return null;
  try {
    const r = await binding.fetch(new Request(BROKER_STATUS_URL, {
      headers: { "x-zevanory-internal": "service-binding" },
      signal: AbortSignal.timeout(15000),
    }));
    if (!r.ok) return null;
    const body = await r.json().catch(() => null);
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

// Writer: reads the broker's live Graph view and persists the sanitized snapshot. An unavailable
// broker is recorded too (source "unavailable"), so the status says why instead of going silent.
export async function refreshMetaStatusSnapshot(env, { now = Date.now(), fetchStatus = fetchBrokerStatus } = {}) {
  const kv = env?.ZEVANORY_PRIVATE_ARTIFACTS;
  const snapshot = buildMetaStatusSnapshot(await fetchStatus(env?.WHATSAPP_BROKER), now);
  let written = false;
  if (kv?.put) {
    try {
      await kv.put(WHATSAPP_META_STATUS_KV_KEY, JSON.stringify(snapshot), { expirationTtl: KV_EXPIRATION_S });
      written = true;
    } catch { written = false; }
  }
  return Object.freeze({ written, snapshot, verdict: evaluateMetaStatusSnapshot(snapshot, { now }) });
}

// Opportunistic refresh between crons (crons run at :00/:05/:15/:35/:45, so a 15-min window alone
// would leave gaps). The isolate-local memo below only avoids duplicate refreshes; readiness itself
// never reads it.
const refreshMemo = globalThis.__ZEVANORY_WA_META_REFRESH__ || (globalThis.__ZEVANORY_WA_META_REFRESH__ = { at: 0 });
export function needsMetaStatusRefresh(raw, { now = Date.now() } = {}) {
  const v = evaluateMetaStatusSnapshot(raw, { now, maxAgeMs: Number.MAX_SAFE_INTEGER });
  if (v.reason === "meta_snapshot_missing" || v.reason === "meta_snapshot_invalid" || v.observed_at === null) return true;
  return now - Date.parse(v.observed_at) >= WHATSAPP_META_STATUS_REFRESH_AFTER_MS;
}
export function scheduleMetaStatusRefresh(env, ctx, raw, { now = Date.now(), memo = refreshMemo, refresh = refreshMetaStatusSnapshot } = {}) {
  if (!ctx?.waitUntil || !env?.WHATSAPP_BROKER?.fetch || !needsMetaStatusRefresh(raw, { now })) return false;
  if (now - memo.at < 5 * 60 * 1000) return false;
  memo.at = now;
  ctx.waitUntil(refresh(env, { now }).catch(() => null));
  return true;
}

// Overlay one string key on an env without mutating it (frozen env safe).
export function withEnvValue(base, key, value) {
  const own = (k) => k === key;
  return new Proxy({}, {
    get(_t, prop) { return own(prop) ? value : Reflect.get(base, prop); },
    has(_t, prop) { return own(prop) || Reflect.has(base, prop); },
    ownKeys() { return [...new Set([...Reflect.ownKeys(base), key])]; },
    getOwnPropertyDescriptor(_t, prop) {
      if (own(prop)) return { value, enumerable: true, configurable: true, writable: false };
      const d = Reflect.getOwnPropertyDescriptor(base, prop);
      return d ? { ...d, configurable: true } : undefined;
    },
  });
}
