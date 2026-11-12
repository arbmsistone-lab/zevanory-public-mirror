// Vigia v2, lado GitHub Actions (NC-CX-1031-05/06). Por workflow vigiado, observa SÓ runs da gh-pages
// (branch, evento e head_branch conferidos), pagina até achar observação relevante e devolve
// falha | saudavel | desconhecido. Correção de nível 1: repete UMA vez apenas os workflows auditados como
// somente-leitura (RERUN_ALLOWLIST), com reserva durável no KV ANTES do POST e estado incerto se a resposta
// se perder; nunca pede de novo o mesmo run. O workflow roda serializado (concurrency sem cancelamento).
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
export const VIGIA_ACTIONS_KEY = "zpc:vigia:actions:v2";
export const RERUN_LEDGER_KEY = "zpc:vigia:rerun:v1";
export const WATCH = Object.freeze(["p18-commercial-check.yml", "command-center-snapshot.yml", "p18-external-monitor.yml", "youtube-autonomous-short.yml", "indexnow-submit.yml", "central-production-integrity-audit.yml"]);
// Só a checagem comercial ao vivo (GET nas páginas e no checkout, relatório em artefato) é repetível sem efeito
// colateral. Snapshot (grava KV/abre issue) e monitor externo (publica evidência/issue) ficam fora.
export const RERUN_ALLOWLIST = Object.freeze(["p18-commercial-check.yml"]);
const REPO = "arbmsistone-lab/zevanory-public-mirror", BRANCH = "gh-pages", EVENTS = ["schedule", "workflow_dispatch", "push"];
const WINDOW_MS = 24 * 3600000, MAX_PAGES = 3, RERUN_MAX_AGE_MS = 6 * 3600000, RERUN_KEEP_MS = 7 * 86400000;
// Memória de repetição com três defesas independentes (NC-CX-1031-05, rodada 2): (1) diário zpc:vigia:rerun:v1,
// (2) cópia no resumo zpc:vigia:actions:v2 (campo reruns), (3) o próprio GitHub: run_attempt === 1 e
// /attempts/2 respondendo 404. Perder o diário não basta para pedir de novo; qualquer dúvida = não pede.

