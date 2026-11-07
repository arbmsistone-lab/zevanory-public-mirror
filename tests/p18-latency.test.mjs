// ZEVANORY | P18, estado de desempenho separado da disponibilidade (ORDEM 295, aval do Sol). Evidência SINTETICA;
// nunca grava no ramo de evidência. Cobre: uma janela lenta não dispara; 2 consecutivas disparam; janela pulada,
// latência ausente ou rota fora do ar quebram a sequência; oscilação (flapping) não gera avisos repetidos;
// recuperação em 2 janelas; dedup por incidente; CRITICO = queda inalterada e com precedência; orçamento < timeout;
// replay de 27/10 17:00-17:25Z; monitor ponta a ponta (canal próprio, falha no aviso não derruba, só GET).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { readTextNormalized } from "./helpers/text.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_PROBE, ALERT_TITLE, validateProbe, validateRun, decideIncident, SALES_PAGES, STATUS_URL } from "../scripts/b0/b0-lib.mjs";
import {
  ROUTE_BUDGETS_MS, DEFAULT_BUDGET_MS, REQUEST_TIMEOUT_MS, assertBudgets, budgetFor, effectiveLatency, classifyTarget, initialPerf, stepPerf, foldPerf,
  decidePerfAlert, validatePerfEvent, SCHEMA_PERF, PERF_TITLE, deriveBudgets, replay, BUDGET_FLOOR_MS,
} from "../scripts/b0/p18-latency.mjs";
import { main as monitorMain, runnerInfo, probeIdOf, targetId } from "../scripts/b0/p18-monitor.mjs";

const NEG = "vendas.zevanory.api.br/negocio-completo", ST = "zevanory.api.br/api/status", HOME = "vendas.zevanory.api.br/";
const T = (hms, day = "2026-10-27") => new Date(`${day}T${hms}Z`).toISOString();
// Sondagem agendada com latência por rota; rota ausente do mapa = rápida (100 ms). null = sem latência medida.
const pr = (hms, lat = {}, { down = [], kind = "scheduled" } = {}) => {
  const ids = [HOME, NEG, ST];
  const targets = ids.map((id) => ({ id, ok: !down.includes(id), status: down.includes(id) ? 503 : 200, latency_ms: Object.hasOwn(lat, id) ? lat[id] : 100 }));
  return validateProbe({ schema: SCHEMA_PROBE, at: T(hms), kind, up: targets.every((t) => t.ok), targets, p22: { readable: true } });
};
const states = (probes, budgets) => { let st = initialPerf(); return probes.map((p) => { st = stepPerf(st, p, budgets); return st.view?.state; }); };

test("[BUD] orçamentos por rota: todos < timeout explícito; padrão 5 s; orçamento >= timeout é recusado", () => {
  assert.equal(REQUEST_TIMEOUT_MS, 20000, "BUD-timeout explícito de 20 s por tentativa");
  assert.equal(DEFAULT_BUDGET_MS, 5000);
  for (const [id, b] of Object.entries(ROUTE_BUDGETS_MS)) assert.ok(b < REQUEST_TIMEOUT_MS, id);
  assert.deepEqual(Object.keys(ROUTE_BUDGETS_MS).sort(), [...SALES_PAGES, STATUS_URL].map(targetId).sort(), "BUD-cobertura: um orçamento por alvo sondado");
  assert.equal(budgetFor("x.example/nova"), DEFAULT_BUDGET_MS, "BUD-default");
  assert.equal(budgetFor(NEG), 4000, "BUD-per-route"); assert.equal(budgetFor(ST), 5000, "BUD-per-route-status"); assert.equal(budgetFor(HOME), 2000, "BUD-per-route-home");
  assert.throws(() => assertBudgets({ a: REQUEST_TIMEOUT_MS }), /PERF_BUDGET_NOT_BELOW_TIMEOUT/, "BUD-igual-ao-timeout");
  assert.throws(() => assertBudgets({ a: 0 }), /PERF_BUDGET_INVALID/);
  assert.equal(assertBudgets({ a: REQUEST_TIMEOUT_MS - 1 }).a, REQUEST_TIMEOUT_MS - 1);
  const src = readTextNormalized(new URL("../scripts/b0/p18-monitor.mjs", import.meta.url));
  assert.match(src, /probeUrl\(u, \{ fetchImpl, pause, retries: 1, timeoutMs: REQUEST_TIMEOUT_MS \}\)/, "BUD-monitor usa o timeout explícito");
});

