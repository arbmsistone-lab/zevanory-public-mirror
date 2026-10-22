import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planShort, publishShort, recordPublication, cloudflareKv, TARGET_CHANNEL, localDay, shortTiming, beatTimes, wrapText } from "../scripts/channels/youtube-daily-short.mjs";
import { calendarEntry } from "../worker/acquisition-engine.mjs";

test("daily plan follows the calendar, passes the F1 gate and is public with an idempotency marker", () => {
  for (const day of ["2026-10-11", "2026-10-12", "2026-10-30"]) {
    const p = planShort(day), e = calendarEntry(day);
    assert.equal(p.entry.theme_id, e.theme_id);
    assert.equal(p.gate.action, "publish"); assert.equal(p.gate.compliance, 100); assert.ok(p.gate.score >= 85);
    assert.equal(p.privacyStatus, "public");
    assert.match(p.marker, /^zevanory-short-key:[0-9a-f]{16}$/);
    assert.ok(p.description.includes(p.marker));
    // P13c: vendas fechadas (padrão) => página do produto; aberto => checkout /comprar/.
    assert.match(p.link, /^https:\/\/vendas\.zevanory\.api\.br\/[a-z-]+\?utm_source=youtube/); assert.doesNotMatch(p.link, /\/comprar\//);
    assert.match(planShort(day, { salesOpen: true }).link, new RegExp("^https://vendas\\.zevanory\\.api\\.br/comprar/" + e.product.sku + "\\?utm_source=youtube"));
    assert.ok(p.title.length <= 95 && p.title.includes(e.product.name));
    assert.doesNotMatch(p.description + p.speech, /lucro garantido|renda garantida|ganhe dinheiro|resultado garantido/i);
  }
  assert.notEqual(planShort("2026-10-11").marker, planShort("2026-10-12").marker);
  assert.equal(localDay(new Date("2026-10-12T02:59:00Z")), "2026-10-11");
});

function youtubeMock({ existing = null, privacy = "public" } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([String(url), init.method || "GET"]);
    const u = String(url);
    if (u.includes("/channels?")) return { ok: true, json: async () => ({ items: [{ id: TARGET_CHANNEL, contentDetails: { relatedPlaylists: { uploads: "UU1" } } }] }) };
    if (u.includes("/playlistItems?")) return { ok: true, json: async () => ({ items: existing ? [{ snippet: { description: "x\n" + existing, resourceId: { videoId: "OLD123" } } }] : [] }) };
    if (u.includes("uploadType=resumable")) { assert.equal(JSON.parse(init.body).status.privacyStatus, "public"); return { ok: true, status: 200, headers: { get: k => k === "location" ? "https://upload.example/session" : null } }; }
    if (u === "https://upload.example/session") return { ok: true, status: 200, json: async () => ({ id: "NEW456" }) };
    if (u.includes("/videos?part=status")) return { ok: true, json: async () => ({ items: [{ status: { uploadStatus: "processed", privacyStatus: privacy }, processingDetails: { processingStatus: "succeeded" } }] }) };
    throw new Error("unexpected " + u);
  };
  return { calls, fetchImpl };
}

