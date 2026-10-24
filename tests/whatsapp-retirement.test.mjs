// ZEVANORY | WhatsApp channel retired (Meta permanently disabled WABA 4019600665012911 on 2026-10-10).
// Guardrails for the fail-closed shutdown:
//   * WHATSAPP_CHANNEL_RETIRED defaults to retired; only the literal "false" re-enables code paths.
//   * With the channel retired, the REAL compat Worker (bundle loaded through tests/t4_sim/hooks.mjs)
//     makes no request to graph.facebook.com or to the broker from any status/health/continuity/
//     control-plane/voice/webhook/config path (spy on fetch and on the WHATSAPP_BROKER binding).
//   * The Meta webhook acknowledges WhatsApp deliveries with 200 and stores no message content.
//   * Onboarding and the synthetic "delivery proof" are 410; the broker is a 410 tombstone.
//   * No automated reply path (instant reply, sender, voice upload, media download, outbound adapter).
//   * Status: whatsapp_mode/runtime.whatsapp = "disabled_permanent"; never counted in quorum/health.
//   * Static: no forged/self-signed Meta webhook generator anywhere outside tests/.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import { register } from "node:module";
import { existsSync } from "node:fs";
import { readTextNormalized } from "./helpers/text.mjs";
import { execFileSync } from "node:child_process";
import * as R from "../worker/whatsapp-retirement.mjs";
import { projectLiveStatus } from "../worker/live-runtime-status.mjs";
import { buildContinuityPlan } from "../worker/continuity-router.mjs";
import brokerWorker from "../worker/whatsapp-credential-broker.mjs";
import { handleWhatsappOnboarding } from "../worker/whatsapp-onboarding.mjs";

const ROOT = new URL("../", import.meta.url);
const read = (p) => readTextNormalized(new URL(p, ROOT));
const BUNDLE = read("worker/cloudflare-worker.recovered.mjs");
const WA_TEXT = "quanto custa o combo retirement-probe";
const WA_FROM = "5511987650000";
const waPayload = (extra = "") => JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "4019600665012911", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "1300972319774588" }, messages: [{ from: WA_FROM, id: "wamid.retirement-probe", timestamp: "1", type: "text", text: { body: WA_TEXT + extra } }] } }] }] });