test("[SM] uma janela lenta isolada NÃO dispara; 2 consecutivas disparam DEGRADADO", () => {
  assert.deepEqual(states([pr("10:00:30"), pr("10:05:30", { [NEG]: 9000 }), pr("10:10:30")]), ["SAUDAVEL", "SAUDAVEL", "SAUDAVEL"], "SM-single");
  let st = foldPerf([pr("10:00:30"), pr("10:05:30", { [NEG]: 9000 })]);
  assert.equal(st.incident, null, "SM-single-no-incident"); assert.equal(st.routes[NEG].slow, 1, "SM-single-streak");
  st = stepPerf(st, pr("10:10:30", { [NEG]: 4100 }));
  assert.equal(st.view.state, "DEGRADADO", "SM-two"); assert.equal(st.view.event, "degraded");
  assert.equal(st.incident.incident_id, "p18perf-" + T("10:10:30")); assert.deepEqual(st.incident.routes, [NEG]);
  assert.equal(st.incident.max_latency_ms[NEG], 4100, "SM-max-latency");
  assert.deepEqual(st.view.slow_now, [{ id: NEG, latency_ms: 4100, budget_ms: 4000 }]);
  // Borda: exatamente no orçamento é dentro; 1 ms acima é lento.
  assert.deepEqual(states([pr("10:00:30", { [NEG]: 4000 }), pr("10:05:30", { [NEG]: 4000 })]), ["SAUDAVEL", "SAUDAVEL"], "SM-edge-equal");
  assert.deepEqual(states([pr("10:00:30", { [NEG]: 4001 }), pr("10:05:30", { [NEG]: 4001 })]), ["SAUDAVEL", "DEGRADADO"], "SM-edge-plus1");
  // Orçamento é POR ROTA: 4,5 s na home (2 s) degrada; 4,5 s no /api/status (5 s) não.
  assert.deepEqual(states([pr("10:00:30", { [HOME]: 4500, [ST]: 4500 }), pr("10:05:30", { [HOME]: 4500, [ST]: 4500 })]).at(-1), "DEGRADADO");
  assert.deepEqual(foldPerf([pr("10:00:30", { [HOME]: 4500, [ST]: 4500 }), pr("10:05:30", { [HOME]: 4500, [ST]: 4500 })]).incident.routes, [HOME], "SM-per-route");
  // Rotas diferentes lentas em janelas alternadas não somam: a sequência é por rota.
  assert.deepEqual(states([pr("10:00:30", { [NEG]: 9000 }), pr("10:05:30", { [ST]: 9000 })]), ["SAUDAVEL", "SAUDAVEL"], "SM-cross-route");
});

test("[SM] consecutivas = janelas de 5 min adjacentes: janela pulada quebra a sequência; confirmação não é janela", () => {
  assert.deepEqual(states([pr("10:00:30", { [NEG]: 9000 }), pr("10:10:30", { [NEG]: 9000 })]), ["SAUDAVEL", "SAUDAVEL"], "SM-gap");
  assert.deepEqual(states([pr("10:04:59", { [NEG]: 9000 }), pr("10:05:01", { [NEG]: 9000 })]), ["SAUDAVEL", "DEGRADADO"], "SM-adjacent-windows");
  // A confirmação cai na janela SEGUINTE (agendada 10:04:30, confirmação 10:05:40) e mesmo assim não conta.
  const withConfirm = [pr("10:04:30", { [NEG]: 9000 }), pr("10:05:40", { [NEG]: 9000 }, { kind: "confirm" })];
  assert.equal(foldPerf(withConfirm).incident, null, "SM-confirm-not-window");
  assert.equal(foldPerf(withConfirm).routes[NEG].slow, 1, "SM-confirm-streak");
  const sameWindow = [pr("10:00:30", { [NEG]: 9000 }), pr("10:03:30", { [NEG]: 9000 })];
  assert.equal(foldPerf(sameWindow).incident, null, "SM-same-window conta uma vez");
});

