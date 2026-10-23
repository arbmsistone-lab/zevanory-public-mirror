// WhatsApp readiness only from FRESH persisted Meta truth (fail-closed). Auditor Sol: Meta said
// name_status=DECLINED / code_verification_status=EXPIRED while /api/release sometimes said
// whatsapp_mode="enabled" (warm isolate with a stale onboarding identity flag).
import test from "node:test";
import assert from "node:assert/strict";
import { readTextNormalized } from "./helpers/text.mjs";
import {
  WHATSAPP_META_STATUS_ENV_KEY, WHATSAPP_META_STATUS_KV_KEY, WHATSAPP_META_STATUS_MAX_AGE_MS,
  buildMetaStatusSnapshot, evaluateMetaStatusSnapshot, refreshMetaStatusSnapshot,
  scheduleMetaStatusRefresh, needsMetaStatusRefresh, readMetaStatusSnapshotRaw, withEnvValue,
} from "../worker/whatsapp-meta-truth.mjs";
import { projectLiveStatus, whatsappTransportIsOperational, whatsappTransportVerdict } from "../worker/live-runtime-status.mjs";

const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const HEALTHY_BROKER = Object.freeze({
  broker: true, token_app_id: "1071149631917061",
  permissions: { business_management: true, whatsapp_business_management: true, whatsapp_business_messaging: true },
  number_verified: true, brand_name_verified: true, verified_name: "ZEVANORY",
  name_status: "APPROVED", new_name_status: "NONE", code_verification_status: "VERIFIED", quality_rating: "GREEN",
  reason: "identity_match",
});
const snap = (over = {}, at = NOW - 60_000) => JSON.stringify(buildMetaStatusSnapshot({ ...HEALTHY_BROKER, ...over }, at));
const verdict = (raw, now = NOW) => evaluateMetaStatusSnapshot(raw, { now });

