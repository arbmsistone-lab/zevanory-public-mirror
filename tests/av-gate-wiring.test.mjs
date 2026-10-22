// P05 — zevanory-av-gate wiring: the publisher and the pack are fail-closed on the FINAL MP4 verdict,
// there is exactly one brand voice (no Piper / no multi-model fallback) and sales-closed content only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { renderShort, avGate, avGateSealed, brandVoice, BRAND_VOICE, planSlot, SLOTS, salesClosedViolations } from "../scripts/channels/youtube-daily-short.mjs";

// Code only (comments may name what was removed).
const SRC = readFileSync(new URL("../scripts/channels/youtube-daily-short.mjs", import.meta.url), "utf8").split("\n").filter(l => !/^\s*\/\//.test(l)).map(l => l.replace(/\s\/\/ .*$/, "")).join("\n");
const voiceOk = async () => ({ pcm: Buffer.alloc(24000 * 2 * 2), rate: 24000, model: BRAND_VOICE.model });
const fakePack = async (raw, script, dir) => {
  await writeFile(dir + "/master.wav", "m"); await writeFile(dir + "/captions.vtt", "WEBVTT\n");
  return { master: dir + "/master.wav", narration: dir + "/narration.m4a", captions: dir + "/captions.vtt", cues: [], duration: 12 };
};
const fakeVideo = async (plan, pkg, out) => { await writeFile(out, "mp4-bytes-" + plan.slot); return { duration: 12 }; };
const base = async (name) => { const b = "/tmp/zevanory-avgate-test-" + name; await rm(b + ".av", { recursive: true, force: true }); await rm(b + ".mp4", { force: true }); await rm(b + ".av-gate.json", { force: true }); return b; };

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
    const gate = async (mp4, manifest) => { seen = JSON.parse(readFileSync(manifest, "utf8")); return { verdict, failed: ["v3.stream_tp"], blocked: [], errors: [] }; };
    await assert.rejects(renderShort(planSlot("2026-10-22", "oferta"), b, { geminiKey: "k", voice: voiceOk, pack: fakePack, video: fakeVideo, gate }), new RegExp("av_gate_" + verdict));
    assert.equal(existsSync(b + ".mp4"), false);
    assert.equal(await avGateSealed(b + ".mp4"), false);
    assert.deepEqual(seen.voice, BRAND_VOICE);
    assert.equal(seen.sales_mode, "closed");
    for (const k of ["script_sha256", "master_sha256", "captions_sha256", "mp4_sha256"]) assert.match(seen[k], /^[0-9a-f]{64}$/);
  });
}

test("gate PASS => sealed file for exactly these bytes; tampering breaks the seal", async () => {
  const b = await base("pass");
  const r = await renderShort(planSlot("2026-10-22", "calc"), b, { geminiKey: "k", voice: voiceOk, pack: fakePack, video: fakeVideo, gate: async () => ({ verdict: "PASS", failed: [], blocked: [], errors: [] }) });
  assert.equal(r.file, b + ".mp4");
  assert.equal(await avGateSealed(b + ".mp4"), true);
  await writeFile(b + ".mp4", "other-bytes");
  assert.equal(await avGateSealed(b + ".mp4"), false);
});

test("avGate wrapper is fail-closed (missing report, exit-code mismatch, unknown verdict)", async () => {
  const dir = "/tmp/zevanory-avgate-wrapper";
  await mkdir(dir, { recursive: true });
  const rep = dir + "/r.json";
  await rm(rep, { force: true });
  assert.equal(avGate("a.mp4", "m.json", rep, { spawn: () => ({ status: 0 }) }).verdict, "ERROR_INFRA");
  await writeFile(rep, JSON.stringify({ verdict: "PASS", decision: {} }));
  assert.equal(avGate("a.mp4", "m.json", rep, { spawn: () => ({ status: 1 }) }).verdict, "ERROR_INFRA");
  assert.equal(avGate("a.mp4", "m.json", rep, { spawn: () => ({ status: 0 }) }).verdict, "PASS");
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
    const wf = readFileSync(new URL("../.github/workflows/" + f, import.meta.url), "utf8");
    assert.doesNotMatch(wf, /piper/i, f);
    assert.match(wf, /scripts\/av_gate\/requirements\.txt/, f);
    assert.match(wf, /scripts\/av_gate\/fetch_models\.sh/, f);
    assert.doesNotMatch(wf, /continue-on-error:\s*true/, f);
    assert.doesNotMatch(wf, /^\s*(push|pull_request|pull_request_target|workflow_run):/m, f);
  }
  const cp = readFileSync(new URL("../scripts/channels/short-crosspost.mjs", import.meta.url), "utf8");
  assert.match(cp, /avGateSealed\(file\)/);
});