test("[FLAP] oscilação: lento/rápido alternado nunca degrada; degradado oscilando não recupera nem repete aviso", () => {
  const flap = Array.from({ length: 12 }, (_, i) => pr(`10:${String(i * 5).padStart(2, "0")}:30`, i % 2 ? {} : { [NEG]: 9000 }));
  assert.ok(states(flap).every((s) => s === "SAUDAVEL"), "FLAP-never");
  assert.deepEqual(replay(flap, ROUTE_BUDGETS_MS), [], "FLAP-no-events");
  const deg = [pr("11:00:30", { [NEG]: 9000 }), pr("11:05:30", { [NEG]: 9000 }),
    ...Array.from({ length: 10 }, (_, i) => pr(`11:${String(10 + i * 5).padStart(2, "0")}:30`, i % 2 ? { [NEG]: 9000 } : {}))];
  assert.ok(states(deg).slice(1).every((s) => s === "DEGRADADO"), "FLAP-stays-degraded");
  const ev = replay(deg, ROUTE_BUDGETS_MS);
  assert.deepEqual(ev.map((e) => e.event), ["degraded"], "FLAP-one-incident");
});

test("[REC] RECUPERADO só com 2 janelas consecutivas dentro do orçamento; depois volta a SAUDAVEL; nova degradação = novo incidente", () => {
  const seq = [pr("10:00:30", { [NEG]: 9000 }), pr("10:05:30", { [NEG]: 9000 }), pr("10:10:30"), pr("10:15:30"), pr("10:20:30")];
  assert.deepEqual(states(seq), ["SAUDAVEL", "DEGRADADO", "DEGRADADO", "RECUPERADO", "SAUDAVEL"], "REC-two");
  const st = foldPerf(seq.slice(0, 4));
  assert.equal(st.incident, null, "REC-closed"); assert.equal(st.last_incident.recovered_at, T("10:15:30"), "REC-at"); assert.equal(st.view.event, "recovered", "REC-event");
  assert.deepEqual(st.view.recovered_routes, [NEG], "REC-routes");
  assert.deepEqual(states([...seq.slice(0, 3), pr("10:20:30")]).at(-1), "DEGRADADO", "REC-gap: rápido, janela pulada, rápido não recupera");
  const again = [...seq, pr("10:25:30", { [NEG]: 9000 }), pr("10:30:30", { [NEG]: 9000 })];
  assert.deepEqual(replay(again, ROUTE_BUDGETS_MS).map((e) => e.event), ["degraded", "recovered", "degraded"], "REC-new-incident");
});

