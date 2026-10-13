import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runDataBackup, finalizeBackup, tokenOk, validIdent, manifestHash, sha256, KV_PREFIXES, REPORT_KEY } from "../worker/data-backup.mjs";

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
  const now = Date.parse("2026-10-12T05:10:00Z");
  const r = await runDataBackup({ ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "postgres://u:p@h/db" }, { sqlFactory: factory, now });
  const fin = await finalizeBackup({ ZEVANORY_PRIVATE_ARTIFACTS: kv }, { parts: 1, now });
  assert.equal(fin.ok, true, JSON.stringify(fin.failures));
  assert.equal(r.ok, true, JSON.stringify(r.failures));
  assert.equal(r.kv.keys, 2);
  assert.equal(r.neon.tables, 1); assert.equal(r.restore.neon.ok, 1);
  assert.equal(r.restore.kv.sampleOk, true); assert.equal(r.restore.kv.mismatch, 0);
  const bundle = JSON.parse(kv.m.get("zpc:backup:v1:neon:2026-10-12:part:0") || "{}");
  assert.ok(typeof bundle.zevanory_leads === "string", "table exported inside the part bundle");
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

test("manifest is order independent; prefixes cover ledger, subscribers and the switch (not lead interest: T3)", async () => {
  assert.equal(await manifestHash({ x: await sha256("1"), y: "2" }), await manifestHash({ y: "2", x: await sha256("1") }));
  for (const p of ["zpc:sales:", "zpc:cp:", "sales:open:v1"]) assert.ok(KV_PREFIXES.includes(p));
  assert.ok(!KV_PREFIXES.some((p) => p.startsWith("zpc:lead:")), "erased lead data must not survive in backups");
});

test("the trigger endpoint is authenticated and never returns data", () => {
  const src = readFileSync(new URL("../worker/cloudflare-worker.compat.mjs", import.meta.url), "utf8");
  const block = src.slice(src.indexOf('"/api/internal/backup/run"'), src.indexOf('"/api/zea10/autonomy"'));
  assert.match(block, /backupTokenOk\(request\.headers\.get\("x-backup-token"\)/);
  assert.match(block, /method_not_allowed/);
});

test("parts: every table lands in exactly one part, credentials are excluded, a missing part fails the day", async () => {
  const tables = Object.fromEntries(["a_t", "b_t", "c_t", "d_t", "e_t", "provider_oauth_credentials"].map((t) => [t, [{ id: 1 }]]));
  const kv = fakeKv({ "zpc:sales:v1:summary": "{}" });
  const { factory } = fakeSql({ tables });
  const now = Date.parse("2026-10-12T05:10:00Z");
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "postgres://x" };
  const seen = [];
  let writes = 0; const put = kv.put.bind(kv); kv.put = async (...a) => { writes++; return put(...a); };
  const del = kv.delete?.bind(kv); if (del) kv.delete = async (...a) => { writes++; return del(...a); };
  for (let p = 0; p < 3; p++) { const r = await runDataBackup(env, { sqlFactory: factory, now, part: p, parts: 3 }); assert.equal(r.ok, true, JSON.stringify(r.failures)); }
  for (const k of [...kv.m.keys()].filter((k) => k.startsWith("zpc:backup:v1:neon:2026-10-12:part:"))) seen.push(...Object.keys(JSON.parse(kv.m.get(k))));
  // KV write budget (Workers Free: 1,000/day for the account): a whole backup stays in single digits.
  assert.ok(writes <= 10, "backup KV writes " + writes);
  const backed = new Set(seen);
  assert.deepEqual([...backed].sort(), ["a_t", "b_t", "c_t", "d_t", "e_t"]);
  const fin = await finalizeBackup({ ZEVANORY_PRIVATE_ARTIFACTS: kv }, { parts: 3, now });
  assert.equal(fin.ok, true, JSON.stringify(fin));
  assert.equal(fin.neon.excluded[0].table, "provider_oauth_credentials");
  kv.m.delete("zpc:backup:v1:report:part:2");
  assert.equal((await finalizeBackup({ ZEVANORY_PRIVATE_ARTIFACTS: kv }, { parts: 3, now })).ok, false);
});
