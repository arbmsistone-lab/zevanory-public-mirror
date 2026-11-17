// ZEVANORY daily data backup with a real restore drill, executed inside the production Worker
// (the only place that holds the database credential). Cost: R$ 0. The endpoint that triggers it
// never returns data: only a report with counts and hashes.
//
//   1. KV  -> Neon : critical KV keys into zevanory_kv_backup (14 days kept), with each key's TTL (absolute
//                    expiration) and metadata as returned by kv.list (no extra subrequest).
//   2. Neon -> KV  : every public table (row cap) as JSON into zpc:backup:v1:neon:<day>:<table>
//                    (8 days kept). The JSON is produced by the database itself.
//   3. Restore drill, read back from the backup copy (never from the source):
//        Neon: tables recreated in the isolated schema zevanory_restore_drill, filled from the
//              KV copy, row count and content hash compared with the copy, then dropped.
//        KV  : every value re-hashed from Neon; a sample restored into zpc:restore-drill:*
//              (1 h TTL), read back, compared and deleted.
//        KV copy for the MONTHLY drill (P20, seção 9.1): today's rows of zevanory_kv_backup, as READ BACK FROM NEON
//              (the copy, never the source), go to zpc:backup:v1:kv:<day> (AES-256-GCM envelope with the backup key,
//              8 days). The source manifest (per-key SHA-256 + TTL + metadata, kv.entries_manifest) is computed from
//              the KV itself before the copy. The CI drill restores those rows into an ephemeral Postgres, rebuilds a
//              KV from them and checks it key by key against that manifest, without any Neon credential.
//   4. Report (no PII) at zpc:backup:v1:report.
// P20 (seção 9.1): with the secret P20_BACKUP_KEY the Neon -> KV bundle is stored as an AES-256-GCM envelope
// (worker/backup-crypto.mjs, docs/p20/cifragem-backup.md); the per-table SHA-256 manifest stays over the plaintext.
import { ENCRYPTION_REQUIRED, ENC_FORMAT, ENC_ALG, loadBackupKey, sealBundle, openBundle, bundleCtxFromKey, loadReportKey, hmacHex, canonical } from "./backup-crypto.mjs";
import { reconciliaDiario, efeitoNoRelatorio, DIARIO_FASE } from "./diario-reconcilia.mjs";
export { ENCRYPTION_REQUIRED };
export const REPORT_KEY = "zpc:backup:v1:report";
// Lead interest keys (personal data, erased on revocation) are deliberately NOT copied: a backup
// would keep them after the erasure promised by the privacy policy (T3). They are not critical.
export const KV_PREFIXES = ["zpc:sales:", "zpc:cp:", "sales:open:v1"];
export const MAX_TABLE_ROWS = 20000;
export const MAX_DRILL_TABLES = 30; // per invocation: keeps a part under the free plan's 50 subrequests
export const DEFAULT_PARTS = 3;
// P20 v2 (docs/p20/particoes-v2.md): partes dinâmicas = ceil(elegíveis / 30), no máximo 6 (limite da rota).
export const MAX_PARTS = 6;
export const CONTRACT_V2 = 2;
export const PLAN_SCHEMA = "zevanory-backup-plan/v2";
// Credentials are not duplicated into another store: they can be re-issued, a copy only widens exposure.
export const SENSITIVE = /credential|oauth|secret|token|password/i;
export const DRILL_SAMPLE = 20;
export const KV_COPY_FORMAT = "zevanory-kv-copy/v1";
export const kvCopyKeyFor = (day) => `zpc:backup:v1:kv:${day}`;
const BACKUP_TABLE = "zevanory_kv_backup";
const DRILL = "zevanory_restore_drill";
const DAY = 86400;
const enc = new TextEncoder();

export async function sha256(s) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(String(s))))].map((x) => x.toString(16).padStart(2, "0")).join(""); }
export const RETENTION_DAYS = 14;

// Retention may NEVER delete the last intact recoverable copy (Sol 165). A copy is proven valid only by its manifest,
// a per-row integrity check and a passed restore drill. snapshots = [{ day: "YYYY-MM-DD", valid: true|false|null }]
// (null = not proven in this run). Returns the days that may be deleted: only days older than the retention window AND
// older than the newest proven-valid copy, which itself is never deleted. No proven-valid copy: nothing is deleted.
export function planRetention({ today, snapshots = [], keepDays = RETENTION_DAYS }) {
  const cutoff = new Date(Date.parse(today + "T00:00:00Z") - keepDays * DAY * 1000).toISOString().slice(0, 10);
  const proven = snapshots.filter((s) => s && s.valid === true).map((s) => s.day).sort();
  const newestValid = proven.length ? proven[proven.length - 1] : null;
  if (!newestValid) return { cutoff, newestValid: null, delete: [], reason: "no_proven_valid_copy" };
  const del = [...new Set(snapshots.map((s) => s.day))].filter((d) => d < cutoff && d < newestValid).sort();
  return { cutoff, newestValid, delete: del, reason: del.length ? "expired_copies_older_than_newest_valid" : "nothing_expired" };
}

