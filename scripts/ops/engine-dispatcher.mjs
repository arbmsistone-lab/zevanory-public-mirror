// Engine dispatcher: GitHub drops most cron firings in this busy repository (measured on
// 12/10: the Short ran 1 of 4 scheduled times; the hourly snapshot never). This dispatcher
// runs whenever any frequent workflow finishes (and on its own cron), checks which engine is
// due and not yet done, and starts it with workflow_dispatch (allowed with GITHUB_TOKEN).
// Engines stay idempotent, so a double start never duplicates a publication.
const TZ = "America/Sao_Paulo";
const MIN = 60e3;

// Due times are Brasília local times. "done" is checked against real evidence.
export const ENGINES = [
  { id: "short-dica", workflow: "youtube-autonomous-short.yml", inputs: { slot: "dica", dry_run: "false" }, at: "10:00", maxPerDay: 9, proof: { kv: "youtube_dica" } },
  { id: "short-oferta", workflow: "youtube-autonomous-short.yml", inputs: { slot: "oferta", dry_run: "false" }, at: "15:00", maxPerDay: 9, proof: { kv: "youtube" } },
  { id: "short-calc", workflow: "youtube-autonomous-short.yml", inputs: { slot: "calc", dry_run: "false" }, at: "19:00", maxPerDay: 9, proof: { kv: "youtube_calc" } },
  { id: "indexnow", workflow: "indexnow-submit.yml", inputs: {}, at: "09:40", proof: { runToday: true } },
  { id: "command-center", workflow: "command-center-snapshot.yml", inputs: {}, everyMinutes: 55, maxPerDay: 30, proof: { runWithin: 55 } },
  { id: "matrix", workflow: "system-matrix.yml", inputs: {}, everyMinutes: 360, maxPerDay: 6, proof: { runWithin: 350 } },
  { id: "market", workflow: "market-weekly.yml", inputs: {}, at: "06:20", weekday: 1, proof: { runWithin: 6 * 24 * 60 } },
  { id: "data-backup", workflow: "data-backup.yml", inputs: {}, at: "02:10", proof: { runToday: true } },
  { id: "voice-eval", workflow: "voice-eval.yml", inputs: {}, at: "09:30", weekday: 0, proof: { runWithin: 6 * 24 * 60 } },
  { id: "tiktok-pack", workflow: "short-pack.yml", inputs: {}, at: "06:00", monthDays: [1, 11, 21], proof: { runToday: true } },
];

export function localParts(t = Date.now()) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday), dom: Number(p.day) };
}

// Retomada dos Shorts (data/shorts-rampa.json): um workflow desativado não é disparado (o POST daria 422 a cada
// execução). O estado é lido a cada execução por GET, que não falha nem gera ruído; quando o proprietário reativar,
// a execução seguinte já dispara. Estado desconhecido (GET falhou): no máximo uma tentativa por hora (minutos 0-19).
export const ACTIVE = "active";
export function workflowGate(state, minutes, sondagemMin = 60) {
  if (state === undefined || state === ACTIVE) return { dispatch: true, status: "active" };
  if (state === "unknown") {
    const janela = Math.max(20, Math.min(sondagemMin, 24 * 60));
    return minutes % janela < 20 ? { dispatch: true, status: "unknown_probe" } : { dispatch: false, status: "unknown_wait_probe" };
  }
  return { dispatch: false, status: "workflow_" + String(state).replace(/[^a-z_]/gi, "") };
}

