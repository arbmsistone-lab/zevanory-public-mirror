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
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import {
  REPORT_KEY, PARTS, partReportKey, assessBackup, assertEphemeralTarget, buildRecord, validateRecord, validateInventory,
} from "./restore-drill-lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CF_ACCOUNT = "1b26415802588185a86c1d4d3ebf5bdb";
export const NAMESPACE = "728a45738e4047f29bcb89934fd533c1"; // ZEVANORY_PRIVATE_ARTIFACTS (produção)
const BACKUP_KEY = /^zpc:backup:v1:(report|report:part:[0-9]|neon:\d{4}-\d{2}-\d{2}:part:[0-9])$/;
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
  return { combined, parts, bundles };
}

// Restauração pelo Python (rotina oficial restore_new_database.restore_full). Os dados vão por arquivo temporário
// (0600, apagado no fim), nunca pela linha de comando; a saída do Python é só metadado.
export function restoreViaPython({ tablesJson, manifestRows, env }) {
  const dir = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), "p20-drill-"));
  try {
    writeFileSync(join(dir, "tables.json"), JSON.stringify(tablesJson), { mode: 0o600 });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifestRows), { mode: 0o600 });
    const r = spawnSync(env.PYTHON || "python3", [join(ROOT, "scripts", "p20", "restore_bridge.py"), dir], { cwd: ROOT, env, encoding: "utf8", timeout: 1800000, maxBuffer: 8 * 1024 * 1024 });
    const last = String(r.stdout || "").trim().split("\n").filter(Boolean).pop() || "";
    let out = null;
    try { out = JSON.parse(last); } catch { out = null; }
    if (!out || typeof out !== "object") return { ok: false, error: "bridge_output_unreadable rc=" + r.status };
    return out;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export async function runDrill({ mode, env = process.env, fetchImpl = fetch, fixture = null, restoreImpl = restoreViaPython, now = () => new Date(), clock = () => performance.now(), inventory = null }) {
  const startedAt = now().toISOString();
  const t0 = clock();
  let readings = null, sourceRead = false, naReason = null;
  try {
    const get = kvReader({ mode, token: env.CLOUDFLARE_API_TOKEN, fixture, fetchImpl });
    readings = await readBackup(get);
    sourceRead = readings.combined != null;
    if (!sourceRead) naReason = "combined_report_absent";
  } catch (e) { naReason = clean(e?.message || e); }
  const assessment = sourceRead ? assessBackup(readings) : null;
  let restore = null;
  if (assessment?.readable && assessment.failures.length === 0) {
    try {
      assertEphemeralTarget(env);
      restore = await restoreImpl({ tablesJson: assessment.tables_json, manifestRows: assessment.manifest_rows, env });
    } catch (e) { restore = { ok: false, error: clean(e?.message || e) }; }
  }
  const rtoSeconds = (clock() - t0) / 1000;
  const rec = buildRecord({ mode, sourceRead: sourceRead && !!assessment?.readable, assessment, restore, startedAt, finishedAt: now().toISOString(), rtoSeconds,
    runId: env.GITHUB_RUN_ID, sha: env.GITHUB_SHA, inventory, notAvailableReason: naReason });
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
    hash_ok: rec.integrity?.tables_hash_ok ?? null, restored: rec.restore?.tables ?? null, rpo_hours: rec.rpo_hours, rto_seconds: rec.rto_seconds, failures: rec.failures.slice(0, 10), reason: rec.reason ?? null }));
  if (rec.verdict !== "APROVADO") console.log(`::error title=P20_RESTORE_DRILL::${rec.verdict} ${clean((rec.failures[0] || rec.reason || ""))}`);
  return rec.verdict === "APROVADO" ? 0 : 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().then((c) => process.exit(c)).catch((e) => { console.log("::error title=P20_RESTORE_DRILL::" + clean(e?.message || e)); process.exit(2); });
