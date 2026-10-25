// ZEVANORY | P18, monitor externo e independente (Roteiro Mestre v4.7, seções 5 e 9: N2 "monitor externo alerta
// em até 10 min"). Roda num runner do GitHub (Azure), fora da Cloudflare. Somente GET; nunca /comprar, checkout ou
// pagamento; nenhum segredo de produção; nenhum dado pessoal.
//
// A cada execução:
//  1. sonda as páginas de venda e o /api/status (uma nova tentativa após 3 s para cada alvo);
//  2. lê a validade da prova financeira (P22) do corpo público do /api/status;
//  3. acrescenta uma linha em EVIDENCE_DIR/p18/probes-AAAA-MM.jsonl (ramo evidence/b0-baseline);
//  4. alerta: 2 sondagens seguidas com falha -> abre (ou atualiza) UMA issue; primeira sondagem boa -> fecha.
import { readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SALES_PAGES, STATUS_URL, SCHEMA_PROBE, readP22, validateProbe, parseJsonl, decideAlert, findOpenAlert, alertBody, ALERT_TITLE } from "./b0-lib.mjs";
import { probeUrl } from "./b0-collector.mjs";

export function targetId(url) { const u = new URL(url); return u.host + u.pathname; }

export async function runProbe({ fetchImpl = fetch, now = () => Date.now(), pause } = {}) {
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
  return validateProbe({ schema: SCHEMA_PROBE, at: new Date(now()).toISOString(), up: targets.every((t) => t.ok), targets, p22 });
}

export function lastProbe(evidenceDir, atIso) {
  // Mês corrente e, na virada do mês, o anterior.
  const d = new Date(atIso), cur = atIso.slice(0, 7);
  const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  for (const m of [cur, prev]) {
    const f = join(evidenceDir, "p18", `probes-${m}.jsonl`);
    if (!existsSync(f)) continue;
    const xs = parseJsonl(readFileSync(f, "utf8"), validateProbe);
    if (xs.length) return xs[xs.length - 1];
  }
  return null;
}

export async function handleAlert({ prev, cur, env, fetchImpl = fetch, log = console.log }) {
  const repo = env.GITHUB_REPOSITORY, token = env.GITHUB_TOKEN;
  if (!repo || !token) throw new Error("github_api_unconfigured");
  const api = async (path, init = {}) => {
    const r = await fetchImpl(`https://api.github.com/repos/${repo}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "zevanory-p18-monitor" }, signal: AbortSignal.timeout(15000) });
    if (r.status < 200 || r.status >= 300) throw new Error("github_http_" + r.status);
    return r.json();
  };
  // Só issues abertas pelo próprio bot com o título exato: ninguém de fora reabre/fecha o alerta pelo título.
  const open = findOpenAlert(await api(`/issues?state=open&per_page=100&creator=${encodeURIComponent("github-actions[bot]")}`));
  const d = decideAlert(prev, cur, open);
  const runUrl = `https://github.com/${repo}/actions/runs/${env.GITHUB_RUN_ID || ""}`;
  if (d.action === "open") await api("/issues", { method: "POST", body: JSON.stringify({ title: ALERT_TITLE, body: alertBody(cur, runUrl) }) });
  if (d.action === "update") await api(`/issues/${d.number}`, { method: "PATCH", body: JSON.stringify({ body: alertBody(cur, runUrl) }) });
  if (d.action === "close") {
    await api(`/issues/${d.number}/comments`, { method: "POST", body: JSON.stringify({ body: `Recuperado: sondagem de ${cur.at} passou em todos os alvos. Execução: ${runUrl}` }) });
    await api(`/issues/${d.number}`, { method: "PATCH", body: JSON.stringify({ state: "closed", state_reason: "completed" }) });
  }
  log(`P18_ALERT action=${d.action}`);
  return d.action;
}

export async function main({ env = process.env, fetchImpl = fetch, now = () => Date.now(), log = console.log, pause } = {}) {
  const dir = env.EVIDENCE_DIR;
  if (!dir) throw new Error("EVIDENCE_DIR_REQUIRED");
  const cur = await runProbe({ fetchImpl, now, pause });
  const prev = lastProbe(dir, cur.at);  // histórico malformado derruba (fail-closed), antes de gravar
  const rec = { ...cur, run_id: String(env.GITHUB_RUN_ID || ""), event: String(env.GITHUB_EVENT_NAME || "") };
  mkdirSync(join(dir, "p18"), { recursive: true });
  appendFileSync(join(dir, "p18", `probes-${cur.at.slice(0, 7)}.jsonl`), JSON.stringify(rec) + "\n");
  log("::notice title=P18_PROBE::" + JSON.stringify({ at: cur.at, up: cur.up, down: cur.targets.filter((t) => !t.ok).map((t) => t.id + ":" + t.status), p22_valid: cur.p22.valid ?? null }));
  const action = await handleAlert({ prev, cur, env, fetchImpl, log });
  return { cur, prev, action };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((e) => { console.log("::error title=P18_MONITOR::" + String(e?.message || e).slice(0, 300)); process.exit(1); });
