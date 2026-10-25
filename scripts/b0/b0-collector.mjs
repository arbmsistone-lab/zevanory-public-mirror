// ZEVANORY | Coletor diário da linha de base B0 (Roteiro Mestre v4.7, seção 8, item 1).
// Somente leitura: GET em páginas públicas, leitura das sondagens P18 e dos ensaios mensais P20 já gravados no ramo
// de evidência e leitura,
// pela API REST do GitHub (GITHUB_TOKEN, escopo actions/checks: read), das anotações públicas que os workflows
// agendados command-center-snapshot e data-backup já emitem. Nenhum segredo de produção, nenhum POST em produção,
// nenhuma chamada de checkout/pagamento, nenhum dado pessoal.
//
// Grava em EVIDENCE_DIR (clone do ramo evidence/b0-baseline, nunca gh-pages):
//   b0/baseline-v1.jsonl  (append-only, uma linha por coleta; a última coleta de cada dia vale)
//   b0/register-v1.json   (registro por processo: início, fontes, metas, rótulos, estado; versionado pelo git)
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  UA, SITEMAPS, PROCESS_IDS, addDays, measured, na, buildDailyRecord, validateDailyRecord, validateProbe, parseJsonl,
  validateTargets, buildRegister, consecutiveCompleteDays, PROCESSES, parseCommandCenter, parseFunnelDiag, parseDataBackup,
  parseSitemap, summarizeHttp, parseA11y, aggregateProbes, aggregateLatency, validateRun, validateIncident, parseWorkersUsage, parsePlanProbe, P19_NEON_STORAGE_MAX_AGE_DAYS, pickMonthlyDrill,
} from "./b0-lib.mjs";
import { parseDrillHistory } from "../p20/restore-drill-lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function probeUrl(url, { fetchImpl = fetch, retries = 1, pause = sleep, timeoutMs = 20000 } = {}) {
  let last = { url, status: 0, error: "not_attempted" };
  for (let i = 0; i <= retries; i++) {
    const t0 = Date.now();
    try {
      const r = await fetchImpl(url, { method: "GET", redirect: "follow", headers: { "user-agent": UA, accept: "text/html,application/json;q=0.9,*/*;q=0.5", "cache-control": "no-cache" }, signal: AbortSignal.timeout(timeoutMs) });
      const body = await r.text().catch(() => "");
      last = { url, status: r.status, latency_ms: Date.now() - t0, body };
      if (r.status < 500) return last;
    } catch (e) { last = { url, status: 0, latency_ms: Date.now() - t0, error: String(e?.name || "error").slice(0, 40) }; }
    if (i < retries) await pause(3000);
  }
  return last;
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

function gh(env, fetchImpl) {
  const repo = env.GITHUB_REPOSITORY, token = env.GITHUB_TOKEN;
  return async (path) => {
    if (!repo || !token) throw new Error("github_api_unconfigured");
    const r = await fetchImpl(`https://api.github.com/repos/${repo}${path}`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "zevanory-b0-collector" }, signal: AbortSignal.timeout(20000) });
    if (r.status !== 200) throw new Error("github_http_" + r.status);
    return r.json();
  };
}

// Último run de um workflow, em gh-pages, criado no dia D (agendado ou manual; nunca PR).
async function latestRun(api, workflowFile, day, { requireSuccess }) {
  const q = `/actions/workflows/${workflowFile}/runs?branch=gh-pages&created=${day}&per_page=100${requireSuccess ? "&status=success" : "&status=completed"}`;
  const d = await api(q);
  const runs = (Array.isArray(d?.workflow_runs) ? d.workflow_runs : [])
    .filter((r) => r && r.head_branch === "gh-pages" && ["schedule", "workflow_dispatch"].includes(r.event) && String(r.path || "").endsWith(".github/workflows/" + workflowFile)
      && typeof r.created_at === "string" && r.created_at.slice(0, 10) === day && r.status === "completed")
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return runs[0] || null;
}
// Último run bem-sucedido de um workflow em gh-pages criado entre fromDay e toDay (inclusive).
async function latestRunInWindow(api, workflowFile, fromDay, toDay) {
  const d = await api(`/actions/workflows/${workflowFile}/runs?branch=gh-pages&created=${fromDay}..${toDay}&per_page=100&status=success`);
  const runs = (Array.isArray(d?.workflow_runs) ? d.workflow_runs : [])
    .filter((r) => r && r.head_branch === "gh-pages" && ["schedule", "workflow_dispatch"].includes(r.event) && String(r.path || "").endsWith(".github/workflows/" + workflowFile)
      && typeof r.created_at === "string" && r.created_at.slice(0, 10) >= fromDay && r.created_at.slice(0, 10) <= toDay && r.status === "completed" && r.conclusion === "success")
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return runs[0] || null;
}
async function annotations(api, runId) {
  const jobs = await api(`/actions/runs/${runId}/jobs?per_page=50`);
  const out = [];
  for (const j of Array.isArray(jobs?.jobs) ? jobs.jobs : []) {
    const a = await api(`/check-runs/${j.id}/annotations?per_page=100`);
    if (Array.isArray(a)) out.push(...a);
  }
  return out;
}
const pick = (anns, title) => { const xs = anns.filter((a) => a && a.title === title && a.annotation_level === "notice"); return xs.length === 1 ? xs[0].message : null; };