export async function watchActions({ token, now = Date.now(), fetchImpl = fetch, ledger = null, previous = null } = {}) {
  if (!token) throw new Error("github_token_missing");
  const raw = async (path, method = "GET") => fetchImpl("https://api.github.com/repos/" + REPO + path, { method, headers: { authorization: "Bearer " + token, accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15000) });
  const api = async (path, method = "GET") => {
    const r = await raw(path, method);
    if (method === "POST") return r.status;
    if (!r.ok) throw new Error("github_http_" + r.status);
    return r.json();
  };
  // previous: resumo anterior (objeto), null (nunca houve) ou "ilegivel". Cópia das repetições, podada a 7 dias.
  const prevReruns = previous && typeof previous === "object" && previous.reruns && typeof previous.reruns === "object" && !Array.isArray(previous.reruns) ? previous.reruns : {};
  const reruns = Object.fromEntries(Object.entries(prevReruns).filter(([id, v]) => /^\d{1,20}$/.test(id) && v && typeof v === "object" && now - Date.parse(v.at) < RERUN_KEEP_MS));
  const workflows = {};
  for (const wf of WATCH) {
    let latest = null, complete = true;
    try {
      for (let page = 1; page <= MAX_PAGES && !latest; page++) {
        const body = await api(`/actions/workflows/${wf}/runs?branch=${BRANCH}&status=completed&per_page=20&page=${page}`);
        if (!Array.isArray(body?.workflow_runs)) { complete = false; break; }
        const relevant = body.workflow_runs.filter((r) => r && r.head_branch === BRANCH && EVENTS.includes(r.event) && Number.isSafeInteger(r.id) && Number.isFinite(Date.parse(r.created_at)) && Date.parse(r.created_at) <= now + 5 * 60000 && ["success", "failure", "timed_out", "startup_failure"].includes(r.conclusion));
        relevant.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
        latest = relevant[0] || null;
        if (body.workflow_runs.length < 20) break;
      }
    } catch { complete = false; }
    if (!complete || !latest || now - Date.parse(latest.created_at) > WINDOW_MS) { workflows[wf] = { state: "desconhecido" }; continue; }
    workflows[wf] = { state: latest.conclusion === "success" ? "saudavel" : "falha", run_id: latest.id, at: latest.created_at, conclusion: latest.conclusion, rerun: "nao_permitida" };
  }
  // Nível 1: repetição única com reserva durável.
  if (ledger) {
    for (const wf of RERUN_ALLOWLIST) {
      const w = workflows[wf];
      if (w?.state !== "falha") continue;
      if (previous === "ilegivel") { w.rerun = "registro_ilegivel"; continue; }
      let book;
      try { const raw = await ledger.get(RERUN_LEDGER_KEY); book = raw === null ? {} : JSON.parse(raw); if (!book || typeof book !== "object" || Array.isArray(book)) throw new Error("shape"); }
      catch { w.rerun = "registro_ilegivel"; continue; } // sem registro confiável, nenhuma repetição
      const id = String(w.run_id);
      const known = book[id] || reruns[id];
      if (known) { w.rerun = known.state === "feita" ? "feita" : known.state === "incerta" ? "incerta" : "ja_registrada"; if (!reruns[id]) reruns[id] = { state: known.state, at: known.at || new Date(now).toISOString(), workflow: wf }; continue; }
      if (now - Date.parse(w.at) > RERUN_MAX_AGE_MS) { w.rerun = "fora_da_politica"; continue; }
      let run;
      try { run = await api(`/actions/runs/${id}`); } catch { w.rerun = "nao_conferida"; continue; }
      if (run?.id !== w.run_id || run?.head_branch !== BRANCH || run?.event !== "schedule" || run?.run_attempt !== 1 || run?.status !== "completed" || !["failure", "timed_out"].includes(run?.conclusion)) { w.rerun = "fora_da_politica"; continue; }
      // O GitHub como terceira memória: existe a 2ª tentativa? Só 404 explícito prova que não.
      let second;
      try { second = (await raw(`/actions/runs/${id}/attempts/2`)).status; } catch { second = 0; }
      if (second === 200) { w.rerun = "ja_registrada"; reruns[id] = { state: "feita", at: new Date(now).toISOString(), workflow: wf }; continue; }
      if (second !== 404) { w.rerun = "nao_conferida"; continue; }
      book[id] = { state: "reservada", at: new Date(now).toISOString(), workflow: wf };
      try { await ledger.put(RERUN_LEDGER_KEY, JSON.stringify(book), { expirationTtl: 30 * 86400 }); } catch { w.rerun = "reserva_falhou"; continue; }
      const status = await api(`/actions/runs/${id}/rerun-failed-jobs`, "POST").catch(() => 0);
      book[id].state = [201, 202, 204].includes(status) ? "feita" : [403, 409, 422].includes(status) ? "recusada" : "incerta";
      w.rerun = book[id].state === "feita" ? "feita" : book[id].state === "incerta" ? "incerta" : "recusada";
      reruns[id] = { state: book[id].state, at: book[id].at, workflow: wf };
      try { await ledger.put(RERUN_LEDGER_KEY, JSON.stringify(book), { expirationTtl: 30 * 86400 }); } catch {}
    }
  }
  return { schema: 2, at: new Date(now).toISOString(), workflows, reruns };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { cloudflareKv } = await import("../channels/youtube-daily-short.mjs");
  const kv = cloudflareKv({ token: process.env.CLOUDFLARE_API_TOKEN, account: process.env.CLOUDFLARE_ACCOUNT_ID, namespace: process.env.KV_NAMESPACE_ID });
  let previous;
  try { const raw = await kv.get(VIGIA_ACTIONS_KEY); previous = raw === null ? null : JSON.parse(raw); } catch { previous = "ilegivel"; }
  if (previous !== null && previous !== "ilegivel" && (typeof previous !== "object" || Array.isArray(previous))) previous = "ilegivel";
  const summary = await watchActions({ token: process.env.GITHUB_TOKEN, ledger: kv, previous });
  await kv.put(VIGIA_ACTIONS_KEY, JSON.stringify(summary), { expirationTtl: 2 * 86400 });
  console.log(JSON.stringify(Object.fromEntries(Object.entries(summary.workflows).map(([k, v]) => [k, v.state + (v.rerun && v.rerun !== "nao_permitida" ? ":" + v.rerun : "")]))));
}
