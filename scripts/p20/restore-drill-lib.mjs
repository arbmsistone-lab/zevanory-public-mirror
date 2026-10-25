// ZEVANORY | P20 (Roteiro Mestre v4.7, seção 9.1): lógica pura do ensaio MENSAL de restauração completa.
// Sem rede, sem banco, sem segredos. Testado em tests/p20-restore-drill.test.mjs (e por mutantes).
//
// O que o ensaio prova, nesta ordem (fail-closed; qualquer dúvida derruba):
//  1. a cópia mais recente do backup Neon -> KV está íntegra: relatório consolidado ok, as 3 partes do mesmo dia,
//     cada bundle no endereço que a parte declara, o SHA-256 de CADA tabela igual ao do manifesto da parte
//     (fp.tables[t].sha, gravado pelo Worker) e o resumo do manifesto (neon.manifest) recalculado igual;
//  2. a restauração COMPLETA num Postgres efêmero (nunca produção) bate contagem e hash de conteúdo por tabela;
//  3. RPO = instante da falha simulada (início do ensaio) - início mais antigo das partes da cópia;
//     RTO (dados) = início do ensaio -> restauração conferida.
// Rótulos (seção 6.4): ENSAIO_EM_PRODUCAO só quando a cópia REAL de produção foi lida; SINTETICA para fixture;
// sem leitura = null + NOT_AVAILABLE. Nada aqui imprime ou grava dado de linha: só nomes de tabela, contagens,
// booleanos e prefixos de 16 hex do manifesto (iguais aos que o Worker já publica).
import { createHash } from "node:crypto";

export const SCHEMA_RECORD = "zevanory.p20.restore-drill.v1";
export const SCHEMA_INVENTORY = "zevanory.p20.inventario.v1";
export const REPORT_KEY = "zpc:backup:v1:report";
export const PARTS = 3;
export const partReportKey = (p) => `${REPORT_KEY}:part:${p}`;
export const bundleKeyFor = (day, p) => `zpc:backup:v1:neon:${day}:part:${p}`;
export const VERDICTS = Object.freeze(["APROVADO", "REPROVADO", "NOT_AVAILABLE"]);
export const LABELS = Object.freeze(["SINTETICA", "ENSAIO_EM_PRODUCAO"]);
export const MAX_AGE_H = 26;      // seção 9.1: 24 h + 2 h de tolerância
export const CRITICAL_AGE_H = 48; // seção 9.1: falha crítica de P20
// Partes da seção 9.1 que este ensaio NÃO cobre (escopo honesto; nunca some daqui sem prova nova).
export const NOT_COVERED = Object.freeze([
  "copia_kv_para_neon: restauração completa em CI exige a credencial do Neon (só o Worker a tem); coberta só pelo ensaio diário por amostra do Worker",
  "conciliacao_pedidos_x_provedor: vendas fechadas e nenhuma credencial somente leitura do provedor no Environment do ensaio",
  "diario_d1: diário de eventos críticos no D1 não implementado",
  "copia_cifrada: a cópia Neon -> KV fica em texto claro no KV (a seção 9.1 pede cifrada)",
]);
const TABLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v) && v >= 0;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
export const isIso = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v) && !Number.isNaN(Date.parse(v));
export const isDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;

export const sha256 = (s) => createHash("sha256").update(String(s), "utf8").digest("hex");
// Igual a worker/data-backup.mjs manifestHash: sha256 das linhas "tabela=sha" em ordem.
export const manifestHash = (entries) => sha256(Object.keys(entries).sort().map((k) => k + "=" + entries[k]).join("\n"));
const parse = (s) => { if (typeof s !== "string") return { ok: false }; try { return { ok: true, v: JSON.parse(s) }; } catch { return { ok: false }; } };

// ---------------------------------------------------------------------------------------------------------
// Alvo da restauração: SÓ um Postgres local e descartável. Qualquer sinal de banco real recusa (antes de conectar).
export const EPHEMERAL_HOSTS = Object.freeze(["localhost", "127.0.0.1", "::1"]);
export function assertEphemeralTarget(env = {}) {
  const host = String(env.PGHOST || "");
  if (!EPHEMERAL_HOSTS.includes(host)) throw new Error("TARGET_NOT_EPHEMERAL host");
  if (env.PGHOSTADDR && !EPHEMERAL_HOSTS.includes(String(env.PGHOSTADDR))) throw new Error("TARGET_NOT_EPHEMERAL hostaddr");
  for (const k of ["DATABASE_URL", "RESTORE_TARGET_DATABASE_URL", "CERTIFICATION_DATABASE_URL", "PGSERVICE", "PGSERVICEFILE"]) {
    if (env[k]) throw new Error("TARGET_NOT_EPHEMERAL " + k);
  }
  if (!/^p20_drill[a-z0-9_]{0,40}$/.test(String(env.PGDATABASE || ""))) throw new Error("TARGET_NOT_EPHEMERAL database");
  return true;
}