// ---------- spies ----------
const external = [];
let realFetch, server, compat, bundle;
const brokerSpy = { calls: 0, async fetch() { this.calls++; return Response.json({ broker: true, identity_verified: true, phone_number_id: "1300972319774588" }); } };
const kvStore = new Map();
const kv = {
  async get(k, o) { const v = kvStore.get(k) ?? null; if (v != null && (o === "json" || o?.type === "json")) { try { return JSON.parse(v); } catch { return null; } } return v; },
  async put(k, v) { kvStore.set(k, String(v)); },
  async delete(k) { kvStore.delete(k); },
  async list({ prefix = "" } = {}) { return { keys: [...kvStore.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; }
};
const MASTER = "retirement-test-master-material-0123456789";
const REENABLE = Object.freeze({ WHATSAPP_CHANNEL_RETIRED: "false", WHATSAPP_INSTANT_REPLY: "true", META_SOCIAL_AUTOREPLY: "true", WHATSAPP_SALES_ENABLED: "true" });
const OPERATOR = "retirement-test-operator-token-0123456789";
let env;
const ctx = { waitUntil() {}, passThroughOnException() {} };
const providerHits = () => external.filter((u) => R.isWhatsappProviderUrl(u));
function staleIsolateGlobals() {
  // A warm isolate from the pre-retirement era: credentials and broker still on globalThis.
  globalThis.__ZEVANORY_WHATSAPP_RUNTIME__ = { identity_verified: true, access_token: "stale-token", phone_number_id: "1300972319774588", app_secret: "stale-app-secret-0123456789", verify_token: "stale-verify", graph_version: "v26.0" };
  globalThis.__ZEVANORY_WHATSAPP_BROKER__ = brokerSpy;
  globalThis.__ZEVANORY_WHATSAPP_BROKER_STATE__ = { broker: true, identity_verified: true, phone_number_id: "1300972319774588" };
}
async function call(path, init = {}) {
  external.length = 0;
  staleIsolateGlobals();
  const response = await compat.fetch(new Request("https://zevanory.api.br" + path, init), env, ctx);
  const text = await response.text();
  let body = null; try { body = JSON.parse(text); } catch {}
  return { status: response.status, text, body };
}

before(async () => {
  register("./t4_sim/hooks.mjs", import.meta.url);
  const originalCreateServer = http.createServer;
  http.createServer = function (...args) { server = originalCreateServer.apply(this, args); return server; };
  realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(url);
    if (u.hostname === "127.0.0.1") return realFetch(input, init);
    external.push(u.href);
    return new Response(JSON.stringify({ error: "blocked_in_test" }), { status: 503, headers: { "content-type": "application/json" } });
  };
  // Encrypted onboarding record WITH WhatsApp credentials: proves the router never loads them.
  const enc = new TextEncoder(), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", enc.encode("zevanory:whatsapp:onboarding:v1:" + MASTER)), { name: "AES-GCM" }, false, ["encrypt"]);
  const sealed = Buffer.from(iv).toString("base64url") + "." + Buffer.from(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify({ access_token: "record-token", phone_number_id: "1300972319774588", waba_id: "4019600665012911", app_secret: "record-app-secret-0123456789", verify_token: "record-verify", identity_verified: true })))).toString("base64url");
  kvStore.set("whatsapp-onboarding/runtime", sealed);
  env = {
    ZEVANORY_PRIVATE_ARTIFACTS: kv, WHATSAPP_BROKER: brokerSpy, ELITE_INTERNAL_TOKEN: MASTER, OPERATOR_TOKEN: OPERATOR, CERTIFICATION_E2E_TOKEN: OPERATOR,
    WHATSAPP_ACCESS_TOKEN: "env-token", WHATSAPP_PHONE_NUMBER_ID: "1300972319774588", META_GRAPH_VERSION: "v26.0",
    META_APP_SECRET: "env-app-secret-0123456789", META_VERIFY_TOKEN: "env-verify", ASSETS: { fetch: async () => new Response("asset") },
    // Every value that used to (or could plausibly) re-enable the channel: all must be ignored.
    ...REENABLE
  };
  Object.assign(process.env, REENABLE);
  compat = (await import("../worker/cloudflare-worker.compat.mjs")).default;
  bundle = await import("../worker/cloudflare-worker.recovered.mjs");
  for (let i = 0; i < 50; i++) { try { await realFetch("http://127.0.0.1:8788/api/health"); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
});
after(() => { globalThis.fetch = realFetch; server?.close(); server?.closeAllConnections?.(); });

// ---------- retirement is a code constant ----------
test("kill-switch: retirement is a code constant; env values that would re-enable WhatsApp or the instant reply are ignored", () => {
  assert.equal(R.WHATSAPP_CHANNEL_RETIRED, true);
  for (const v of [undefined, null, "", "false", " FALSE ", "False", "0", "no", "off", "true"]) {
    const e = v === undefined ? {} : { WHATSAPP_CHANNEL_RETIRED: v, WHATSAPP_INSTANT_REPLY: "true" };
    assert.equal(R.whatsappChannelRetired(e), true, String(v));
    assert.equal(R.whatsappInstantReplyEnabled(e), false, String(v));
  }
  assert.equal(R.whatsappChannelRetired(undefined), true);
  assert.equal(R.whatsappInstantReplyEnabled({ WHATSAPP_INSTANT_REPLY: "true", WHATSAPP_CHANNEL_RETIRED: "false" }), false);
  const src = read("worker/whatsapp-retirement.mjs").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(src, /process\.env|\benv\s*[?.\[]|_env\s*[?.\[]|WHATSAPP_CHANNEL_RETIRED\s*\]|WHATSAPP_INSTANT_REPLY/, "the retirement module must not read any environment value");
});

// ---------- no Graph / broker call from any listed path ----------
const READ_PATHS = ["/api/status", "/api/health", "/api/continuity", "/api/control-plane", "/api/voice/status", "/api/voice/probe", "/api/voice/final-closure",
  "/api/config?view=closure_status", "/api/config?view=channel_identity_health", "/api/config?view=meta-migration-probe", "/api/release", "/api/support/instant-status",
  "/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1", "/api/whatsapp/status", "/webhooks/whatsapp"];
test("retired: no fetch to graph.facebook.com or the broker from status/health/continuity/control-plane/voice/config/webhook paths", async () => {
  for (const path of READ_PATHS) {
    brokerSpy.calls = 0;
    const r = await call(path);
    assert.deepEqual(providerHits(), [], path + " reached a WhatsApp provider: " + providerHits().join(","));
    assert.equal(brokerSpy.calls, 0, path + " called the broker binding");
    assert.equal(globalThis.__ZEVANORY_WHATSAPP_BROKER__, null, path + " left the broker binding exposed");
    assert.equal(globalThis.__ZEVANORY_WHATSAPP_BROKER_STATE__, null, path);
    assert.deepEqual(globalThis.__ZEVANORY_WHATSAPP_RUNTIME__, {}, path + " loaded WhatsApp credentials");
    assert.ok(r.status < 600);
  }
});

test("status surfaces: whatsapp_mode disabled_permanent, identity not attempted, distribution and instant-status exclude WhatsApp", async () => {
  const release = await call("/api/release");
  assert.equal(release.body.whatsapp_mode, "disabled_permanent");
  const identity = await call("/api/config?view=channel_identity_health");
  assert.equal(identity.body.whatsapp.attempted, false);
  assert.equal(identity.body.whatsapp.reason, "meta_account_permanently_disabled");
  const closure = await call("/api/config?view=closure_status");
  assert.equal(closure.body.channels.whatsapp.operational_mode, "disabled_permanent");
  assert.equal(closure.body.channels.whatsapp.scope_status, "retired");
  assert.equal(closure.body.channels.whatsapp.counts_toward_active_total, false);
  assert.ok(!("whatsapp" in (closure.body.distribution?.fronts || {})), "retired front must not count toward distribution readiness");
  assert.ok(!closure.text.includes("whatsapp_provider_identity_unverified"));
  const probe = await call("/api/config?view=meta-migration-probe");
  assert.equal(probe.body.facebook, false); assert.deepEqual(providerHits(), [], "the retired WhatsApp token was used for a Page read");
  const instant = await call("/api/support/instant-status");
  assert.equal(instant.body.enabled, false);
  assert.equal(instant.body.broker_binding_present, false);
  assert.equal(instant.body.whatsapp_channel.mode, "disabled_permanent");
  assert.equal(instant.body.whatsapp_channel.reason, "meta_account_permanently_disabled");
});

test("projection: runtime.whatsapp disabled_permanent with reason, never 'enabled' even if a transport looks operational", () => {
  const s = projectLiveStatus({ runtime: { whatsapp: "enabled" }, channel_readiness: { whatsapp: { commercial: true, scope_status: "active", release_gate: "enabled", commercial_execution: "enabled" }, email: { scope_status: "active" } } }, { salesOpen: true, whatsappTransportOperational: true, whatsappRetired: true });
  assert.equal(s.runtime.whatsapp, "disabled_permanent");
  assert.equal(s.runtime.whatsapp_state, "retired");
  assert.equal(s.runtime.whatsapp_reason, "meta_account_permanently_disabled");
  assert.equal(s.channel_readiness.whatsapp.scope_status, "retired");
  assert.equal(s.channel_readiness.whatsapp.operational_ready, false);
  assert.equal(s.channel_readiness.email.release_gate, "enabled");
});

test("provider independence: a retired WhatsApp never counts toward continuity quorum", () => {
  const active = { scope_status: "active", release_gate: "enabled", commercial_execution: "enabled" };
  const status = { runtime: { sales: "enabled", whatsapp: "disabled_permanent" }, channel_readiness: { whatsapp: active, zevanory: active, email: active } };
  const plan = buildContinuityPlan(status, { minQuorum: 3 });
  assert.ok(!plan.available_channels.includes("whatsapp"));
  assert.equal(plan.quorum_ok, false, "two real channels cannot reach a quorum of three by counting WhatsApp");
  assert.deepEqual([...plan.retired_channels], ["whatsapp"]);
  assert.equal(plan.whatsapp_transport_operational, false);
  const flagged = buildContinuityPlan({ runtime: {}, channel_readiness: { whatsapp: { ...active, retired: true }, zevanory: active } }, { minQuorum: 1 });
  assert.ok(!flagged.available_channels.includes("whatsapp"));
});

// ---------- webhook: acknowledge only ----------
test("Meta webhook: WhatsApp deliveries get 200 ack only (no processing, no stored content, no provider call)", async () => {
  assert.equal(R.classifyMetaWebhookBody(waPayload()), "whatsapp");
  const before = new Map(kvStore);
  for (const path of ["/api/webhooks/meta", "/api/webhooks?provider=meta"]) {
    brokerSpy.calls = 0;
    const r = await call(path, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=" + "0".repeat(64) }, body: waPayload() });
    assert.equal(r.status, 200, path);
    assert.deepEqual(r.body, { accepted: true, processed: false, stored: false, reason: "meta_account_permanently_disabled" });
    assert.deepEqual(providerHits(), []); assert.equal(brokerSpy.calls, 0);
  }
  const edge = await compat.fetch(new Request("https://zevanory.api.br/api/webhooks/meta", { method: "POST", headers: { "content-type": "application/json" }, body: waPayload() }), env, ctx);
  assert.equal(edge.headers.get("x-zevanory-ack-layer"), "edge", "classified at the edge before any downstream handling");
  assert.equal(edge.headers.get("x-zevanory-meta-product"), "whatsapp_business_account");
  for (const [k, v] of kvStore) {
    if (before.get(k) === v) continue;
    assert.ok(!String(v).includes("retirement-probe") && !String(v).includes(WA_FROM), "stored webhook content under " + k);
  }
});

test("Meta webhook: Instagram/Facebook, oversized and unclassifiable deliveries are never silently acknowledged", async () => {
  const igSmall = JSON.stringify({ object: "instagram", entry: [{ id: "ig", changes: [{ field: "comments", value: { id: "c1", message: "quero o link", from: { id: "u" } } }] }] });
  const igLarge = JSON.stringify({ object: "instagram", entry: [{ id: "ig", changes: [{ field: "comments", value: { id: "c2", message: "x".repeat(300 * 1024), from: { id: "u" } } }] }] });
  const pageLarge = JSON.stringify({ object: "page", entry: [{ id: "pg", changes: [{ field: "feed", value: { item: "comment", comment_id: "c3", message: "y".repeat(300 * 1024), from: { id: "u" } } }] }] });
  const mixed = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "x", changes: [{ field: "feed", value: { message: "z" } }] }] });
  const waLarge = waPayload("w".repeat(300 * 1024));
  const cases = [["instagram small", igSmall, "instagram"], ["instagram large", igLarge, "unclassified"], ["page large", pageLarge, "unclassified"], ["invalid json", "{not json", "unclassified"], ["mixed product", mixed, "unclassified"], ["whatsapp oversized", waLarge, "unclassified"]];
  for (const [name, body, product] of cases) {
    assert.equal(R.classifyMetaWebhookBody(body), product, name);
    for (const path of ["/api/webhooks/meta", "/api/webhooks?provider=meta"]) {
      const r = await call(path, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=" + "1".repeat(64) }, body });
      assert.notEqual(r.body?.reason, "meta_account_permanently_disabled", `${name} ${path} was silently acknowledged`);
      assert.ok([400, 401, 413].includes(r.status), `${name} ${path}: normal handling expected (signature/size), got ${r.status}`);
    }
  }
  // A declared oversized body is not even read at the edge; the normal handler rejects it.
  const declared = await compat.fetch(new Request("https://zevanory.api.br/api/webhooks/meta", { method: "POST", headers: { "content-type": "application/json", "content-length": String(300 * 1024) }, body: igLarge }), env, ctx);
  assert.notEqual(declared.headers.get("x-zevanory-ack-layer"), "edge");
  assert.equal(declared.status, 413);
});

