// Owner notification for the shared KV write quota (Marco B / Q1c). Opens or updates ONE GitHub issue
// per UTC day when the forecast is not "ok": GitHub e-mails the owner, and nothing is written to KV.
// Never fails the snapshot: any error becomes a warning annotation (exit 0).
import { readFileSync } from "node:fs";

export const issueTitle = (day) => `[KV] cota de gravações em risco — ${day}`;
export function issueBody(f) {
  return [
    `Nível: **${f.level}** · gravações hoje: **${f.writes}/${f.limit}** (${f.pct}%) · projeção até 00:00 UTC: **${f.projectedEndOfDay}** (${f.projectedPct}%).`,
    "",
    "- `early`: ≥ 60% ou projeção ≥ 90% → não iniciar novas publicações até a virada (00:00 UTC).",
    "- `shedding`: ≥ 70% → o Worker já descarta observabilidade.",
    "- `critical`: ≥ 90% ou projeção ≥ 100% → risco de a prova financeira não renovar e as vendas fecharem.",
    "",
    `Atualizado em ${new Date().toISOString()} pelo command-center-snapshot. Sem dados pessoais.`,
  ].join("\n");
}
// Decide what to do; pure.
export function decide(forecast, openIssues) {
  if (!forecast || !forecast.level || forecast.level === "ok" || !/^\d{4}-\d{2}-\d{2}$/.test(String(forecast.day || ""))) return { action: "skip" };
  const title = issueTitle(forecast.day);
  const existing = (openIssues || []).find((i) => i && i.title === title && !i.pull_request);
  return existing ? { action: "update", number: existing.number, title } : { action: "create", title };
}

export async function run({ env = process.env, fetchImpl = fetch, log = console.log, readFile = readFileSync } = {}) {
  let forecast = null;
  try { forecast = JSON.parse(String(readFile(env.KV_FORECAST_OUT, "utf8"))); } catch { log("KV_QUOTA_ISSUE: no forecast (ok or unverified)"); return "skip"; }
  if (!forecast || forecast.level === "ok") { log("KV_QUOTA_ISSUE: level ok"); return "skip"; }
  const repo = env.GITHUB_REPOSITORY, token = env.GITHUB_TOKEN;
  if (!repo || !token) { log("::warning title=KV_QUOTA_ISSUE::missing repository or token"); return "error"; }
  const api = (path, init = {}) => fetchImpl(`https://api.github.com/repos/${repo}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", ...(init.headers || {}) }, signal: AbortSignal.timeout(15000) });
  try {
    const r = await api(`/issues?state=open&per_page=100&creator=${encodeURIComponent("github-actions[bot]")}`);
    if (!r.ok) throw new Error("list_http_" + r.status);
    const d = decide(forecast, await r.json());
    if (d.action === "skip") return "skip";
    const body = JSON.stringify(d.action === "create" ? { title: d.title, body: issueBody(forecast) } : { body: issueBody(forecast) });
    const w = await api(d.action === "create" ? "/issues" : `/issues/${d.number}`, { method: d.action === "create" ? "POST" : "PATCH", body });
    if (!w.ok) throw new Error(d.action + "_http_" + w.status);
    log(`KV_QUOTA_ISSUE: ${d.action} ${d.title}`);
    return d.action;
  } catch (e) {
    log("::warning title=KV_QUOTA_ISSUE::" + String(e?.message || e).slice(0, 120));
    return "error";
  }
}
const isMain = process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href;
if (isMain) run().then(() => process.exit(0));
