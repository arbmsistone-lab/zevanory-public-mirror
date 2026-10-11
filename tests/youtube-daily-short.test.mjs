import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planShort, publishShort, recordPublication, cloudflareKv, TARGET_CHANNEL, localDay, shortTiming } from "../scripts/channels/youtube-daily-short.mjs";
import { calendarEntry } from "../worker/acquisition-engine.mjs";

test("daily plan follows the calendar, passes the F1 gate and is unlisted with an idempotency marker", () => {
  for (const day of ["2026-10-11", "2026-10-12", "2026-10-30"]) {
    const p = planShort(day), e = calendarEntry(day);
    assert.equal(p.entry.theme_id, e.theme_id);
    assert.equal(p.gate.action, "publish"); assert.equal(p.gate.compliance, 100); assert.ok(p.gate.score >= 85);
    assert.equal(p.privacyStatus, "unlisted");
    assert.match(p.marker, /^zevanory-short-key:[0-9a-f]{16}$/);
    assert.ok(p.description.includes(p.marker));
    assert.match(p.link, new RegExp("^https://vendas\\.zevanory\\.api\\.br/comprar/" + e.product.sku + "\\?utm_source=youtube"));
    assert.ok(p.title.length <= 95 && p.title.includes(e.product.name));
    assert.doesNotMatch(p.description + p.speech, /lucro garantido|renda garantida|ganhe dinheiro|resultado garantido/i);
  }
  assert.notEqual(planShort("2026-10-11").marker, planShort("2026-10-12").marker);
  assert.equal(localDay(new Date("2026-10-12T02:59:00Z")), "2026-10-11");
});

function youtubeMock({ existing = null, privacy = "unlisted" } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([String(url), init.method || "GET"]);
    const u = String(url);
    if (u.includes("/channels?")) return { ok: true, json: async () => ({ items: [{ id: TARGET_CHANNEL, contentDetails: { relatedPlaylists: { uploads: "UU1" } } }] }) };
    if (u.includes("/playlistItems?")) return { ok: true, json: async () => ({ items: existing ? [{ snippet: { description: "x\n" + existing, resourceId: { videoId: "OLD123" } } }] : [] }) };
    if (u.includes("uploadType=resumable")) { assert.equal(JSON.parse(init.body).status.privacyStatus, "unlisted"); return { ok: true, status: 200, headers: { get: k => k === "location" ? "https://upload.example/session" : null } }; }
    if (u === "https://upload.example/session") return { ok: true, status: 200, json: async () => ({ id: "NEW456" }) };
    if (u.includes("/videos?part=status")) return { ok: true, json: async () => ({ items: [{ status: { uploadStatus: "processed", privacyStatus: privacy }, processingDetails: { processingStatus: "succeeded" } }] }) };
    throw new Error("unexpected " + u);
  };
  return { calls, fetchImpl };
}

test("uploads once as unlisted and reports provider-locked privacy honestly", async () => {
  const plan = planShort("2026-10-11"), m = youtubeMock({ privacy: "private" });
  const r = await publishShort(plan, Buffer.from("mp4"), { accessToken: "t", fetchImpl: m.fetchImpl, sleep: async () => {} });
  assert.equal(r.video_id, "NEW456"); assert.equal(r.reused, false);
  assert.equal(r.url, "https://www.youtube.com/shorts/NEW456");
  assert.equal(r.visibility_note, "provider_locked_private_pending_api_audit");
  assert.equal(m.calls.filter(([u]) => u.includes("uploadType=resumable")).length, 1);
});
test("a retry with the same day reuses the existing video (no duplicate upload)", async () => {
  const plan = planShort("2026-10-11"), m = youtubeMock({ existing: plan.marker });
  const r = await publishShort(plan, Buffer.from("mp4"), { accessToken: "t", fetchImpl: m.fetchImpl, sleep: async () => {} });
  assert.equal(r.reused, true); assert.equal(r.video_id, "OLD123");
  assert.equal(m.calls.some(([u]) => u.includes("uploadType=resumable")), false);
});
test("wrong channel fails closed before any upload", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ items: [{ id: "UCother" }] }) });
  await assert.rejects(publishShort(planShort("2026-10-11"), Buffer.from("x"), { accessToken: "t", fetchImpl }), /youtube_channel_id_mismatch/);
});
test("publication is recorded as a masked post_published activity plus per-day outcome", async () => {
  const map = new Map(); const kv = { get: async k => map.get(k) ?? null, put: async (k, v) => { map.set(k, v); } };
  const plan = planShort("2026-10-11");
  const a = await recordPublication(kv, plan, { video_id: "NEW456", url: "https://www.youtube.com/shorts/NEW456", privacy_status: "private" }, { now: Date.parse("2026-10-11T18:05:00Z") });
  assert.equal(a.emitted, true);
  const ev = [...map].filter(([k]) => k.startsWith("zpc-activity:v1:event:")).map(([, v]) => JSON.parse(v));
  assert.equal(ev.length, 1); assert.equal(ev[0].type, "post_published"); assert.equal(ev[0].channel, "youtube"); assert.equal(ev[0].status, "private");
  assert.equal(ev[0].link, "https://www.youtube.com/shorts/NEW456");
  assert.equal(JSON.parse(map.get("zpc:acquisition:daily:2026-10-11:youtube")).status, "publicado");
  assert.equal((await recordPublication(kv, plan, { video_id: "NEW456", url: "https://www.youtube.com/shorts/NEW456", privacy_status: "private" })).duplicate, true);
});
test("Cloudflare KV REST adapter maps 404 to null and passes the TTL", async () => {
  const calls = [];
  const kv = cloudflareKv({ token: "tok", account: "acc", namespace: "ns", fetchImpl: async (u, i = {}) => { calls.push([u, i.method || "GET"]); return u.includes("missing") ? { status: 404, ok: false } : { ok: true, status: 200, text: async () => "v" }; } });
  assert.equal(await kv.get("missing"), null); assert.equal(await kv.get("k:1"), "v");
  await kv.put("a:b", "x", { expirationTtl: 60 });
  assert.match(calls[2][0], /values\/a%3Ab\?expiration_ttl=60$/); assert.equal(calls[2][1], "PUT");
});
test("scheduled workflow: daily, single concurrency, no secret echo", () => {
  const wf = readFileSync(new URL("../.github/workflows/youtube-autonomous-short.yml", import.meta.url), "utf8");
  assert.match(wf, /schedule:\s*\n\s*- cron: "0 18 \* \* \*"/);
  assert.match(wf, /concurrency:\s*\n\s*group: youtube-autonomous-short/);
  assert.match(wf, /node scripts\/channels\/youtube-daily-short\.mjs/);
  assert.doesNotMatch(wf, /echo .*secrets\./);
});

test("Short lasts as long as the narration (no dead air) and reveals every line before it ends", () => {
  const a = shortTiming(10.2, 4);
  assert.equal(a.duration, 11.4);
  assert.deepEqual(a.reveal.map(x => x < a.duration), [true, true, true, true]);
  assert.equal(shortTiming(3, 4).duration, 8);
  assert.equal(shortTiming(0, 4).duration, 12);
  const long = shortTiming(30, 4);
  assert.equal(long.duration, 20);
  assert.ok(Math.max(...long.reveal) < long.duration);
});