export function readHistory(evidenceDir) {
  const f = join(evidenceDir, "b0", "baseline-v1.jsonl");
  return existsSync(f) ? parseJsonl(readFileSync(f, "utf8"), validateDailyRecord) : [];
}
// Linhas p18/<prefix>-AAAA-MM.jsonl dos meses dos dias pedidos. Malformado derruba (HISTORY_MALFORMED).
export function readP18(evidenceDir, prefix, days, validate) {
  const dir = join(evidenceDir, "p18");
  if (!existsSync(dir)) return [];
  const months = new Set(days.map((d) => d.slice(0, 7)));
  const re = new RegExp(`^${prefix}-(\\d{4}-\\d{2})\\.jsonl$`);
  const out = [];
  for (const f of readdirSync(dir).sort()) {
    const m = re.exec(f);
    if (!m || !months.has(m[1])) continue;
    out.push(...parseJsonl(readFileSync(join(dir, f), "utf8"), validate));
  }
  return out;
}
export function readProbes(evidenceDir, days) { return readP18(evidenceDir, "probes", days, validateProbe); }

// Registros do ensaio mensal P20 (p20/restore-drills-v1.jsonl, gravado por p20-monthly-restore-drill.yml).
// Malformado lança; o chamador transforma em NOT_AVAILABLE só do campo P20 (os outros processos seguem).
export function readDrills(evidenceDir) {
  const f = join(evidenceDir, "p20", "restore-drills-v1.jsonl");
  return existsSync(f) ? parseDrillHistory(readFileSync(f, "utf8")) : [];
}

