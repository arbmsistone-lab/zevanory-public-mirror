// ZEVANORY | P18, monitor externo e independente (Roteiro Mestre v4.7, seções 5 e 9: N2 "monitor externo alerta
// em até 10 min"). Roda num runner do GitHub (Azure), fora da Cloudflare. Somente GET; nunca /comprar, checkout ou
// pagamento; nenhum segredo de produção; nenhum dado pessoal.
//
// A cada execução (cron '2-59/5', auditoria Sol 246.09):
//  1. sonda as páginas de venda e o /api/status (uma nova tentativa após 3 s para cada alvo);
//  2. se é a 1ª falha ainda não confirmada, espera CONFIRM_DELAY_MS (60 s) e re-sonda NA MESMA EXECUÇÃO: duas
//     sondagens seguidas com falha, >= 60 s entre elas, confirmam sem esperar o próximo cron;
//  3. grava em EVIDENCE_DIR/p18 (ramo evidence/b0-baseline): probes-AAAA-MM.jsonl (cada sondagem),
//     incidents-AAAA-MM.jsonl (1ª falha observada, confirmação, emissão do alerta, recuperação, latências),
//     runs-AAAA-MM.jsonl (atraso do início sobre o slot do cron e intervalo desde a execução anterior) e
//     heartbeat.json (só quando a execução termina inteira; lido pelo vigia p18-monitor-watchdog);
//  4. alerta: incidente confirmado -> abre (ou atualiza) UMA issue; primeira sondagem boa -> fecha.
// Histórico malformado derruba antes de qualquer rede (fail-closed). Falha ao emitir o alerta grava o incidente com
// alert_emitted_at = null, NÃO grava o batimento e termina com erro (o vigia e a notificação de falha do workflow
// passam a valer); a próxima execução tenta emitir de novo e a latência medida inclui o atraso.
//
// Gatilho externo (AVAL Sol 253/254): o cron do Worker de controle pede workflow_dispatch a cada 5 min com
// window_id/dispatched_at/dispatch_source (env P18_WINDOW_ID, P18_DISPATCHED_AT, P18_DISPATCH_SOURCE). Cada execução
// grava o início real do runner e, quando pedida, dispatch_to_start_s. Janela já sondada (pelo id pedido ou pela
// janela do início) = execução duplicate_window: grava a linha de execução (prova de que o pedido chegou e iniciou),
// não sonda, não alerta, não grava batimento. O agendador do GitHub segue como caminho extra de melhor esforço.
import { readFileSync, appendFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  SALES_PAGES, STATUS_URL, SCHEMA_PROBE, CONFIRM_DELAY_MS, readP22, validateProbe, validateRun, validateIncident, parseJsonl,
  decideIncident, finalizeIncident, openIncident, buildRunRecord, buildHeartbeat, findOpenAlert, alertBody, ALERT_TITLE,
  resolveDispatch, isDuplicateWindow, buildCfDispatch, PROBING_OUTCOMES, evaluateCfDispatch, firstProofAt,
} from "./b0-lib.mjs";
import { probeUrl } from "./b0-collector.mjs";

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function targetId(url) { const u = new URL(url); return u.host + u.pathname; }

export async function runProbe({ fetchImpl = fetch, now = () => Date.now(), pause, kind = "scheduled" } = {}) {
  const urls = [...SALES_PAGES, STATUS_URL];
  const res = await Promise.all(urls.map((u) => probeUrl(u, { fetchImpl, pause, retries: 1, timeoutMs: 20000 })));
  let p22 = { readable: false, reason: "status_unreachable" };
  const targets = res.map((r) => {
    let ok = r.status >= 200 && r.status < 400;
    if (r.url === STATUS_URL) {
      let body = null;
      try { body = JSON.parse(r.body || ""); } catch { body = null; }
      ok = r.status === 200 && body !== null && typeof body === "object";
      p22 = ok ? readP22(body, now()) : { readable: false, reason: "status_http_" + r.status };
    }
    return { id: targetId(r.url), ok, status: Number.isInteger(r.status) ? r.status : 0, latency_ms: r.latency_ms ?? null, ...(r.error ? { error: r.error } : {}) };
  });
  return validateProbe({ schema: SCHEMA_PROBE, at: new Date(now()).toISOString(), kind, up: targets.every((t) => t.ok), targets, p22 });
}

// Linhas do mês corrente e do anterior (virada do mês), em ordem. Malformado derruba.
export function readRecent(evidenceDir, prefix, atIso, validate) {
  const d = new Date(atIso), cur = atIso.slice(0, 7);
  const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const out = [];
  for (const m of [prev, cur]) {
    const f = join(evidenceDir, "p18", `${prefix}-${m}.jsonl`);
    if (existsSync(f)) out.push(...parseJsonl(readFileSync(f, "utf8"), validate));
  }
  return out;
}
export function lastProbe(evidenceDir, atIso) { return readRecent(evidenceDir, "probes", atIso, validateProbe).at(-1) || null; }

