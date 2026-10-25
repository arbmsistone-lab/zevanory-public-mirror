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
  // Sol 233: a verificação passa pelo resolvedor único (janela de migração da credencial de operador).
  assert.match(block, /verifyOperatorToken\(normalized, request\.headers\.get\("x-backup-token"\)\)/);
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

// Raiz do incidente Neon de 15/10 (5 GB/mês de transferência estourados): o backup passa a ser incremental.
function fakeSqlFp(tables) {
  const backup = []; const dumped = [];
  const crypto = globalThis.crypto;
  const md5ish = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].slice(0, 16).map((x) => x.toString(16).padStart(2, "0")).join("");
  const query = async (text, params = []) => {
    if (/^insert into zevanory_kv_backup/.test(text.trim())) { const [day, k, v, h] = params; k.forEach((key, i) => backup.push({ day, key, value: v[i], sha256: h[i] })); return []; }
    if (/from information_schema.tables/.test(text)) return Object.entries(tables).map(([t, rows]) => ({ t, n: rows.length }));
    if (/ as fp\b/.test(text)) return Promise.all(params[0].map(async (t) => ({ t, fp: await md5ish(JSON.stringify(tables[t])) })));
    if (/json_agg/.test(text)) { dumped.push(...params[0]); return params[0].map((t) => ({ t, j: JSON.stringify(tables[t]) })); }
    if (/^with ins as/.test(text.trim())) { const rows = JSON.parse(params[0]); return [{ n: rows.length, h: "same", hb: "same" }]; }
    if (/select key, value, sha256 from zevanory_kv_backup/.test(text)) return backup.filter((r) => r.day === params[0]);
    return [];
  };
  return { factory: () => ({ query }), dumped };
}

test("incremental: unchanged tables are not exported again; the copy is renewed from KV with the same content", async () => {
  const tables = { a_t: [{ id: 1 }], b_t: [{ id: 2 }, { id: 3 }] };
  const kv = fakeKv({ "zpc:sales:v1:summary": "{}" });
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "postgres://x" };
  const s = fakeSqlFp(tables);
  const d1 = Date.parse("2026-10-12T05:10:00Z"), d2 = Date.parse("2026-10-13T05:10:00Z"), d3 = Date.parse("2026-10-14T05:10:00Z");
  const r1 = await runDataBackup(env, { sqlFactory: s.factory, now: d1 });
  assert.equal(r1.ok, true, JSON.stringify(r1.failures)); assert.deepEqual(r1.transfer && [r1.transfer.dumped, r1.transfer.reused], [2, 0]);
  s.dumped.length = 0;
  const r2 = await runDataBackup(env, { sqlFactory: s.factory, now: d2 });
  assert.equal(r2.ok, true, JSON.stringify(r2.failures));
  assert.deepEqual([r2.transfer.dumped, r2.transfer.reused, r2.transfer.dumpBytes], [0, 2, 0]);
  assert.deepEqual(s.dumped, [], "nenhuma exportação do banco quando nada mudou");
  assert.equal(kv.m.get("zpc:backup:v1:neon:2026-10-13:part:0"), kv.m.get("zpc:backup:v1:neon:2026-10-12:part:0"), "cópia renovada idêntica");
  assert.equal(r2.restore.neon.mode, "alteradas"); assert.equal(r2.restore.neon.tables, 0, "dia comum: só tabelas exportadas são ensaiadas");
  tables.b_t.push({ id: 4 }); s.dumped.length = 0;
  const r3 = await runDataBackup(env, { sqlFactory: s.factory, now: d3 });
  assert.equal(r3.ok, true); assert.deepEqual(s.dumped, ["b_t"], "só a tabela alterada é exportada");
  const b3 = JSON.parse(kv.m.get("zpc:backup:v1:neon:2026-10-14:part:0"));
  assert.equal(JSON.parse(b3.b_t).length, 3); assert.equal(JSON.parse(b3.a_t).length, 1);
});

test("incremental: corrupted or missing previous copy forces a full export (never reuses unverified data)", async () => {
  const tables = { a_t: [{ id: 1 }] };
  const kv = fakeKv({});
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "postgres://x" };
  const s = fakeSqlFp(tables);
  await runDataBackup(env, { sqlFactory: s.factory, now: Date.parse("2026-10-12T05:10:00Z") });
  kv.m.set("zpc:backup:v1:neon:2026-10-12:part:0", JSON.stringify({ a_t: '[{"id":999}]' }));
  s.dumped.length = 0;
  const r = await runDataBackup(env, { sqlFactory: s.factory, now: Date.parse("2026-10-13T05:10:00Z") });
  assert.deepEqual(s.dumped, ["a_t"]); assert.equal(r.transfer.reused, 0);
  const b = JSON.parse(kv.m.get("zpc:backup:v1:neon:2026-10-13:part:0")); assert.equal(b.a_t, JSON.stringify(tables.a_t));
  kv.m.delete("zpc:backup:v1:report:part:0"); s.dumped.length = 0;
  await runDataBackup(env, { sqlFactory: s.factory, now: Date.parse("2026-10-14T05:10:00Z") });
  assert.deepEqual(s.dumped, ["a_t"], "sem relatório anterior: exportação completa");
});

test("ensaio de restauração: completo aos domingos, sem cópia anterior ou após 7 dias sem ensaio completo", async () => {
  const tables = { a_t: [{ id: 1 }], b_t: [{ id: 2 }] };
  const kv = fakeKv({});
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "postgres://x" };
  const s = fakeSqlFp(tables);
  const dia = (d) => Date.parse(`2026-10-${d}T05:10:00Z`);
  const r12 = await runDataBackup(env, { sqlFactory: s.factory, now: dia(12) }); // segunda, sem cópia anterior
  assert.equal(r12.restore.neon.mode, "completo"); assert.equal(r12.restore.neon.ok, 2);
  const r13 = await runDataBackup(env, { sqlFactory: s.factory, now: dia(13) });
  assert.equal(r13.restore.neon.mode, "alteradas"); assert.equal(r13.ok, true);
  const fin = await finalizeBackup({ ZEVANORY_PRIVATE_ARTIFACTS: kv }, { parts: 1, now: dia(13) });
  assert.equal(fin.ok, true, JSON.stringify(fin.failures));
  const r18 = await runDataBackup(env, { sqlFactory: s.factory, now: dia(18) }); // domingo
  assert.equal(r18.restore.neon.mode, "completo"); assert.equal(r18.restore.neon.ok, 2);
  // relatório com último ensaio completo antigo (>= 7 dias): força completo mesmo em dia comum
  const rep = JSON.parse(kv.m.get("zpc:backup:v1:report:part:0")); rep.fp.lastFullDrill = "2026-10-11T05:10:00.000Z";
  kv.m.set("zpc:backup:v1:report:part:0", JSON.stringify(rep));
  const r19 = await runDataBackup(env, { sqlFactory: s.factory, now: dia(19) });
  assert.equal(r19.restore.neon.mode, "completo");
});
