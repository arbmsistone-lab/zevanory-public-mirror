import test from "node:test";
import assert from "node:assert/strict";
import { decide } from "../scripts/ops/engine-dispatcher.mjs";
const at = (iso) => Date.parse(iso);
const run = (wf, created, conclusion = "success", status = "completed") => ({ path: ".github/workflows/" + wf, created_at: created, conclusion, status });

test("starts the morning Short and IndexNow after their time when not done", () => {
  const ids = decide({ now: at("2026-10-12T13:30:00Z"), runs: [], kvDone: {} }).map((e) => e.id);
  assert.ok(ids.includes("short-dica")); assert.ok(ids.includes("indexnow")); assert.ok(ids.includes("command-center"));
  assert.ok(!ids.includes("short-oferta"), "only one start per workflow per tick");
});

test("nothing before the due time; nothing when already done; waits while running", () => {
  assert.ok(!decide({ now: at("2026-10-12T12:00:00Z") }).some((e) => e.id === "short-dica"));
  const done = decide({ now: at("2026-10-12T19:00:00Z"), kvDone: { youtube_dica: true, youtube: false } }).map((e) => e.id);
  assert.ok(done.includes("short-oferta") && !done.includes("short-dica"));
  const busy = decide({ now: at("2026-10-12T19:00:00Z"), runs: [run("youtube-autonomous-short.yml", "2026-10-12T18:58:00Z", null, "in_progress")] });
  assert.ok(!busy.some((e) => e.workflow === "youtube-autonomous-short.yml"));
});

test("backs off after a recent attempt and caps attempts per day", () => {
  const recent = decide({ now: at("2026-10-12T13:30:00Z"), runs: [run("youtube-autonomous-short.yml", "2026-10-12T13:20:00Z", "failure")] });
  assert.ok(!recent.some((e) => e.id === "short-dica"));
  const many = Array.from({ length: 9 }, (_, i) => run("youtube-autonomous-short.yml", `2026-10-12T1${3 + Math.floor(i / 6)}:0${i % 6}:00Z`, "failure"));
  assert.ok(!decide({ now: at("2026-10-12T22:30:00Z"), runs: many }).some((e) => e.workflow === "youtube-autonomous-short.yml"));
});

test("hourly snapshot is skipped when a recent success exists; weekly market only on Monday", () => {
  const r = decide({ now: at("2026-10-12T13:30:00Z"), runs: [run("command-center-snapshot.yml", "2026-10-12T13:00:00Z")] });
  assert.ok(!r.some((e) => e.id === "command-center"));
  assert.ok(!decide({ now: at("2026-10-13T13:30:00Z") }).some((e) => e.id === "market"));
});