function appendLine(dir, prefix, atIso, obj) {
  mkdirSync(join(dir, "p18"), { recursive: true });
  appendFileSync(join(dir, "p18", `${prefix}-${atIso.slice(0, 7)}.jsonl`), JSON.stringify(obj) + "\n");
}

// Batimento do caminho Cloudflare -> GitHub: só execução pedida pela Cloudflare com janela aceita.
function writeCfDispatch(dir, run) {
  if (run.dispatch_source !== "cloudflare-cron" || !run.window_id) return;
  mkdirSync(join(dir, "p18"), { recursive: true });
  writeFileSync(join(dir, "p18", "cf-dispatch.json"), JSON.stringify(buildCfDispatch(run), null, 2) + "\n");
}

// Ordem Sol 263: 1ª prova VÁLIDA do caminho Cloudflare, levada adiante no batimento. Vem do batimento anterior ou, na
// falta, do cf-dispatch.json atual SE ele for prova válida (FRESH/STALE). Documento quebrado nunca vira 1ª prova.
function readJson(f) { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } }
function carryFirstProof(dir, nowMs) {
  const prev = existsSync(join(dir, "p18", "heartbeat.json")) ? firstProofAt(readJson(join(dir, "p18", "heartbeat.json")), nowMs) : null;
  if (prev) return prev;
  const f = join(dir, "p18", "cf-dispatch.json");
  const ev = existsSync(f) ? evaluateCfDispatch(readJson(f), nowMs) : null;
  return ev?.valid_proof ? ev.started_at : null;
}

