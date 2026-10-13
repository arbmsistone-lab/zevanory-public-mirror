// Master certification matrix (Auditoria Suprema, item 16), generated — not hand-written.
// Discovers what exists (every workflow in the repository, every public URL in the sitemaps,
// every business process in the inventory, the production panel proof, the unit-test suite)
// and classifies each item PASS / FAIL / BLOCKED / NOT_TESTED with its evidence and time.
// No evidence = NOT_TESTED, never PASS. Writes KV zpc:matrix:v1 (command center).
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

export const MATRIX_KEY = "zpc:matrix:v1";
const DAY = 864e5;

export function classifyWorkflow(wf, runs, now = Date.now()) {
  if (String(wf.state || "").startsWith("disabled")) return { state: "BLOCKED", owner: "interno", evidence: "rotina desativada (" + wf.state + ")" };
  const done = (runs || []).filter((r) => r.status === "completed" && r.conclusion !== "cancelled");
  if (!done.length) return { state: "NOT_TESTED", owner: "interno", evidence: "nenhuma execução registrada" };
  const last = done[0];
  const at = last.updated_at || last.created_at;
  if (["failure", "timed_out", "startup_failure", "action_required"].includes(last.conclusion)) return { state: "FAIL", owner: "interno", evidence: `última execução: ${last.conclusion}`, at, url: last.html_url };
  if (now - Date.parse(at) > 30 * DAY) return { state: "NOT_TESTED", owner: "interno", evidence: "última execução com mais de 30 dias", at };
  return { state: "PASS", owner: "interno", evidence: `última execução: ${last.conclusion}`, at, url: last.html_url };
}

export function classifyProcess(p) {
  if (!p.eligible) return null;
  if (p.proven) return { state: "PASS", owner: "interno", evidence: p.how || "evidência recente", at: p.lastEvidence };
  if (p.failed) return { state: "FAIL", owner: "interno", evidence: p.how || "evidência recente negativa", at: p.lastEvidence };
  if (p.state === "awaiting_event") return { state: "BLOCKED", owner: "externo", evidence: p.dependency || "aguardando evento real" };
  if (p.state === "blocked_third_party") return { state: "BLOCKED", owner: "externo", evidence: p.dependency || "dependência de terceiro" };
  if (p.state === "partial") return { state: "BLOCKED", owner: "interno", evidence: p.dependency || "parcial" };
  return { state: "NOT_TESTED", owner: "interno", evidence: p.dependency || "sem evidência recente" };
}

export function summarize(items) {
  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_TESTED: 0 };
  for (const i of items) counts[i.state] = (counts[i.state] || 0) + 1;
  const order = { FAIL: 0, BLOCKED: 1, NOT_TESTED: 2, PASS: 3 };
  return { counts, total: items.length, passPct: items.length ? Math.round((1000 * counts.PASS) / items.length) / 10 : null, items: [...items].sort((a, b) => order[a.state] - order[b.state] || a.id.localeCompare(b.id)) };
}

