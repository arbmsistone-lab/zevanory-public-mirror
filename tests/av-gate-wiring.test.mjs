// P05 — zevanory-av-gate wiring: the publisher and the pack are fail-closed on the FINAL MP4 verdict,
// there is exactly one brand voice (no Piper / no multi-model fallback) and sales-closed content only.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readTextNormalized } from "./helpers/text.mjs";
import { writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderShort, avGate, avGateSealed, humanApproved, fsCandidateStore, storeCandidate, publishApproved, brandVoice, brandVoiceQueued, recordSlotLost, slotLostKey, VOICE_RETRY, BRAND_VOICE, planSlot, SLOTS, salesClosedViolations } from "../scripts/channels/youtube-daily-short.mjs";

// Code only (comments may name what was removed).
const SRC = readTextNormalized(new URL("../scripts/channels/youtube-daily-short.mjs", import.meta.url)).split("\n").filter(l => !/^\s*\/\//.test(l)).map(l => l.replace(/\s\/\/ .*$/, "")).join("\n");
const voiceOk = async () => ({ pcm: Buffer.alloc(24000 * 2 * 2), rate: 24000, model: BRAND_VOICE.model });
const fakePack = async (raw, script, dir) => {
  await writeFile(dir + "/master.wav", "m"); await writeFile(dir + "/captions.vtt", "WEBVTT\n");
  return { master: dir + "/master.wav", narration: dir + "/narration.m4a", captions: dir + "/captions.vtt", cues: [], duration: 12 };
};
const fakeVideo = async (plan, pkg, out) => { await writeFile(out, "mp4-bytes-" + plan.slot); return { duration: 12 }; };
const base = async (name) => { const b = join(tmpdir(), "zevanory-avgate-test-" + name); await rm(b + ".av", { recursive: true, force: true }); await rm(b + ".mp4", { force: true }); await rm(b + ".av-gate.json", { force: true }); return b; };

test("brand voice unavailable => BLOCKED before any render, nothing to upload", async () => {
  const b = await base("novoice");
  let called = 0;
  const spy = async () => { called++; return {}; };
  await assert.rejects(renderShort(planSlot("2026-10-22", "dica"), b, { geminiKey: "", pack: spy, video: spy, gate: spy }), /brand_voice_BLOCKED:brand_voice_key_missing/);
  await assert.rejects(renderShort(planSlot("2026-10-22", "dica"), b, { geminiKey: "k", voice: async () => ({ blocked: "brand_voice_http_429" }), pack: spy, video: spy, gate: spy }), /brand_voice_BLOCKED:brand_voice_http_429/);
  assert.equal(called, 0);
  assert.equal(existsSync(b + ".mp4"), false);
});

for (const verdict of ["FAIL", "BLOCKED", "ERROR_INFRA"]) {
  test(`gate verdict ${verdict} => no publishable file and no PASS seal`, async () => {
    const b = await base("v" + verdict);
    let seen = null;
    const gate = async (mp4, manifest) => { seen = JSON.parse(readTextNormalized(manifest)); return { verdict, failed: ["v3.stream_tp"], blocked: [], errors: [] }; };
    await assert.rejects(renderShort(planSlot("2026-10-22", "oferta"), b, { geminiKey: "k", voice: voiceOk, pack: fakePack, video: fakeVideo, gate }), new RegExp("av_gate_" + verdict));
    assert.equal(existsSync(b + ".mp4"), false);
    assert.equal(await avGateSealed(b + ".mp4"), false);
    assert.deepEqual(seen.voice, BRAND_VOICE);
    assert.equal(seen.sales_mode, "closed");
    for (const k of ["script_sha256", "master_sha256", "captions_sha256", "mp4_sha256"]) assert.match(seen[k], /^[0-9a-f]{64}$/);
  });
}

test("PHASE 1: a technical pass yields a candidate (bytes + sha256) and NEVER a publishable/sealed file", async () => {
  const b = await base("pending");
  const gate = async () => ({ verdict: "PASS_TECH_PENDING_HUMAN", failed: [], blocked: [], errors: [] });
  const r = await renderShort(planSlot("2026-10-22", "calc"), b, { geminiKey: "k", voice: voiceOk, pack: fakePack, video: fakeVideo, gate });
  assert.match(r.sha, /^[0-9a-f]{64}$/); assert.equal(r.bytes.toString(), "mp4-bytes-calc");
  assert.equal(existsSync(b + ".mp4"), false);
  assert.equal(await avGateSealed(b + ".mp4"), false);
  // approvals file: only an entry for exactly this sha256 with approver + date counts
  const dir = join(tmpdir(), "zevanory-avgate-approvals"); await mkdir(dir, { recursive: true });
  const f = join(dir, "a.json");
  await writeFile(f, JSON.stringify({ approvals: [{ mp4_sha256: "ab", approver: "dono", at: "2026-10-23" }, { mp4_sha256: "cd" }] }));
  assert.equal((await humanApproved("ab", { file: f })).approver, "dono");
  assert.equal(await humanApproved("cd", { file: f }), null);
  assert.equal(await humanApproved("ab", { file: undefined }), null);
});

test("two-phase publishing: immutable write-once candidate; publish exactly the approved bytes; mutants killed", async () => {
  const dir = join(tmpdir(), "zevanory-candidates-test-" + process.pid); await rm(dir, { recursive: true, force: true });
  const store = fsCandidateStore(dir);
  const plan = planSlot("2026-10-22", "dica");
  const bytes = Buffer.from("approved-mp4-bytes");
  const tech = { verdict: "PASS_TECH_PENDING_HUMAN", failed: [], blocked: [] };
  const st = await storeCandidate(store, { bytes, plan, report: tech, manifestSha: "m".repeat(64) });
  assert.equal((await storeCandidate(store, { bytes, plan, report: tech })).reused, true, "write-once: reused, not rewritten");
  await assert.rejects(storeCandidate(store, { bytes: Buffer.from("x"), plan, report: { verdict: "FAIL" } }), /candidate_not_tech_passed/);
  await assert.rejects(storeCandidate(store, { bytes, plan: planSlot("2026-10-23", "dica"), report: tech }), /candidate_write_once_conflict/);
  const yes = async sha => sha === st.sha ? { approver: "dono", at: "2026-10-23" } : null, no = async () => null;
  let sent = null;
  const publish = async (p, b) => { sent = b; return { video_id: "V1" }; };
  // missing approval → refuse
  await assert.rejects(publishApproved(st.sha, { store, approvals: no, publish }), /candidate_not_approved/); assert.equal(sent, null);
  // approved → publishes EXACTLY the stored bytes, with the plan of the stored day/slot
  const ok = await publishApproved(st.sha, { store, approvals: yes, publish });
  assert.ok(sent.equals(bytes)); assert.equal(ok.plan.marker, plan.marker);
  // tampered bytes in the store → refuse (hash re-verified before upload)
  await writeFile(join(dir, ("zpc:short:candidate:" + st.sha).replace(/[^a-z0-9._-]/gi, "_")), "tampered");
  sent = null;
  await assert.rejects(publishApproved(st.sha, { store, approvals: yes, publish }), /candidate_hash_mismatch/); assert.equal(sent, null);
  // mutants: without the hash check the tampered bytes would go out; without the approval check an unapproved one
  await publishApproved(st.sha, { store, approvals: yes, publish, verifyHash: false }); assert.equal(sent.toString(), "tampered", "mutant verifyHash=false killed");
  await writeFile(join(dir, ("zpc:short:candidate:" + st.sha).replace(/[^a-z0-9._-]/gi, "_")), bytes);
  await publishApproved(st.sha, { store, approvals: no, publish, requireApproval: false }); assert.ok(sent.equals(bytes), "mutant requireApproval=false killed");
  // unknown / malformed sha → refuse
  await assert.rejects(publishApproved("f".repeat(64), { store, approvals: yes, publish }), /candidate_missing/);
  await assert.rejects(publishApproved("../etc", { store, approvals: yes, publish }), /candidate_sha_invalid/);
});

test("publish phase cannot re-render: no voice / ffmpeg / gate / render call in the publish path", () => {
  const body = (name) => { const i = SRC.indexOf("export async function " + name); const j = SRC.indexOf("\nexport ", i + 10); return SRC.slice(i, j); };
  for (const fn of ["loadApprovedCandidate", "publishApproved", "sealApproved"]) {
    const b = body(fn);
    assert.ok(b.length > 50, fn);
    for (const banned of [/renderShort/, /brandVoice/, /packageNarration/, /renderVideo/, /avGate\(/, /ffmpeg/, /run\(/, /spawn/]) assert.doesNotMatch(b, banned, fn);
  }
  const i0 = SRC.indexOf('if (phase === "publish")');
  const main = SRC.slice(i0, SRC.indexOf('const day = (process.argv', i0));
  assert.ok(main.length > 100);
  for (const banned of [/renderShort/, /brandVoice/, /storeCandidate/, /ffmpeg/]) assert.doesNotMatch(main, banned);
});

test("avGate wrapper is fail-closed (missing report, exit-code mismatch, unknown verdict)", async () => {
  const dir = join(tmpdir(), "zevanory-avgate-wrapper");
  await mkdir(dir, { recursive: true });
  const rep = dir + "/r.json";
  await rm(rep, { force: true });
  assert.equal(avGate("a.mp4", "m.json", rep, { spawn: () => ({ status: 0 }) }).verdict, "ERROR_INFRA");
  await writeFile(rep, JSON.stringify({ verdict: "PASS_TECH_PENDING_HUMAN", decision: {} }));
  assert.equal(avGate("a.mp4", "m.json", rep, { spawn: () => ({ status: 1 }) }).verdict, "ERROR_INFRA");
  assert.equal(avGate("a.mp4", "m.json", rep, { spawn: () => ({ status: 4 }) }).verdict, "PASS_TECH_PENDING_HUMAN");
  await writeFile(rep, JSON.stringify({ verdict: "PASS", decision: {} }));  // the gate never emits a final PASS
  assert.equal(avGate("a.mp4", "m.json", rep, { spawn: () => ({ status: 0 }) }).verdict, "ERROR_INFRA");
  await writeFile(rep, JSON.stringify({ verdict: "FAIL", decision: { failed: ["v2.critical_terms"] } }));
  const f = avGate("a.mp4", "m.json", rep, { spawn: () => ({ status: 1 }) });
  assert.equal(f.verdict, "FAIL"); assert.deepEqual(f.failed, ["v2.critical_terms"]);
  await writeFile(rep, JSON.stringify({ verdict: "MAYBE" }));
  assert.equal(avGate("a.mp4", "m.json", rep, { spawn: () => ({ status: 0 }) }).verdict, "ERROR_INFRA");
});

test("single brand voice: one model, style only as speech metadata (never read aloud), no Piper / fallback chain", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push([url, JSON.parse(init.body)]); return { ok: false, status: 503 }; };
  const r = await brandVoice("Texto aprovado.", "k", { fetchImpl });
  assert.equal(r.blocked, "brand_voice_http_503");
  assert.equal(calls.length, 1, "no second model is tried");
  const body = calls[0][1];
  assert.equal(body.model, "gemini-3.8-flash-tts");
  assert.equal(body.input[0].content[0].text, "Texto aprovado.");
  assert.equal(body.input[0].content[0].annotations[0].type, "speech_metadata");
  for (const banned of [/piper/i, /flash-lite/, /gemini-2\.5/, /3\.1-flash-tts-preview/, /anullsrc/, /speechForLocalVoice/, /STYLE \+ /]) assert.doesNotMatch(SRC, banned);
});

test("sales closed: no slot of the next 90 days carries a price, a /comprar link or a purchase promise", () => {
  for (let d = 0; d < 90; d++) {
    const day = new Date(Date.UTC(2026, 9, 22 + d)).toISOString().slice(0, 10);
    for (const slot of SLOTS) {
      const p = planSlot(day, slot);
      assert.deepEqual(salesClosedViolations(p), [], day + " " + slot);
      assert.equal(p.gate.action, "publish");
    }
  }
  const bad = { ...planSlot("2026-10-22", "oferta"), description: "Lucro & Caixa R$ 247 https://vendas.zevanory.api.br/comprar/ZEV-LCX-011" };
  assert.deepEqual(salesClosedViolations(bad), ["sales_closed_purchase_cta"]);
});

test("workflows: gate installed before render, no Piper, workflows stay as the owner left them (no new triggers)", () => {
  for (const f of ["youtube-autonomous-short.yml", "short-pack.yml"]) {
    const wf = readTextNormalized(new URL("../.github/workflows/" + f, import.meta.url));
    assert.doesNotMatch(wf, /piper/i, f);
    assert.match(wf, /scripts\/av_gate\/requirements\.txt/, f);
    assert.match(wf, /scripts\/av_gate\/fetch_models\.sh/, f);
    assert.doesNotMatch(wf, /continue-on-error:\s*true/, f);
    assert.doesNotMatch(wf, /^\s*(push|pull_request|pull_request_target|workflow_run):/m, f);
  }
  const cp = readTextNormalized(new URL("../scripts/channels/short-crosspost.mjs", import.meta.url));
  assert.match(cp, /avGateSealed\(file\)/);
});

test("voice unavailable: bounded retry queue (same voice only), TTL, then the slot is LOST — never a fallback", async () => {
  const pcm = { pcm: Buffer.alloc(48000), rate: 24000, model: BRAND_VOICE.model };
  const seq = (...r) => { const calls = []; return { calls, voice: async (t, k) => { calls.push([t, k]); return r[Math.min(calls.length - 1, r.length - 1)]; } }; };
  const sleeps = [], sleep = async ms => { sleeps.push(ms); };
  // transient errors then success: same function every time (no other model), bounded backoff
  let q = seq({ blocked: "brand_voice_http_429" }, { blocked: "brand_voice_http_503" }, pcm);
  let r = await brandVoiceQueued("x", "k", { voice: q.voice, sleep });
  assert.equal(r.model, BRAND_VOICE.model); assert.equal(q.calls.length, 3); assert.deepEqual(sleeps, VOICE_RETRY.backoffMs);
  // always transient: at most maxAttempts calls, then slot lost
  q = seq({ blocked: "brand_voice_http_500" });
  r = await brandVoiceQueued("x", "k", { voice: q.voice, sleep: async () => {} });
  assert.equal(r.lost, true); assert.equal(r.blocked, "slot_lost_voice_unavailable"); assert.equal(q.calls.length, VOICE_RETRY.maxAttempts);
  // permanent error: no retry at all
  q = seq({ blocked: "brand_voice_key_missing" });
  r = await brandVoiceQueued("x", "", { voice: q.voice, sleep: async () => {} });
  assert.equal(r.blocked, "brand_voice_key_missing"); assert.equal(q.calls.length, 1);
  // TTL / end of commercial day: no wait beyond the deadline
  let t = 0; q = seq({ blocked: "brand_voice_http_429" });
  r = await brandVoiceQueued("x", "k", { voice: q.voice, sleep: async ms => { t += ms; }, now: () => t, deadline: 10000 });
  assert.equal(r.lost, true); assert.equal(q.calls.length, 1);
  // renderShort turns a lost slot into a BLOCKED run without rendering
  let rendered = 0;
  await assert.rejects(renderShort(planSlot("2026-10-22", "dica"), join(tmpdir(), "zevanory-avgate-test-lost"), { geminiKey: "k", voice: async () => ({ blocked: "slot_lost_voice_unavailable", lost: true }), pack: async () => { rendered++; }, video: async () => { rendered++; }, gate: async () => { rendered++; } }), /brand_voice_BLOCKED:slot_lost_voice_unavailable/);
  assert.equal(rendered, 0);
  // the lost slot is recorded so later runs of the same day skip it
  const m = new Map(); await recordSlotLost({ put: async (k, v) => m.set(k, v) }, "2026-10-22", "dica", "slot_lost_voice_unavailable");
  assert.equal(JSON.parse(m.get(slotLostKey("2026-10-22", "dica"))).policy, "lose_the_slot_no_fallback");
});

test("absolute slot deadline enforced at START and at COMPLETION of synthesis (fake clock); mutants without either check are killed", async () => {
  const pcm = { pcm: Buffer.alloc(48000), rate: 24000, model: BRAND_VOICE.model };
  // starts after the deadline: no synthesis call at all, slot lost
  let calls = 0, t = 2000;
  let r = await brandVoiceQueued("x", "k", { voice: async () => { calls++; return pcm; }, now: () => t, deadline: 1000 });
  assert.equal(r.lost, true); assert.equal(r.reason, "deadline_before_start"); assert.equal(calls, 0);
  // mutant without the start check accepts it
  r = await brandVoiceQueued("x", "k", { voice: async () => pcm, now: () => t, deadline: 1000, enforceStart: false, enforceEnd: false });
  assert.equal(r.model, BRAND_VOICE.model, "mutant (no start check) would accept late audio");
  // starts before, completes after the deadline: audio discarded, slot lost
  t = 900;
  r = await brandVoiceQueued("x", "k", { voice: async () => { t = 1500; return pcm; }, now: () => t, deadline: 1000 });
  assert.equal(r.lost, true); assert.equal(r.reason, "late_audio_discarded"); assert.equal(r.pcm, undefined);
  // mutant without the completion check accepts the late audio
  t = 900;
  r = await brandVoiceQueued("x", "k", { voice: async () => { t = 1500; return pcm; }, now: () => t, deadline: 1000, enforceEnd: false });
  assert.equal(r.model, BRAND_VOICE.model, "mutant (no completion check) would accept late audio");
  // on time: accepted
  t = 100;
  r = await brandVoiceQueued("x", "k", { voice: async () => { t = 500; return pcm; }, now: () => t, deadline: 1000 });
  assert.equal(r.model, BRAND_VOICE.model);
});

test("TTL (15 min) enforced at COMPLETION too: synthesis finishing after start+TTL but before end of day is discarded; mutant killed", async () => {
  const pcm = { pcm: Buffer.alloc(48000), rate: 24000, model: BRAND_VOICE.model };
  const dayEnd = 10 * 3600 * 1000, ttl = VOICE_RETRY.ttlMs;
  let t = 0;
  let r = await brandVoiceQueued("x", "k", { voice: async () => { t = ttl + 60000; return pcm; }, now: () => t, deadline: dayEnd });
  assert.equal(r.lost, true); assert.equal(r.reason, "late_audio_discarded");
  t = 0;
  r = await brandVoiceQueued("x", "k", { voice: async () => { t = ttl + 60000; return pcm; }, now: () => t, deadline: dayEnd, ttlAtCompletion: false });
  assert.equal(r.model, BRAND_VOICE.model, "mutant (TTL not enforced at completion) would accept it");
  // a retry may not START after start+TTL either
  t = 0; let calls = 0;
  r = await brandVoiceQueued("x", "k", { voice: async () => { calls++; t = ttl + 1; return { blocked: "brand_voice_http_503" }; }, now: () => t, deadline: dayEnd, sleep: async () => {} });
  assert.equal(r.lost, true); assert.equal(calls, 1);
  // within TTL: accepted
  t = 0;
  r = await brandVoiceQueued("x", "k", { voice: async () => { t = ttl - 1; return pcm; }, now: () => t, deadline: dayEnd });
  assert.equal(r.model, BRAND_VOICE.model);
});
