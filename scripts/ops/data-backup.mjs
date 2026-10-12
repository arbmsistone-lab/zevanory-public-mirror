// ZEVANORY daily data backup with a real restore drill. Cost: R$ 0 (GitHub Actions on a public
// repository, Cloudflare KV and Neon free plans). Data never touches GitHub: the runner moves it
// directly between the two providers, and the logs carry only counts and hashes (no PII).
//
//   1. KV  -> Neon : critical KV keys (sales ledger, Conteúdo Pronto subscribers, leads' interest,
//                    sales switch) into table zevanory_kv_backup (14 days kept).
//   2. Neon -> KV  : every public table (up to the size cap) as JSON into
//                    zpc:backup:v1:neon:<day>:<table> (8 days kept).
//   3. Restore drill, read from the backup copy (never from the source):
//        Neon: each table restored into the isolated schema zevanory_restore_drill, row count and
//              content hash compared with the backup, then the drill tables are dropped.
//        KV  : every backed-up value re-hashed from Neon; a sample restored into
//              zpc:restore-drill:* (1 h TTL), read back, compared and deleted.
//   4. Report (no PII) at zpc:backup:v1:report; any mismatch fails the run.
import crypto from "node:crypto";

export const REPORT_KEY = "zpc:backup:v1:report";
export const KV_PREFIXES = ["zpc:sales:", "zpc:cp:", "zpc:lead:interest:", "sales:open:v1"];
export const MAX_TABLE_ROWS = 20000;
export const MAX_TABLE_BYTES = 20 * 1024 * 1024;
export const DRILL_SAMPLE = 20;
const BACKUP_TABLE = "zevanory_kv_backup";
const DRILL_SCHEMA = "zevanory_restore_drill";

export const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
export const validIdent = (s) => /^[a-z_][a-z0-9_]{0,62}$/.test(String(s));
export function manifestHash(entries) {
  // Order-independent digest of {key: sha256(value)}.
  return sha256(Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, h]) => k + "=" + h).join("\n"));
}
export function chunk(list, size) { const out = []; for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size)); return out; }

