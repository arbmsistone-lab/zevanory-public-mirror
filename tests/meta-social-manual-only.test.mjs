// Instagram / Facebook Page inbound is MANUAL-ONLY (owner decision; same Meta Business portfolio and app
// 1071149631917061 as the WhatsApp account Meta disabled permanently on 2026-10-10). No automated public or
// private reply exists and no environment value can turn one on.
import test from "node:test";
import assert from "node:assert/strict";
import * as inbound from "../worker/inbound-autonomy.mjs";
import { readTextNormalized } from "./helpers/text.mjs";

const comment = (id, text) => ({ field: "comments", value: { id, comment_id: id, message: text, from: { id: "u-" + id } } });
const ig = (...changes) => ({ object: "instagram", entry: [{ id: "ig", changes }] });
const pageFeed = { object: "page", entry: [{ id: "pg", changes: [{ field: "feed", value: { item: "comment", comment_id: "c9", message: "quero preço", from: { id: "u" } } }] }] };
const dm = { object: "page", entry: [{ id: "pg", messaging: [{ sender: { id: "s1" }, timestamp: 1, message: { mid: "m1", text: "quero o link" } }] }] };
const ENABLE_ATTEMPT = { META_SOCIAL_AUTOREPLY: "true", META_ACCESS_TOKEN: "page-token", META_PAGE_ID: "pg", INSTAGRAM_BUSINESS_ACCOUNT_ID: "ig", WHATSAPP_CHANNEL_RETIRED: "false" };

function spyWorld() {
  const kv = new Map(), calls = [];
  const store = { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, String(v)); } };
  const fetchImpl = async (url) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => ({ id: "r" }) }; };
  return { kv, calls, store, fetchImpl };
}

test("keyword comments, Page feed comments and DMs get no automated reply, even with every enable-looking env value", async () => {
  const w = spyWorld();
  const saved = globalThis.fetch; globalThis.fetch = w.fetchImpl;
  try {
    for (const payload of [ig(comment("c1", "Quero o link, qual o preço?")), pageFeed, dm]) {
      const out = await inbound.handleMetaSocialInbound(payload, { ...ENABLE_ATTEMPT, ZEVANORY_PRIVATE_ARTIFACTS: w.store }, w.fetchImpl);
      assert.equal(out.handled, true); assert.equal(out.replied, 0); assert.equal(out.mode, "manual_only");
    }
  } finally { globalThis.fetch = saved; }
  assert.deepEqual(w.calls, [], "no Graph call"); assert.equal(w.kv.size, 0, "no stored message content or reservation");
});

test("non-social payloads are not claimed (handled=false) and nothing is sent", async () => {
  const out = await inbound.handleMetaSocialInbound({ object: "whatsapp_business_account", entry: [] }, ENABLE_ATTEMPT);
  assert.deepEqual(out, { handled: false, received: 0, replied: 0 });
});

test("static: no social automation path or switch exists in the module", () => {
  const src = readTextNormalized(new URL("../worker/inbound-autonomy.mjs", import.meta.url));
  for (const forbidden of ["graph.facebook.com", "private_replies", "/comments", "META_SOCIAL_AUTOREPLY", "META_ACCESS_TOKEN", "/messages"]) assert.ok(!src.includes(forbidden), forbidden);
  assert.equal(typeof inbound.metaSocialAutoreplyEnabled, "undefined", "no enable switch exported");
  const bundle = readTextNormalized(new URL("../worker/cloudflare-worker.recovered.mjs", import.meta.url));
  assert.ok(/const social = await handleMetaSocialInbound\(payload\)\.catch/.test(bundle), "webhook must call the manual-only handler with the payload only (no Page token)");
  assert.ok(!bundle.includes("META_SOCIAL_AUTOREPLY"));
});