// Rótulo da seção 6.4. Produção só conta se a cópia real foi efetivamente lida.
export function decideLabel(mode, sourceRead) {
  if (mode === "sintetica") return "SINTETICA";
  if (mode === "producao" && sourceRead === true) return "ENSAIO_EM_PRODUCAO";
  return null;
}

export function rpoHours(partStartedAts, failureAtIso) {
  if (!Array.isArray(partStartedAts) || partStartedAts.length === 0 || !partStartedAts.every(isIso) || !isIso(failureAtIso)) return null;
  const oldest = Math.min(...partStartedAts.map((t) => Date.parse(t)));
  const h = (Date.parse(failureAtIso) - oldest) / 36e5;
  return h < 0 ? null : Math.round(h * 100) / 100;
}

// ---------------------------------------------------------------------------------------------------------
// Avaliação da cópia (relatórios + bundles já lidos do KV). Não restaura nada.
// readings = { combined: string|null, parts: [string|null x PARTS], bundles: { key: string|null } }
// Retorna { readable, failures[], day, parts[], tables_json{t: js}, manifest_rows{t:{rows}}, datasets[], totals }.
// readable=false só quando a fonte não pôde ser lida/entendida (NOT_AVAILABLE); integridade ruim = failures.
export function assessBackup(readings) {
  const out = { readable: false, failures: [], day: null, parts: [], tables_json: {}, manifest_rows: {}, datasets: [], totals: { tables: 0, rows: 0 }, excluded: [] };
  const fail = (w) => out.failures.push(w);
  const c = parse(readings?.combined);
  if (!c.ok || !isObj(c.v)) { out.reason = "combined_report_unreadable"; return out; }
  const R = c.v;
  if (R.schema !== "zevanory-backup/v1" || !isDay(R.day) || R.parts !== PARTS || typeof R.ok !== "boolean" || !isObj(R.neon) || !isInt(R.neon.tables) || !isInt(R.neon.rows) || !Array.isArray(R.neon.excluded)) {
    out.reason = "combined_report_malformed"; return out;
  }
  out.day = R.day;
  out.excluded = R.neon.excluded.filter((e) => isObj(e) && typeof e.table === "string" && TABLE_RE.test(e.table)).map((e) => e.table).sort();
  if (out.excluded.length !== R.neon.excluded.length) fail("excluded_list_malformed");
  if (R.ok !== true) fail("combined_report_not_ok");
  if (Array.isArray(R.failures) && R.failures.length) fail("combined_report_failures:" + R.failures.length);
  if (!Array.isArray(readings.parts) || readings.parts.length !== PARTS) { out.reason = "parts_unreadable"; return out; }
  const seen = new Set();
  for (let p = 0; p < PARTS; p++) {
    const pr = parse(readings.parts[p]);
    if (!pr.ok || !isObj(pr.v)) { out.reason = "part_report_unreadable:" + p; return out; }
    const P = pr.v;
    const fp = P.fp;
    if (P.schema !== "zevanory-backup/v1" || P.part !== p || !isDay(P.day) || !isIso(P.startedAt) || !isObj(P.neon) || !isInt(P.neon.tables) || !isInt(P.neon.rows)
      || typeof P.neon.manifest !== "string" || !isObj(fp) || typeof fp.bundleKey !== "string" || !isObj(fp.tables)) {
      out.reason = "part_report_malformed:" + p; return out;
    }
    const info = { part: p, day: P.day, started_at: P.startedAt, finished_at: isIso(P.finishedAt) ? P.finishedAt : null, tables: 0, rows: 0, manifest_ok: false, bundle_read: false };
    out.parts.push(info);
    if (P.day !== R.day) fail(`part_day_mismatch:${p}`);
    if (P.ok !== true || (Array.isArray(P.failures) && P.failures.length)) fail(`part_not_ok:${p}`);
    if (fp.bundleKey !== bundleKeyFor(R.day, p)) { fail(`bundle_key_mismatch:${p}`); continue; }
    if (!HEX16.test(P.neon.manifest)) fail(`part_manifest_digest_malformed:${p}`);
    const raw = readings.bundles?.[fp.bundleKey];
    if (raw == null) { fail(`bundle_missing:${p}`); continue; }
    const b = parse(raw);
    if (!b.ok || !isObj(b.v)) { fail(`bundle_malformed:${p}`); continue; }
    info.bundle_read = true;
    const bundle = b.v;
    const manifest = fp.tables;
    const names = Object.keys(bundle).sort(), mnames = Object.keys(manifest).sort();
    for (const t of mnames) if (!(t in bundle)) fail(`table_in_manifest_missing_from_bundle:${t}`);
    const shaOf = {};
    let partRows = 0, partOk = true;
    for (const t of names) {
      const js = bundle[t];
      const m = manifest[t];
      const ds = { table: t, part: p, rows: null, hash_ok: false, in_manifest: isObj(m) };
      out.datasets.push(ds);
      if (!TABLE_RE.test(t)) { fail("table_name_invalid"); partOk = false; continue; }
      if (seen.has(t)) { fail(`duplicate_table:${t}`); partOk = false; continue; }
      seen.add(t);
      if (typeof js !== "string") { fail(`table_not_string:${t}`); partOk = false; continue; }
      if (!isObj(m) || typeof m.sha !== "string" || !HEX64.test(m.sha)) { fail(`table_without_manifest_hash:${t}`); partOk = false; continue; }
      const h = sha256(js);
      shaOf[t] = h;
      if (h !== m.sha) { fail(`hash_mismatch:${t}`); partOk = false; continue; }
      const rows = parse(js);
      if (!rows.ok || !Array.isArray(rows.v)) { fail(`table_not_array:${t}`); partOk = false; continue; }
      ds.rows = rows.v.length; ds.hash_ok = true;
      partRows += rows.v.length;
      out.tables_json[t] = js;
      out.manifest_rows[t] = { rows: rows.v.length };
    }
    info.tables = names.length; info.rows = partRows;
    info.manifest_ok = partOk && names.length === mnames.length && manifestHash(shaOf).slice(0, 16) === P.neon.manifest;
    if (!info.manifest_ok) fail(`part_manifest_digest_mismatch:${p}`);
    if (names.length !== P.neon.tables) fail(`part_table_count_mismatch:${p}`);
    if (partRows !== P.neon.rows) fail(`part_row_count_mismatch:${p}`);
  }
  out.readable = true;
  out.totals = { tables: Object.keys(out.tables_json).length, rows: Object.values(out.manifest_rows).reduce((s, m) => s + m.rows, 0) };
  if (out.datasets.length !== R.neon.tables) fail("total_table_count_mismatch");
  if (out.datasets.every((d) => d.hash_ok) && out.totals.rows !== R.neon.rows) fail("total_row_count_mismatch");
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Inventário da seção 9.1 (docs/p20/inventario-estado-critico.json). Malformado derruba.
export function validateInventory(doc) {
  if (!isObj(doc) || doc.schema !== SCHEMA_INVENTORY || !Array.isArray(doc.classes) || doc.classes.length === 0) throw new Error("INVENTORY_MALFORMED header");
  if (doc.status === "PROPOSTA" ? (doc.approved_by != null || doc.approved_at != null) : !(doc.status === "APPROVED" && typeof doc.approved_by === "string" && isDay(doc.approved_at))) {
    throw new Error("INVENTORY_MALFORMED approval");
  }
  const owner = new Map();
  for (const c of doc.classes) {
    if (!isObj(c) || typeof c.id !== "string" || typeof c.fonte_da_verdade !== "string" || typeof c.backup !== "string" || !Array.isArray(c.tables)) throw new Error("INVENTORY_MALFORMED class");
    for (const k of ["rpo_objetivo_h", "rto_objetivo_h"]) if (!(c[k] === null || (isNum(c[k]) && c[k] >= 0))) throw new Error("INVENTORY_MALFORMED " + k + " " + c.id);
    for (const t of c.tables) {
      if (!TABLE_RE.test(t)) throw new Error("INVENTORY_MALFORMED table " + t);
      if (owner.has(t)) throw new Error("INVENTORY_MALFORMED duplicate " + t);
      owner.set(t, c.id);
    }
  }
  return doc;
}

// Agrupa as tabelas restauradas por classe do inventário. Tabela sem classe é listada (nunca escondida).
export function byClass(datasets, restoredTables, inventory, measuredRpoH) {
  const owner = new Map();
  for (const c of inventory.classes) for (const t of c.tables) owner.set(t, c.id);
  const restored = new Set(restoredTables || []);
  const classes = {};
  for (const c of inventory.classes) {
    if (!c.tables.length || c.fora_do_backup_por_politica) continue;
    const ds = datasets.filter((d) => owner.get(d.table) === c.id);
    classes[c.id] = {
      tables_in_backup: ds.length,
      tables_hash_ok: ds.filter((d) => d.hash_ok).length,
      tables_restored: ds.filter((d) => restored.has(d.table)).length,
      rows: ds.reduce((s, d) => s + (d.rows || 0), 0),
      rpo_objetivo_h: c.rpo_objetivo_h, rto_objetivo_h: c.rto_objetivo_h,
      rpo_medido_h: ds.length && ds.every((d) => restored.has(d.table)) ? measuredRpoH : null,
    };
  }
  const unclassified = datasets.map((d) => d.table).filter((t) => !owner.has(t)).sort();
  return { classes, unclassified };
}

// ---------------------------------------------------------------------------------------------------------
// Registro de evidência (uma linha JSONL em p20/restore-drills-v1.jsonl do ramo evidence/b0-baseline).
export function buildRecord({ mode, sourceRead, assessment, restore, startedAt, finishedAt, rtoSeconds, runId, sha, inventory, notAvailableReason }) {
  const label = decideLabel(mode, sourceRead);
  const a = assessment || { readable: false, failures: [], datasets: [], parts: [], totals: { tables: 0, rows: 0 }, excluded: [] };
  const restoreOk = !!(restore && restore.ok === true);
  const failures = [...(a.failures || [])];
  if (a.readable && !failures.length && !restoreOk) failures.push("restore_failed:" + String(restore?.error || "not_run").replace(/[^A-Za-z0-9_.:,= -]/g, "").slice(0, 120));
  const rpo = a.readable ? rpoHours(a.parts.map((p) => p.started_at), startedAt) : null;
  if (a.readable && rpo == null) failures.push("rpo_not_computable");
  let verdict;
  if (!label || !a.readable) verdict = "NOT_AVAILABLE";
  else verdict = failures.length === 0 && restoreOk ? "APROVADO" : "REPROVADO";
  const restoredTables = restoreOk ? Object.keys(restore.tables || {}) : [];
  const cls = inventory ? byClass(a.datasets || [], restoredTables, inventory, rpo) : { classes: {}, unclassified: [] };
  const rec = {
    schema: SCHEMA_RECORD,
    label: verdict === "NOT_AVAILABLE" ? null : label, mode, verdict,
    started_at: startedAt, finished_at: finishedAt,
    run_id: String(runId || ""), sha: String(sha || ""),
    backup: a.readable ? {
      day: a.day,
      parts: a.parts.map((p) => ({ part: p.part, day: p.day, started_at: p.started_at, finished_at: p.finished_at, tables: p.tables, rows: p.rows, manifest_ok: p.manifest_ok })),
      tables: (a.datasets || []).length, rows: a.totals.rows, excluded_by_policy: a.excluded,
    } : null,
    integrity: a.readable ? {
      tables_checked: (a.datasets || []).length,
      tables_hash_ok: (a.datasets || []).filter((d) => d.hash_ok).length,
      tables_hash_failed: (a.datasets || []).filter((d) => !d.hash_ok).map((d) => d.table).sort(),
    } : null,
    restore: restoreOk ? {
      target: "postgres efemero do runner (service container), banco descartavel",
      tables: restoredTables.length,
      rows: Object.values(restore.tables).reduce((s, v) => s + (isInt(v) ? v : 0), 0),
      content_hash_ok: true,
      preserved_without_schema: Array.isArray(restore.preserved_without_schema) ? restore.preserved_without_schema.slice().sort() : [],
      worker_schema_ready: restore.worker_schema_ready === true,
    } : { executed: !!restore, ok: false },
    rpo_hours: verdict === "NOT_AVAILABLE" ? null : rpo,
    rpo_over_26h: verdict === "NOT_AVAILABLE" || rpo == null ? null : rpo > MAX_AGE_H,
    rpo_over_48h_critical: verdict === "NOT_AVAILABLE" || rpo == null ? null : rpo > CRITICAL_AGE_H,
    rto_seconds: verdict === "APROVADO" && isNum(rtoSeconds) ? Math.round(rtoSeconds * 10) / 10 : null,
    rto_scope: "dados: leitura da copia + conferencia de hash + esquema + carga + conferencia num Postgres efemero; NAO inclui troca de DNS, reconfiguracao do Worker nem o tempo de aprovacao do Environment",
    by_class: cls.classes,
    unclassified_tables: cls.unclassified,
    not_covered: [...NOT_COVERED],
    scope_complete_9_1: false,
    failures: failures.slice(0, 50),
  };
  if (verdict === "NOT_AVAILABLE") rec.reason = String(notAvailableReason || a.reason || "source_not_read").replace(/[^A-Za-z0-9_.:,= -]/g, "").slice(0, 160);
  rec.scope_complete_9_1 = rec.not_covered.length === 0 && verdict === "APROVADO";
  return rec;
}

// Releitura estrita (publicação e coletor B0). Rótulo e veredito coerentes; nada de dado de linha.
export function validateRecord(r) {
  if (!isObj(r) || r.schema !== SCHEMA_RECORD) throw new Error("bad_schema");
  if (!VERDICTS.includes(r.verdict)) throw new Error("bad_verdict");
  if (!(r.label === null || LABELS.includes(r.label))) throw new Error("bad_label");
  if (!["producao", "sintetica"].includes(r.mode)) throw new Error("bad_mode");
  if (r.label === "ENSAIO_EM_PRODUCAO" && r.mode !== "producao") throw new Error("label_mode_mismatch");
  if (r.label === "SINTETICA" && r.mode !== "sintetica") throw new Error("label_mode_mismatch");
  if (r.label === null && r.verdict !== "NOT_AVAILABLE") throw new Error("unlabelled_measurement");
  if (r.label !== null && r.verdict === "NOT_AVAILABLE") throw new Error("labelled_not_available");
  if (!isIso(r.started_at) || !isIso(r.finished_at) || Date.parse(r.finished_at) < Date.parse(r.started_at)) throw new Error("bad_times");
  if (!Array.isArray(r.not_covered) || typeof r.scope_complete_9_1 !== "boolean" || (r.scope_complete_9_1 && r.not_covered.length)) throw new Error("bad_scope");
  if (!Array.isArray(r.failures)) throw new Error("bad_failures");
  if (r.verdict === "NOT_AVAILABLE") {
    if (r.rpo_hours !== null || r.rto_seconds !== null || typeof r.reason !== "string") throw new Error("not_available_with_values");
    return r;
  }
  const b = r.backup, i = r.integrity;
  if (!isObj(b) || !isDay(b.day) || !Array.isArray(b.parts) || b.parts.length !== PARTS || !isInt(b.tables) || !isInt(b.rows)) throw new Error("bad_backup");
  if (!isObj(i) || !isInt(i.tables_checked) || !isInt(i.tables_hash_ok) || i.tables_hash_ok > i.tables_checked || !Array.isArray(i.tables_hash_failed)) throw new Error("bad_integrity");
  if (!(isNum(r.rpo_hours) && r.rpo_hours >= 0) && !(r.verdict === "REPROVADO" && r.rpo_hours === null && r.failures.includes("rpo_not_computable"))) throw new Error("bad_rpo");
  if (r.verdict === "APROVADO") {
    if (r.failures.length || i.tables_hash_ok !== i.tables_checked || i.tables_hash_failed.length) throw new Error("approved_with_failures");
    if (!isObj(r.restore) || r.restore.content_hash_ok !== true || !isInt(r.restore.tables) || r.restore.tables !== i.tables_checked) throw new Error("approved_without_full_restore");
    if (!isNum(r.rto_seconds) || r.rto_seconds <= 0) throw new Error("approved_without_rto");
  } else if (!r.failures.length) throw new Error("rejected_without_failure");
  return r;
}

export function parseDrillHistory(text) {
  const out = [];
  String(text || "").replace(/\r\n/g, "\n").split("\n").forEach((line, n) => {
    if (!line.trim()) return;
    let o;
    try { o = JSON.parse(line); } catch { throw new Error(`DRILL_HISTORY_MALFORMED line ${n + 1}: invalid_json`); }
    try { out.push(validateRecord(o)); } catch (e) { throw new Error(`DRILL_HISTORY_MALFORMED line ${n + 1}: ${e.message}`); }
  });
  return out;
}
