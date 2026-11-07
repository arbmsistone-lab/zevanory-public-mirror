// ZEVANORY | P18, estado de DESEMPENHO separado da disponibilidade (ORDEM 295, aval do Sol).
//
// Motivo: em 27/10 17:05-17:15Z o /api/status levou até 15,4 s e /negocio-completo 9,1 s, ambos HTTP 200, e o
// monitor só conhecia "no ar / fora do ar": nenhum aviso saiu. Este módulo NÃO muda o significado de up/down nem o
// alerta de queda (b0-lib decideIncident); ele lê as MESMAS sondagens GET e deriva um segundo estado:
//   SAUDAVEL   — nenhuma rota acima do orçamento em 2 janelas seguidas;
//   DEGRADADO  — alguma rota acima do SEU orçamento em 2 janelas de 5 min CONSECUTIVAS (uma janela lenta isolada não
//                dispara; janela pulada, sem latência ou com a rota fora do ar quebra a sequência);
//   CRITICO    — a falha de disponibilidade existente (sondagem com up=false), inalterada; tem precedência na leitura;
//   RECUPERADO — 2 janelas consecutivas dentro do orçamento depois de DEGRADADO (vale na janela da recuperação; a
//                seguinte volta a SAUDAVEL).
// Janela = janela de 5 min do instante da sondagem agendada (windowStartMs, igual ao window_id do gatilho). A
// re-sondagem de confirmação (kind=confirm) não é janela. Sem latência medida = "unknown": nunca degrada, nunca
// recupera (falta de dado não é prova de lentidão nem de saúde).
//
// Aviso deduplicado por incidente de desempenho: UMA notificação ao entrar em DEGRADADO e UMA em RECUPERADO,
// registradas em p18/perf-AAAA-MM.jsonl (ramo evidence/b0-baseline). Canal separado do alerta de queda: issue com
// título próprio (PERF_TITLE), severidade AVISO; falha ao avisar não derruba a execução nem o batimento (não é queda).
// Nenhuma chamada à Cloudflare: o estado é refeito a partir do histórico de sondagens no ramo de evidência (sem KV).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { windowStartMs, DISPATCH_WINDOW_MIN } from "./b0-lib.mjs";

export const SCHEMA_PERF = "zevanory.p18.perf.v1";
export const PERF_STATES = Object.freeze(["SAUDAVEL", "DEGRADADO", "CRITICO", "RECUPERADO"]);
export const PERF_EVENTS = Object.freeze(["degraded", "recovered"]);
export const WINDOW_MS = DISPATCH_WINDOW_MIN * 60000;
export const DEGRADE_WINDOWS = 2;
export const RECOVER_WINDOWS = 2;

// Tempo limite explícito de CADA tentativa de GET (b0-collector probeUrl). Precisa ser maior que qualquer orçamento:
// uma rota lenta tem de terminar e ser medida, não virar "timeout" (que é disponibilidade, não desempenho).
export const REQUEST_TIMEOUT_MS = 20000;
export const DEFAULT_BUDGET_MS = 5000;  // orçamento provisório (Sol) para rota sem linha de base

// Método de derivação (documentado em docs/b0/p18-latency-budgets.md e reproduzível por
// `node scripts/b0/p18-latency.mjs --derive probes-AAAA-MM.jsonl`):
//   amostra = sondagens agendadas, rota com ok=true e HTTP 200, latência medida;
//   orçamento = min(DEFAULT_BUDGET_MS, max(BUDGET_FLOOR_MS, arredonda_para_cima_500ms(BUDGET_FACTOR x p95)));
//   menos de BUDGET_MIN_SAMPLES amostras = DEFAULT_BUDGET_MS.
export const BUDGET_FACTOR = 2;
export const BUDGET_FLOOR_MS = 2000;
export const BUDGET_STEP_MS = 500;
export const BUDGET_MIN_SAMPLES = 200;

