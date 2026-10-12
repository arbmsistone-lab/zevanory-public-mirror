import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runDataBackup, tokenOk, validIdent, manifestHash, sha256, KV_PREFIXES, REPORT_KEY } from "../worker/data-backup.mjs";

function fakeKv(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    m,
    async list({ prefix }) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
  };
}

// Minimal SQL double: answers each statement of the backup by its shape.
function fakeSql({ tables = { zevanory_leads: [{ id: 1, email_hash: "a" }, { id: 2, email_hash: "b" }] }, corruptRestore = false } = {}) {
  const backup = [];
  const calls = [];
  const query = async (text, params = []) => {
    calls.push(text.replace(/\s+/g, " ").slice(0, 60));
    if (/^insert into zevanory_kv_backup/.test(text.trim())) { const [, k, v, h] = params; k.forEach((key, i) => backup.push({ key, value: v[i], sha256: h[i] })); return []; }
    if (/from information_schema.tables/.test(text)) return Object.entries(tables).map(([t, rows]) => ({ t, n: rows.length }));
    if (/json_agg/.test(text)) return params[0].map((t) => ({ t, j: JSON.stringify(tables[t]) }));
    if (/^with ins as/.test(text.trim())) { const rows = JSON.parse(params[0]); return [{ n: rows.length, h: corruptRestore ? "x" : "same", hb: "same" }]; }
    if (/select key, value, sha256 from zevanory_kv_backup/.test(text)) return backup;
    return [];
  };
  return { factory: () => ({ query }), calls };
}

test("full run: copies both ways, restores from the copies and reports only counts and hashes", async () => {
  const kv = fakeKv({ "zpc:sales:v1:summary": '{"totals":{"approved":0}}', "zpc:cp:sub:x": '{"plan":"cp"}', "unrelated:key": "no" });
  const { factory } = fakeSql();
  const r = await runDataBackup({ ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "postgres://u:p@h/db" }, { sqlFactory: factory, now: Date.parse("2026-10-12T05:10:00Z") });
  assert.equal(r.ok, true, JSON.stringify(r.failures));
  assert.equal(r.kv.keys, 2);
  assert.equal(r.neon.tables, 1); assert.equal(r.restore.neon.ok, 1);
  assert.equal(r.restore.kv.sampleOk, true); assert.equal(r.restore.kv.mismatch, 0);
  assert.ok(kv.m.has("zpc:backup:v1:neon:2026-10-12:zevanory_leads"));
  assert.ok(![...kv.m.keys()].some((k) => k.startsWith("zpc:restore-drill:")), "drill keys are cleaned up");
  const stored = JSON.parse(kv.m.get(REPORT_KEY));
  assert.doesNotMatch(JSON.stringify(stored), /email_hash|cp"|approved/); // no data in the report
});

test("a restore that does not match the copy fails the run", async () => {
  const { factory } = fakeSql({ corruptRestore: true });
  const r = await runDataBackup({ ZEVANORY_PRIVATE_ARTIFACTS: fakeKv(), DATABASE_URL: "postgres://x" }, { sqlFactory: factory });
  assert.equal(r.ok, false); assert.ok(r.failures.some((f) => f.startsWith("neon_restore:")));
});

test("missing database or KV fails closed", async () => {
  assert.equal((await runDataBackup({ ZEVANORY_PRIVATE_ARTIFACTS: fakeKv() }, {})).ok, false);
  assert.equal((await runDataBackup({ DATABASE_URL: "x" }, { sqlFactory: () => ({}) })).ok, false);
});

test("trigger token: constant-time, exact, minimum length", () => {
  const t = "a".repeat(40);
  assert.equal(tokenOk(t, t), true);
  assert.equal(tokenOk("a".repeat(39) + "b", t), false);
  assert.equal(tokenOk("", t), false);
  assert.equal(tokenOk("short", "short"), false);
});

test("identifiers are validated before reaching SQL", () => {
  assert.ok(validIdent("zevanory_leads"));
  for (const bad of ['x"; drop table y; --', "Leads", "a b", "", "1abc", "a,b", "a}b"]) assert.equal(validIdent(bad), false);
});

test("manifest is order independent; prefixes cover ledger, subscribers, leads and the switch", async () => {
  assert.equal(await manifestHash({ x: await sha256("1"), y: "2" }), await manifestHash({ y: "2", x: await sha256("1") }));
  for (const p of ["zpc:sales:", "zpc:cp:", "zpc:lead:interest:", "sales:open:v1"]) assert.ok(KV_PREFIXES.includes(p));
});

test("the trigger endpoint is authenticated and never returns data", () => {
  const src = readFileSync(new URL("../worker/cloudflare-worker.compat.mjs", import.meta.url), "utf8");
  const block = src.slice(src.indexOf('"/api/internal/backup/run"'), src.indexOf('"/api/zea10/autonomy"'));
  assert.match(block, /backupTokenOk\(request\.headers\.get\("x-backup-token"\)/);
  assert.match(block, /method_not_allowed/);
});