test("[MISS] latência ausente: nunca degrada, nunca recupera, quebra a sequência; elapsed_ms (nova tentativa) vence latency_ms", () => {
  assert.deepEqual(states([pr("10:00:30", { [NEG]: 9000 }), pr("10:05:30", { [NEG]: null }), pr("10:10:30", { [NEG]: 9000 })]), ["SAUDAVEL", "SAUDAVEL", "SAUDAVEL"], "MISS-break-slow");
  assert.deepEqual(states([pr("10:00:30", { [NEG]: null }), pr("10:05:30", { [NEG]: null })]), ["SAUDAVEL", "SAUDAVEL"], "MISS-all-null");
  const deg = [pr("10:00:30", { [NEG]: 9000 }), pr("10:05:30", { [NEG]: 9000 })];
  assert.deepEqual(states([...deg, pr("10:10:30"), pr("10:15:30", { [NEG]: null }), pr("10:20:30")]).slice(2), ["DEGRADADO", "DEGRADADO", "DEGRADADO"], "MISS-break-fast");
  assert.deepEqual(states([...deg, pr("10:10:30", { [NEG]: "lento" }), pr("10:15:30", { [NEG]: -1 })]).slice(2), ["DEGRADADO", "DEGRADADO"], "MISS-garbage");
  const noTarget = validateProbe({ schema: SCHEMA_PROBE, at: T("10:10:30"), kind: "scheduled", up: true, targets: [{ id: HOME, ok: true, status: 200, latency_ms: 100 }], p22: { readable: true } });
  const st = stepPerf(stepPerf(foldPerf(deg), noTarget), pr("10:15:30"));
  assert.equal(st.view.state, "DEGRADADO", "MISS-route-absent conta como sem dado");
  assert.equal(effectiveLatency({ latency_ms: 300, elapsed_ms: 3400 }), 3400, "MISS-retry: 1ª tentativa falhou, nova tentativa rápida não esconde o tempo total");
  assert.equal(effectiveLatency({ latency_ms: 300 }), 300, "MISS-legacy-line"); assert.equal(effectiveLatency({}), null, "MISS-none");
  assert.equal(classifyTarget({ id: HOME, ok: true, status: 200, latency_ms: 300, elapsed_ms: 3400 }).verdict, "slow", "MISS-retry-slow");
});

test("[CRIT] CRITICO = queda existente, inalterada e com precedência; rota fora do ar não é amostra de lentidão", () => {
  const down = pr("10:05:30", {}, { down: [NEG] });
  assert.equal(down.up, false, "CRIT-up-meaning: up/down continua sendo só disponibilidade");
  assert.equal(decideIncident({ seq: [pr("10:00:30", { [NEG]: 15000 }), pr("10:05:30", { [NEG]: 15000 })], open: null }).action, "none", "CRIT-latency-never-down: lentidão com 200 não abre incidente de queda");
  assert.deepEqual(states([pr("10:00:30", { [NEG]: 9000 }), down, pr("10:10:30", { [NEG]: 9000 })]), ["SAUDAVEL", "CRITICO", "SAUDAVEL"], "CRIT-break");
  const st = foldPerf([pr("10:00:30", { [ST]: 9000 }), pr("10:05:30", { [ST]: 9000 }, { down: [NEG] })]);
  assert.equal(st.view.state, "CRITICO", "CRIT-precedence"); assert.deepEqual(st.incident?.routes, [ST], "CRIT-others-tracked: a degradação das outras rotas segue registrada");
  assert.equal(classifyTarget({ id: NEG, ok: false, status: 0, latency_ms: 20000, error: "TimeoutError" }).verdict, "unknown", "CRIT-timeout-is-availability");
});

test("[DEDUP] um aviso ao entrar, um ao recuperar, por incidente; falha reenvia; CRITICO suprime", () => {
  const deg = foldPerf([pr("10:00:30", { [NEG]: 9000 }), pr("10:05:30", { [NEG]: 9000 })]);
  const id = deg.incident.incident_id;
  const ev = (event, notified = true, extra = {}) => validatePerfEvent({ schema: SCHEMA_PERF, incident_id: id, event, at: T("10:05:30"), recorded_at: T("10:05:40"), routes: [NEG], notified_at: notified ? T("10:05:41") : null, ...(notified ? {} : { error: "github_http_503" }), ...extra });
  assert.equal(decidePerfAlert({ perf: deg, events: [] }).action, "notify_degraded", "DEDUP-enter");
  assert.equal(decidePerfAlert({ perf: deg, events: [ev("degraded")] }).action, "none", "DEDUP-once");
  const still = stepPerf(deg, pr("10:10:30", { [NEG]: 9000 }));
  assert.equal(decidePerfAlert({ perf: still, events: [ev("degraded")] }).action, "none", "DEDUP-same-incident");
  assert.equal(decidePerfAlert({ perf: deg, events: [ev("degraded", false)] }).action, "notify_degraded", "DEDUP-retry-after-failure");
  const rec = foldPerf([pr("10:00:30", { [NEG]: 9000 }), pr("10:05:30", { [NEG]: 9000 }), pr("10:10:30"), pr("10:15:30")]);
  assert.equal(decidePerfAlert({ perf: rec, events: [ev("degraded")] }).action, "notify_recovered", "DEDUP-recover");
  assert.equal(decidePerfAlert({ perf: rec, events: [ev("degraded"), ev("recovered")] }).action, "none", "DEDUP-recover-once");
  assert.equal(decidePerfAlert({ perf: stepPerf(rec, pr("10:20:30")), events: [ev("degraded"), ev("recovered")] }).action, "none", "DEDUP-after-recover");
  assert.equal(decidePerfAlert({ perf: rec, events: [] }).action, "none", "DEDUP-no-recover-without-enter");
  const crit = stepPerf(deg, pr("10:10:30", { [ST]: 100 }, { down: [HOME] }));
  assert.deepEqual(decidePerfAlert({ perf: crit, events: [] }), { action: "none", reason: "critical_owns_alert" }, "DEDUP-critical-suppresses");
  assert.equal(decidePerfAlert({ perf: initialPerf(), events: [] }).action, "none", "DEDUP-empty");
  assert.throws(() => validatePerfEvent({ ...ev("degraded"), notified_at: null }), /perf_event_unnotified_without_error/, "DEDUP-ledger-error-required");
  assert.throws(() => validatePerfEvent({ ...ev("degraded"), event: "down" }), /bad_perf_event/, "DEDUP-ledger-kind");
});