// Slots de Short que a rampa permite hoje: registro do dia gravado pelo próprio Short (zpc:shorts:rampa:<dia>);
// sem registro, os slots do nível 1. Episódio de congelamento ativo => nenhum slot. congelado=null (KV ilegível)
// também => nenhum slot: erro de leitura nunca vira "não congelado". A decisão de congelamento vem de
// congelamentoAtivo (scripts/channels/shorts-retomada.mjs), a mesma regra por episódio do Short.
export function shortSlotsAllowed({ config, statusDia = null, congelado = null, dia } = {}) {
  if (congelado !== false) return { slots: [], motivo: congelado === true ? "canal_congelado" : "congelamento_ilegivel" };
  if (config?.canal?.aviso_manual === true) return { slots: [], motivo: "canal_congelado" };
  if (statusDia && statusDia.day === dia && Array.isArray(statusDia.slots)) return { slots: statusDia.slots.filter((x) => typeof x === "string"), motivo: "registro_do_dia:" + String(statusDia.estado || "") };
  const n1 = Array.isArray(config?.niveis) && config.niveis[0] && Array.isArray(config.niveis[0].slots) ? config.niveis[0].slots : [];
  return { slots: [...n1], motivo: "nivel_1_padrao" };
}

// Pure decision: which engines to start now.
export function decide({ now = Date.now(), runs = [], kvDone = {}, workflowStates = {}, shortSlots = null, sondagemMin = 60 } = {}) {
  const L = localParts(now);
  const out = [];
  for (const e of ENGINES) {
    if (!workflowGate(workflowStates[e.workflow], L.minutes, sondagemMin).dispatch) continue;
    if (e.inputs.slot && Array.isArray(shortSlots) && !shortSlots.includes(e.inputs.slot)) continue;
    if (e.weekday != null && L.weekday !== e.weekday) continue;
    if (e.monthDays && !e.monthDays.includes(L.dom)) continue;
    if (e.at) { const [h, m] = e.at.split(":").map(Number); if (L.minutes < h * 60 + m) continue; }
    const mine = runs.filter((r) => r.path.endsWith(e.workflow) && (!e.inputs.slot || r.slot === e.inputs.slot || r.slot == null));
    // Something already running or queued for this workflow → wait.
    if (runs.some((r) => r.path.endsWith(e.workflow) && ["queued", "in_progress", "waiting", "pending", "requested"].includes(r.status))) continue;
    // Recent attempt (any outcome) in the last 25 minutes → back off.
    if (mine.some((r) => now - Date.parse(r.created_at) < 25 * MIN)) continue;
    const today = runs.filter((r) => r.path.endsWith(e.workflow) && localParts(Date.parse(r.created_at)).day === L.day).length;
    if (today >= (e.maxPerDay || 3)) continue;
    let done = false;
    if (e.proof.kv) done = kvDone[e.proof.kv] === true;
    if (e.proof.runToday) done = runs.some((r) => r.path.endsWith(e.workflow) && r.conclusion === "success" && localParts(Date.parse(r.created_at)).day === L.day);
    if (e.proof.runWithin) done = runs.some((r) => r.path.endsWith(e.workflow) && r.conclusion === "success" && now - Date.parse(r.created_at) < e.proof.runWithin * MIN);
    if (!done) out.push(e);
  }
  // One start per workflow per tick (the Short slots share a workflow: earliest due first).
  const seen = new Set();
  return out.filter((e) => (seen.has(e.workflow) ? false : (seen.add(e.workflow), true)));
}

