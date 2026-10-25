// ZEVANORY | Vigia do monitor P18 (auditoria Sol 246.09/246.14). Lê p18/heartbeat.json no ramo evidence/b0-baseline
// pela API REST do GitHub (GITHUB_TOKEN, somente leitura de conteúdo) e acusa quando a última execução BEM-SUCEDIDA
// do monitor é mais velha que HEARTBEAT_STALE_MIN (15 min), ou quando o batimento falta, está malformado ou no futuro.
//
// Canal distinto do alerta de vendas: issue própria ([P18-VIGIA], nunca a issue de vendas) E o próprio job termina com
// falha, o que dispara a notificação de falha de workflow agendado do GitHub (e-mail para quem por último alterou o
// agendamento). Fecha a issue quando o batimento volta a ficar fresco. Nenhuma chamada à produção, nenhum segredo.
//
// Limite honesto: este vigia roda no MESMO agendador do GitHub. Ele pega monitor quebrado, desativado, com push de
// evidência falhando ou atrasado enquanto o vigia ainda roda; não pega uma parada geral do agendador. O gatilho
// independente (cron já existente do Worker de controle) é passo do proprietário (descrito no PR do vigia).
import { pathToFileURL } from "node:url";
import { evaluateHeartbeat, findOpenAlert, watchdogBody, WATCHDOG_TITLE } from "./b0-lib.mjs";

export const HEARTBEAT_PATH = "p18/heartbeat.json";

export async function readHeartbeat({ env, fetchImpl = fetch }) {
  const repo = env.GITHUB_REPOSITORY, token = env.GITHUB_TOKEN, ref = env.EVIDENCE_BRANCH || "evidence/b0-baseline";
  if (ref !== "evidence/b0-baseline") throw new Error("EVIDENCE_BRANCH_REFUSED");
  const r = await fetchImpl(`https://api.github.com/repos/${repo}/contents/${HEARTBEAT_PATH}?ref=${encodeURIComponent(ref)}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github.raw", "user-agent": "zevanory-p18-watchdog" }, signal: AbortSignal.timeout(15000),
  });
  if (r.status === 404) return { hb: null };
  if (r.status !== 200) return { hb: undefined, error: "github_http_" + r.status };
  const text = await r.text();
  try { return { hb: JSON.parse(text) }; } catch { return { hb: { malformed: true } }; }
}

export async function watchdog({ env = process.env, fetchImpl = fetch, now = () => Date.now(), log = console.log } = {}) {
  const repo = env.GITHUB_REPOSITORY, token = env.GITHUB_TOKEN;
  if (!repo || !token) throw new Error("github_api_unconfigured");
  const read = await readHeartbeat({ env, fetchImpl });
  const ev = read.error ? { state: "UNREADABLE", alert: true, age_s: null, last_success_at: null, error: read.error } : evaluateHeartbeat(read.hb, now());
  const api = async (path, init = {}) => {
    const r = await fetchImpl(`https://api.github.com/repos/${repo}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "zevanory-p18-watchdog" }, signal: AbortSignal.timeout(15000) });
    if (r.status < 200 || r.status >= 300) throw new Error("github_http_" + r.status);
    return r.json();
  };
  const open = findOpenAlert(await api(`/issues?state=open&per_page=100&creator=${encodeURIComponent("github-actions[bot]")}`), WATCHDOG_TITLE);
  const runUrl = `https://github.com/${repo}/actions/runs/${env.GITHUB_RUN_ID || ""}`;
  let action = "none";
  if (ev.alert) {
    const body = JSON.stringify({ title: WATCHDOG_TITLE, body: watchdogBody(ev, runUrl) });
    if (open) { await api(`/issues/${open.number}`, { method: "PATCH", body }); action = "update"; }
    else { await api("/issues", { method: "POST", body }); action = "open"; }
  } else if (open) {
    await api(`/issues/${open.number}/comments`, { method: "POST", body: JSON.stringify({ body: `Batimento fresco de novo (${ev.last_success_at}, idade ${ev.age_s} s). Execução: ${runUrl}` }) });
    await api(`/issues/${open.number}`, { method: "PATCH", body: JSON.stringify({ state: "closed", state_reason: "completed" }) });
    action = "close";
  }
  log("::notice title=P18_WATCHDOG::" + JSON.stringify({ state: ev.state, age_s: ev.age_s, last_success_at: ev.last_success_at, action }));
  return { ev, action };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  watchdog().then(({ ev }) => {
    if (ev.alert) { console.log(`::error title=P18_WATCHDOG::monitor P18 sem batimento fresco (${ev.state}, idade ${ev.age_s ?? "?"} s)`); process.exit(1); }
  }).catch((e) => { console.log("::error title=P18_WATCHDOG::" + String(e?.message || e).slice(0, 300)); process.exit(1); });
}