test("uploads once as public and reports provider-locked privacy honestly", async () => {
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
test("scheduled workflow: three daily slots + backstop, single concurrency, no secret echo", () => {
  const wf = readFileSync(new URL("../.github/workflows/youtube-autonomous-short.yml", import.meta.url), "utf8");
  for (const c of ["0 13 \\* \\* \\*", "0 18 \\* \\* \\*", "0 22 \\* \\* \\*", "30 23 \\* \\* \\*"]) assert.match(wf, new RegExp(`- cron: "${c}"`));
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

test("beats snap to the real pauses of the voice and keep their order", () => {
  const said = [["Sem tempo para organizar?", "Isso é para salões de beleza."], ["Comece com 15 minutos por semana."], ["Vendas na Prática, com arrependimento em sete dias corridos."], ["Veja o guia no link da descrição."]];
  const starts = beatTimes(said, 12, [1.4, 3.9, 6.6, 9.2], 13.2);
  assert.deepEqual(starts, [0, 3.9, 6.6, 9.2]);
  const fallback = beatTimes(said, 12, [], 13.2);
  assert.ok(fallback[1] > 0 && fallback[1] < fallback[2] && fallback[2] < fallback[3] && fallback[3] < 13.2);
});
test("every calendar day has a full on-screen script that wraps within the frame", () => {
  for (let d = 0; d < 35; d++) {
    const day = new Date(Date.UTC(2026, 9, 11 + d)).toISOString().slice(0, 10), p = planShort(day);
    assert.equal(p.said.length, 4);
    for (const k of ["hook", "niche", "tip", "product", "offer", "cta", "url"]) assert.ok(String(p.screen[k] || "").trim(), k);
    assert.ok(wrapText(p.screen.hook, 14, 3), "hook fits in 3 lines");
    assert.match(p.speech, /arrependimento em sete dias corridos/); assert.doesNotMatch(p.speech + p.description, /garantia/i);
  }
});

test("reach mix: value Shorts rotate across the 40 guides and 7 calculators, safe wording, distinct markers, offer marker unchanged", async () => {
  const { planSlot, SLOTS } = await import("../scripts/channels/youtube-daily-short.mjs");
  assert.deepEqual([...SLOTS], ["dica", "oferta", "calc"]);
  const seen = new Set(), calcs = new Set();
  for (let d = 0; d < 40; d++) {
    const day = new Date(Date.UTC(2026, 9, 12 + d)).toISOString().slice(0, 10);
    const tip = planSlot(day, "dica"), calc = planSlot(day, "calc"), offer = planSlot(day, "oferta");
    for (const p of [tip, calc]) {
      assert.equal(p.gate.action, "publish"); assert.doesNotMatch(p.speech + p.description, /gr[aá]tis|antes e depois/i);
      assert.match(p.link, /^https:\/\/vendas\.zevanory\.api\.br\/(ia-para|calculadora)-[a-z-]+\?utm_source=youtube&utm_medium=short&utm_campaign=(dica|calc)_[a-z-]+$/);
      assert.equal(p.said.length, 4); assert.ok(p.title.length <= 100); assert.doesNotMatch(p.screen.tip, /\.\.$/);
    }
    assert.notEqual(tip.marker, offer.marker); assert.notEqual(calc.marker, offer.marker);
    seen.add(tip.link.split("?")[0]); calcs.add(calc.link.split("?")[0]);
  }
  assert.equal(seen.size, 40); assert.equal(calcs.size, 7);
  assert.equal(planSlot("2026-10-11", "oferta").marker, planShort("2026-10-11").marker);
});

import { audioQuality, speechForLocalVoice } from "../scripts/channels/youtube-daily-short.mjs";
test("audio gate: loudness, peak and dead air", () => {
  const good = "  Integrated loudness:\n    I:         -16.1 LUFS\n  True peak:\n    Peak:       -1.6 dBFS";
  assert.equal(audioQuality(good, [3.4], [3.0], 12).ok, true);
  assert.equal(audioQuality(good, [6.0], [3.0], 12).ok, false);
  assert.equal(audioQuality(good.replace("-16.1", "-27.0"), [], [], 12).ok, false);
  assert.equal(audioQuality(good.replace("-1.6", "0.2"), [], [], 12).ok, false);
});
test("local voice reads the brand and prices correctly", () => {
  assert.equal(speechForLocalVoice("ZEVANORY por R$ 197"), "Zevanóri por 197 reais");
});

import { publicationWindow } from "../scripts/channels/youtube-daily-short.mjs";
test("publication window: never early, late only inside the same commercial day", () => {
  const at = (iso) => Date.parse(iso);
  const day = "2026-10-13";
  // On time and the delays the owner asked to certify.
  assert.equal(publicationWindow({ day, slot: "dica", now: at("2026-10-13T13:00:00Z") }).action, "publish");
  const d15 = publicationWindow({ day, slot: "dica", now: at("2026-10-13T13:15:00Z") }); assert.equal(d15.action, "publish"); assert.equal(d15.late, false);
  const d1h = publicationWindow({ day, slot: "oferta", now: at("2026-10-13T19:00:00Z") }); assert.equal(d1h.action, "publish"); assert.equal(d1h.late, true); assert.equal(d1h.delayMin, 60);
  assert.equal(publicationWindow({ day, slot: "oferta", now: at("2026-10-13T22:00:00Z") }).action, "publish", "4 h late, same day");
  assert.equal(publicationWindow({ day, slot: "dica", now: at("2026-10-13T21:00:00Z") }).action, "publish", "8 h late, same day");
  assert.equal(publicationWindow({ day, slot: "calc", now: at("2026-10-14T06:00:00Z") }).action, "expired", "8 h late crosses midnight: not published");
  // The 12/10 incident: a backstop starting at 00:44 of 13/10 must not publish 13/10's 10:00 and 15:00 Shorts.
  const early = publicationWindow({ day, slot: "dica", now: at("2026-10-13T03:44:00Z") });
  assert.equal(early.action, "wait"); assert.equal(early.reason, "before_planned_time");
  assert.equal(publicationWindow({ day, slot: "oferta", now: at("2026-10-13T03:44:00Z") }).action, "wait");
  // And it must not publish the previous day's slots after midnight either.
  assert.equal(publicationWindow({ day: "2026-10-12", slot: "calc", now: at("2026-10-13T03:44:00Z") }).action, "expired");
  assert.equal(publicationWindow({ day: "2026-10-12", slot: "calc", now: at("2026-10-13T02:45:00Z") }).action, "publish", "23:45 of the same day is still that day");
});