// Tabela proposta a partir de evidence/b0-baseline@08b9f51 p18/probes-2026-10.jsonl (277 linhas, 276 agendadas,
// 2026-10-26T19:00:38Z .. 2026-10-27T18:00:38Z). PROVISÓRIA: recalcular com 14 dias de histórico (B0).
export const BUDGET_SOURCE = "evidence/b0-baseline@08b9f51ce49e p18/probes-2026-10.jsonl n=277 2026-10-26T19:00Z..2026-10-27T18:00Z";
export const ROUTE_BUDGETS_MS = Object.freeze({
  "vendas.zevanory.api.br/": 2000,                   // n 276 p50 563  p95 875  p99 1112 max 2980 (piso)
  "vendas.zevanory.api.br/solucoes": 2000,           // n 276 p50 494  p95 758  p99 974  max 2922 (piso)
  "vendas.zevanory.api.br/ia-na-pratica": 4000,      // n 276 p50 1261 p95 1915 p99 3797 max 12833
  "vendas.zevanory.api.br/vendas-na-pratica": 4000,  // n 276 p50 1228 p95 1925 p99 3130 max 4607
  "vendas.zevanory.api.br/lucro-e-caixa": 4000,      // n 276 p50 1259 p95 1893 p99 2108 max 4638
  "vendas.zevanory.api.br/combo-ia-vendas": 4000,    // n 275 p50 1258 p95 1962 p99 3777 max 8403
  "vendas.zevanory.api.br/negocio-completo": 4000,   // n 276 p50 1237 p95 1933 p99 4094 max 9143
  "zevanory.api.br/api/status": 5000,                // n 276 p50 1488 p95 2291 p99 8053 max 15418 (2x p95 -> 5000 = teto)
});

export function assertBudgets(budgets, timeoutMs = REQUEST_TIMEOUT_MS) {
  for (const [id, b] of Object.entries(budgets)) {
    if (!Number.isInteger(b) || b <= 0) throw new Error("PERF_BUDGET_INVALID " + id);
    if (b >= timeoutMs) throw new Error(`PERF_BUDGET_NOT_BELOW_TIMEOUT ${id} ${b}>=${timeoutMs}`);
  }
  if (DEFAULT_BUDGET_MS >= timeoutMs) throw new Error("PERF_DEFAULT_BUDGET_NOT_BELOW_TIMEOUT");
  return budgets;
}
assertBudgets(ROUTE_BUDGETS_MS);  // fail-closed no carregamento: orçamento >= timeout nunca entra em produção

export const budgetFor = (id, budgets = ROUTE_BUDGETS_MS) => (Object.hasOwn(budgets, id) ? budgets[id] : DEFAULT_BUDGET_MS);
const isMs = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
// Latência da rota na janela: elapsed_ms (inclui a nova tentativa e a pausa de 3 s, quando houve) ou latency_ms
// (linhas antigas, uma tentativa). Nada medido = null.
export function effectiveLatency(t) {
  if (isMs(t?.elapsed_ms)) return t.elapsed_ms;
  if (isMs(t?.latency_ms)) return t.latency_ms;
  return null;
}
export function classifyTarget(t, budgets = ROUTE_BUDGETS_MS) {
  const latency = effectiveLatency(t), budget = budgetFor(t.id, budgets);
  // Rota fora do ar é disponibilidade (CRITICO), nunca amostra de desempenho.
  if (!t.ok || latency === null) return { verdict: "unknown", latency_ms: latency, budget_ms: budget };
  return { verdict: latency > budget ? "slow" : "fast", latency_ms: latency, budget_ms: budget };
}

export function initialPerf() { return { routes: {}, last_window: null, incident: null, last_incident: null, view: null }; }