test("[27/10] replay de 17:00-17:25Z (valores reais do ramo de evidência): orçamentos por rota detectam; 5 s fixo não", () => {
  const ids = ["vendas.zevanory.api.br/", "vendas.zevanory.api.br/solucoes", "vendas.zevanory.api.br/ia-na-pratica", "vendas.zevanory.api.br/vendas-na-pratica",
    "vendas.zevanory.api.br/lucro-e-caixa", "vendas.zevanory.api.br/combo-ia-vendas", NEG, ST];
  const rows = [["17:00:34.767", [334, 295, 293, 291, 292, 290, 288, 703]], ["17:05:56.622", [968, 621, 1774, 1699, 1325, 2702, 9143, 3075]],
    ["17:10:51.035", [777, 747, 1532, 1953, 1213, 2018, 4059, 15418]], ["17:15:40.259", [664, 626, 1278, 1362, 1679, 1619, 1627, 1531]],
    ["17:20:34.219", [619, 578, 1442, 1342, 1193, 1342, 1514, 1480]], ["17:25:36.900", [594, 553, 1256, 550, 1204, 1220, 1749, 1451]]];
  const probes = rows.map(([hms, l]) => validateProbe({ schema: SCHEMA_PROBE, at: T(hms), kind: "scheduled", up: true, targets: ids.map((id, i) => ({ id, ok: true, status: 200, latency_ms: l[i] })), p22: { readable: true } }));
  assert.deepEqual(replay(probes, ROUTE_BUDGETS_MS), [{ at: T("17:10:51.035"), event: "degraded", routes: [NEG] }, { at: T("17:20:34.219"), event: "recovered", routes: [NEG] }], "27/10-proposed");
  assert.deepEqual(replay(probes, Object.fromEntries(ids.map((id) => [id, 5000]))), [], "27/10-flat-5s: /api/status 3,1 s -> 15,4 s é uma janela só acima de 5 s");
  assert.ok(probes.every((p) => p.up), "disponibilidade seguiu no ar: nenhum alerta de queda era devido");
});