async function gh(path) {
  const r = await fetch("https://api.github.com/" + path, { headers: { authorization: "Bearer " + process.env.GITHUB_TOKEN, accept: "application/vnd.github+json" } });
  return r.ok ? r.json() : {};
}
async function kv(method, key, body) {
  const { CLOUDFLARE_API_TOKEN: tk, CLOUDFLARE_ACCOUNT_ID: ac, KV_NAMESPACE_ID: ns } = process.env;
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ac}/storage/kv/namespaces/${ns}/values/${encodeURIComponent(key)}`, { method, headers: { authorization: "Bearer " + tk }, body });
  if (method === "GET") { if (!r.ok) return null; try { return JSON.parse(await r.text()); } catch { return null; } }
  if (!r.ok) throw new Error("kv_put_" + r.status);
}

export async function main() {
  const now = Date.now();
  const repo = process.env.GITHUB_REPOSITORY;
  const items = [];
  // 1) Every workflow in the repository (discovered).
  let page = 1, workflows = [];
  for (;;) { const j = await gh(`repos/${repo}/actions/workflows?per_page=100&page=${page}`); workflows = workflows.concat(j.workflows || []); if (!j.workflows || j.workflows.length < 100) break; page++; }
  // GitHub keeps records of workflows that only ever existed on PR branches; those are history,
  // not part of the running system, and are reported separately instead of as FAIL.
  const orphans = workflows.filter((wf) => !existsSync(wf.path));
  const retiredItems = [];
  let retired = [];
  try { retired = JSON.parse(readFileSync("data/retired-workflows.json", "utf8")).retired || []; } catch {}
  const retiredSet = new Map(retired.map((r) => [r.file, r]));
  let awaiting = [];
  try { awaiting = JSON.parse(readFileSync("data/retired-workflows.json", "utf8")).awaitingRealEvent || []; } catch {}
  const awaitingSet = new Map(awaiting.map((r) => [r.file, r.event]));
  let gated = [];
  try { gated = JSON.parse(readFileSync("data/retired-workflows.json", "utf8")).ownerGated || []; } catch {}
  // Owner-gated proofs count as BLOCKED (dono) only while the gate really exists in the workflow file.
  const gatedSet = new Map(gated.filter((g) => { try { return readFileSync(".github/workflows/" + g.file, "utf8").includes(g.gate); } catch { return false; } }).map((g) => [g.file, g.reason]));
  for (const wf of workflows.filter((w) => existsSync(w.path))) {
    const file = wf.path.split("/").pop();
    if (retiredSet.has(file)) { retiredItems.push({ id: "wf:" + file, reason: retiredSet.get(file).reason, since: retiredSet.get(file).since }); continue; }
    const j = await gh(`repos/${repo}/actions/workflows/${wf.id}/runs?per_page=30`);
    const c = classifyWorkflow(wf, j.workflow_runs || [], now);
    // Proofs that need a real customer payment cannot be produced artificially: BLOCKED (externo).
    if (awaitingSet.has(file) && c.state !== "PASS") { items.push({ id: "wf:" + file, kind: "rotina", name: wf.name, state: "BLOCKED", owner: "externo", evidence: "aguardando " + awaitingSet.get(file), at: c.at }); continue; }
    if (gatedSet.has(file) && c.state !== "PASS") { items.push({ id: "wf:" + file, kind: "rotina", name: wf.name, state: "BLOCKED", owner: "dono", evidence: gatedSet.get(file), at: c.at }); continue; }
    items.push({ id: "wf:" + file, kind: "rotina", name: wf.name, ...c });
  }
  // 2) Every public URL in the sitemaps (discovered).
  for (const sm of ["https://vendas.zevanory.api.br/sitemap.xml", "https://zevanory.api.br/sitemap.xml"]) {
    let xml = "";
    try { xml = await (await fetch(sm, { signal: AbortSignal.timeout(15000) })).text(); } catch {}
    const urls = [...new Set([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim()))];
    if (!urls.length) items.push({ id: "sitemap:" + new URL(sm).host, kind: "página", name: sm, state: "FAIL", owner: "interno", evidence: "mapa do site sem URLs ou inacessível" });
    for (const u of urls) {
      let state = "FAIL", evidence = "";
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(15000), headers: { "user-agent": "Mozilla/5.0 zevanory-matrix" } });
        const html = await r.text();
        const ok = r.status === 200 && /<title>[^<]{3,}<\/title>/i.test(html);
        state = ok ? "PASS" : "FAIL"; evidence = `HTTP ${r.status}${/<title>/i.test(html) ? "" : " · sem título"}`;
      } catch (e) { evidence = "sem resposta"; }
      items.push({ id: "page:" + u.replace(/^https:\/\//, ""), kind: "página", name: u, state, owner: "interno", evidence, at: new Date().toISOString() });
    }
  }
  // 3) Business processes from the certifiable-autonomy inventory.
  const snap = await kv("GET", "zpc:command:v1:snapshot");
  for (const p of snap?.inventory?.processes || []) { const c = classifyProcess(p); if (c) items.push({ id: "proc:" + p.id, kind: "processo", name: p.name, ...c }); }
  if (!snap?.inventory) items.push({ id: "proc:inventory", kind: "processo", name: "Inventário de processos", state: "NOT_TESTED", owner: "interno", evidence: "consolidado indisponível" });
  // 4) Production panel geometry proof (other repository).
  const proof = await gh("repos/arbmsistone-lab/zevanory-product-control-edge/actions/workflows/command-center-live-proof.yml/runs?per_page=5");
  items.push({ id: "proof:panel-live", kind: "prova", name: "Painel em produção: sem corte, sobreposição ou rolagem", ...classifyWorkflow({ state: "active" }, proof.workflow_runs || [], now) });
  // 5) Unit and contract tests of this repository, run now.
  const t = spawnSync(process.execPath, ["--test", "tests/*.test.mjs"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const pass = Number((t.stdout.match(/# pass (\d+)/) || [])[1] || 0), fail = Number((t.stdout.match(/# fail (\d+)/) || [])[1] || 0);
  items.push({ id: "tests:unit", kind: "testes", name: "Testes automatizados do repositório", state: fail === 0 && pass > 0 ? "PASS" : pass ? "FAIL" : "NOT_TESTED", owner: "interno", evidence: `${pass} passaram, ${fail} falharam`, at: new Date().toISOString() });

  const out = { schema: "zevanory-matrix/v1", generatedAt: new Date(now).toISOString(), ...summarize(items), historyOnlyWorkflows: orphans.length, retired: retiredItems };
  await kv("PUT", MATRIX_KEY, JSON.stringify(out));
  console.log("::notice title=SYSTEM_MATRIX::" + JSON.stringify({ historyOnly: orphans.length, retired: retiredItems.length, total: out.total, counts: out.counts, passPct: out.passPct, fail: out.items.filter((i) => i.state === "FAIL").slice(0, 40).map((i) => i.id), notTested: out.items.filter((i) => i.state === "NOT_TESTED").slice(0, 20).map((i) => i.id), blocked: out.items.filter((i) => i.state === "BLOCKED").map((i) => i.id) }));
}
const isMain = process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href;
if (isMain) main().catch((e) => { console.log("::error title=SYSTEM_MATRIX::" + String(e?.message || e).slice(0, 200)); process.exit(1); });
