// ZEVANORY daily data backup with a real restore drill, executed inside the production Worker
// (the only place that holds the database credential). Cost: R$ 0. The endpoint that triggers it
// never returns data: only a report with counts and hashes.
//
//   1. KV  -> Neon : critical KV keys into zevanory_kv_backup (14 days kept).
//   2. Neon -> KV  : every public table (row cap) as JSON into zpc:backup:v1:neon:<day>:<table>
//                    (8 days kept). The JSON is produced by the database itself.
//   3. Restore drill, read back from the backup copy (never from the source):
//        Neon: tables recreated in the isolated schema zevanory_restore_drill, filled from the
//              KV copy, row count and content hash compared with the copy, then dropped.
//        KV  : every value re-hashed from Neon; a sample restored into zpc:restore-drill:*
//              (1 h TTL), read back, compared and deleted.
//   4. Report (no PII) at zpc:backup:v1:report.
export const REPORT_KEY = "zpc:backup:v1:report";
export const KV_PREFIXES = ["zpc:sales:", "zpc:cp:", "zpc:lead:interest:", "sales:open:v1"];
export const MAX_TABLE_ROWS = 20000;
export const MAX_DRILL_TABLES = 30; // per invocation: keeps a part under the free plan's 50 subrequests
export const DEFAULT_PARTS = 3;
// Credentials are not duplicated into another store: they can be re-issued, a copy only widens exposure.
export const SENSITIVE = /credential|oauth|secret|token|password/i;
export const DRILL_SAMPLE = 20;
const BACKUP_TABLE = "zevanory_kv_backup";
const DRILL = "zevanory_restore_drill";
const DAY = 86400;
const enc = new TextEncoder();

export async function sha256(s) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(String(s))))].map((x) => x.toString(16).padStart(2, "0")).join(""); }
export const validIdent = (s) => /^[a-z_][a-z0-9_]{0,62}$/.test(String(s));
export async function manifestHash(entries) { return sha256(Object.keys(entries).sort().map((k) => k + "=" + entries[k]).join("\n")); }