export const validIdent = (s) => /^[a-z_][a-z0-9_]{0,62}$/.test(String(s));
export async function manifestHash(entries) { return sha256(Object.keys(entries).sort().map((k) => k + "=" + entries[k]).join("\n")); }
// Per-key entry of the KV source manifest: value hash, absolute expiration (s) and metadata hash (JSON text).
// Contract shared with scripts/p20/restore-drill-lib.mjs kvEntryDigest (independent implementation, tested together).
export async function kvEntryDigest({ sha, expiration, metadata }) {
  return `${sha}|${expiration == null ? "" : String(expiration)}|${metadata == null ? "" : await sha256(metadata)}`;
}

// Constant-time token check for the trigger endpoint.
export function tokenOk(provided, expected) {
  const a = String(provided || ""), b = String(expected || "");
  if (b.length < 32 || a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// kv.list already returns each key's expiration (unix seconds) and metadata: captured at no extra cost.
async function listAll(kv, prefix) {
  const out = []; let cursor;
  do {
    const page = await kv.list({ prefix, cursor, limit: 1000 });
    for (const k of page.keys) out.push({ name: k.name, expiration: Number.isInteger(k.expiration) ? k.expiration : null, metadata: k.metadata == null ? null : JSON.stringify(k.metadata) });
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// P20 v2: plano do dia. Garantia: com parts = ceil(E/30) e atribuição circular sobre as ELEGÍVEIS (j % parts),
// cada parte recebe floor(E/parts) ou ceil(E/parts) <= 30 tabelas (demonstração em docs/p20/particoes-v2.md).
// As tabelas de credencial saem da lista ANTES da numeração, então a posição delas não afeta a distribuição.
export function partsFor(eligibleCount) { return eligibleCount <= 0 ? 1 : Math.ceil(eligibleCount / MAX_DRILL_TABLES); }
export function assignParts(eligible, parts) {
  const out = Array.from({ length: parts }, () => []);
  eligible.forEach((t, j) => out[j % parts].push(t));
  return out;
}
const byCodepoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Inventário lido do PRÓPRIO banco: tabelas BASE do public (menos a tabela de backup do KV) com (coluna, tipo, nulidade).
export async function readInventory(sql) {
  const rows = await sql.query(
    `select t.table_name as t,
            coalesce((select json_agg(json_build_array(c.column_name, c.data_type, c.is_nullable) order by c.ordinal_position)::text
                        from information_schema.columns c where c.table_schema = 'public' and c.table_name = t.table_name), '[]') as cols
       from information_schema.tables t
      where t.table_schema = 'public' and t.table_type = 'BASE TABLE' and t.table_name <> $1
      order by t.table_name collate "C"`, [BACKUP_TABLE]);
  return (rows || []).map((r) => ({ t: String(r.t), cols: typeof r.cols === "string" ? JSON.parse(r.cols) : (r.cols || []) })).sort((a, b) => byCodepoint(a.t, b.t));
}

// Plano autenticado. plan_id = HMAC-SHA256(K_rel, JSON canônico do plano). Sem chave (só fora da produção, com
// cifragem opcional): plan_id = "sha256:" + SHA-256 do plano e auth "nao_autenticado" (nunca "completo" adiante).
export async function computePlan({ sql, env = {}, day, encryptionRequired = ENCRYPTION_REQUIRED }) {
  const rk = await loadReportKey(env.P20_BACKUP_KEY);
  if (rk.state === "invalid") return { ok: false, failures: ["backup_key_invalid"] };
  if (rk.state === "absent" && encryptionRequired) return { ok: false, failures: ["backup_key_absent_encryption_required"] };
  const inv = await readInventory(sql);
  const eligible = inv.filter((x) => !SENSITIVE.test(x.t)).map((x) => x.t);
  const excluded = inv.filter((x) => SENSITIVE.test(x.t)).map((x) => x.t);
  const fingerprint = await sha256(canonical(inv.filter((x) => !SENSITIVE.test(x.t)).map((x) => [x.t, x.cols])));
  const parts = partsFor(eligible.length);
  if (parts > MAX_PARTS) return { ok: false, failures: ["capacity_exceeded:" + eligible.length], eligible: eligible.length };
  const plan = { schema: PLAN_SCHEMA, v: CONTRACT_V2, day, eligible, excluded, fingerprint, parts, per_part_max: MAX_DRILL_TABLES };
  const text = canonical(plan);
  const plan_id = rk.state === "present" ? await hmacHex(rk, text) : "sha256:" + (await sha256(text));
  // colsOf (fora do plano, só para a parte): nomes das colunas por tabela, na ordem do banco, para conferir o conteúdo exportado.
  const colsOf = Object.fromEntries(inv.map((x) => [x.t, x.cols.map((c) => c[0])]));
  return { ok: true, failures: [], plan, plan_id, auth: rk.state === "present" ? { state: "autenticado", alg: "HMAC-SHA256", kid: rk.kid } : { state: "nao_autenticado" }, rk, colsOf };
}

// Resposta pública da rota de plano: só contagens, plan_id e o kid (nunca nomes de tabela ou dados).
export async function planBackup(env = {}, { sqlFactory, now = Date.now(), encryptionRequired = ENCRYPTION_REQUIRED } = {}) {
  const day = new Date(now).toISOString().slice(0, 10);
  if (!env.DATABASE_URL || !sqlFactory) return { schema: PLAN_SCHEMA, ok: false, day, failures: ["database_unavailable"] };
  try {
    const p = await computePlan({ sql: sqlFactory(String(env.DATABASE_URL)), env, day, encryptionRequired });
    if (!p.ok) return { schema: PLAN_SCHEMA, ok: false, day, failures: p.failures };
    return { schema: PLAN_SCHEMA, ok: true, day, plan_id: p.plan_id, parts: p.plan.parts, eligible: p.plan.eligible.length, excluded: p.plan.excluded.length, auth: p.auth, failures: [] };
  } catch (e) {
    return { schema: PLAN_SCHEMA, ok: false, day, failures: ["error:" + String(e?.message || e).replace(/postgres(ql)?:\/\/\S+/g, "[db]").slice(0, 200)] };
  }
}

export const RUN_ID_RE = /^[0-9a-f]{32}$/;

// P20 v2: parte REJEITADA não grava NADA no KV (nem o próprio relatório). O relatório válido que estiver lá (de outra
// chamada) fica intacto; a rejeição volta só na resposta HTTP. A consolidação exige o run_id desta execução em TODAS as
// partes, então uma parte rejeitada nesta execução nunca é suprida por um relatório antigo (part_run_mismatch).
function reject(report) {
  report.ok = false;
  report.rejected = true;
  report.finishedAt = new Date().toISOString();
  return report;
}

export async function runDataBackup(env = {}, { sqlFactory, now = Date.now(), part = 0, parts = 1, encryptionRequired = ENCRYPTION_REQUIRED, planId = null, runId = null } = {}) {
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  const day = new Date(now).toISOString().slice(0, 10);
  const report = { schema: "zevanory-backup/v1", day, part, parts, startedAt: new Date(now).toISOString(), ok: false, kv: {}, neon: {}, restore: {}, failures: [] };
  const fail = (w) => report.failures.push(w);
  if (!kv?.list || !kv?.get || !kv?.put) { fail("kv_unavailable"); return report; }
  if (!env.DATABASE_URL || !sqlFactory) { fail("database_unavailable"); return report; }
  // Cifragem (fase 1: sem chave, texto claro marcado "nao_cifrado"; chave inválida ou cifragem obrigatória sem chave:
  // a parte falha ANTES de qualquer escrita, nunca grava em claro em silêncio).
  const bk = await loadBackupKey(env.P20_BACKUP_KEY);
  report.encryption = bk.state === "present" ? { state: "cifrado", format: ENC_FORMAT, alg: ENC_ALG, kid: bk.kid } : { state: "nao_cifrado", format: null, alg: null, kid: null, reason: bk.state === "invalid" ? "key_invalid" : "key_absent" };
  if (bk.state === "invalid") { fail("backup_key_invalid"); return report; }
  if (bk.state === "absent" && encryptionRequired) { fail("backup_key_absent_encryption_required"); return report; }
  report.warnings = bk.state === "present" ? [] : ["backup_nao_cifrado"];
  const encKeys = bk.state === "present" ? [bk] : [];
  const sql = sqlFactory(String(env.DATABASE_URL));
  const v2 = typeof planId === "string" && planId.length > 0;
  let myTables = null;
  let pl = null;
  try {
    // P20 v2: a parte RELÊ o inventário e recalcula o plano. Se o plan_id não for o recebido (esquema mudou, outro dia,
    // plano forjado), falha ANTES de qualquer escrita: nunca há cobertura parcial aceita.
    if (v2) {
      report.contract = CONTRACT_V2;
      if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) { fail("run_id_missing_or_malformed"); return reject(report); }
      report.run_id = runId;
      pl = await computePlan({ sql, env, day, encryptionRequired });
      if (!pl.ok) { pl.failures.forEach(fail); return reject(report); }
      if (pl.plan_id !== planId) { fail("inventory_changed"); return reject(report); }
      if (!Number.isInteger(part) || part < 0 || part >= pl.plan.parts) { fail("part_out_of_range"); return reject(report); }
      report.parts = pl.plan.parts;
      report.plan_id = pl.plan_id;
      report.auth = pl.auth;
      if (part === 0) report.plan = pl.plan;
      myTables = assignParts(pl.plan.eligible, pl.plan.parts)[part];
    }
    // 1. KV -> Neon (first part only)
    const kvPart = part === 0;
    const listed = new Map();
    if (kvPart) for (const e of (await Promise.all(KV_PREFIXES.map((p) => listAll(kv, p)))).flat()) if (!e.name.startsWith("zpc:restore-drill:") && !listed.has(e.name)) listed.set(e.name, e);
    const keys = [...listed.keys()];
    const present = (await Promise.all(keys.map(async (k) => [k, await kv.get(k)]))).filter(([, v]) => v != null);
    const hashes = Object.fromEntries(await Promise.all(present.map(async ([k, v]) => [k, await sha256(v)])));
    const metaOf = (k) => listed.get(k) || { expiration: null, metadata: null };
    // Source manifest of the KV (value hash + TTL + metadata per key), computed from the KV BEFORE the copy.
    const entries = Object.fromEntries(await Promise.all(present.map(async ([k]) => [k, await kvEntryDigest({ sha: hashes[k], ...metaOf(k) })])));
    await sql.query(`create table if not exists ${BACKUP_TABLE} (snapshot_day date not null, key text not null, value text not null, sha256 text not null, taken_at timestamptz not null default now(), expiration bigint, metadata text, primary key (snapshot_day, key))`);
    if (kvPart) await sql.query(`alter table zevanory_kv_backup add column if not exists expiration bigint, add column if not exists metadata text`);
    if (present.length) {
      await sql.query(
        `insert into ${BACKUP_TABLE}(snapshot_day,key,value,sha256,expiration,metadata) select $1::date, k, v, h, e, m from unnest($2::text[], $3::text[], $4::text[], $5::bigint[], $6::text[]) as t(k, v, h, e, m)
         on conflict (snapshot_day, key) do update set value = excluded.value, sha256 = excluded.sha256, expiration = excluded.expiration, metadata = excluded.metadata, taken_at = now()`,
        [day, present.map(([k]) => k), present.map(([, v]) => v), present.map(([k]) => hashes[k]), present.map(([k]) => metaOf(k).expiration), present.map(([k]) => metaOf(k).metadata)],
      );
    }
    // Retention runs only AFTER today's copy is proven (manifest + integrity + drill): see step 3c below.
    if (kvPart) report.kv = { keys: present.length, bytes: present.reduce((s, [, v]) => s + v.length, 0), manifest: (await manifestHash(hashes)).slice(0, 16), entries_manifest: await manifestHash(entries) };

    // 2. Neon -> KV: counts and JSON produced by the database in one round trip.
    const stats = await sql.query(
      `select table_name as t,
              (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', table_name), false, true, '')))[1]::text::int as n
         from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' and table_name <> $1 order by 1`, [BACKUP_TABLE]);
    const skipped = []; const wanted = [];
    const excluded = [];
    // v2: a parte copia EXATAMENTE as tabelas que o plano autenticado atribuiu a ela; uma tabela do plano ausente agora
    // no banco é mudança de inventário (falha). v1 (legado): índice entre TODAS as tabelas (inclui as de credencial).
    if (v2) for (const t of myTables) if (!stats.some((s) => s.t === t)) fail("inventory_changed");
    stats.forEach(({ t, n }, i) => {
      if (SENSITIVE.test(t)) { if (part === 0) excluded.push({ table: t, rows: n, reason: "credenciais_nao_duplicadas" }); return; }
      if (v2 ? !myTables.includes(t) : i % parts !== part) return;
      if (!validIdent(t)) { skipped.push({ table: t, reason: "name" }); fail("not_backed_up:" + t); }
      else if (n > MAX_TABLE_ROWS) { skipped.push({ table: t, rows: n, reason: "rows_over_cap" }); fail("not_backed_up:" + t); }
      else wanted.push({ table: t, rows: n });
    });
    if (v2 && report.failures.includes("inventory_changed")) return reject(report);
    const drillSet = wanted.slice(0, MAX_DRILL_TABLES);
    for (const w of wanted.slice(MAX_DRILL_TABLES)) { skipped.push({ table: w.table, rows: w.rows, reason: "over_table_budget" }); fail("not_backed_up:" + w.table); }
    report.totalTables = stats.length;
    const names = drillSet.map((w) => w.table);
    // Incremental (raiz do incidente Neon de 15/10: cada backup exportava o banco inteiro e estourou os 5 GB/mês de
    // transferência do plano Free). A impressão digital de cada tabela é calculada DENTRO do banco (md5 de 32 bytes por
    // tabela, transferência desprezível); só as tabelas que mudaram desde a última cópia válida são exportadas. As
    // inalteradas são copiadas do bundle anterior no KV (sem tráfego do banco), o que também renova a validade da cópia.
    // As impressões da última execução ficam no relatório da própria parte (já gravado a cada execução, validade de 3
    // dias): nenhuma escrita extra no KV (cota do Workers Free: 1.000 escritas/dia). Sem relatório válido: exportação completa.
    let prev = {};
    try { prev = (JSON.parse(String(await kv.get(`${REPORT_KEY}:part:${part}`) || "{}")) || {}).fp || {}; } catch { prev = {}; }
    const fps = names.length ? await sql.query(
      `select t, (xpath('/row/h/text()', query_to_xml(format('select md5(coalesce(string_agg(r, ''|'' order by r), '''')) as h from (select row_to_json(x)::text r from public.%I x) s', t), false, true, '')))[1]::text as fp
         from unnest($1::text[]) as t`, [names]) : [];
    const fpOf = Object.fromEntries((fps || []).filter((r) => r && typeof r.fp === "string" && /^[0-9a-f]{32}$/.test(r.fp)).map((r) => [r.t, r.fp]));
    let prevBundle = null;
    const reused = {};
    for (const t of names) {
      const p = prev.tables && prev.tables[t];
      if (!fpOf[t] || !p || p.fp !== fpOf[t] || !prev.bundleKey) continue;
      // Bundle anterior cifrado com outra chave (rotação) ou ilegível: exportação completa (nunca reaproveita sem prova).
      if (prevBundle === null) { try { const c = bundleCtxFromKey(prev.bundleKey); prevBundle = c ? JSON.parse((await openBundle(await kv.get(prev.bundleKey), c, encKeys)).text) || {} : {}; } catch { prevBundle = {}; } }
      const j = prevBundle[t];
      if (typeof j === "string" && (await sha256(j)) === p.sha) reused[t] = j;
    }
    const toDump = names.filter((t) => !(t in reused));
    const fresh = toDump.length ? await sql.query(
      `select t, (xpath('/row/j/text()', query_to_xml(format('select coalesce(json_agg(x), ''[]''::json)::text as j from public.%I x', t), false, true, '')))[1]::text as j
         from unnest($1::text[]) as t`, [toDump]) : [];
    // P20 v2: o esquema pode mudar entre a validação do plano (acima) e a exportação. Duas conferências DEPOIS da
    // exportação e ANTES de qualquer escrita no KV:
    //  (a) cada linha exportada tem exatamente as colunas do inventário validado (pega coluna criada, removida ou
    //      renomeada no meio, mesmo que desfeita antes de (b));
    //  (b) o plano é recalculado e tem de ser o mesmo (pega também mudança de tipo ou de nulidade).
    // Divergência: a parte é rejeitada sem gravar (o dia não fecha: falta o relatório desta execução).
    if (v2) {
      for (const r of fresh || []) {
        const want = (pl.colsOf[r.t] || []).join("\u0000");
        let rowsJ;
        try { rowsJ = JSON.parse(String(r.j ?? "[]")); } catch { rowsJ = null; }
        if (!Array.isArray(rowsJ) || rowsJ.some((o) => !o || typeof o !== "object" || Object.keys(o).join("\u0000") !== want)) { fail("export_columns_mismatch:" + r.t); }
      }
      const post = await computePlan({ sql, env, day, encryptionRequired });
      if (!post.ok || post.plan_id !== planId) fail("inventory_changed_during_export");
      if (report.failures.some((f) => f === "inventory_changed_during_export" || f.startsWith("export_columns_mismatch:"))) return reject(report);
    }
    const dumps = [...fresh, ...Object.entries(reused).map(([t, j]) => ({ t, j }))];
    const dumpBytes = fresh.reduce((s, r) => s + String(r.j ?? "").length, 0);
    // Ensaio de restauração (contestação T2 do Sol, Ordem 008): completo aos domingos (UTC) ou sem cópia anterior;
    // nos demais dias, só as tabelas exportadas agora. As reaproveitadas têm SHA-256 idêntico a uma cópia já ensaiada.
    const ultimoCompleto = Date.parse(String(prev.lastFullDrill || ""));
    const drillAll = new Date(now).getUTCDay() === 0 || !prev.bundleKey || !Number.isFinite(ultimoCompleto) || now - ultimoCompleto >= 7 * DAY * 1000;
    const drillNames = drillAll ? names : names.filter((t) => toDump.includes(t));
    // ONE KV write per part (Workers Free: 1,000 KV writes per day for the whole account; one key
    // per table spent ~50 writes per backup and exhausted the quota on 12/10).
    const exported = [];
    const bundle = {};
    for (const { t, j } of dumps) {
      const json = j ?? "[]";
      // v2: as linhas do relatório são contadas NO CONTEÚDO COPIADO (não na estatística, que é outra instrução e pode
      // divergir se houver escrita no meio). v1: estatística, como antes.
      let rows = drillSet.find((w) => w.table === t).rows;
      if (v2) { try { const a = JSON.parse(json); rows = Array.isArray(a) ? a.length : -1; } catch { rows = -1; } if (rows < 0) fail("neon_copy_not_array:" + t); }
      exported.push({ table: t, rows, sha: await sha256(json) });
      bundle[t] = json;
    }
    const bundleKey = `zpc:backup:v1:neon:${day}:part:${part}`;
    const bctx = { day, part, bundleKey };
    if (exported.length) {
      const stored = bk.state === "present" ? await sealBundle(JSON.stringify(bundle), bctx, bk) : JSON.stringify(bundle);
      await kv.put(bundleKey, stored, { expirationTtl: 8 * DAY });
      // v2: hash do VALOR GRAVADO (envelope), conferido pelo arquivador antes de arquivar a parte.
      if (v2) report.bundle = { key: bundleKey, sha256: await sha256(stored) };
    }
    if (v2) report.tables = Object.fromEntries(exported.map((e) => [e.table, { rows: e.rows, sha: e.sha }]));
    {
      const tablesFp = {};
      for (const e of exported) if (fpOf[e.table]) tablesFp[e.table] = { fp: fpOf[e.table], sha: e.sha };
      report.fp = { bundleKey, tables: tablesFp };
    }
    report.transfer = { dumped: toDump.length, reused: Object.keys(reused).length, dumpBytes };
    report.neon = { tables: exported.length, rows: exported.reduce((s, e) => s + e.rows, 0), skipped, excluded, manifest: (await manifestHash(Object.fromEntries(exported.map((e) => [e.table, e.sha])))).slice(0, 16) };

    // 3a. Neon restore drill from the KV copy, inside the isolated schema.
    await sql.query(`do $$ declare t text; begin
        create schema if not exists ${DRILL};
        foreach t in array $arr$${"{" + drillNames.join(",") + "}"}$arr$::text[] loop
          execute format('drop table if exists ${DRILL}.%I', t);
          execute format('create table ${DRILL}.%I (like public.%I)', t, t);
        end loop; end $$`);
    const neonDrill = [];
    let storedBundle = {};
    // Releitura da cópia gravada: decifra (AAD do dia/parte) e exige o envelope quando a chave existe (sem rebaixamento).
    if (exported.length) {
      try {
        const opened = await openBundle(await kv.get(bundleKey), bctx, encKeys);
        if (bk.state === "present" && !opened.encrypted) fail("neon_copy_not_encrypted");
        else storedBundle = JSON.parse(opened.text) || {};
      } catch (e) { fail("neon_copy_unreadable:" + String(e?.code || "error")); storedBundle = {}; }
    }
    for (const e of exported.filter((x) => drillNames.includes(x.table))) {
      const stored = typeof storedBundle[e.table] === "string" ? storedBundle[e.table] : null;
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
        foreach t in array $arr$${"{" + drillNames.join(",") + "}"}$arr$::text[] loop execute format('drop table if exists ${DRILL}.%I', t); end loop; end $$`);
    // Garantia de cobertura: nenhum intervalo maior que 7 dias sem um ensaio completo aprovado.
    if (report.fp) report.fp.lastFullDrill = drillAll && neonDrill.length === exported.length && neonDrill.every((d) => d.ok) ? new Date(now).toISOString() : (prev.lastFullDrill || null);

    // 3b. KV restore drill from the Neon copy (first part only).
    const backed = (kvPart ? await sql.query(`select to_char(snapshot_day, 'YYYY-MM-DD') as snapshot_day, key, value, sha256, expiration, metadata from ${BACKUP_TABLE} where snapshot_day = $1::date order by key`, [day]) : [])
      .map((r) => ({ snapshot_day: r.snapshot_day == null ? day : String(r.snapshot_day), key: String(r.key), value: String(r.value), sha256: String(r.sha256), expiration: r.expiration == null ? null : Number(r.expiration), metadata: r.metadata == null ? null : String(r.metadata) }));
    let mismatch = 0;
    for (const r of backed) if ((await sha256(r.value)) !== r.sha256 || hashes[r.key] !== r.sha256 || entries[r.key] !== (await kvEntryDigest({ sha: r.sha256, expiration: r.expiration, metadata: r.metadata }))) mismatch++;
    const missing = present.length - backed.filter((r) => hashes[r.key]).length;
    if (mismatch || missing) fail(`kv_copy_integrity:${mismatch}:${missing}`);
    const sample = backed.slice(0, DRILL_SAMPLE);
    // The sample is restored as ONE key and read back (2 KV writes instead of 2 per sampled key).
    let sampleOk = true;
    if (sample.length) {
      const drillKey = "zpc:restore-drill:" + day;
      await kv.put(drillKey, JSON.stringify(Object.fromEntries(sample.map((r) => [r.key, r.value]))), { expirationTtl: 3600 });
      let back = {};
      try { back = JSON.parse(String(await kv.get(drillKey) || "{}")); } catch { back = {}; }
      for (const r of sample) { const v = back[r.key]; if (typeof v !== "string" || (await sha256(v)) !== r.sha256) sampleOk = false; }
      await kv.delete(drillKey);
    }
    if (!sampleOk) fail("kv_restore_drill");
    // KV copy for the monthly drill: exactly the rows Neon returned above (never the KV source), one KV write.
    if (kvPart && backed.length) {
      const copyKey = kvCopyKeyFor(day);
      const copyJson = JSON.stringify(backed);
      const cctx = { day, part: 0, bundleKey: copyKey };
      await kv.put(copyKey, bk.state === "present" ? await sealBundle(copyJson, cctx, bk) : copyJson, { expirationTtl: 8 * DAY });
      const copySha = await sha256(copyJson);
      let backOk = false;
      try { const o = await openBundle(await kv.get(copyKey), cctx, encKeys); backOk = (bk.state !== "present" || o.encrypted) && (await sha256(o.text)) === copySha; } catch { backOk = false; }
      if (!backOk) fail("kv_copy_bundle_integrity");
      report.kv.copy = { format: KV_COPY_FORMAT, bundleKey: copyKey, rows: backed.length, sha: copySha };
    }
    // 3c. Retention (own copies only): never deletes the last intact recoverable copy. Today's copy is proven valid
    // only when its manifest equals the source manifest, every row re-hashes, nothing is missing and the drill passed;
    // older copies are not re-verified here, so without a proven copy today nothing is deleted.
    if (kvPart) {
      const copyManifest = await manifestHash(Object.fromEntries(backed.filter((r) => hashes[r.key]).map((r) => [r.key, r.sha256])));
      const todayValid = backed.length > 0 && present.length > 0 && !mismatch && !missing && sampleOk
        && copyManifest === (await manifestHash(hashes));
      const plan = planRetention({ today: day, snapshots: [{ day, valid: todayValid }] });
      // Range delete bounded by BOTH the window and the newest proven-valid copy (never that copy itself).
      if (plan.newestValid) await sql.query(`delete from ${BACKUP_TABLE} where snapshot_day < $1::date and snapshot_day < $2::date`, [plan.cutoff, plan.newestValid]);
      report.retention = { ran: Boolean(plan.newestValid), cutoff: plan.cutoff, newestValid: plan.newestValid,
        reason: plan.newestValid ? "bounded_by_newest_valid_copy" : plan.reason };
    }
    report.restore = {
      neon: { mode: drillAll ? "completo" : "alteradas", tables: neonDrill.length, ok: neonDrill.filter((d) => d.ok).length, rows: neonDrill.reduce((s, d) => s + (d.restored || 0), 0), isolatedSchema: DRILL },
      kv: { verified: backed.length, mismatch, missing, sampleRestored: sample.length, sampleOk },
    };
    report.ok = report.failures.length === 0;
  } catch (e) {
    fail("error:" + String(e?.message || e).replace(/postgres(ql)?:\/\/\S+/g, "[db]").slice(0, 200));
  }
  return finishPart(kv, report, part);
}

async function finishPart(kv, report, part) {
  report.ok = report.ok === true && report.failures.length === 0;
  report.finishedAt = new Date().toISOString();
  try { await kv.put(`${REPORT_KEY}:part:${part}`, JSON.stringify(report), { expirationTtl: 3 * DAY }); } catch { report.failures.push("report_write_failed"); report.ok = false; }
  return report;
}

// Combines today's parts into the single report the panel and the inventory read.
// OK only when every part ran today, every part passed and no table was left out.
// P20 diário D1 (PR 4): com sqlFactory, a reconciliação diária Neon × diário entra no relatório (campo diario). Em
// DIARIO_FASE "sombra" a divergência é alerta (warnings); em "ativo", falha de P20. Sem env.DIARIO: "nao_configurado".
export async function finalizeBackup(env = {}, { parts = DEFAULT_PARTS, now = Date.now(), encryptionRequired = ENCRYPTION_REQUIRED, sqlFactory = null, diarioFase = DIARIO_FASE, planId = null, runId = null } = {}) {
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  const v2 = typeof planId === "string" && planId.length > 0;
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
  // Estado da cifragem do dia: "cifrado" só com TODAS as partes cifradas. Fase 1: alerta; fase 2: falha.
  const cif = valid.filter((r) => r.encryption?.state === "cifrado");
  report.encryption = { state: valid.length === parts && cif.length === parts ? "cifrado" : cif.length ? "parcial" : "nao_cifrado", parts_cifradas: cif.length, parts, kids: [...new Set(cif.map((r) => r.encryption.kid))].sort() };
  report.warnings = report.encryption.state === "cifrado" ? [] : ["backup_nao_cifrado:" + report.encryption.state];
  if (encryptionRequired && report.encryption.state !== "cifrado") failures.push("backup_nao_cifrado:" + report.encryption.state);
  report.coverage = report.totalTables ? `${report.neon.tables} de ${report.totalTables - report.neon.excluded.length} tabelas (credenciais fora por política: ${report.neon.excluded.length})` : null;
  try { report.diario = await reconciliaDiario(env, { sqlFactory, now, fase: diarioFase }); } catch { report.diario = { estado: "incompleto", motivo: "reconciliacao_excecao", fase: diarioFase, cadeia_ok: null }; }
  const efeito = efeitoNoRelatorio(report.diario);
  if (efeito.alerta) report.warnings.push(efeito.alerta);
  if (efeito.falha) failures.push(efeito.falha);
  if (v2) await finalizeV2(env, { report, got, parts, planId, runId, day, failures });
  report.ok = failures.length === 0 && valid.length === parts && report.restore.neon.ok === report.restore.neon.tables && report.totalTables != null && report.neon.tables === report.totalTables - report.neon.excluded.length;
  if (v2) await sealReport(env, report);
  await kv.put(REPORT_KEY, JSON.stringify(report));
  return report;
}

// P20 v2: conferência da consolidação contra o plano autenticado. Qualquer divergência reprova o DIA inteiro.
async function finalizeV2(env, { report, got, parts, planId, runId, day, failures }) {
  report.contract = CONTRACT_V2;
  report.plan_id = planId;
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) { failures.push("run_id_missing_or_malformed"); return; }
  report.run_id = runId;
  const p0 = got[0];
  const plan = p0 && p0.plan;
  if (!plan || plan.schema !== PLAN_SCHEMA || plan.day !== day || plan.parts !== parts || !Array.isArray(plan.eligible)) { failures.push("plan_missing_or_malformed"); return; }
  const rk = await loadReportKey(env.P20_BACKUP_KEY);
  const text = canonical(plan);
  const expectedId = rk.state === "present" ? await hmacHex(rk, text) : "sha256:" + (await sha256(text));
  if (expectedId !== planId) { failures.push("plan_auth_failed"); return; }
  report.plan = plan;
  const assigned = assignParts(plan.eligible, parts);
  const seen = new Map();
  report.parts_detail = [];
  got.forEach((r, i) => {
    if (!r || r.day !== day) return; // já reprovado acima (part_missing)
    if (r.contract !== CONTRACT_V2 || r.plan_id !== planId || r.part !== i) { failures.push("part_plan_mismatch:" + i); return; }
    // Relatório de OUTRA execução (parte desta execução rejeitada ou não chamada): nunca supre a parte.
    if (r.run_id !== runId) { failures.push("part_run_mismatch:" + i); return; }
    const names = Object.keys(r.tables || {}).sort(byCodepoint);
    const want = [...assigned[i]].sort(byCodepoint);
    if (names.length !== want.length || names.some((t, k) => t !== want[k])) failures.push("part_tables_mismatch:" + i);
    for (const t of names) { if (seen.has(t)) failures.push("table_in_two_parts:" + t); seen.set(t, i); }
    if (names.length && !(r.bundle && typeof r.bundle.sha256 === "string" && /^[0-9a-f]{64}$/.test(r.bundle.sha256))) failures.push("part_bundle_hash_missing:" + i);
    report.parts_detail.push({ part: i, run_id: r.run_id, bundle_key: r.bundle ? r.bundle.key : null, bundle_sha256: r.bundle ? r.bundle.sha256 : null, tables: r.tables || {} });
  });
  const missing = plan.eligible.filter((t) => !seen.has(t));
  if (missing.length) failures.push("coverage_incomplete:" + missing.length);
  report.coverage = `${seen.size} de ${plan.eligible.length} tabelas elegíveis (credenciais fora por política: ${plan.excluded.length})`;
}

// Relatório v2 autenticado INTEIRO por HMAC(K_rel): plano, partes, hash de cada bundle, tabelas, exclusões e veredito.
// Sem a chave: auth.state = "nao_autenticado" e nenhum consumidor pode declarar a cópia completa.
export const AUTHENTICATED_FIELDS = Object.freeze(["contract", "day", "plan_id", "plan", "parts", "parts_detail", "ok", "failures", "encryption"]);
async function sealReport(env, report) {
  const rk = await loadReportKey(env.P20_BACKUP_KEY);
  const body = Object.fromEntries(AUTHENTICATED_FIELDS.map((k) => [k, report[k] === undefined ? null : report[k]]));
  report.auth = rk.state === "present" ? { state: "autenticado", alg: "HMAC-SHA256", kid: rk.kid, fields: [...AUTHENTICATED_FIELDS], hmac: await hmacHex(rk, canonical(body)) } : { state: "nao_autenticado" };
}
