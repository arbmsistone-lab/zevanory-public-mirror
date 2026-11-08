// ZEVANORY | P20: ensaio MENSAL de restauração completa (Roteiro Mestre v4.7, seção 9.1).
//
//   node scripts/p20/restore-drill.mjs --mode producao  --out drill.json
//   node scripts/p20/restore-drill.mjs --mode sintetica --fixture kv.json --out drill.json
//
// producao : lê do KV de produção, SOMENTE com GET na API REST do Cloudflare, o relatório consolidado do backup,
//            os relatórios das 3 partes (manifesto: SHA-256 por tabela) e os 3 bundles da cópia mais recente.
//            Nunca grava, apaga ou lista nada; só chaves zpc:backup:v1:*. Exige CLOUDFLARE_API_TOKEN (Environment
//            producao-critica, com aprovação do proprietário). Rótulo ENSAIO_EM_PRODUCAO só se a cópia real foi lida.
// sintetica: mesmo caminho, lendo um arquivo {chave: valor} gerado pelo código real do Worker num Postgres
//            descartável (tests/helpers/p20_worker_backup_fixture.mjs). Rótulo SINTETICA, sempre.
// Restauração: scripts/p20/restore_bridge.py -> scripts/ops/restore_new_database.restore_full (esquema das
// migrações + DDL do Worker, contagem e hash de conteúdo por tabela) num Postgres LOCAL e descartável
// (assertEphemeralTarget recusa qualquer outro alvo antes de conectar). Saída: um registro JSON sem dado de linha.
// Cópia KV -> Neon: lê também (GET) zpc:backup:v1:kv:<dia>, as linhas do dia de zevanory_kv_backup relidas do Neon
// pelo Worker. A ponte as carrega em zevanory_kv_backup no MESMO Postgres efêmero e as relê; daqui elas viram um KV em
// memória conferido chave a chave (valor, TTL, metadados) contra o manifesto da fonte (kvRestoreDrill). Sem credencial
// do Neon: o Neon de produção nunca é acessado pelo CI.
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import {
  REPORT_KEY, PARTS, partReportKey, assessBackup, assertEphemeralTarget, buildRecord, validateRecord, validateInventory,
  assessKvCopy, kvRestoreDrill, KV_COPY_TABLE,
} from "./restore-drill-lib.mjs";
import { parseKeyring } from "./backup-envelope.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CF_ACCOUNT = "1b26415802588185a86c1d4d3ebf5bdb";
export const NAMESPACE = "728a45738e4047f29bcb89934fd533c1"; // ZEVANORY_PRIVATE_ARTIFACTS (produção)
const BACKUP_KEY = /^zpc:backup:v1:(report|report:part:[0-9]|neon:\d{4}-\d{2}-\d{2}:part:[0-9]|kv:\d{4}-\d{2}-\d{2})$/;
const KV_COPY_KEY = /^zpc:backup:v1:kv:\d{4}-\d{2}-\d{2}$/;
const clean = (s) => String(s || "").replace(/[^A-Za-z0-9_.:,= -]/g, "").slice(0, 160);