// Behavioural copy of the REAL recovered-worker WhatsApp entry (extracted from the bundle source, which
// cannot be imported under node because of "cloudflare:node").
const RECOVERED = readTextNormalized(new URL("../worker/cloudflare-worker.recovered.mjs", import.meta.url));
function extract(name) {
  const start = RECOVERED.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} missing in recovered worker`);
  const end = RECOVERED.indexOf(`__name(${name}, "${name}");`, start);
  assert.ok(end > start, `${name} end missing`);
  return RECOVERED.slice(start, end);
}
const gatedEntry = new Function("evaluateMetaStatusSnapshot", "WHATSAPP_META_STATUS_ENV_KEY", "process", "__name",
  `${extract("whatsappMetaTruth")}\n${extract("whatsappMetaGatedEntry")}\nreturn whatsappMetaGatedEntry;`)(
  evaluateMetaStatusSnapshot, WHATSAPP_META_STATUS_ENV_KEY, { env: {} }, (f) => f);
// Warm isolate: credentials + onboarding identity flag present => channelReadiness said configured=true.
const WARM_STATE = Object.freeze({ provider: "meta-whatsapp-cloud-api", configured: true, implemented: true, commercial: true, role: "conversation_support" });
const entryFor = (raw) => gatedEntry(WARM_STATE, { profileUrl: null }, { ready: true, target_url: "https://wa.me/x" }, { [WHATSAPP_META_STATUS_ENV_KEY]: raw });
// The bundle evaluates against the real clock: build those snapshots relative to Date.now().
const entryNow = (over = {}, ageMs = 60_000) => entryFor(snap(over, Date.now() - ageMs));

test("DECLINED display name => disabled with meta_name_declined (even in a warm isolate)", () => {
  const raw = snap({ name_status: "DECLINED" });
  const v = verdict(raw);
  assert.equal(v.ready, false);
  assert.equal(v.reason, "meta_name_declined");
  assert.equal(v.name_status, "DECLINED");
  const e = entryNow({ name_status: "DECLINED" });
  assert.equal(e.operational_ready, false);
  assert.equal(e.configured, false);
  assert.equal(e.operational_mode, "blocked");
  assert.equal(e.blocked_reason, "meta_name_declined");
  assert.equal(whatsappTransportIsOperational({ [WHATSAPP_META_STATUS_ENV_KEY]: raw }, { identity_verified: true, access_token: "t", phone_number_id: "p" }, { broker: true, identity_verified: true }, { now: NOW }), false);
  assert.equal(verdict(snap({ name_status: "PENDING_REVIEW" })).reason, "meta_name_not_approved");
  assert.equal(verdict(snap({ name_status: "AVAILABLE_WITHOUT_REVIEW" })).ready, true);
});

test("EXPIRED code verification => disabled with meta_code_verification_expired", () => {
  const raw = snap({ code_verification_status: "EXPIRED" });
  const v = verdict(raw);
  assert.equal(v.ready, false);
  assert.equal(v.reason, "meta_code_verification_expired");
  assert.equal(v.code_verification_status, "EXPIRED");
  assert.equal(entryNow({ code_verification_status: "EXPIRED" }).operational_ready, false);
  assert.equal(entryNow({ code_verification_status: "EXPIRED" }).blocked_reason, "meta_code_verification_expired");
  assert.equal(verdict(snap({ code_verification_status: "NOT_VERIFIED" })).reason, "meta_code_verification_not_verified");
  assert.equal(verdict(snap({ code_verification_status: "" })).reason, "meta_code_verification_not_verified");
});

test("Sol's live Meta truth (DECLINED + EXPIRED) => whatsapp_mode disabled on /api/status projection", () => {
  const env = { [WHATSAPP_META_STATUS_ENV_KEY]: snap({ name_status: "DECLINED", code_verification_status: "EXPIRED" }) };
  const v = whatsappTransportVerdict(env, { now: NOW });
  assert.equal(v.ready, false);
  const status = projectLiveStatus({ runtime: { whatsapp: "enabled" } }, { whatsappTransportOperational: v.ready, whatsappReason: v.reason });
  assert.equal(status.runtime.whatsapp, "disabled");
  assert.equal(status.runtime.whatsapp_reason, "meta_name_declined");
  // A truthy non-boolean never enables.
  assert.equal(projectLiveStatus({}, { whatsappTransportOperational: "yes" }).runtime.whatsapp, "disabled");
});

test("stale snapshot => disabled; the 15-minute bound is exact", () => {
  const max = WHATSAPP_META_STATUS_MAX_AGE_MS;
  assert.equal(max, 15 * 60 * 1000);
  assert.equal(verdict(snap({}, NOW - max)).ready, true);
  const stale = verdict(snap({}, NOW - max - 1000));
  assert.equal(stale.ready, false);
  assert.equal(stale.reason, "meta_snapshot_stale");
  assert.equal(stale.age_seconds, 901);
  assert.equal(entryNow({}, max + 60_000).operational_ready, false);
  assert.equal(entryNow({}, max + 60_000).blocked_reason, "meta_snapshot_stale");
  // Old healthy snapshot in an isolate that previously saw it: still bounded by observed_at.
  assert.equal(whatsappTransportIsOperational({ [WHATSAPP_META_STATUS_ENV_KEY]: snap({}, NOW - max - 1000) }, {}, {}, { now: NOW }), false);
  const future = verdict(snap({}, NOW + 3 * 60_000));
  assert.equal(future.ready, false);
  assert.equal(future.reason, "meta_snapshot_from_future");
  assert.equal(verdict(snap({}, NOW + 60_000)).ready, true);
});

test("cold isolate with no snapshot => disabled, regardless of credential globals", () => {
  for (const raw of [undefined, null, "", "false", "null"]) {
    const v = verdict(raw);
    assert.equal(v.ready, false);
    assert.equal(v.reason, "meta_snapshot_missing");
    assert.equal(entryFor(raw).operational_ready, false);
  }
  assert.equal(whatsappTransportIsOperational({}, { identity_verified: true, access_token: "t", phone_number_id: "p" }, { broker: true, identity_verified: true }), false);
  for (const raw of ["{not json", "[]", JSON.stringify({ observed_at: new Date(NOW).toISOString() }), JSON.stringify({ schema: "zevanory.whatsapp-meta-status.v1", observed_at: "x" })]) {
    assert.equal(verdict(raw).reason, "meta_snapshot_invalid");
  }
});

test("all healthy and fresh => enabled with meta_truth_fresh_healthy", () => {
  const raw = snap();
  const v = verdict(raw);
  assert.equal(v.ready, true);
  assert.equal(v.reason, "meta_truth_fresh_healthy");
  assert.equal(v.observed_at, new Date(NOW - 60_000).toISOString());
  assert.equal(v.age_seconds, 60);
  const e = entryNow();
  assert.equal(e.operational_ready, true);
  assert.equal(e.configured, true);
  assert.equal(e.operational_mode, "provider_api_meta_verified");
  assert.equal(e.blocked_reason, null);
  assert.equal(whatsappTransportIsOperational({ [WHATSAPP_META_STATUS_ENV_KEY]: raw }, {}, {}, { now: NOW }), true);
  const status = projectLiveStatus({}, { whatsappTransportOperational: true });
  assert.equal(status.runtime.whatsapp, "enabled");
  assert.equal(status.runtime.whatsapp_reason, "meta_truth_fresh_healthy");
  assert.equal(verdict(snap({ quality_rating: "YELLOW" })).ready, true);
});

test("token, number, display name, quality and phone status each fail closed", () => {
  const cases = [
    [{ token_app_id: "" }, "meta_token_invalid"],
    [{ permissions: { whatsapp_business_management: true, whatsapp_business_messaging: false } }, "meta_token_invalid"],
    [{ permissions: { whatsapp_business_management: false, whatsapp_business_messaging: true } }, "meta_token_invalid"],
    [{ number_verified: false }, "meta_number_not_official"],
    [{ brand_name_verified: false }, "meta_display_name_mismatch"],
    [{ quality_rating: "RED" }, "meta_quality_not_ok"],
    [{ quality_rating: "UNKNOWN" }, "meta_quality_not_ok"],
    [{ phone_status: "FLAGGED" }, "meta_phone_status_not_connected"],
    [{ broker: false }, "meta_snapshot_unavailable"],
  ];
  for (const [over, reason] of cases) {
    const v = verdict(snap(over));
    assert.equal(v.ready, false, reason);
    assert.equal(v.reason, reason);
  }
  assert.equal(verdict(snap({ phone_status: "CONNECTED" })).ready, true);
});

test("snapshot is a closed whitelist of non-secret fields", () => {
  const s = buildMetaStatusSnapshot({ ...HEALTHY_BROKER, access_token: "EAAG-secret", app_secret: "s3cr3t", two_step_pin: "123456", reason: "Invalid OAuth access token EAAG-secret" }, NOW);
  assert.deepEqual(Object.keys(s).sort(), ["brand_name_verified", "broker_reason", "code_verification_status", "messaging_limit_tier", "name_status", "new_name_status", "number_verified", "observed_at", "phone_status", "quality_rating", "schema", "source", "token_valid"]);
  const text = JSON.stringify(s);
  assert.doesNotMatch(text, /EAAG|s3cr3t|123456/);
  assert.equal(s.broker_reason, "provider_error");
  assert.equal(s.token_valid, true);
});

test("writer persists the sanitized snapshot under the canonical KV key with a bounded TTL", async () => {
  const puts = [];
  const kv = { put: async (k, v, o) => puts.push([k, v, o]) };
  const out = await refreshMetaStatusSnapshot({ ZEVANORY_PRIVATE_ARTIFACTS: kv, WHATSAPP_BROKER: {} }, { now: NOW, fetchStatus: async () => ({ ...HEALTHY_BROKER, name_status: "DECLINED", code_verification_status: "EXPIRED" }) });
  assert.equal(out.written, true);
  assert.equal(out.verdict.ready, false);
  assert.equal(out.verdict.reason, "meta_name_declined");
  assert.equal(puts.length, 1);
  assert.equal(puts[0][0], WHATSAPP_META_STATUS_KV_KEY);
  assert.equal(JSON.parse(puts[0][1]).name_status, "DECLINED");
  assert.equal(JSON.parse(puts[0][1]).observed_at, new Date(NOW).toISOString());
  assert.equal(puts[0][2].expirationTtl, 3600);
  const down = await refreshMetaStatusSnapshot({ ZEVANORY_PRIVATE_ARTIFACTS: kv }, { now: NOW, fetchStatus: async () => null });
  assert.equal(down.snapshot.source, "unavailable");
  assert.equal(down.verdict.reason, "meta_snapshot_unavailable");
  const reads = [];
  assert.equal(await readMetaStatusSnapshotRaw({ get: async (k, o) => { reads.push([k, o]); return "x"; } }), "x");
  assert.deepEqual(reads, [[WHATSAPP_META_STATUS_KV_KEY, { cacheTtl: 60 }]]);
  assert.equal(await readMetaStatusSnapshotRaw({ get: async () => { throw new Error("kv"); } }), "");
  assert.equal(await readMetaStatusSnapshotRaw(null), "");
});

test("opportunistic refresh only when missing/older than 10 min, throttled", () => {
  assert.equal(needsMetaStatusRefresh(snap({}, NOW - 9 * 60_000), { now: NOW }), false);
  assert.equal(needsMetaStatusRefresh(snap({}, NOW - 10 * 60_000), { now: NOW }), true);
  assert.equal(needsMetaStatusRefresh("", { now: NOW }), true);
  const calls = [];
  const ctx = { waitUntil: (p) => calls.push(p) };
  const env = { WHATSAPP_BROKER: { fetch() {} } };
  const memo = { at: 0 };
  const refresh = async () => ({});
  assert.equal(scheduleMetaStatusRefresh(env, ctx, snap({}, NOW - 60_000), { now: NOW, memo, refresh }), false);
  assert.equal(scheduleMetaStatusRefresh(env, ctx, "", { now: NOW, memo, refresh }), true);
  assert.equal(scheduleMetaStatusRefresh(env, ctx, "", { now: NOW + 60_000, memo, refresh }), false);
  assert.equal(scheduleMetaStatusRefresh(env, ctx, "", { now: NOW + 5 * 60_000, memo, refresh }), true);
  assert.equal(calls.length, 2);
  const proxied = withEnvValue(Object.freeze({ A: "1" }), WHATSAPP_META_STATUS_ENV_KEY, "v");
  assert.equal(proxied[WHATSAPP_META_STATUS_ENV_KEY], "v");
  assert.equal(proxied.A, "1");
  assert.deepEqual(Object.entries(proxied).sort(), [["A", "1"], [WHATSAPP_META_STATUS_ENV_KEY, "v"]]);
});

test("wiring: release/status read only the per-request snapshot, never isolate globals", () => {
  const status = extract("publicChannelStatus");
  assert.ok(/if \(name === "whatsapp"\) return \[name, whatsappMetaGatedEntry\(state2, profile2, fallback, env\)\];/.test(status), "wiring regex missing: " + /if \(name === "whatsapp"\) return \[name, whatsappMetaGatedEntry\(state2, profile2, fallback, env\)\];/.source.slice(0, 60));
  const entry = extract("whatsappMetaGatedEntry");
  assert.ok(!/state2\.configured|fallback\.ready|alternate\.|__ZEVANORY_/.test(entry), "wiring regex must not match: " + /state2\.configured|fallback\.ready|alternate\.|__ZEVANORY_/.source.slice(0, 60));
  assert.ok(/whatsappModeReason: whatsappTransport \? "meta_truth_fresh_healthy" : String\(whatsapp\?\.blocked_reason/.test(extract("runtimeReleaseModes")), "wiring regex missing: " + /whatsappModeReason: whatsappTransport \? "meta_truth_fresh_healthy" : String\(whatsapp\?\.blocked_reason/.source.slice(0, 60));
  assert.ok(/whatsapp_mode: runtimeModes\.whatsappMode, whatsapp_mode_reason: runtimeModes\.whatsappModeReason/.test(RECOVERED), "wiring regex missing: " + /whatsapp_mode: runtimeModes\.whatsappMode, whatsapp_mode_reason: runtimeModes\.whatsappModeReason/.source.slice(0, 60));
  assert.ok(/target\[WHATSAPP_META_STATUS_ENV_KEY\] = String\(env\?\.\[WHATSAPP_META_STATUS_ENV_KEY\] \?\? ""\);/.test(extract("hydrateRuntimeConfig")), "wiring regex missing: " + /target\[WHATSAPP_META_STATUS_ENV_KEY\] = String\(env\?\.\[WHATSAPP_META_STATUS_ENV_KEY\] \?\? ""\);/.source.slice(0, 60));
  assert.ok(/if \(key === "whatsapp"\) \{\s*const truth = whatsappMetaTruth\(env\);/.test(extract("commercialDistributionReadiness")), "wiring regex missing: " + /if \(key === "whatsapp"\) \{\s*const truth = whatsappMetaTruth\(env\);/.source.slice(0, 60));
  const compat = readTextNormalized(new URL("../worker/cloudflare-worker.compat.mjs", import.meta.url));
  assert.ok(/if \(whatsappPath \|\| url\.pathname === "\/api\/release" \|\| url\.pathname === "\/api\/config"\) \{\s*const metaRaw = await readMetaStatusSnapshotRaw\(normalized\.ZEVANORY_PRIVATE_ARTIFACTS\);\s*normalized = withEnvValue\(normalized, WHATSAPP_META_STATUS_ENV_KEY, metaRaw\);/.test(compat), "wiring regex missing: " + /if \(whatsappPath \|\| url\.pathname === "\/api\/release" \|\| url\.pathname === "\/api\/config"\) \{\s*const metaRaw = await readMetaStatusSnapshotRaw\(normalized\.ZEVANORY_PRIVATE_ARTIFACTS\);\s*normalized = withEnvValue\(normalized, WHATSAPP_META_STATUS_ENV_KEY, metaRaw\);/.source.slice(0, 60));
  assert.ok(!/whatsappTransportIsOperational\(/.test(compat), "wiring regex must not match: " + /whatsappTransportIsOperational\(/.source.slice(0, 60));
  assert.ok(/const wa = await refreshMetaStatusSnapshot\(normalized\);/.test(compat), "wiring regex missing: " + /const wa = await refreshMetaStatusSnapshot\(normalized\);/.source.slice(0, 60));
});