// Executa a ação de alerta. Retorna { action, emitted_at, issue, error }. Nunca lança: o erro volta para o chamador
// gravar o incidente sem alert_emitted_at antes de falhar a execução.
export async function handleAlert({ decision, cur, incident, env, fetchImpl = fetch, now = () => Date.now(), log = console.log }) {
  const repo = env.GITHUB_REPOSITORY, token = env.GITHUB_TOKEN;
  const out = { action: decision.action, emitted_at: null, issue: null, error: null };
  try {
    if (!repo || !token) throw new Error("github_api_unconfigured");
    const api = async (path, init = {}) => {
      const r = await fetchImpl(`https://api.github.com/repos/${repo}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "zevanory-p18-monitor" }, signal: AbortSignal.timeout(15000) });
      if (r.status < 200 || r.status >= 300) throw new Error("github_http_" + r.status);
      return r.json();
    };
    // Só issues abertas pelo próprio bot com o título exato: ninguém de fora reabre/fecha o alerta pelo título.
    const open = findOpenAlert(await api(`/issues?state=open&per_page=100&creator=${encodeURIComponent("github-actions[bot]")}`), ALERT_TITLE);
    const runUrl = `https://github.com/${repo}/actions/runs/${env.GITHUB_RUN_ID || ""}`;
    const body = JSON.stringify({ title: ALERT_TITLE, body: alertBody(cur, runUrl, incident) });
    const a = decision.action;
    if (a === "confirm" || a === "alert_retry" || a === "update") {
      const r = open ? await api(`/issues/${open.number}`, { method: "PATCH", body }) : await api("/issues", { method: "POST", body });
      out.issue = Number.isInteger(r?.number) ? r.number : open?.number ?? null;
      if (a !== "update") out.emitted_at = new Date(now()).toISOString();  // instante em que a issue existe com o alerta
    } else if (cur.up && open) {
      await api(`/issues/${open.number}/comments`, { method: "POST", body: JSON.stringify({ body: `Recuperado: sondagem de ${cur.at} passou em todos os alvos. Execução: ${runUrl}` }) });
      await api(`/issues/${open.number}`, { method: "PATCH", body: JSON.stringify({ state: "closed", state_reason: "completed" }) });
      out.issue = open.number;
    }
  } catch (e) { out.error = String(e?.message || e).slice(0, 80); }
  log(`P18_ALERT action=${out.action}${out.error ? " error=" + out.error : ""}`);
  return out;
}

export async function main({ env = process.env, fetchImpl = fetch, now = () => Date.now(), log = console.log, pause, sleep = realSleep } = {}) {
  const dir = env.EVIDENCE_DIR;
  if (!dir) throw new Error("EVIDENCE_DIR_REQUIRED");
  const startedMs = now(), startedIso = new Date(startedMs).toISOString();
  // Fail-closed antes de qualquer rede: histórico de sondagens, incidentes e execuções precisa estar íntegro.
  const hist = readRecent(dir, "probes", startedIso, validateProbe);
  const incLines = readRecent(dir, "incidents", startedIso, validateIncident);
  const runs = readRecent(dir, "runs", startedIso, validateRun);
  const open = openIncident(incLines);
  const dispatch = resolveDispatch({ windowId: env.P18_WINDOW_ID || "", dispatchedAt: env.P18_DISPATCHED_AT || "", source: env.P18_DISPATCH_SOURCE || "", startedMs });
  const prevProbing = runs.filter((r) => PROBING_OUTCOMES.includes(r.outcome)).at(-1) || null;
  const run = buildRunRecord({ runId: env.GITHUB_RUN_ID, event: env.GITHUB_EVENT_NAME, startedMs, prevRun: prevProbing, dispatch });
  log("::notice title=P18_DISPATCH::" + JSON.stringify({ event: run.event, window_id: run.window_id, start_window_id: run.start_window_id, dispatch_source: run.dispatch_source, dispatched_at: run.dispatched_at, dispatch_to_start_s: run.dispatch_to_start_s, window_rejected: run.window_rejected }));
  if (isDuplicateWindow(runs, dispatch)) {
    // Idempotência: nenhuma rede, nenhuma sondagem, nenhum alerta; só a prova de que o pedido iniciou no runner.
    const dup = validateRun({ ...run, probes_at: [], confirm_reprobe: false, decision: "skip", incident_id: open?.incident_id ?? null, outcome: "duplicate_window" });
    appendLine(dir, "runs", run.started_at, dup);
    writeCfDispatch(dir, dup);
    log("::notice title=P18_SKIP::" + JSON.stringify({ reason: "window_already_probed", window_id: dup.window_id, start_window_id: dup.start_window_id }));
    return { cur: null, probes: [], decision: { action: "skip" }, action: "skip", incident: null, run: dup };
  }

  const probes = [await runProbe({ fetchImpl, now, pause, kind: "scheduled" })];
  appendLine(dir, "probes", probes[0].at, { ...probes[0], run_id: run.run_id, event: run.event });
  let d = decideIncident({ seq: [...hist, ...probes], open });
  if (d.action === "pending") {
    // 1ª falha: confirmação dentro desta execução, sem esperar o próximo cron.
    await sleep(CONFIRM_DELAY_MS);
    const p2 = await runProbe({ fetchImpl, now, pause, kind: "confirm" });
    appendLine(dir, "probes", p2.at, { ...p2, run_id: run.run_id, event: run.event });
    probes.push(p2);
    d = decideIncident({ seq: [...hist, ...probes], open });
  }
  const cur = probes.at(-1);
  log("::notice title=P18_PROBE::" + JSON.stringify({ at: cur.at, up: cur.up, probes: probes.length, decision: d.action, down: cur.targets.filter((t) => !t.ok).map((t) => t.id + ":" + t.status), p22_valid: cur.p22.valid ?? null }));

  const pendingInc = d.action === "confirm" ? d.incident : d.action === "alert_retry" ? open : null;
  const alert = await handleAlert({ decision: d, cur, incident: pendingInc, env, fetchImpl, now, log });
  let incident = null;
  if (d.action === "confirm") incident = finalizeIncident(d.incident, { alertEmittedAt: alert.emitted_at, alertIssue: alert.issue, alertError: alert.error });
  else if (d.action === "alert_retry" && alert.emitted_at) incident = finalizeIncident(open, { alertEmittedAt: alert.emitted_at, alertIssue: alert.issue });
  else if (d.action === "recover") incident = d.incident;
  if (incident) {
    appendLine(dir, "incidents", incident.confirmed_at, validateIncident(incident));
    log("::notice title=P18_INCIDENT::" + JSON.stringify({ id: incident.incident_id, first_failure_observed_at: incident.first_failure_observed_at, confirmed_at: incident.confirmed_at, alert_emitted_at: incident.alert_emitted_at, recovered_at: incident.recovered_at ?? null, latency_seconds: incident.latency_seconds, upper_bound_latency_seconds: incident.upper_bound_latency_seconds, s9: incident.s9 }));
  }
  const runRec = validateRun({ ...run, probes_at: probes.map((p) => p.at), confirm_reprobe: probes.length > 1, decision: d.action, incident_id: incident?.incident_id ?? open?.incident_id ?? null, outcome: alert.error ? "alert_failed" : "ok" });
  appendLine(dir, "runs", run.started_at, runRec);
  writeCfDispatch(dir, runRec);
  if (alert.error) throw new Error("P18_ALERT_FAILED " + alert.error);  // sem batimento: o vigia acusa
  const stillOpen = d.action === "recover" ? null : incident || open;
  writeFileSync(join(dir, "p18", "heartbeat.json"), JSON.stringify(buildHeartbeat({ nowMs: now(), runId: env.GITHUB_RUN_ID, run, cur, open: stillOpen, cfFirstProofAt: carryFirstProof(dir, now()) }), null, 2) + "\n");
  return { cur, probes, decision: d, action: d.action, incident, run: runRec };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((e) => { console.log("::error title=P18_MONITOR::" + String(e?.message || e).slice(0, 300)); process.exit(1); });