test("[DERIVE] método: amostra = agendadas ok/200; orçamento = min(5 s, max(2 s, teto500(2 x p95))); amostra pequena = 5 s", () => {
  const mk = (i, lat, extra = {}) => ({ at: new Date(Date.parse(T("00:00:30")) + i * 300000).toISOString(), kind: "scheduled", up: true, targets: [{ id: "a", ok: true, status: 200, latency_ms: lat }, { id: "b", ok: true, status: 200, latency_ms: 400 }, { id: "c", ok: true, status: 200, latency_ms: 3000 }], ...extra });
  const probes = Array.from({ length: 200 }, (_, i) => mk(i, 1000 + (i % 20) * 50));
  probes.push({ ...mk(201, 99999), kind: "confirm" });
  probes.push({ ...mk(202, 0), targets: [{ id: "a", ok: false, status: 503, latency_ms: 1 }] });
  const d = deriveBudgets(probes);
  assert.equal(d.a.n, 200, "DERIVE-sample: confirmação e rota fora do ar não entram"); assert.equal(d.a.p95, 1900, "DERIVE-p95"); assert.equal(d.a.budget_ms, 4000, "DERIVE-factor"); assert.equal(d.a.basis, "factor_x_p95", "DERIVE-basis");
  assert.equal(d.b.budget_ms, BUDGET_FLOOR_MS, "DERIVE-floor"); assert.equal(d.b.basis, "floor", "DERIVE-floor-basis");
  assert.equal(d.c.budget_ms, 5000, "DERIVE-cap"); assert.equal(d.c.basis, "cap", "DERIVE-cap-basis");
  assert.equal(deriveBudgets(probes.slice(0, 50)).a.budget_ms, 5000, "DERIVE-insufficient"); assert.equal(deriveBudgets(probes.slice(0, 50)).a.basis, "insufficient_samples_default");
});

