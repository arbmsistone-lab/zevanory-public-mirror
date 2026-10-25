// ZEVANORY | P20: acrescenta o registro do ensaio mensal ao ramo de evidência (clone em EVIDENCE_DIR), em
// p20/restore-drills-v1.jsonl (append-only). Roda num job SEM segredos e SEM Environment.
//   node scripts/p20/publish-drill.mjs --record drill.json --mode producao
// Registro ausente (job do ensaio não rodou: aprovação negada/expirada ou falha de infraestrutura) ou inválido
// vira um registro NOT_AVAILABLE explícito (rótulo null): a ausência fica visível e nunca conta como ensaio.
// Histórico malformado derruba sem acrescentar nada (nunca é "consertado").
import { readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildRecord, validateRecord, parseDrillHistory } from "./restore-drill-lib.mjs";

export const HISTORY = join("p20", "restore-drills-v1.jsonl");

export function recordOrNotAvailable(text, { mode, now, runId, sha }) {
  const na = (reason) => validateRecord(buildRecord({ mode, sourceRead: false, assessment: null, restore: null, startedAt: now, finishedAt: now, runId, sha, notAvailableReason: reason }));
  if (typeof text !== "string" || !text.trim()) return na("drill_job_produced_no_record");
  let r;
  try { r = JSON.parse(text); } catch { return na("record_invalid_json"); }
  try { validateRecord(r); } catch (e) { return na("record_invalid:" + e.message); }
  if (r.mode !== mode) return na("record_mode_mismatch");
  return r;
}

export function publish({ evidenceDir, recordText, mode, now = new Date().toISOString(), runId = "", sha = "" }) {
  if (!evidenceDir) throw new Error("EVIDENCE_DIR_REQUIRED");
  const file = join(evidenceDir, HISTORY);
  if (existsSync(file)) parseDrillHistory(readFileSync(file, "utf8"));
  const rec = recordOrNotAvailable(recordText, { mode, now, runId, sha });
  mkdirSync(join(evidenceDir, "p20"), { recursive: true });
  appendFileSync(file, JSON.stringify(rec) + "\n");
  return rec;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const a = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  try {
    const path = a("--record");
    const text = path && existsSync(path) ? readFileSync(path, "utf8") : null;
    const rec = publish({ evidenceDir: process.env.EVIDENCE_DIR, recordText: text, mode: a("--mode") || "producao", runId: process.env.GITHUB_RUN_ID, sha: process.env.GITHUB_SHA });
    console.log("::notice title=P20_DRILL_EVIDENCE::" + JSON.stringify({ label: rec.label, verdict: rec.verdict, reason: rec.reason ?? null }));
  } catch (e) { console.log("::error title=P20_DRILL_EVIDENCE::" + String(e?.message || e).slice(0, 300)); process.exit(1); }
}