test("bundle layer (node handler): WhatsApp delivery acked without processing; broker never used for signature or verify token", async () => {
  staleIsolateGlobals(); brokerSpy.calls = 0; external.length = 0;
  globalThis.__ZEVANORY_PRIVATE_KV__ = kv;
  const keys = new Set(kvStore.keys());
  const direct = await realFetch("http://127.0.0.1:8788/api/webhooks?provider=meta", { method: "POST", headers: { "content-type": "application/json", connection: "close" }, body: waPayload() });
  assert.equal(direct.status, 200);
  assert.equal(direct.headers.get("x-zevanory-ack-layer"), null, "bundle layer acknowledges on its own");
  assert.deepEqual(await direct.json(), { accepted: true, processed: false, stored: false, reason: "meta_account_permanently_disabled" });
  staleIsolateGlobals();
  const social = await realFetch("http://127.0.0.1:8788/api/webhooks?provider=meta", { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=bad", connection: "close" }, body: JSON.stringify({ object: "page", entry: [] }) });
  assert.equal(social.status, 401, "bad signature on a non-WhatsApp delivery is still rejected");
  staleIsolateGlobals();
  const verify = await realFetch("http://127.0.0.1:8788/api/webhooks?provider=meta&hub.mode=subscribe&hub.verify_token=stale-verify&hub.challenge=9", { headers: { connection: "close" } });
  assert.equal(verify.status, 403, "the retired runtime verify token is not accepted");
  assert.equal(brokerSpy.calls, 0, "broker contacted for signature/token verification");
  assert.deepEqual(providerHits(), []);
  for (const k of kvStore.keys()) if (!keys.has(k)) assert.ok(!String(kvStore.get(k)).includes(WA_TEXT), k);
});

// ---------- onboarding, proof, broker: 410 ----------
test("onboarding routes and the synthetic delivery proof are 410 Gone for any method and credential", async () => {
  const routes = [["/admin/whatsapp-onboard", "GET"], ["/admin/whatsapp-onboard/start", "GET"], ["/admin/whatsapp-onboard/callback?code=c&state=s", "GET"], ["/admin/whatsapp-onboard/embedded-complete", "POST"], ["/admin/whatsapp-onboard/bootstrap", "POST"], ["/admin/whatsapp-onboard/finalize", "POST"], ["/admin/whatsapp-onboard/voice-key", "POST"], ["/api/admin/whatsapp-onboard/status", "GET"], ["/api/admin/whatsapp-onboard/delivery-proof", "POST"], ["/api/admin/whatsapp-onboard/register", "POST"], ["/api/admin/whatsapp-onboard/request-code", "POST"], ["/api/admin/whatsapp-onboard/verify-code", "POST"]];
  for (const [path, method] of routes) for (const auth of [true, false]) {
    brokerSpy.calls = 0;
    const r = await call(path, { method, headers: auth ? { authorization: "Bearer " + OPERATOR, "content-type": "application/json" } : { "content-type": "application/json" }, body: method === "POST" ? JSON.stringify({ operation: "text" }) : undefined });
    assert.equal(r.status, 410, `${method} ${path}`);
    assert.equal(r.body.error, "whatsapp_channel_retired");
    assert.ok(!r.text.includes("signed_body") && !r.text.includes("signature"));
    assert.deepEqual(providerHits(), []); assert.equal(brokerSpy.calls, 0);
  }
  for (const operation of ["subscriptions", "owner", "text", "audio", "audit-observe", "audit-media", "audit-cache"]) {
    const r = await handleWhatsappOnboarding(new Request("https://zevanory.api.br/api/admin/whatsapp-onboard/delivery-proof", { method: "POST", headers: { authorization: "Bearer " + OPERATOR }, body: JSON.stringify({ operation }) }));
    assert.equal(r?.status, 410, operation);
  }
  const voice = await call("/api/admin/voice/audit", { method: "POST", body: JSON.stringify({ operation: "audit-source" }) });
  assert.equal(voice.status, 401, "voice audit route stays authenticated");
  const wrongOp = await call("/api/admin/voice/audit", { method: "POST", headers: { authorization: "Bearer " + OPERATOR }, body: JSON.stringify({ operation: "text" }) });
  assert.equal(wrongOp.status, 400, "no message operation on the voice audit route");
});

test("broker tombstone: every route 410, reads no binding/secret/DB and performs no fetch", async () => {
  let touched = 0, fetched = 0;
  const trapEnv = new Proxy({}, { get() { touched++; throw new Error("broker must not read env"); }, has() { touched++; return false; } });
  const saved = globalThis.fetch; globalThis.fetch = async () => { fetched++; return new Response("{}"); };
  try {
    for (const [path, method, internal] of [["/__zevanory/runtime", "GET", false], ["/broker/status", "GET", true], ["/broker/send", "POST", true], ["/broker/media", "POST", true], ["/broker/request-code", "POST", true], ["/broker/verify-code", "POST", true], ["/broker/oauth/start", "POST", true], ["/broker/oauth/callback", "POST", true], ["/broker/verify-signature", "POST", true], ["/broker/verify-token", "POST", true], ["/anything", "GET", false]]) {
      const host = internal ? "https://whatsapp-broker.internal" : "https://giro-whatsapp-bridge.example.workers.dev";
      const r = await brokerWorker.fetch(new Request(host + path, { method, headers: internal ? { "x-zevanory-internal": "service-binding" } : {}, body: method === "POST" ? "{}" : undefined }), trapEnv);
      assert.equal(r.status, 410, path);
      assert.equal((await r.json()).error, "whatsapp_channel_retired");
    }
  } finally { globalThis.fetch = saved; }
  assert.equal(touched, 0); assert.equal(fetched, 0);
  const src = read("worker/whatsapp-credential-broker.mjs");
  for (const forbidden of ["graph.facebook.com", "env.", "subtle", "caches", "DB"]) assert.ok(!src.includes(forbidden), forbidden);
  assert.doesNotMatch(src.replace(/async fetch\(\)/g, ""), /\bfetch\(/, "no outbound fetch in the tombstone");
});

// ---------- no automated reply path ----------
function slice(name) {
  const start = BUNDLE.indexOf(`async function ${name}(`);
  const end = BUNDLE.indexOf(`__name(${name}, "${name}")`, start);
  assert.ok(start > 0 && end > start, "bundle slice missing: " + name);
  return BUNDLE.slice(start, end);
}
function sandbox(extra = {}) {
  const spy = { fetch: 0, broker: 0 };
  const box = {
    process: { env: {} }, spy,
    whatsappChannelRetired: R.whatsappChannelRetired, whatsappInstantReplyEnabled: R.whatsappInstantReplyEnabled, WHATSAPP_RETIRED_REASON: R.WHATSAPP_RETIRED_REASON, WHATSAPP_RETIRED_MODE: R.WHATSAPP_RETIRED_MODE,
    fetch: async () => { spy.fetch++; return Response.json({ id: "x", messages: [{ id: "wamid.x" }] }); },
    globalThis: { __ZEVANORY_WHATSAPP_BROKER__: { fetch: async () => { spy.broker++; return Response.json({ media_id: "m", provider_message_id: "p" }); } }, __ZEVANORY_WHATSAPP_BROKER_STATE__: { identity_verified: true }, __ZEVANORY_WHATSAPP_RUNTIME__: { identity_verified: true, access_token: "t", phone_number_id: "p" } },
    Request, Response, JSON, FormData, Blob, AbortSignal, ArrayBuffer, Uint8Array, String, Object, Error, Promise, encodeURIComponent,
    clean29: (v) => String(v ?? ""), stageVoiceTemporarily: async () => ({ key: null, staged: false }), __name: (f) => f,
    ...extra
  };
  box.whatsappBrokerCall = extra.whatsappBrokerCall || (async () => { spy.broker++; return { ok: true, status: 200, body: { media_id: "m", provider_message_id: "p" } }; });
  vm.createContext(box);
  return box;
}

test("sender primitives refuse while retired: Graph send, voice upload, media download, broker call", async () => {
  let box = sandbox(); vm.runInContext(slice("postWhatsappMessage"), box);
  const sent = await box.postWhatsappMessage({ token: "t", phoneId: "p", version: "v26.0" }, { to: WA_FROM });
  assert.equal(sent.ok, false); assert.equal(sent.status, 410); assert.equal(box.spy.fetch, 0);

  box = sandbox(); vm.runInContext(slice("uploadVoiceToWhatsapp"), box);
  await assert.rejects(box.uploadVoiceToWhatsapp({ audio: { bytes: new Uint8Array(3), mime: "audio/mpeg" }, phoneId: "p", token: "t", version: "v26.0", env: {}, fetchImpl: box.fetch }), /whatsapp_channel_retired/);
  assert.equal(box.spy.fetch, 0); assert.equal(box.spy.broker, 0);

  box = sandbox(); vm.runInContext(slice("fetchWhatsappMedia"), box);
  await assert.rejects(box.fetchWhatsappMedia({ media_id: "123" }, { WHATSAPP_ACCESS_TOKEN: "t" }, box.fetch), /whatsapp_channel_retired/);
  assert.equal(box.spy.fetch, 0);

  box = sandbox(); delete box.whatsappBrokerCall; vm.runInContext(slice("whatsappBrokerCall"), box);
  const brokered = await box.whatsappBrokerCall("/broker/send", { method: "POST", body: { message: { to: WA_FROM } } });
  assert.equal(brokered.ok, false); assert.equal(brokered.status, 410); assert.equal(box.spy.broker, 0);
});

test("outbound adapter channel:whatsapp refuses before any gate, token or fetch", async () => {
  const start = BUNDLE.indexOf('"channel:whatsapp": /* @__PURE__ */ __name(async (event) => {');
  const end = BUNDLE.indexOf('}, "channel:whatsapp")', start);
  assert.ok(start > 0 && end > start);
  const fn = BUNDLE.slice(start + '"channel:whatsapp": '.length, end + '}, "channel:whatsapp")'.length);
  let gates = 0;
  const box = sandbox({ env: { WHATSAPP_ACCESS_TOKEN: "t", WHATSAPP_PHONE_NUMBER_ID: "p", WHATSAPP_SALES_ENABLED: "true", META_GRAPH_VERSION: "v26.0" }, commercialGate: () => ({ enabled: true }), fetchImpl: null,
    ensureOutboundAllowed: () => { gates++; }, supportEventAllowed: () => true, required3: (v) => v, voiceReplyRequested: () => false, ensureHttps: (v) => v,
    providerAcceptanceMissing: (m) => new Error(m), recordWhatsappEvidence: async () => true, metaBase: () => "https://graph.facebook.com/v26.0" });
  box.requestJson2 = async () => { box.spy.fetch++; return { messages: [{ id: "wamid.out" }] }; };
  vm.runInContext("var adapter = " + fn, box);
  await assert.rejects(box.adapter({ event_id: "e1", payload: { contact_ref: WA_FROM, text: "oi", consent_allowed: true } }), /whatsapp_channel_retired/);
  assert.equal(box.spy.fetch, 0); assert.equal(box.spy.broker, 0); assert.equal(gates, 0);
});

test("instant reply: exported replyWhatsappConversation never answers, whatever the environment says", async () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, REENABLE, { WHATSAPP_ACCESS_TOKEN: "env-token", WHATSAPP_PHONE_NUMBER_ID: "1300972319774588" });
    staleIsolateGlobals(); external.length = 0;
    const item = { from: WA_FROM, phone_number_id: "1300972319774588", type: "text", message_id: "wamid.reply-probe" };
    for (const question of ["quanto custa?", "quero o link"]) {
      const out = await bundle.replyWhatsappConversation(item, question);
      assert.deepEqual(out, { sent: false, reason: "whatsapp_channel_retired" });
    }
    delete process.env.WHATSAPP_CHANNEL_RETIRED; delete process.env.WHATSAPP_INSTANT_REPLY;
    assert.deepEqual(await bundle.replyWhatsappConversation(item, "oi"), { sent: false, reason: "whatsapp_channel_retired" });
    assert.deepEqual(providerHits(), [], "an automated reply reached the provider");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("webhook handler: even with WHATSAPP_CHANNEL_RETIRED=false and WHATSAPP_INSTANT_REPLY=true the bot never replies or processes", async () => {
  const handlerSource = BUNDLE.slice(BUNDLE.indexOf("async function handler18(req, res) {"), BUNDLE.indexOf('__name(handler18, "handler")'));
  const calls = [];
  const item = { from: WA_FROM, phone_number_id: "1300972319774588", type: "text", text: "quanto custa", message_id: "wamid.h18" };
  const box = {
    process: { env: { ...REENABLE } }, globalThis: { __ZEVANORY_PRIVATE_KV__: null, __ZEVANORY_WHATSAPP_OPS_STORE__: null, __ZEVANORY_WHATSAPP_RUNTIME__: {} },
    whatsappChannelRetired: R.whatsappChannelRetired, whatsappInstantReplyEnabled: R.whatsappInstantReplyEnabled, isWhatsappWebhookBody: R.isWhatsappWebhookBody, WHATSAPP_RETIRED_REASON: R.WHATSAPP_RETIRED_REASON,
    rawText: () => JSON.stringify({ object: "page_not_whatsapp", entry: [] }), normalizeWhatsappStatusPayload: () => [], verifyMetaSignature: () => true, whatsappBrokerSignatureValid: async () => false,
    extractWhatsappInboundMessages: () => [item], cs: () => ({ query: async () => [] }), handleMetaSocialInbound: async () => ({ handled: false }),
    whatsappStageRecorder: () => async () => {}, whatsappInboundSafety: () => null, Date, JSON, String, Number,
    understandWhatsappInbound: async (x) => ({ ...x, understanding: x.text }),
    replyWhatsappConversation: async () => { calls.push("reply"); return { sent: true }; },
    queueWhatsappConversation: async () => ({ queued: false }), recordWhatsappEvidence: async () => false,
    json14: (_res, code, body) => ({ code, body })
  };
  vm.createContext(box); vm.runInContext(handlerSource, box);
  const out = await box.handler18({ method: "POST", headers: {} }, { setHeader() {} });
  assert.equal(out.code, 200);
  assert.deepEqual(calls, [], "automated reply attempted");
  assert.equal(out.body.inbound_jobs_queued, undefined, "inbound processed although retired");
  box.process.env = {};
  const retired = await box.handler18({ method: "POST", headers: {} }, { setHeader() {} });
  assert.deepEqual(calls, [], "retired channel processed inbound messages");
  assert.equal(retired.body.inbound_jobs_queued, undefined, "no inbound processing while retired");
});

// ---------- static guards ----------
function repoFiles() {
  const opts = { cwd: new URL(".", ROOT), encoding: "utf8" };
  const listed = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], opts).split("\n").filter(Boolean);
  return [...new Set(listed)].filter((f) => /\.(mjs|cjs|js|ts|py|ya?ml|sh)$/.test(f) && !f.startsWith("tests/") && existsSync(new URL(f, ROOT)));
}
const SIGN = /createHmac\(|name:\s*["']HMAC["']|\bhmac\.new\(|openssl\s+dgst[^\n]*-hmac|subtle\.sign\(/i;
const INBOUND_LITERAL = /object["']?\s*:\s*["']whatsapp_business_account["'][\s\S]{0,400}entry["']?\s*:\s*\[/i;
const APP_SECRET_SIGN = /createHmac\(\s*["']sha256["']\s*,\s*[^)]*app_?secret|importKey\([^;]{0,200}app_?secret[^;]{0,200}\[\s*["']sign["']\s*\]/i;
const EMITS_SIGNATURE = /signed_body|["']?x-hub-signature-256["']?\s*:\s*["'`]?sha256=|["']?x-hub-signature-256["']?\s*:\s*[a-z_$][\w$.]*signature/i;
const POSTS_TO_WEBHOOK = /\b(fetch|curl|requests\.post|urlopen)\b[^\n]{0,240}\/api\/webhooks\/meta/;
const HUB_HEADER = /x-hub-signature-256/i;
export function forgedWebhookGenerators(files, readFile) {
  const hits = [];
  for (const f of files) {
    const t = readFile(f);
    if (SIGN.test(t) && INBOUND_LITERAL.test(t) && (APP_SECRET_SIGN.test(t) || EMITS_SIGNATURE.test(t))) hits.push(f + ": signs a hand-built inbound Meta payload");
    if (APP_SECRET_SIGN.test(t) && EMITS_SIGNATURE.test(t)) hits.push(f + ": emits an app-secret signature for a payload");
    if (POSTS_TO_WEBHOOK.test(t) && HUB_HEADER.test(t)) hits.push(f + ": posts a signed delivery to the production Meta webhook");
  }
  return hits;
}
test("static: no forged/self-signed Meta webhook generator anywhere outside tests/", () => {
  const files = repoFiles();
  assert.ok(files.length > 100 && files.includes("worker/cloudflare-worker.recovered.mjs"), "repository listing incomplete");
  assert.deepEqual(forgedWebhookGenerators(files, (f) => readTextNormalized(new URL(f, ROOT))), []);
  // The detector itself must catch the historical generators (recorded verbatim shapes).
  const legacyProof = 'const payload={object:"whatsapp_business_account",entry:[{id:wabaId,changes:[{field:"messages",value:{messages:[message]}}]}]};const key=await crypto.subtle.importKey("raw",encoder.encode(record.app_secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);const signature="sha256="+hex(await crypto.subtle.sign("HMAC",key,encoder.encode(body)));return responseJson({signed_body:body,signature});';
  const legacyWorkflow = "const r=await fetch(base+'/api/webhooks/meta?voice_proof=1',{method:'POST',headers:{'content-type':'application/json','x-hub-signature-256':ack.signature},body:ack.signed_body});";
  const legacyPython = "sig='sha256='+hmac.new(secret,body,hashlib.sha256).hexdigest()\nrequests.post('https://zevanory.api.br/api/webhooks/meta',data=body,headers={'X-Hub-Signature-256':sig})";
  for (const sample of [legacyProof, legacyWorkflow, legacyPython]) assert.ok(forgedWebhookGenerators(["x"], () => sample).length > 0, sample.slice(0, 60));
  // The production verifier (compare, never emit) is not a generator.
  const verifier = 'const expected = "sha256=" + crypto8.createHmac("sha256", secret).update(payload, "utf8").digest("hex"); return crypto8.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)); const sig = req.headers?.["x-hub-signature-256"];';
  assert.deepEqual(forgedWebhookGenerators(["v"], () => verifier), []);
});

test("static: retired workflows carry no proof job, no secret and no literal-false WhatsApp leftovers", () => {
  const proof = read(".github/workflows/voice-render-proof.yml");
  assert.doesNotMatch(proof, /secrets\.|environment:|wrangler|fetch\(|curl /);
  assert.match(proof, /if: github\.event_name == 'workflow_dispatch'/);
  const recovery = read(".github/workflows/whatsapp-delivery-recovery.yml");
  assert.doesNotMatch(recovery, /^\s{2}production-proof:/m);
  assert.doesNotMatch(recovery, /secrets\.|real_proof/);
  assert.ok(!existsSync(new URL(".github/workflows/whatsapp-closure-probe.yml", ROOT)));
  const workflows = execFileSync("git", ["ls-files", "-co", "--exclude-standard", ".github/workflows"], { cwd: new URL(".", ROOT), encoding: "utf8" }).split("\n").filter((f) => /\.ya?ml$/.test(f) && existsSync(new URL(f, ROOT)));
  // Financial workflow retired by the owner's rule; changing it needs written authorization (ops/publishers.json).
  const OWNER_GATED = new Set([".github/workflows/mercadopago-exact-sha-recovery.yml"]);
  for (const f of workflows) {
    const t = read(f).replace(/^\s*#.*$/gm, "").replace(/\s#\s.*$/gm, "");
    if (/api\/admin\/whatsapp-onboard\/delivery-proof/.test(t)) assert.fail(f + " still calls the retired proof endpoint");
    if (OWNER_GATED.has(f)) continue;
    if (/if:\s*(\$\{\{\s*)?false\b/.test(t) && /whatsapp|webhooks\/meta/i.test(t)) assert.fail(f + " keeps a WhatsApp job parked behind if: false");
  }
});

test("static: retired onboarding module has no Graph, broker, HMAC or signing code", () => {
  const src = read("worker/whatsapp-onboarding.mjs");
  for (const forbidden of ["graph.facebook.com", "brokerJson", '"HMAC"', "subtle.sign", "createHmac", "signed_body", "/register", "request_code", "verify_code", "finalizeTransport", "fetch("]) assert.ok(!src.includes(forbidden), forbidden);
  const compat = read("worker/cloudflare-worker.compat.mjs");
  assert.ok(!compat.includes("loadWhatsappRuntimeCredentials"));
  assert.ok(!/WHATSAPP_INSTANT_REPLY \?\? "true"/.test(compat), "instant reply must not default to on");
  assert.ok(!/process\.env\.WHATSAPP_INSTANT_REPLY !== "false"/.test(BUNDLE), "instant reply must not default to on");
});
