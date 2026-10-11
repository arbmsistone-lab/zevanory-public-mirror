import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { syncOperationalActivity } from "../worker/operational-activity-sync.mjs";
import { createFinancialProofSnapshot, COMMERCIAL_PROOF_KV_KEY, LAUNCH_EPOCH_KV_KEY } from "../worker/commercial-metrics-projection.mjs";

const SHA = "b".repeat(40), now = Date.parse("2026-10-11T12:35:00Z");
const OID = "22222222-2222-4222-8222-222222222222", TOK = "33333333-3333-4333-8333-333333333333";
function kv() { const map = new Map(); return { map, get: async k => map.get(k) ?? null, put: async (k, v) => { map.set(k, v); }, list: async ({ prefix }) => ({ keys: [...map.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }) }; }
const events = store => [...store.map].filter(([k]) => k.startsWith("zpc-activity:v1:event:")).map(([, v]) => JSON.parse(v));
const audited = { code: 200, result: { complete: true, ambiguous: 0, production_confirmed: 1, production_paid_orders: 1, production_payment_events: 1, production_refund_events: 0, certification_events: 22, orders: { certification: 22, noncertified_unverified: 2 } } };

test("deploy and sales switch are emitted once per release SHA / switch revision", async () => {
  const store = kv(), env = { ZEVANORY_PRIVATE_ARTIFACTS: store, ZEVANORY_RELEASE_SHA: SHA };
  const sw = { enabled: true, requested: true, revision: "2026-10-10T20:19:12Z" };
  const a = await syncOperationalActivity(env, { now, salesSwitch: sw });
  assert.deepEqual(a.sections, { deploy: 1, sales_switch: 1 });
  const b = await syncOperationalActivity(env, { now: now + 60000, salesSwitch: sw });
  assert.equal(b.emitted, 0);
  const c = await syncOperationalActivity({ ...env, ZEVANORY_RELEASE_SHA: "c".repeat(40) }, { now, salesSwitch: { ...sw, enabled: false, requested: false, revision: "2026-10-12T10:00:00Z" } });
  assert.deepEqual(c.sections, { deploy: 1, sales_switch: 1 });
  const ev = events(store);
  assert.deepEqual(ev.filter(e => e.type === "sales_switch").map(e => e.status).sort(), ["closed", "open"]);
  assert.ok(!JSON.stringify(ev).includes(SHA), "refs are hashed");
});
test("refund requests from KV become masked refund_requested events", async () => {
  const store = kv();
  await store.put("refund:req:" + OID, JSON.stringify({ status: "pending", email_hash: "x" }));
  await store.put("refund:req:not-a-uuid", JSON.stringify({ status: "pending" }));
  const out = await syncOperationalActivity({ ZEVANORY_PRIVATE_ARTIFACTS: store }, { now });
  assert.equal(out.sections.refund_requested, 1);
  const ev = events(store).find(e => e.type === "refund_requested");
  assert.equal(ev.status, "pending"); assert.equal(ev.channel, "finance");
  assert.ok(!JSON.stringify(events(store)).includes(OID));
});
test("deliveries, downloads and provider-verified refunds come from production orders only", async () => {
  const store = kv(), calls = [];
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: store, ZEVANORY_RELEASE_SHA: SHA, DATABASE_URL: "postgres://not-used" };
  await store.put(LAUNCH_EPOCH_KV_KEY, JSON.stringify({ at: "2026-10-09T20:19:12Z" }));
  await store.put(COMMERCIAL_PROOF_KV_KEY, JSON.stringify(createFinancialProofSnapshot(env, audited, { now: now - 5 * 60000 })));
  const sqlFactory = () => ({ query: async (text, params) => { calls.push({ text, params });
    if (text.includes("artifact_download_tokens")) return [{ ref: TOK, used: true }, { ref: "bad", used: true }];
    if (text.includes("refund_confirmed")) return [{ ref: OID, at: "2026-10-11T12:20:00Z" }, { ref: OID.replace("2222-4", "2222-5"), at: "2026-10-11T12:34:00Z" }];
    return []; } });
  const out = await syncOperationalActivity(env, { sqlFactory, now });
  assert.equal(out.sections.delivery_sent, 1); assert.equal(out.sections.download_done, 1);
  assert.equal(out.sections.refund_approved, 1, "refund after the proof measurement is not credited");
  for (const c of calls.filter(c => !c.text.includes("whatsapp_observations"))) { assert.match(c.text, /certification_pilot is false/); assert.deepEqual(c.params, ["2026-10-09T20:19:12.000Z"]); }
  const refund = events(store).find(e => e.type === "refund_approved");
  assert.equal(refund.financialProof, "provider-get-verified");
  const again = await syncOperationalActivity(env, { sqlFactory, now: now + 60000 });
  assert.equal(again.emitted, 0, "idempotent");
});
test("without a verified financial snapshot no refund_approved is emitted; DB errors are contained", async () => {
  const store = kv(), env = { ZEVANORY_PRIVATE_ARTIFACTS: store, DATABASE_URL: "x" };
  await store.put(LAUNCH_EPOCH_KV_KEY, JSON.stringify({ at: "2026-10-09T20:19:12Z" }));
  const out = await syncOperationalActivity(env, { sqlFactory: () => ({ query: async t => t.includes("refund_confirmed") ? [{ ref: OID, at: "2026-10-11T12:00:00Z" }] : (() => { throw new Error("PII@x") })() }), now });
  assert.equal(out.ok, true); assert.equal(out.sections.refund_approved, undefined); assert.equal(out.sections.delivery_error, 1);
  assert.ok(!JSON.stringify(out).includes("PII"));
  assert.equal((await syncOperationalActivity({}, { now })).reason, "kv_unavailable");
  const idle = await syncOperationalActivity({ ZEVANORY_PRIVATE_ARTIFACTS: kv(), DATABASE_URL: "x" }, { sqlFactory: () => ({ query: async () => [] }), now });
  assert.equal(idle.idle, "no_launch_epoch");
});
test("WhatsApp replies and purchase links: one aggregated event per completed hour, no per-message KV write", async () => {
  const store = kv(), calls = [];
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: store, DATABASE_URL: "postgres://x" };
  const sqlFactory = () => ({ query: async (text, params) => { calls.push({ text, params });
    if (text.includes("whatsapp_observations")) return [{ hour: "2026-10-11T11:00:00Z", replies: 4, links: 2 }, { hour: "2026-10-11T10:00:00Z", replies: 1, links: 0 }, { hour: "bad", replies: 3, links: 1 }];
    return []; } });
  const out = await syncOperationalActivity(env, { sqlFactory, now });
  assert.equal(out.sections.whatsapp_replied, 2); assert.equal(out.sections.link_sent, 1);
  const q = calls.find(c => c.text.includes("whatsapp_observations"));
  assert.match(q.text, /updated_at < date_trunc\('hour', \$2::timestamptz\)/, "only completed hours");
  const ev = events(store);
  assert.deepEqual(ev.filter(e => e.type === "whatsapp_replied").map(e => e.status).sort(), ["replied-1", "replied-4"]);
  assert.equal(ev.find(e => e.type === "link_sent").status, "sent-2");
  assert.ok(!JSON.stringify(ev).includes("5588"));
  assert.equal((await syncOperationalActivity(env, { sqlFactory, now: now + 60000 })).sections.whatsapp_replied, undefined, "idempotent per hour");
});
test("WhatsApp reply path itself is untouched (KV write budget: dedup put only)", () => {
  const rec = readFileSync(new URL("../worker/cloudflare-worker.recovered.mjs", import.meta.url), "utf8");
  assert.equal(rec.includes("emitActivity"), false);
});
test("wiring: operational sync in the isolated 5,35 cron; inline emits for leads and alerts", () => {
  const compat = readFileSync(new URL("../worker/cloudflare-worker.compat.mjs", import.meta.url), "utf8");
  const s = compat.indexOf('if (controller?.cron === "5,35 * * * *")'), e = compat.indexOf('if (controller?.cron === "15,45 * * * *")', s);
  assert.ok(compat.slice(s, e).includes("syncOperationalActivity(normalized"));
  for (const f of ["lead-magnet", "owner-alerts"]) assert.match(readFileSync(new URL("../worker/" + f + ".mjs", import.meta.url), "utf8"), /emitActivity\(env, \{ type: "(lead_captured|email_sent|owner_alert_sent)"/);
});