// Um passo da máquina de estados (puro). Retorna um NOVO estado; view = leitura desta janela.
export function stepPerf(st, probe, budgets = ROUTE_BUDGETS_MS) {
  if (probe.kind === "confirm") return st;
  const w = windowStartMs(Date.parse(probe.at));
  if (st.last_window !== null && w <= st.last_window) return st;  // mesma janela já contada (defensivo)
  const consecutive = st.last_window !== null && w - st.last_window === WINDOW_MS;
  const routes = {};
  for (const [id, r] of Object.entries(st.routes)) routes[id] = consecutive ? { ...r } : { ...r, slow: 0, fast: 0 };
  const seen = new Set(), recoveredRoutes = [], detail = {};
  for (const t of probe.targets) {
    seen.add(t.id);
    const c = classifyTarget(t, budgets);
    detail[t.id] = c;
    const r = routes[t.id] || { state: "SAUDAVEL", slow: 0, fast: 0, since: null };
    if (c.verdict === "unknown") { r.slow = 0; r.fast = 0; }
    else if (c.verdict === "slow") {
      r.slow += 1; r.fast = 0;
      if (r.state === "SAUDAVEL" && r.slow >= DEGRADE_WINDOWS) { r.state = "DEGRADADO"; r.since = probe.at; }
    } else {
      r.fast += 1; r.slow = 0;
      if (r.state === "DEGRADADO" && r.fast >= RECOVER_WINDOWS) { r.state = "SAUDAVEL"; r.since = probe.at; recoveredRoutes.push(t.id); }
    }
    routes[t.id] = r;
  }
  for (const id of Object.keys(routes)) if (!seen.has(id)) { routes[id].slow = 0; routes[id].fast = 0; }  // rota ausente = sem dado
  const degraded = Object.keys(routes).filter((id) => routes[id].state === "DEGRADADO").sort();
  let incident = st.incident, lastIncident = st.last_incident, event = null;
  const worst = (inc) => {
    const m = { ...(inc?.max_latency_ms || {}) };
    for (const id of degraded) { const l = detail[id]?.latency_ms; if (isMs(l) && detail[id].verdict === "slow" && !(m[id] >= l)) m[id] = l; }
    return m;
  };
  if (!incident && degraded.length) {
    incident = { incident_id: "p18perf-" + probe.at, entered_at: probe.at, routes: degraded, max_latency_ms: worst(null), recovered_at: null };
    event = "degraded";
  } else if (incident && degraded.length) {
    incident = { ...incident, routes: [...new Set([...incident.routes, ...degraded])].sort(), max_latency_ms: worst(incident) };
  } else if (incident && !degraded.length) {
    lastIncident = { ...incident, recovered_at: probe.at };
    incident = null;
    event = "recovered";
  }
  const state = !probe.up ? "CRITICO" : event === "recovered" ? "RECUPERADO" : incident ? "DEGRADADO" : "SAUDAVEL";
  const slowNow = Object.entries(detail).filter(([, c]) => c.verdict === "slow").map(([id, c]) => ({ id, latency_ms: c.latency_ms, budget_ms: c.budget_ms }));
  const view = { at: probe.at, window_start: new Date(w).toISOString(), state, event, degraded_routes: degraded, recovered_routes: recoveredRoutes, slow_now: slowNow,
    unknown_routes: Object.entries(detail).filter(([, c]) => c.verdict === "unknown").map(([id]) => id) };
  return { routes, last_window: w, incident, last_incident: lastIncident, view };
}

export function foldPerf(probes, budgets = ROUTE_BUDGETS_MS) {
  return [...probes].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).reduce((st, p) => stepPerf(st, p, budgets), initialPerf());
}

// Linha do registro de avisos (append-only). notified_at nulo = aviso não emitido (a próxima execução tenta de novo).
export function validatePerfEvent(e) {
  const isIso = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString() === v;
  if (e === null || typeof e !== "object" || e.schema !== SCHEMA_PERF || typeof e.incident_id !== "string" || !/^p18perf-/.test(e.incident_id)
    || !PERF_EVENTS.includes(e.event) || !isIso(e.at) || !isIso(e.recorded_at) || !(e.notified_at === null || isIso(e.notified_at))
    || !Array.isArray(e.routes)) throw new Error("bad_perf_event");
  if (e.notified_at === null && typeof e.error !== "string") throw new Error("perf_event_unnotified_without_error");
  return e;
}
const notified = (events, id, kind) => events.some((e) => e.incident_id === id && e.event === kind && e.notified_at);

// Decide o aviso desta execução a partir do estado refeito e do registro de avisos (dedup por incidente).
// CRITICO suprime: durante a queda vale só o alerta de disponibilidade; o aviso pendente sai depois.
export function decidePerfAlert({ perf, events }) {
  const view = perf.view;
  if (!view || view.state === "CRITICO") return { action: "none", reason: view ? "critical_owns_alert" : "no_window" };
  if (perf.incident) {
    return notified(events, perf.incident.incident_id, "degraded") ? { action: "none", reason: "degraded_already_notified" } : { action: "notify_degraded", incident: perf.incident };
  }
  const last = perf.last_incident;
  if (last && notified(events, last.incident_id, "degraded") && !notified(events, last.incident_id, "recovered")) return { action: "notify_recovered", incident: last };
  return { action: "none", reason: "nothing_to_notify" };
}

