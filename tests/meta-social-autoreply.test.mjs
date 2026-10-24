// Instagram/Facebook comment & DM auto-reply share the Meta Business portfolio and app (1071149631917061)
// of the WhatsApp account Meta disabled permanently on 2026-10-10. Kill-switch META_SOCIAL_AUTOREPLY is
// OFF by default; when on: one private reply per comment, only on a user-typed keyword, no public reply,
// rate-limited, circuit breaker on any 4xx or Graph policy error.
import test from "node:test";
import assert from "node:assert/strict";
import { handleMetaSocialInbound, metaSocialAutoreplyEnabled, META_SOCIAL_BREAKER_KEY, META_SOCIAL_LIMITS } from "../worker/inbound-autonomy.mjs";

const store = () => { const m = new Map(); return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, String(v)); } }; };
const counters = () => { const m = new Map(); return { m, get: async (k) => m.get(k) || 0, put: async (k, n) => { m.set(k, n); } }; };
const comment = (id, text, from = "u-" + id) => ({ field: "comments", value: { id, comment_id: id, message: text, from: { id: from } } });
const igComments = (...changes) => ({ object: "instagram", entry: [{ id: "ig", changes }] });
const dm = (mid, text, sender = "s-" + mid) => ({ object: "page", entry: [{ id: "pg", messaging: [{ sender: { id: sender }, timestamp: 1, message: { mid, text } }] }] });
function graph(status = 200, body = { id: "r1" }) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return { ok: status >= 200 && status < 300, status, json: async () => body }; };
  return { calls, fetchImpl };
}
const ON = { META_SOCIAL_AUTOREPLY: "true", META_ACCESS_TOKEN: "page-token", META_PAGE_ID: "pg", INSTAGRAM_BUSINESS_ACCOUNT_ID: "ig" };

test("kill-switch is OFF by default: no Graph call and no KV write for comments or DMs", async () => {
  for (const v of [undefined, "", "1", "yes", "on", "TRUE?"]) assert.equal(metaSocialAutoreplyEnabled(v === undefined ? {} : { META_SOCIAL_AUTOREPLY: v }), false, String(v));
  assert.equal(metaSocialAutoreplyEnabled({ META_SOCIAL_AUTOREPLY: " TRUE " }), true);
  const kv = store(), g = graph();
  for (const payload of [igComments(comment("c1", "quero o link")), dm("m1", "preço?")]) {
    const out = await handleMetaSocialInbound(payload, { META_ACCESS_TOKEN: "page-token", ZEVANORY_PRIVATE_ARTIFACTS: kv }, g.fetchImpl, { counters: counters() });
    assert.equal(out.handled, true); assert.equal(out.replied, 0); assert.equal(out.disabled, "meta_social_autoreply_off");
  }
  assert.equal(g.calls.length, 0); assert.equal(kv.m.size, 0);
});

test("on: a keyword comment gets exactly one private reply and never a public reply; redelivery does not reply again", async () => {
  const kv = store(), g = graph(), c = counters();
  const env = { ...ON, ZEVANORY_PRIVATE_ARTIFACTS: kv };
  const first = await handleMetaSocialInbound(igComments(comment("c1", "Quero o link, qual o preço?")), env, g.fetchImpl, { counters: c });
  assert.equal(first.replied, 1);
  assert.equal(g.calls.length, 1);
  assert.match(g.calls[0].url, /\/c1\/private_replies$/);
  assert.ok(!g.calls.some((x) => /\/comments$/.test(x.url)), "public comment reply is forbidden");
  assert.match(g.calls[0].body.message, /utm_source=instagram/);
  const again = await handleMetaSocialInbound(igComments(comment("c1", "Quero o link, qual o preço?")), env, g.fetchImpl, { counters: c });
  assert.equal(again.replied, 0); assert.equal(g.calls.length, 1, "at most one private reply per comment");
});

test("on: no keyword typed by the person means no reply at all (comment or DM)", async () => {
  const kv = store(), g = graph();
  const env = { ...ON, ZEVANORY_PRIVATE_ARTIFACTS: kv };
  const out = await handleMetaSocialInbound(igComments(comment("c2", "que legal!")), env, g.fetchImpl, { counters: counters() });
  assert.equal(out.replied, 0); assert.equal(out.results[0].skipped, "no_keyword");
  const d = await handleMetaSocialInbound(dm("m2", "bom dia"), env, g.fetchImpl, { counters: counters() });
  assert.equal(d.replied, 0);
  assert.equal(g.calls.length, 0);
  assert.equal(kv.m.size, 0, "nothing reserved or stored for ignored events");
});

test("on: rate limits per person per day and per hour", async () => {
  const kv = store(), g = graph(), c = counters();
  const env = { ...ON, ZEVANORY_PRIVATE_ARTIFACTS: kv };
  await handleMetaSocialInbound(igComments(comment("a1", "quero", "same"), comment("a2", "link", "same")), env, g.fetchImpl, { counters: c });
  assert.equal(g.calls.length, META_SOCIAL_LIMITS.per_sender_per_day, "one reply per person per day");
  const many = Array.from({ length: META_SOCIAL_LIMITS.per_hour + 3 }, (_, i) => comment("b" + i, "quero o link", "person-" + i));
  const out = await handleMetaSocialInbound(igComments(...many), env, g.fetchImpl, { counters: c });
  assert.equal(g.calls.length, META_SOCIAL_LIMITS.per_hour, "hourly ceiling across everyone");
  assert.ok(out.results.some((x) => x.skipped === "rate_limited"));
});

test("on: any 4xx trips the circuit breaker, stops the batch and blocks later deliveries", async () => {
  const kv = store(), g = graph(400, { error: { code: 1, message: "unknown error" } });
  const env = { ...ON, ZEVANORY_PRIVATE_ARTIFACTS: kv };
  const out = await handleMetaSocialInbound(igComments(comment("d1", "quero", "p1"), comment("d2", "quero", "p2")), env, g.fetchImpl, { counters: counters() });
  assert.equal(out.breaker, "tripped"); assert.equal(g.calls.length, 1, "batch stops at the first rejection");
  assert.ok(kv.m.get(META_SOCIAL_BREAKER_KEY));
  const ok = graph();
  const later = await handleMetaSocialInbound(igComments(comment("d3", "quero", "p3")), env, ok.fetchImpl, { counters: counters() });
  assert.equal(later.breaker, "open"); assert.equal(ok.calls.length, 0);
});

test("on: a Graph policy error code trips the breaker even without a 4xx status; a plain 5xx does not but never retries the same comment", async () => {
  const kv = store(), policy = graph(500, { error: { code: 368, message: "temporarily blocked for policy" } });
  const env = { ...ON, ZEVANORY_PRIVATE_ARTIFACTS: kv };
  const out = await handleMetaSocialInbound(igComments(comment("e1", "quero")), env, policy.fetchImpl, { counters: counters() });
  assert.equal(out.breaker, "tripped");
  const kv2 = store(), flaky = graph(503, {});
  const env2 = { ...ON, ZEVANORY_PRIVATE_ARTIFACTS: kv2 };
  const t1 = await handleMetaSocialInbound(igComments(comment("f1", "quero")), env2, flaky.fetchImpl, { counters: counters() });
  assert.equal(t1.breaker, undefined); assert.ok(!kv2.m.get(META_SOCIAL_BREAKER_KEY));
  await handleMetaSocialInbound(igComments(comment("f1", "quero")), env2, flaky.fetchImpl, { counters: counters() });
  assert.equal(flaky.calls.length, 1, "reservation keeps it at most once");
});