export async function collect({ env = process.env, fetchImpl = fetch, now = new Date(), pause = sleep, log = console.log } = {}) {
  const evidenceDir = env.EVIDENCE_DIR;
  if (!evidenceDir) throw new Error("EVIDENCE_DIR_REQUIRED");
  const nowIso = now.toISOString();
  const day = env.B0_DAY || addDays(nowIso.slice(0, 10), -1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day >= nowIso.slice(0, 10)) throw new Error("B0_DAY_INVALID");

  // Fail-closed antes de qualquer rede: metas e histórico precisam estar íntegros.
  const targets = validateTargets(JSON.parse(readFileSync(env.TARGETS_FILE || "docs/b0/metas-propostas.json", "utf8")));
  const history = readHistory(evidenceDir);
  // Vizinhos (dia anterior e seguinte) entram só para medir a lacuna entre verificações que atravessa a meia-noite.
  const around = [addDays(day, -1), day, addDays(day, 1)];
  const probes = readProbes(evidenceDir, around);
  const runs = readP18(evidenceDir, "runs", around, validateRun);
  const incidents = readP18(evidenceDir, "incidents", around, validateIncident);

  const F = Object.fromEntries(PROCESS_IDS.map((p) => [p, {}]));
  const api = gh(env, fetchImpl);

  // P03: status HTTP de todas as URLs dos sitemaps públicos + pa11y das páginas de venda (arquivo do passo anterior).
  try {
    const urls = [];
    for (const sm of SITEMAPS) {
      const r = await probeUrl(sm, { fetchImpl, pause });
      if (r.status !== 200) throw new Error("sitemap_http_" + r.status);
      const p = parseSitemap(r.body);
      if (!p.ok) throw new Error("sitemap_" + p.reason);
      urls.push(...p.urls);
    }
    const uniq = [...new Set(urls)].slice(0, 400);
    const res = await pool(uniq, 6, (u) => probeUrl(u, { fetchImpl, pause }));
    F.P03.public_pages_http = measured("GET sitemaps públicos + URLs listadas (runner GitHub, fora da Cloudflare)", summarizeHttp(res, [...SITEMAPS]));
  } catch (e) { F.P03.public_pages_http = na("GET sitemaps públicos", e.message); }
  try {
    const a = parseA11y(JSON.parse(readFileSync(env.A11Y_FILE || "", "utf8")));
    F.P03.a11y_wcag2aa = a.ok ? measured("pa11y ao vivo (passo p03-a11y)", a.v) : na("pa11y ao vivo", a.reason);
  } catch { F.P03.a11y_wcag2aa = na("pa11y ao vivo", "a11y_file_missing_or_invalid_json"); }

  // P06 e P08: não há fonte somente leitura (ver PROCESSES.*.sources). NOT_AVAILABLE explícito, nunca 0.
  F.P06.publication_duplicate_audit = na("registro de publicações", "no_readonly_source");
  F.P08.lead_consent_counts = na("tabela de leads + eventos (Neon)", "no_readonly_source");

  // P15 e P19: anotações COMMAND_CENTER / FUNNEL_DIAG do último run bem-sucedido do command-center no dia D.
  try {
    const run = await latestRun(api, "command-center-snapshot.yml", day, { requireSuccess: true });
    if (!run) throw new Error("no_successful_run_on_day");
    const anns = await annotations(api, run.id);
    const src = `command-center-snapshot run ${run.id}`;
    const cc = parseCommandCenter(pick(anns, "COMMAND_CENTER"), day);
    const fd = parseFunnelDiag(pick(anns, "FUNNEL_DIAG"));
    if (!cc.ok) throw new Error("command_center_" + cc.reason);
    F.P19.kv_quota = cc.kv.ok ? measured(src, cc.kv.v) : na(src, cc.kv.reason);
    F.P15.funnel_visits = cc.visits.ok ? measured(src, cc.visits.v) : na(src, cc.visits.reason);
    if (fd.ok) { F.P15.funnel_origin = measured(src, fd.origin); F.P15.funnel_interest = measured(src, fd.interest); }
    else { F.P15.funnel_origin = na(src, "funnel_diag_" + fd.reason); F.P15.funnel_interest = na(src, "funnel_diag_" + fd.reason); }
  } catch (e) {
    for (const [p, f] of [["P19", "kv_quota"], ["P15", "funnel_visits"], ["P15", "funnel_origin"], ["P15", "funnel_interest"]]) F[p][f] = na("command-center-snapshot", e.message);
  }

  // P19 Workers: o command-center grava em workersUsage o dia UTC COMPLETO anterior; o dia D vem de um run de D+1.
  try {
    const next = addDays(day, 1);
    if (next > nowIso.slice(0, 10)) throw new Error("next_day_not_started");
    const run = await latestRun(api, "command-center-snapshot.yml", next, { requireSuccess: true });
    if (!run) throw new Error("no_successful_run_on_next_day");
    const w = parseWorkersUsage(pick(await annotations(api, run.id), "COMMAND_CENTER"), day);
    F.P19.workers_usage = w.ok ? measured(`command-center-snapshot run ${run.id} (workersUsage do dia ${day})`, w.v) : na(`command-center-snapshot run ${run.id}`, w.reason);
  } catch (e) { F.P19.workers_usage = na("command-center-snapshot (workersUsage)", e.message); }
  // P19 Neon armazenamento: anotação PLAN_PROBE do plan-probe semanal (até 8 dias antes do fim do dia D).
  try {
    const run = await latestRunInWindow(api, "plan-probe.yml", addDays(day, -P19_NEON_STORAGE_MAX_AGE_DAYS), day);
    if (!run) throw new Error("no_successful_plan_probe_within_8_days");
    const n = parsePlanProbe(pick(await annotations(api, run.id), "PLAN_PROBE"), run, day);
    F.P19.neon_storage = n.ok ? measured(`plan-probe run ${run.id}`, n.v) : na(`plan-probe run ${run.id}`, n.reason);
  } catch (e) { F.P19.neon_storage = na("plan-probe (PLAN_PROBE)", e.message); }
  // P19 Neon CU-h do mês: sem fonte somente leitura (exige chave de API do Neon, credencial nova). NOT_AVAILABLE explícito.
  F.P19.neon_compute = na("API de consumo do Neon", "requires_new_credential_neon_api_key");

  // P18 e P22: agregação das sondagens do monitor externo gravadas no próprio ramo de evidência.
  const ag = aggregateProbes(probes, day);
  F.P18.sales_availability = ag.enough ? measured("p18-external-monitor (ramo de evidência)", ag.p18) : na("p18-external-monitor", `coverage_insufficient ${ag.p18.probes}/${ag.p18.expected}`);
  // Seção 9 auditada: latências dos incidentes, atraso do agendador e veredito MET/NOT_MET/NOT_PROVEN do dia.
  F.P18.alert_latency = ag.enough ? measured("p18-external-monitor: incidentes, execuções e sondagens (ramo de evidência)", aggregateLatency({ probes, runs, incidents, day }))
    : na("p18-external-monitor", `coverage_insufficient ${ag.p18.probes}/${ag.p18.expected}`);
  F.P22.financial_proof_freshness = ag.enough ? measured("GET /api/status em cada sondagem P18", ag.p22) : na("GET /api/status via P18", `coverage_insufficient ${ag.p22.readings}/${ag.p22.expected}`);

  // P20: último run concluído do data-backup no dia D (sucesso OU falha: ambos são medição).
  try {
    const run = await latestRun(api, "data-backup.yml", day, { requireSuccess: false });
    if (!run) throw new Error("no_completed_run_on_day");
    const anns = await annotations(api, run.id);
    const msg = anns.filter((a) => a && a.title === "DATA_BACKUP" && ["notice", "failure"].includes(a.annotation_level)).map((a) => a.message).find((m) => m && m.trim().startsWith("{"));
    const b = parseDataBackup(msg, run, nowIso);
    F.P20.backup_restore_sample = b.ok ? measured(`data-backup run ${run.id}`, b.v) : na(`data-backup run ${run.id}`, b.reason);
  } catch (e) { F.P20.backup_restore_sample = na("data-backup", e.message); }
  // P20: ensaio mensal de restauração completa (registro no próprio ramo de evidência). SINTETICA nunca conta.
  {
    const src = "p20-monthly-restore-drill (ramo de evidência, p20/restore-drills-v1.jsonl)";
    let drills = null;
    try { drills = readDrills(evidenceDir); } catch { drills = null; }
    const d = drills ? pickMonthlyDrill(drills, day) : { ok: false, reason: "drill_history_malformed" };
    F.P20.monthly_full_restore_drill = d.ok ? measured(src, d.v) : na(src, d.reason);
  }

  const record = buildDailyRecord({ day, collectedAt: nowIso, runId: env.GITHUB_RUN_ID, sha: env.GITHUB_SHA, fieldsByProcess: F });
  validateDailyRecord(JSON.parse(JSON.stringify(record)));  // o que gravamos tem de passar na releitura estrita

  const all = [...history, record];
  const register = buildRegister(all, targets, nowIso);
  mkdirSync(join(evidenceDir, "b0"), { recursive: true });
  appendFileSync(join(evidenceDir, "b0", "baseline-v1.jsonl"), JSON.stringify(record) + "\n");
  writeFileSync(join(evidenceDir, "b0", "register-v1.json"), JSON.stringify(register, null, 2) + "\n");

  const summary = PROCESS_IDS.map((p) => ({ p, complete: record.processes[p].complete, consecutive: consecutiveCompleteDays(all, p, PROCESSES[p].label).consecutive, state: register.processes[p].state, missing: record.processes[p].incomplete_reasons }));
  for (const s of summary) log(`B0 ${day} ${s.p} complete=${s.complete} consecutive=${s.consecutive} state=${s.state}${s.missing.length ? " missing=" + s.missing.join(";") : ""}`);
  log("::notice title=B0_BASELINE::" + JSON.stringify({ day, processes: Object.fromEntries(summary.map((s) => [s.p, { complete: s.complete, consecutive: s.consecutive, state: s.state }])) }));
  return { record, register };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) collect().catch((e) => { console.log("::error title=B0_BASELINE::" + String(e?.message || e).slice(0, 300)); process.exit(1); });