function cf({ token, account, namespace }) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${namespace}`;
  const headers = { authorization: "Bearer " + token };
  const call = async (path, init = {}, attempt = 0) => {
    const r = await fetch(base + path, { ...init, headers: { ...headers, ...(init.headers || {}) }, signal: AbortSignal.timeout(30000) });
    if ((r.status === 429 || r.status >= 500) && attempt < 3) { await new Promise((ok) => setTimeout(ok, 1500 * (attempt + 1))); return call(path, init, attempt + 1); }
    return r;
  };
  return {
    async list(prefix) {
      const names = []; let cursor = "";
      do {
        const r = await call(`/keys?limit=1000&prefix=${encodeURIComponent(prefix)}${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`);
        const j = await r.json();
        if (!j.success) throw new Error("kv_list_failed_" + r.status);
        for (const k of j.result) names.push(k.name);
        cursor = j.result_info?.cursor || "";
      } while (cursor);
      return names;
    },
    async get(key) {
      const r = await call(`/values/${encodeURIComponent(key)}`);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error("kv_get_failed_" + r.status);
      return await r.text();
    },
    async putMany(items) { // [{key, value, expiration_ttl}]
      for (const part of chunk(items, 100)) {
        const r = await call("/bulk", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(part) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.success === false) throw new Error("kv_bulk_put_failed_" + r.status);
      }
    },
    async deleteMany(keys) {
      for (const part of chunk(keys, 1000)) {
        const r = await call("/bulk/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(part) });
        if (!r.ok) throw new Error("kv_bulk_delete_failed_" + r.status);
      }
    },
  };
}

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => { while (i < list.length) { const n = i++; out[n] = await fn(list[n], n); } }));
  return out;
}

export async function main({ env = process.env, now = Date.now() } = {}) {
  const { default: pg } = await import("pg");
  const kv = cf({ token: env.CLOUDFLARE_API_TOKEN, account: env.CLOUDFLARE_ACCOUNT_ID, namespace: env.KV_NAMESPACE_ID });
  const db = new pg.Client({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: true } });
  await db.connect();
  const day = new Date(now).toISOString().slice(0, 10);
  const report = { schema: "zevanory-backup/v1", day, startedAt: new Date(now).toISOString(), ok: false, kv: {}, neon: {}, restore: {}, failures: [] };
  const fail = (what) => report.failures.push(what);
  try {
    // 1. KV -> Neon
    const keys = [...new Set((await mapLimit(KV_PREFIXES, 2, (p) => kv.list(p))).flat())].filter((k) => !k.startsWith("zpc:restore-drill:"));
    const values = await mapLimit(keys, 8, async (k) => [k, await kv.get(k)]);
    const present = values.filter(([, v]) => v != null);
    const sourceHashes = Object.fromEntries(present.map(([k, v]) => [k, sha256(v)]));
    await db.query(`create table if not exists ${BACKUP_TABLE} (snapshot_day date not null, key text not null, value text not null, sha256 text not null, taken_at timestamptz not null default now(), primary key (snapshot_day, key))`);
    for (const part of chunk(present, 200)) {
      await db.query(
        `insert into ${BACKUP_TABLE}(snapshot_day,key,value,sha256) select $1::date, k, v, h from unnest($2::text[], $3::text[], $4::text[]) as t(k, v, h)
         on conflict (snapshot_day, key) do update set value = excluded.value, sha256 = excluded.sha256, taken_at = now()`,
        [day, part.map(([k]) => k), part.map(([, v]) => v), part.map(([k]) => sourceHashes[k])],
      );
    }
    await db.query(`delete from ${BACKUP_TABLE} where snapshot_day < $1::date - 14`, [day]);
    report.kv = { prefixes: KV_PREFIXES, keys: present.length, bytes: present.reduce((s, [, v]) => s + Buffer.byteLength(v), 0), manifest: manifestHash(sourceHashes).slice(0, 16) };

    // 2. Neon -> KV
    const { rows: tables } = await db.query(`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' and table_name <> $1 order by 1`, [BACKUP_TABLE]);
    const exported = []; const skipped = [];
    for (const { table_name: t } of tables) {
      if (!validIdent(t)) { skipped.push({ table: t, reason: "name" }); continue; }
      const { rows: [{ n }] } = await db.query(`select count(*)::int as n from public."${t}"`);
      if (n > MAX_TABLE_ROWS) { skipped.push({ table: t, rows: n, reason: "rows_over_cap" }); continue; }
      const { rows: [{ j }] } = await db.query(`select coalesce(json_agg(x), '[]'::json)::text as j from public."${t}" x`);
      if (Buffer.byteLength(j) > MAX_TABLE_BYTES) { skipped.push({ table: t, rows: n, reason: "bytes_over_cap" }); continue; }
      exported.push({ table: t, rows: n, json: j, sha: sha256(j) });
    }
    await kv.putMany(exported.map((e) => ({ key: `zpc:backup:v1:neon:${day}:${e.table}`, value: e.json, expiration_ttl: 8 * 86400 })));
    report.neon = { tables: exported.length, rows: exported.reduce((s, e) => s + e.rows, 0), skipped, manifest: manifestHash(Object.fromEntries(exported.map((e) => [e.table, e.sha]))).slice(0, 16) };

    // 3a. Neon restore drill, reading the backup copy back from KV.
    await db.query(`create schema if not exists ${DRILL_SCHEMA}`);
    const neonDrill = [];
    for (const e of exported) {
      const stored = await kv.get(`zpc:backup:v1:neon:${day}:${e.table}`);
      const storedOk = stored != null && sha256(stored) === e.sha;
      let restoredRows = null; let contentOk = false;
      if (storedOk) {
        await db.query(`drop table if exists ${DRILL_SCHEMA}."${e.table}"`);
        await db.query(`create table ${DRILL_SCHEMA}."${e.table}" (like public."${e.table}")`);
        await db.query(`insert into ${DRILL_SCHEMA}."${e.table}" select * from json_populate_recordset(null::${DRILL_SCHEMA}."${e.table}", $1::json)`, [stored]);
        const { rows: [{ n, h }] } = await db.query(`select count(*)::int as n, md5(coalesce(string_agg(r, '|' order by r), '')) as h from (select row_to_json(x)::text r from ${DRILL_SCHEMA}."${e.table}" x) s`);
        const { rows: [{ h: hb }] } = await db.query(`select md5(coalesce(string_agg(r, '|' order by r), '')) as h from (select row_to_json(x)::text r from json_populate_recordset(null::${DRILL_SCHEMA}."${e.table}", $1::json) x) s`, [stored]);
        restoredRows = n; contentOk = n === e.rows && h === hb;
        await db.query(`drop table if exists ${DRILL_SCHEMA}."${e.table}"`);
      }
      const ok = storedOk && contentOk;
      if (!ok) fail("neon_restore:" + e.table);
      neonDrill.push({ table: e.table, rows: e.rows, restoredRows, ok });
    }
    // 3b. KV restore drill, reading the backup copy back from Neon.
    const { rows: backed } = await db.query(`select key, value, sha256 from ${BACKUP_TABLE} where snapshot_day = $1::date`, [day]);
    const hashMismatch = backed.filter((r) => sha256(r.value) !== r.sha256 || sourceHashes[r.key] !== r.sha256).length;
    const missing = present.length - backed.filter((r) => sourceHashes[r.key]).length;
    if (hashMismatch || missing) fail(`kv_backup_integrity:${hashMismatch}:${missing}`);
    const sample = backed.slice(0, DRILL_SAMPLE);
    const drillKeys = sample.map((r) => "zpc:restore-drill:" + r.key);
    await kv.putMany(sample.map((r, i) => ({ key: drillKeys[i], value: r.value, expiration_ttl: 3600 })));
    const readBack = await mapLimit(drillKeys, 8, (k) => kv.get(k));
    const kvDrillOk = sample.every((r, i) => readBack[i] != null && sha256(readBack[i]) === r.sha256);
    if (!kvDrillOk) fail("kv_restore_drill");
    if (drillKeys.length) await kv.deleteMany(drillKeys);
    report.restore = {
      neon: { tables: neonDrill.length, ok: neonDrill.filter((d) => d.ok).length, rows: neonDrill.reduce((s, d) => s + (d.restoredRows || 0), 0), isolatedSchema: DRILL_SCHEMA },
      kv: { verified: backed.length, hashMismatch, missing, sampleRestored: sample.length, sampleOk: kvDrillOk },
    };
    report.ok = report.failures.length === 0;
  } catch (e) {
    fail("error:" + String(e?.message || e).replace(/postgres(ql)?:\/\/\S+/g, "[db]").slice(0, 160));
  } finally {
    report.finishedAt = new Date().toISOString();
    try { await kv.putMany([{ key: REPORT_KEY, value: JSON.stringify(report) }]); } catch (e) { report.failures.push("report_write_failed"); report.ok = false; }
    await db.end().catch(() => {});
  }
  return report;
}

const isMain = process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href;
if (isMain) {
  const report = await main();
  console.log("::notice title=DATA_BACKUP::" + JSON.stringify({ ok: report.ok, kv: report.kv, neon: { tables: report.neon.tables, rows: report.neon.rows, skipped: report.neon.skipped }, restore: report.restore, failures: report.failures }));
  if (!report.ok) { console.log("::error title=DATA_BACKUP::" + report.failures.join(", ").slice(0, 400)); process.exit(1); }
}