// Constant-time token check for the trigger endpoint.
export function tokenOk(provided, expected) {
  const a = String(provided || ""), b = String(expected || "");
  if (b.length < 32 || a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function listAll(kv, prefix) {
  const names = []; let cursor;
  do { const page = await kv.list({ prefix, cursor, limit: 1000 }); for (const k of page.keys) names.push(k.name); cursor = page.list_complete ? undefined : page.cursor; } while (cursor);
  return names;
}

export async function runDataBackup(env = {}, { sqlFactory, now = Date.now(), part = 0, parts = 1 } = {}) {
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  const day = new Date(now).toISOString().slice(0, 10);
  const report = { schema: "zevanory-backup/v1", day, part, parts, startedAt: new Date(now).toISOString(), ok: false, kv: {}, neon: {}, restore: {}, failures: [] };
  const fail = (w) => report.failures.push(w);
  if (!kv?.list || !kv?.get || !kv?.put) { fail("kv_unavailable"); return report; }
  if (!env.DATABASE_URL || !sqlFactory) { fail("database_unavailable"); return report; }
  const sql = sqlFactory(String(env.DATABASE_URL));
  try {
    // 1. KV -> Neon (first part only)
    const kvPart = part === 0;
    const keys = !kvPart ? [] : [...new Set((await Promise.all(KV_PREFIXES.map((p) => listAll(kv, p)))).flat())].filter((k) => !k.startsWith("zpc:restore-drill:"));
    const present = (await Promise.all(keys.map(async (k) => [k, await kv.get(k)]))).filter(([, v]) => v != null);
    const hashes = Object.fromEntries(await Promise.all(present.map(async ([k, v]) => [k, await sha256(v)])));
    await sql.query(`create table if not exists ${BACKUP_TABLE} (snapshot_day date not null, key text not null, value text not null, sha256 text not null, taken_at timestamptz not null default now(), primary key (snapshot_day, key))`);
    if (present.length) {
      await sql.query(
        `insert into ${BACKUP_TABLE}(snapshot_day,key,value,sha256) select $1::date, k, v, h from unnest($2::text[], $3::text[], $4::text[]) as t(k, v, h)
         on conflict (snapshot_day, key) do update set value = excluded.value, sha256 = excluded.sha256, taken_at = now()`,
        [day, present.map(([k]) => k), present.map(([, v]) => v), present.map(([k]) => hashes[k])],
      );
    }
    await sql.query(`delete from ${BACKUP_TABLE} where snapshot_day < $1::date - 14`, [day]);
    if (kvPart) report.kv = { keys: present.length, bytes: present.reduce((s, [, v]) => s + v.length, 0), manifest: (await manifestHash(hashes)).slice(0, 16) };

    // 2. Neon -> KV: counts and JSON produced by the database in one round trip.
    const stats = await sql.query(
      `select table_name as t,
              (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', table_name), false, true, '')))[1]::text::int as n
         from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' and table_name <> $1 order by 1`, [BACKUP_TABLE]);
    const skipped = []; const wanted = [];
    const excluded = [];
    stats.forEach(({ t, n }, i) => {
      if (SENSITIVE.test(t)) { if (part === 0) excluded.push({ table: t, rows: n, reason: "credenciais_nao_duplicadas" }); return; }
      if (i % parts !== part) return;
      if (!validIdent(t)) { skipped.push({ table: t, reason: "name" }); fail("not_backed_up:" + t); }
      else if (n > MAX_TABLE_ROWS) { skipped.push({ table: t, rows: n, reason: "rows_over_cap" }); fail("not_backed_up:" + t); }
      else wanted.push({ table: t, rows: n });
    });
    const drillSet = wanted.slice(0, MAX_DRILL_TABLES);
    for (const w of wanted.slice(MAX_DRILL_TABLES)) { skipped.push({ table: w.table, rows: w.rows, reason: "over_table_budget" }); fail("not_backed_up:" + w.table); }
    report.totalTables = stats.length;
    const names = drillSet.map((w) => w.table);
    const dumps = names.length ? await sql.query(
      `select t, (xpath('/row/j/text()', query_to_xml(format('select coalesce(json_agg(x), ''[]''::json)::text as j from public.%I x', t), false, true, '')))[1]::text as j
         from unnest($1::text[]) as t`, [names]) : [];
    const exported = [];
    for (const { t, j } of dumps) {
      const json = j ?? "[]";
      const e = { table: t, rows: drillSet.find((w) => w.table === t).rows, sha: await sha256(json) };
      await kv.put(`zpc:backup:v1:neon:${day}:${t}`, json, { expirationTtl: 8 * DAY });
      exported.push(e);
    }
    report.neon = { tables: exported.length, rows: exported.reduce((s, e) => s + e.rows, 0), skipped, excluded, manifest: (await manifestHash(Object.fromEntries(exported.map((e) => [e.table, e.sha])))).slice(0, 16) };

    // 3a. Neon restore drill from the KV copy, inside the isolated schema.
    await sql.query(`do $$ declare t text; begin
        create schema if not exists ${DRILL};
        foreach t in array $arr$${"{" + names.join(",") + "}"}$arr$::text[] loop
          execute format('drop table if exists ${DRILL}.%I', t);
          execute format('create table ${DRILL}.%I (like public.%I)', t, t);
        end loop; end $$`);
    const neonDrill = [];
    for (const e of exported) {
      const stored = await kv.get(`zpc:backup:v1:neon:${day}:${e.table}`);
      if (stored == null || (await sha256(stored)) !== e.sha) { fail("neon_copy_integrity:" + e.table); neonDrill.push({ table: e.table, ok: false }); continue; }
      const [r] = await sql.query(
        `with ins as (insert into ${DRILL}."${e.table}" select * from json_populate_recordset(null::${DRILL}."${e.table}", $1::json) returning *)
         select (select count(*)::int from ins) as n,
                (select md5(coalesce(string_agg(r, '|' order by r), '')) from (select row_to_json(ins)::text r from ins) a) as h,
                (select md5(coalesce(string_agg(r, '|' order by r), '')) from (select row_to_json(x)::text r from json_populate_recordset(null::${DRILL}."${e.table}", $1::json) x) b) as hb`,
        [stored]);
      const ok = r && r.n === e.rows && r.h === r.hb;
      if (!ok) fail("neon_restore:" + e.table);
      neonDrill.push({ table: e.table, rows: e.rows, restored: r?.n ?? null, ok });
    }
    await sql.query(`do $$ declare t text; begin
        foreach t in array $arr$${"{" + names.join(",") + "}"}$arr$::text[] loop execute format('drop table if exists ${DRILL}.%I', t); end loop; end $$`);

    // 3b. KV restore drill from the Neon copy (first part only).
    const backed = kvPart ? await sql.query(`select key, value, sha256 from ${BACKUP_TABLE} where snapshot_day = $1::date`, [day]) : [];
    let mismatch = 0;
    for (const r of backed) if ((await sha256(r.value)) !== r.sha256 || hashes[r.key] !== r.sha256) mismatch++;
    const missing = present.length - backed.filter((r) => hashes[r.key]).length;
    if (mismatch || missing) fail(`kv_copy_integrity:${mismatch}:${missing}`);
    const sample = backed.slice(0, DRILL_SAMPLE);
    for (const r of sample) await kv.put("zpc:restore-drill:" + r.key, r.value, { expirationTtl: 3600 });
    let sampleOk = true;
    for (const r of sample) { const back = await kv.get("zpc:restore-drill:" + r.key); if (back == null || (await sha256(back)) !== r.sha256) sampleOk = false; await kv.delete("zpc:restore-drill:" + r.key); }
    if (!sampleOk) fail("kv_restore_drill");
    report.restore = {
      neon: { tables: neonDrill.length, ok: neonDrill.filter((d) => d.ok).length, rows: neonDrill.reduce((s, d) => s + (d.restored || 0), 0), isolatedSchema: DRILL },
      kv: { verified: backed.length, mismatch, missing, sampleRestored: sample.length, sampleOk },
    };
    report.ok = report.failures.length === 0;
  } catch (e) {
    fail("error:" + String(e?.message || e).replace(/postgres(ql)?:\/\/\S+/g, "[db]").slice(0, 200));
  }
  report.finishedAt = new Date().toISOString();
  try { await kv.put(`${REPORT_KEY}:part:${part}`, JSON.stringify(report), { expirationTtl: 3 * DAY }); } catch { report.failures.push("report_write_failed"); report.ok = false; }
  return report;
}

// Combines today's parts into the single report the panel and the inventory read.
// OK only when every part ran today, every part passed and no table was left out.
export async function finalizeBackup(env = {}, { parts = DEFAULT_PARTS, now = Date.now() } = {}) {
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  const day = new Date(now).toISOString().slice(0, 10);
  const got = [];
  for (let i = 0; i < parts; i++) { try { got.push(JSON.parse(String(await kv.get(`${REPORT_KEY}:part:${i}`) || "null"))); } catch { got.push(null); } }
  const failures = [];
  got.forEach((r, i) => { if (!r || r.day !== day) failures.push("part_missing:" + i); else failures.push(...(r.failures || [])); });
  const valid = got.filter((r) => r && r.day === day);
  const sum = (f) => valid.reduce((s, r) => s + (f(r) || 0), 0);
  const first = valid.find((r) => r.part === 0) || {};
  const report = {
    schema: "zevanory-backup/v1", day, parts, finishedAt: new Date().toISOString(),
    kv: first.kv || {}, totalTables: first.totalTables ?? null,
    neon: { tables: sum((r) => r.neon?.tables), rows: sum((r) => r.neon?.rows), excluded: first.neon?.excluded || [], skipped: valid.flatMap((r) => r.neon?.skipped || []) },
    restore: { neon: { tables: sum((r) => r.restore?.neon?.tables), ok: sum((r) => r.restore?.neon?.ok), rows: sum((r) => r.restore?.neon?.rows), isolatedSchema: DRILL }, kv: first.restore?.kv || null },
    failures,
  };
  report.coverage = report.totalTables ? `${report.neon.tables} de ${report.totalTables - report.neon.excluded.length} tabelas (credenciais fora por política: ${report.neon.excluded.length})` : null;
  report.ok = failures.length === 0 && valid.length === parts && report.restore.neon.ok === report.neon.tables && report.totalTables != null && report.neon.tables === report.totalTables - report.neon.excluded.length;
  await kv.put(REPORT_KEY, JSON.stringify(report));
  return report;
}