async function gh(path, init = {}) {
  const r = await fetch("https://api.github.com/repos/" + process.env.GITHUB_REPOSITORY + path, { ...init, headers: { authorization: "Bearer " + process.env.GITHUB_TOKEN, accept: "application/vnd.github+json", ...(init.headers || {}) } });
  if (init.method === "POST") return r.status;
  if (!r.ok) console.log("::warning title=ENGINE_DISPATCHER::GET " + path.split("?")[0] + " http " + r.status);
  return r.ok ? r.json() : {};
}
// Leitura crua para o congelamento: 404 = null; qualquer outra falha (sem token, HTTP, rede) LANÇA.
function kvRaw() {
  const { CLOUDFLARE_API_TOKEN: tk, CLOUDFLARE_ACCOUNT_ID: ac, KV_NAMESPACE_ID: ns } = process.env;
  return { async get(key) {
    if (!tk) throw new Error("kv_sem_token");
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ac}/storage/kv/namespaces/${ns}/values/${encodeURIComponent(key)}`, { headers: { authorization: "Bearer " + tk } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error("kv_get_http_" + r.status);
    return r.text();
  } };
}
async function kvGet(key) {
  const { CLOUDFLARE_API_TOKEN: tk, CLOUDFLARE_ACCOUNT_ID: ac, KV_NAMESPACE_ID: ns } = process.env;
  if (!tk) return null;
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ac}/storage/kv/namespaces/${ns}/values/${encodeURIComponent(key)}`, { headers: { authorization: "Bearer " + tk } });
  if (!r.ok) return null;
  try { return JSON.parse(await r.text()); } catch { return null; }
}

export async function main() {
  const now = Date.now();
  const L = localParts(now);
  const runs = [];
  const seen = {};
  const workflowStates = {};
  const { readFileSync } = await import("node:fs");
  const rampa = JSON.parse(readFileSync(new URL("../../data/shorts-rampa.json", import.meta.url), "utf8"));
  for (const wf of [...new Set(ENGINES.map((e) => e.workflow))]) {
    const w = await gh(`/actions/workflows/${wf}`);
    workflowStates[wf] = typeof w.state === "string" ? w.state : "unknown";
    const j = await gh(`/actions/workflows/${wf}/runs?per_page=30`);
    seen[wf] = (j.workflow_runs || []).length;
    for (const r of j.workflow_runs || []) runs.push({ path: r.path, status: r.status, conclusion: r.conclusion, created_at: r.created_at, slot: (r.display_title || "").match(/slot=(\w+)/)?.[1] || null });
  }
  const kvDone = {};
  for (const ch of ["youtube", "youtube_dica", "youtube_calc"]) kvDone[ch] = (await kvGet(`zpc:acquisition:daily:${L.day}:${ch}`))?.status === "publicado";
  const { lerCongelamento, congelamentoAtivo } = await import("../channels/shorts-retomada.mjs");
  const cg = await lerCongelamento(kvRaw());
  const congelado = cg.erro ? null : congelamentoAtivo({ config: rampa, registro: cg.registro });
  const shorts = shortSlotsAllowed({ config: rampa, statusDia: await kvGet(`zpc:shorts:rampa:${L.day}`), congelado, dia: L.day });
  const sondagemMin = Number(rampa?.dispatcher?.sondagem_estado_desconhecido_min) || 60;
  const due = decide({ now, runs, kvDone, workflowStates, shortSlots: shorts.slots, sondagemMin });
  const started = [];
  for (const e of due) {
    const status = await gh(`/actions/workflows/${e.workflow}/dispatches`, { method: "POST", body: JSON.stringify({ ref: "gh-pages", inputs: e.inputs }) });
    started.push(`${e.id}:${status}`);
    if (status === 422) console.log("::warning title=ENGINE_DISPATCHER::" + e.id + " dispatch 422 (workflow " + e.workflow + " state=" + workflowStates[e.workflow] + ")");
  }
  // Status registrado no log de toda execução (sem gravação no KV): workflows não ativos e slots da rampa.
  const inactive = Object.fromEntries(Object.entries(workflowStates).filter(([, s]) => s !== "active").map(([wf, s]) => [wf, workflowGate(s, L.minutes, sondagemMin).status]));
  console.log("::notice title=ENGINE_DISPATCHER::" + JSON.stringify({ seen, local: L.day + " " + Math.floor(L.minutes / 60) + ":" + String(L.minutes % 60).padStart(2, "0"), kvDone, shorts, inactive, started }));
}
const isMain = process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href;
if (isMain) main().catch((e) => { console.log("::error title=ENGINE_DISPATCHER::" + String(e?.message || e).slice(0, 200)); process.exit(1); });