// Leitor do KV. Produção: só GET, só chaves do backup, só api.cloudflare.com. Fixture: objeto em memória.
export function kvReader({ mode, token, fixture, fetchImpl = fetch }) {
  if (mode === "sintetica") {
    if (!fixture || typeof fixture !== "object") throw new Error("fixture_required");
    return async (key) => {
      if (!BACKUP_KEY.test(key)) throw new Error("key_outside_backup_namespace");
      const v = fixture[key];
      return typeof v === "string" ? v : null;
    };
  }
  if (mode !== "producao") throw new Error("mode_invalid");
  if (fixture) throw new Error("fixture_forbidden_in_producao");
  if (typeof token !== "string" || token.length < 20) throw new Error("cloudflare_token_unavailable");
  return async (key) => {
    if (!BACKUP_KEY.test(key)) throw new Error("key_outside_backup_namespace");
    const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/storage/kv/namespaces/${NAMESPACE}/values/${encodeURIComponent(key)}`;
    const r = await fetchImpl(url, { method: "GET", headers: { authorization: "Bearer " + token, "user-agent": "zevanory-p20-restore-drill/1" }, signal: AbortSignal.timeout(60000) });
    if (r.status === 404) return null;
    if (r.status !== 200) throw new Error("kv_http_" + r.status);
    return await r.text();
  };
}

export async function readBackup(get) {
  const combined = await get(REPORT_KEY);
  const parts = [];
  for (let p = 0; p < PARTS; p++) parts.push(await get(partReportKey(p)));
  const bundles = {};
  for (const raw of parts) {
    let key = null;
    try { key = JSON.parse(String(raw))?.fp?.bundleKey; } catch { key = null; }
    if (typeof key === "string" && BACKUP_KEY.test(key) && key.startsWith("zpc:backup:v1:neon:") && !(key in bundles)) bundles[key] = await get(key);
  }
  // Cópia KV -> Neon declarada pela parte 0 (Worker anterior não declara: fica null e a lacuna continua).
  let kvCopy = null, kvKey = null;
  try { kvKey = JSON.parse(String(parts[0]))?.kv?.copy?.bundleKey; } catch { kvKey = null; }
  if (typeof kvKey === "string" && KV_COPY_KEY.test(kvKey)) kvCopy = await get(kvKey);
  return { combined, parts, bundles, kv_copy: kvCopy };
}

// Restauração pelo Python (rotina oficial restore_new_database.restore_full). Os dados vão por arquivo temporário
// (0600, apagado no fim), nunca pela linha de comando; a saída do Python é só metadado.
export function restoreViaPython({ tablesJson, manifestRows, env, kvCopy = null }) {
  const dir = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), "p20-drill-"));
  try {
    writeFileSync(join(dir, "tables.json"), JSON.stringify(tablesJson), { mode: 0o600 });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifestRows), { mode: 0o600 });
    if (kvCopy) {
      writeFileSync(join(dir, "kv_copy.json"), kvCopy.json, { mode: 0o600 });
      writeFileSync(join(dir, "kv_manifest.json"), JSON.stringify({ day: kvCopy.day, rows: kvCopy.keys }), { mode: 0o600 });
    }
    const r = spawnSync(env.PYTHON || "python3", [join(ROOT, "scripts", "p20", "restore_bridge.py"), dir], { cwd: ROOT, env, encoding: "utf8", timeout: 1800000, maxBuffer: 8 * 1024 * 1024 });
    const last = String(r.stdout || "").trim().split("\n").filter(Boolean).pop() || "";
    let out = null;
    try { out = JSON.parse(last); } catch { out = null; }
    if (!out || typeof out !== "object") return { ok: false, error: "bridge_output_unreadable rc=" + r.status };
    // Linhas da cópia do KV relidas do Postgres efêmero (arquivo 0600 escrito pela ponte, nunca stdout).
    if (kvCopy && out.ok === true) { try { out.kv_rows = JSON.parse(readFileSync(join(dir, "kv_restored.json"), "utf8")); } catch { out.kv_rows = null; } }
    return out;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export async function runDrill({ mode, env = process.env, fetchImpl = fetch, fixture = null, restoreImpl = restoreViaPython, now = () => new Date(), clock = () => performance.now(), inventory = null }) {
  const startedAt = now().toISOString();
  const t0 = clock();
  let readings = null, sourceRead = false, naReason = null;
  // Conjunto de chaves (P20_BACKUP_KEYS). Malformado = NOT_AVAILABLE com código; a chave nunca entra em mensagem.
  let keyring = new Map();
  try { keyring = parseKeyring(env.P20_BACKUP_KEYS); } catch (e) { naReason = clean(e?.code || "backup_keyring_malformed"); }
  if (!naReason) try {
    const get = kvReader({ mode, token: env.CLOUDFLARE_API_TOKEN, fixture, fetchImpl });
    readings = await readBackup(get);
    sourceRead = readings.combined != null;
    if (!sourceRead) naReason = "combined_report_absent";
  } catch (e) { naReason = clean(e?.message || e); }
  const assessment = sourceRead ? assessBackup(readings, { keyring }) : null;
  // Cópia KV -> Neon: falha na cópia (hash, envelope, manifesto, prefixo) reprova ANTES de restaurar qualquer coisa.
  const kvA = assessment?.readable ? assessKvCopy(readings, { day: assessment.day, keyring }) : null;
  if (kvA?.present) assessment.failures.push(...kvA.failures);
  let restore = null;
  if (assessment?.readable && assessment.failures.length === 0) {
    try {
      assertEphemeralTarget(env);
      restore = await restoreImpl({ tablesJson: assessment.tables_json, manifestRows: assessment.manifest_rows, env,
        kvCopy: kvA?.present ? { json: kvA.json, day: kvA.day, keys: kvA.keys, table: KV_COPY_TABLE } : null });
    } catch (e) { restore = { ok: false, error: clean(e?.message || e) }; }
  }
  let kvCopy = kvA?.present ? { proof: null, failures: [] } : null;
  if (kvCopy && restore?.ok === true) {
    if (!Array.isArray(restore.kv_rows)) kvCopy.failures.push("kv_restore_not_run");
    else kvCopy = await kvRestoreDrill(restore.kv_rows, kvA, { nowSec: Math.floor(now().getTime() / 1000) });
  }
  const rtoSeconds = (clock() - t0) / 1000;
  const rec = buildRecord({ mode, sourceRead: sourceRead && !!assessment?.readable, assessment, restore, startedAt, finishedAt: now().toISOString(), rtoSeconds,
    runId: env.GITHUB_RUN_ID, sha: env.GITHUB_SHA, inventory, notAvailableReason: naReason, kvCopy });
  return validateRecord(rec);
}

function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; }

export async function main() {
  const mode = arg("--mode"), out = arg("--out"), fixturePath = arg("--fixture");
  if (!["producao", "sintetica"].includes(mode) || !out) throw new Error("uso: --mode producao|sintetica --out arquivo [--fixture kv.json]");
  if (mode === "producao" && (fixturePath || process.env.P20_FIXTURE)) throw new Error("fixture_forbidden_in_producao");
  const inventory = validateInventory(JSON.parse(readFileSync(join(ROOT, "docs", "p20", "inventario-estado-critico.json"), "utf8")));
  const fixture = mode === "sintetica" ? JSON.parse(readFileSync(fixturePath, "utf8")) : null;
  const rec = await runDrill({ mode, fixture, inventory });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(rec) + "\n");
  console.log("::notice title=P20_RESTORE_DRILL::" + JSON.stringify({ label: rec.label, verdict: rec.verdict, backup_day: rec.backup?.day ?? null, tables: rec.integrity?.tables_checked ?? null,
    hash_ok: rec.integrity?.tables_hash_ok ?? null, restored: rec.restore?.tables ?? null, copia_cifrada: rec.backup?.copia_cifrada ?? null,
    kv_copy: rec.kv_copy ? { keys: rec.kv_copy.keys, restored: rec.kv_copy.restored, expired: rec.kv_copy.expired_at_restore, manifest_ok: rec.kv_copy.entries_manifest_ok } : null, rpo_hours: rec.rpo_hours, rto_seconds: rec.rto_seconds, failures: rec.failures.slice(0, 10), reason: rec.reason ?? null }));
  if (rec.verdict !== "APROVADO") console.log(`::error title=P20_RESTORE_DRILL::${rec.verdict} ${clean((rec.failures[0] || rec.reason || ""))}`);
  return rec.verdict === "APROVADO" ? 0 : 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().then((c) => process.exit(c)).catch((e) => { console.log("::error title=P20_RESTORE_DRILL::" + clean(e?.message || e)); process.exit(2); });