// ---- Monitor ponta a ponta -----------------------------------------------------------------------------------
const res = (body, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
function net(ctl) {
  const calls = [], issues = [], comments = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    calls.push({ url: String(url), method });
    const u = new URL(String(url));
    if (u.host === "api.github.com") {
      if (ctl.githubDown) return res({}, 503);
      if (ctl.createDown && u.pathname.endsWith("/issues") && method === "POST") return res({}, 503);  // só a criação da issue falha
      if (u.pathname.endsWith("/issues") && method === "GET") return res(issues.filter((i) => i.state === "open"));
      if (u.pathname.endsWith("/issues")) { const b = JSON.parse(init.body); const i = { number: 50 + issues.length, title: b.title, body: b.body, state: "open" }; issues.push(i); return res(i, 201); }
      const m = /\/issues\/(\d+)$/.exec(u.pathname);
      if (m && method === "PATCH") { const i = issues.find((x) => x.number === Number(m[1])); const b = JSON.parse(init.body); if (b.state) i.state = b.state; return res(i); }
      const c = /\/issues\/(\d+)\/comments$/.exec(u.pathname);
      if (c) { comments.push({ issue: Number(c[1]), body: JSON.parse(init.body).body }); return res({ id: comments.length }, 201); }
      return res({}, 404);
    }
    if (ctl.slow.includes(u.host + u.pathname)) await new Promise((r) => setTimeout(r, ctl.slowMs));
    if (u.pathname === "/api/status") return res({ commercial_metrics_provenance: { state: "UNVERIFIED_FAIL_CLOSED", measured_at: null, commercial_release_allowed: false }, sales_authorization: { state: "closed" } });
    return res("<html>ok</html>", 200);
  };
  return { calls, issues, comments, fetchImpl };
}
const ALL = [...SALES_PAGES, STATUS_URL].map(targetId);
const BUDGETS = Object.fromEntries(ALL.map((id) => [id, 150]));
const lines = (dir, f) => (existsSync(join(dir, "p18", f)) ? readTextNormalized(join(dir, "p18", f)).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

test("[E2E-PERF] monitor: 1 janela lenta não avisa; 2ª avisa UMA vez no canal próprio; 3ª não repete; 2 rápidas recuperam e fecham", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zev-p18lat-"));
  try {
    const ctl = { slow: [NEG], slowMs: 400, githubDown: false };
    const n = net(ctl);
    let clock = Date.parse(T("10:02:20", "2026-10-25"));
    const env = (id) => ({ EVIDENCE_DIR: dir, GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "fake", GITHUB_RUN_ID: id, GITHUB_RUN_ATTEMPT: "1", GITHUB_EVENT_NAME: "schedule",
      RUNNER_ENVIRONMENT: "github-hosted", RUNNER_OS: "Linux", RUNNER_ARCH: "X64", RUNNER_NAME: "GitHub Actions 1000", ImageOS: "ubuntu24", ImageVersion: "20261020.1" });
    const run = async (id) => { const r = await monitorMain({ env: env(id), fetchImpl: n.fetchImpl, now: () => clock, sleep: async (ms) => { clock += ms; }, pause: async () => {}, log: () => {}, budgets: BUDGETS }); clock += 300000; return r; };
    const r1 = await run("201");
    assert.equal(r1.action, "none", "E2E-up-unchanged: lento com 200 continua 'no ar'"); assert.equal(r1.cur.up, true, "E2E-up");
    assert.equal(r1.perf.view.state, "SAUDAVEL", "E2E-single"); assert.equal(r1.perfDecision.action, "none", "E2E-single-action"); assert.equal(n.issues.length, 0, "E2E-single-issues");
    const r2 = await run("202");
    assert.equal(r2.perf.view.state, "DEGRADADO", "E2E-two"); assert.equal(r2.perfAlert?.error, null, "E2E-two-alert-ok");
    assert.equal(n.issues.length, 1, "E2E-enter-once"); assert.equal(n.issues[0].title, PERF_TITLE, "E2E-channel: título próprio");
    assert.notEqual(PERF_TITLE, ALERT_TITLE, "E2E-channel-distinct"); assert.match(n.issues[0].body, /AVISO/); assert.match(n.issues[0].body, /negocio-completo/);
    assert.ok(!n.issues.some((i) => i.title === ALERT_TITLE), "E2E-no-down-alert: degradação nunca abre o alerta de queda");
    const r3 = await run("203");
    assert.equal(r3.perf.view.state, "DEGRADADO", "E2E-three"); assert.equal(r3.perfDecision.action, "none", "E2E-dedup"); assert.equal(n.issues.length, 1, "E2E-dedup-issues"); assert.equal(n.comments.length, 0, "E2E-dedup-comments");
    ctl.slow = [];
    const r4 = await run("204");
    assert.equal(r4.perf.view.state, "DEGRADADO", "E2E-one-fast-not-enough"); assert.equal(n.issues[0].state, "open", "E2E-still-open");
    const r5 = await run("205");
    assert.equal(r5.perf.view.state, "RECUPERADO", "E2E-recovered"); assert.equal(r5.perfDecision.action, "notify_recovered", "E2E-recover-action");
    assert.equal(n.issues[0].state, "closed", "E2E-close"); assert.equal(n.comments.length, 1, "E2E-recover-comment"); assert.match(n.comments[0].body, /RECUPERADO/, "E2E-recover-body");
    const r6 = await run("206");
    assert.equal(r6.perf.view.state, "SAUDAVEL", "E2E-healthy-again"); assert.equal(r6.perfDecision.action, "none", "E2E-healthy-action");
    const perf = lines(dir, "perf-2026-10.jsonl").map(validatePerfEvent);
    assert.deepEqual(perf.map((e) => e.event), ["degraded", "recovered"], "E2E-ledger");
    assert.equal(perf[0].incident_id, perf[1].incident_id, "E2E-ledger-same-incident"); assert.ok(perf.every((e) => e.notified_at), "E2E-ledger-notified");
    assert.equal(perf[0].budgets_ms[NEG], 150, "E2E-ledger-budget"); assert.ok(perf[0].max_latency_ms[NEG] > 150, "E2E-ledger-latency");
    const probes = lines(dir, "probes-2026-10.jsonl").map(validateProbe);
    assert.equal(probes.length, 6, "E2E-probes");
    assert.deepEqual(probes.map((p) => p.probe_id), ["201", "202", "203", "204", "205", "206"].map((id) => `p18p-${id}-1-0`), "E2E-probe-id");
    assert.deepEqual(probes[0].runner, runnerInfo(env("x")), "E2E-runner");
    assert.equal(probes[0].runner.environment, "github-hosted"); assert.equal(probes[0].runner.region, null); assert.equal(probes[0].runner.region_reason, "not_exposed_by_github_runner_env");
    const neg = probes[1].targets.find((t) => t.id === NEG);
    assert.equal(neg.attempts, 1, "E2E-attempts"); assert.ok(neg.elapsed_ms >= 350 && neg.latency_ms >= 350, "E2E-latency-recorded");
    const runs = lines(dir, "runs-2026-10.jsonl").map(validateRun);
    assert.deepEqual(runs.map((r) => r.perf_state), ["SAUDAVEL", "DEGRADADO", "DEGRADADO", "DEGRADADO", "RECUPERADO", "SAUDAVEL"], "E2E-run-perf-state");
    assert.deepEqual(runs.map((r) => r.decision), ["none", "none", "none", "none", "none", "none"], "E2E-availability-untouched");
    const hb = JSON.parse(readTextNormalized(join(dir, "p18", "heartbeat.json")));
    assert.equal(hb.perf_state, "SAUDAVEL", "E2E-heartbeat-perf"); assert.equal(hb.up, true, "E2E-heartbeat-up");
    const prod = n.calls.filter((c) => !c.url.startsWith("https://api.github.com/"));
    assert.equal(prod.length, 6 * ALL.length, "E2E-no-extra-requests: 8 GETs por janela, igual a antes");
    assert.ok(prod.every((c) => c.method === "GET" && !/comprar|checkout|pagamento/.test(c.url)), "só GET em páginas públicas e status");
    assert.ok(n.calls.every((c) => !/cloudflare/.test(c.url)), "nenhuma chamada à Cloudflare (sem KV)");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("[E2E-PERF] falha ao avisar não derruba a execução nem o batimento; a próxima execução reenvia (sem duplicar)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zev-p18lat-"));
  try {
    const ctl = { slow: [NEG], slowMs: 400, githubDown: false, createDown: false };
    const n = net(ctl);
    let clock = Date.parse(T("12:02:20", "2026-10-25"));
    const logs = [];
    const run = async () => { const r = await monitorMain({ env: { EVIDENCE_DIR: dir, GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "fake", GITHUB_RUN_ID: "300", GITHUB_EVENT_NAME: "schedule" }, fetchImpl: n.fetchImpl, now: () => clock, sleep: async (ms) => { clock += ms; }, pause: async () => {}, log: (m) => logs.push(m), budgets: BUDGETS }); clock += 300000; return r; };
    await run();
    ctl.createDown = true;
    let r2 = null, thrown = null;
    try { r2 = await run(); } catch (e) { thrown = String(e?.message || e); }
    assert.equal(thrown, null, "E2E-not-escalated: aviso de desempenho não vira falha da execução");
    assert.equal(r2.perfAlert?.error, "github_http_503", "E2E-fail-recorded"); assert.equal(r2.run.outcome, "ok", "E2E-outcome-ok");
    assert.equal(JSON.parse(readTextNormalized(join(dir, "p18", "heartbeat.json"))).perf_state, "DEGRADADO", "batimento gravado");
    assert.ok(logs.some((l) => /::warning title=P18_PERF_ALERT_FAILED/.test(l)), "E2E-warning");
    let perf = lines(dir, "perf-2026-10.jsonl").map(validatePerfEvent);
    assert.equal(perf.length, 1, "E2E-fail-ledger"); assert.equal(perf[0].notified_at, null, "E2E-fail-ledger-null");
    ctl.createDown = false;
    const r3 = await run();
    assert.equal(r3.perfDecision.action, "notify_degraded", "E2E-retry"); assert.equal(n.issues.length, 1, "E2E-retry-issue");
    await run();
    assert.equal(n.issues.length, 1, "E2E-no-dup"); perf = lines(dir, "perf-2026-10.jsonl");
    assert.deepEqual(perf.map((e) => [e.event, Boolean(e.notified_at)]), [["degraded", false], ["degraded", true]], "E2E-retry-ledger");
    assert.equal(probeIdOf({}, 0), "p18p-local-1-0", "E2E-probe-id-local");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