export const PERF_TITLE = "[P18-DESEMPENHO] Latência acima do orçamento — aviso (não é queda)";
export function perfBody(kind, inc, view, runUrl, budgets = ROUTE_BUDGETS_MS) {
  const lines = inc.routes.map((id) => `- \`${id}\`: pior ${inc.max_latency_ms?.[id] ?? "?"} ms, orçamento ${budgetFor(id, budgets)} ms`);
  const head = kind === "degraded"
    ? `**DEGRADADO** (severidade AVISO; disponibilidade segue no ar): latência acima do orçamento da rota em ${DEGRADE_WINDOWS} janelas de 5 min consecutivas.`
    : `**RECUPERADO**: ${RECOVER_WINDOWS} janelas de 5 min consecutivas dentro do orçamento.`;
  return [head, "", `Incidente: ${inc.incident_id} (entrou em ${inc.entered_at}${inc.recovered_at ? `, recuperado em ${inc.recovered_at}` : ""})`, `Janela: ${view.window_start}`, "", ...lines, "",
    `Execução: ${runUrl}`, "", "Uma notificação ao entrar e uma ao recuperar. Queda (CRITICO) continua no alerta próprio do P18. Somente GET; sem dados pessoais."].join("\n");
}

// ---- Derivação dos orçamentos (linha de base) --------------------------------------------------------------
const pct = (xs, q) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.max(0, Math.ceil(q * v.length) - 1))] : null; };
export function deriveBudgets(probes, { factor = BUDGET_FACTOR, floor = BUDGET_FLOOR_MS, cap = DEFAULT_BUDGET_MS, step = BUDGET_STEP_MS, minSamples = BUDGET_MIN_SAMPLES } = {}) {
  const by = new Map();
  for (const p of probes) {
    if (p.kind === "confirm") continue;
    for (const t of p.targets) {
      const l = effectiveLatency(t);
      if (!by.has(t.id)) by.set(t.id, []);
      if (t.ok && t.status === 200 && l !== null) by.get(t.id).push(l);
    }
  }
  const out = {};
  for (const [id, xs] of by) {
    const p50 = pct(xs, 0.5), p95 = pct(xs, 0.95), p99 = pct(xs, 0.99);
    const enough = xs.length >= minSamples;
    const budget = enough ? Math.min(cap, Math.max(floor, Math.ceil((factor * p95) / step) * step)) : cap;
    out[id] = { n: xs.length, p50, p95, p99, max: xs.length ? Math.max(...xs) : null, budget_ms: budget, basis: enough ? (budget === cap ? "cap" : budget === floor ? "floor" : "factor_x_p95") : "insufficient_samples_default" };
  }
  return out;
}

// Replay do histórico: quantas vezes cada orçamento teria disparado (falso positivo / incidente real).
export function replay(probes, budgets) {
  let st = initialPerf(); const events = [];
  for (const p of [...probes].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    st = stepPerf(st, p, budgets);
    if (st.view && st.view.at === p.at && st.view.event) events.push({ at: p.at, event: st.view.event, routes: st.view.event === "degraded" ? st.incident.routes : st.last_incident.routes });
  }
  return events;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const i = process.argv.indexOf("--derive");
  if (i < 0 || !process.argv[i + 1]) { console.error("uso: node scripts/b0/p18-latency.mjs --derive p18/probes-AAAA-MM.jsonl [...]"); process.exit(2); }
  const probes = process.argv.slice(i + 1).flatMap((f) => readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)));
  const d = deriveBudgets(probes);
  const proposed = Object.fromEntries(Object.entries(d).map(([id, x]) => [id, x.budget_ms]));
  const flat = Object.fromEntries(Object.keys(d).map((id) => [id, DEFAULT_BUDGET_MS]));
  console.log(JSON.stringify({ probes: probes.length, from: probes[0]?.at, to: probes.at(-1)?.at, method: { factor: BUDGET_FACTOR, floor_ms: BUDGET_FLOOR_MS, cap_ms: DEFAULT_BUDGET_MS, step_ms: BUDGET_STEP_MS, min_samples: BUDGET_MIN_SAMPLES },
    routes: d, matches_table: JSON.stringify(proposed) === JSON.stringify(Object.fromEntries(Object.keys(d).map((id) => [id, budgetFor(id)]))),
    replay_proposed: replay(probes, proposed), replay_flat_5000: replay(probes, flat) }, null, 2));
}
