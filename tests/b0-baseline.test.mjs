// ZEVANORY | Fase B0 e P18 externo: testes da lógica do coletor e do monitor (evidência SINTETICA; nunca grava
// no ramo de evidência). Cobre: fail-closed em fonte malformada, NOT_AVAILABLE nunca conta como dia completo,
// contador de dias consecutivos, rótulos nunca misturados, estados MEDICAO_ATIVA/B0_VALIDA/APTO, alerta 2x;
// Sol 246.09/246.14: latência por incidente, confirmação na mesma execução, vigia do batimento, NOT_PROVEN em lacunas.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTextNormalized } from "./helpers/text.mjs";
import {
  NA, PROCESSES, PROCESS_IDS, SALES_PAGES, STATUS_URL, SCHEMA_PROBE, SCHEMA_A11Y, measured, na, processEntry, buildDailyRecord,
  validateDailyRecord, parseJsonl, consecutiveCompleteDays, countsByLabel, validateTargets, computeState, buildRegister,
  parseCommandCenter, parseFunnelDiag, parseDataBackup, readP22, parseSitemap, parseA11y, aggregateProbes,
  findOpenAlert, ALERT_TITLE, addDays, validateProbe, fieldOk, SCHEMA_INCIDENT, SCHEMA_RUN, SCHEMA_HEARTBEAT, finalizeIncident,
  withRecovery, validateIncident, decideIncident, openIncident, evaluateHeartbeat, HEARTBEAT_STALE_MIN, aggregateLatency, percentile,
  CONFIRM_BUDGET_S, WATCHDOG_TITLE, WATCHDOG_CF_TITLE, windowIdOf, parseWindowId, resolveDispatch, isDuplicateWindow, validateRun,
  evaluateCfDispatch, SCHEMA_CF_DISPATCH, CF_DISPATCH_STALE_MIN, schedSlotMs,
} from "../scripts/b0/b0-lib.mjs";
import { collect } from "../scripts/b0/b0-collector.mjs";
import { main as monitorMain } from "../scripts/b0/p18-monitor.mjs";
import { watchdog } from "../scripts/b0/p18-watchdog.mjs";

const TARGETS = JSON.parse(readTextNormalized(new URL("../docs/b0/metas-propostas.json", import.meta.url)));
const approvedTargets = () => {
  const t = structuredClone(TARGETS);
  for (const list of Object.values(t.processes)) for (const x of list) Object.assign(x, { status: "APPROVED", approved_by: "proprietario", approved_at: "2026-11-01" });
  return t;
};
const OKV = {
  sales_availability: { probes: 288, expected: 288, coverage: 1, up: 288, down: 0, availability: 1, max_gap_min: 5 },
  alert_latency: { s9_10min: "MET", s9_reasons: [], incidents: 0, alerts_emitted: 0, alerts_missing: 0, max_alert_latency_s: null, p95_alert_latency_s: null,
    max_upper_bound_latency_s: null, runs: 288, scheduled_runs: 288, max_start_delay_s: 40, p95_start_delay_s: 20, max_run_gap_s: 320, p95_run_gap_s: 305,
    max_check_gap_s: 320, capability_bound_s: 496 },
  financial_proof_freshness: { readings: 144, expected: 144, coverage: 1, valid: 0, invalid: 144, unreadable: 0, fail_safe_violations: 0, valid_ratio: 0, invalidation_reasons: {} },
  funnel_visits: { visitors7_clean: 79, visitors7_raw: 80, snapshot_at: "2026-10-25T23:17:00.000Z" },
  funnel_origin: { sources: { direto: { views: 10, intents: 1 } } },
  funnel_interest: { intents_total: 1, checkouts7: 0, leads7: 0 },
  kv_quota: { verified: true, day: "2026-10-25", writes: 600, reads: 30000, limit: 1000, pct: 60, snapshot_at: "2026-10-25T23:17:00.000Z" },
  backup_restore_sample: { run_created_at: "2026-10-25T09:47:17Z", run_conclusion: "success", ok: true, neon_tables: 53, neon_restored_ok: 53, kv_sample_ok: true, failures: 0, age_hours_at_collection: 16 },
};
const fullFields = (pid) => Object.fromEntries(PROCESSES[pid].fields.filter((f) => OKV[f]).map((f) => [f, measured("teste", OKV[f])]));
const dayRec = (day, overrides = {}) => buildDailyRecord({ day, collectedAt: day + "T23:59:00Z", runId: "1", sha: "x",
  fieldsByProcess: Object.fromEntries(PROCESS_IDS.map((p) => [p, overrides[p] || fullFields(p)])) });
const days = (start, n) => Array.from({ length: n }, (_, i) => addDays(start, i));

test("NOT_AVAILABLE, campo ausente ou valor malformado nunca formam dia completo", () => {
  assert.equal(processEntry("P18", { sales_availability: measured("t", OKV.sales_availability), alert_latency: measured("t", OKV.alert_latency) }).complete, true);
  assert.equal(processEntry("P18", { sales_availability: measured("t", OKV.sales_availability) }).complete, false, "sem o veredito da seção 9 o dia do P18 não fecha");
  assert.equal(processEntry("P18", { sales_availability: na("t", "coverage_insufficient") }).complete, false);
  assert.equal(processEntry("P18", {}).complete, false);
  const low = processEntry("P18", { sales_availability: measured("t", { ...OKV.sales_availability, coverage: 0.5 }) });
  assert.equal(low.complete, false, "cobertura abaixo de 80% não é dia completo");
  assert.equal(low.fields.sales_availability.value, NA);
  const bad = processEntry("P19", { kv_quota: measured("t", { ...OKV.kv_quota, verified: false }) });
  assert.equal(bad.complete, false); assert.match(bad.incomplete_reasons[0], /malformed_value/);
  for (const pid of ["P06", "P08"]) assert.equal(dayRec("2026-10-25").processes[pid].complete, false, pid + " sem fonte somente leitura nunca completa");
});

test("contador: dias consecutivos terminando no último dia; lacuna ou dia incompleto quebra; última coleta do dia vale", () => {
  const recs = days("2026-10-01", 5).map((d) => dayRec(d));
  assert.equal(consecutiveCompleteDays(recs, "P18", "OPERACIONAL").consecutive, 5);
  const gap = recs.filter((r) => r.day !== "2026-10-03");
  assert.equal(consecutiveCompleteDays(gap, "P18", "OPERACIONAL").consecutive, 2, "dia sem coleta quebra a sequência");
  const naLast = [...recs, dayRec("2026-10-06", { P18: { sales_availability: na("t", "x") } })];
  assert.equal(consecutiveCompleteDays(naLast, "P18", "OPERACIONAL").consecutive, 0, "último dia NOT_AVAILABLE zera");
  const rerun = { ...dayRec("2026-10-06"), collected_at: "2026-10-07T03:00:00Z" };
  assert.equal(consecutiveCompleteDays([...naLast, rerun], "P18", "OPERACIONAL").consecutive, 6, "reexecução do mesmo dia substitui");
});

test("histórico malformado derruba (fail-closed): JSON inválido, flag complete forjada, rótulo trocado, campo desconhecido", () => {
  const good = JSON.stringify(dayRec("2026-10-01"));
  assert.equal(parseJsonl(good + "\n\n", validateDailyRecord).length, 1);
  assert.throws(() => parseJsonl(good + "\n{oops", validateDailyRecord), /HISTORY_MALFORMED line 2: invalid_json/);
  const forged = dayRec("2026-10-02", { P06: {} }); forged.processes.P06.complete = true;
  assert.throws(() => parseJsonl(JSON.stringify(forged), validateDailyRecord), /complete_flag_mismatch P06/);
  const relabel = dayRec("2026-10-02"); relabel.processes.P20.label = "OPERACIONAL";
  assert.throws(() => parseJsonl(JSON.stringify(relabel), validateDailyRecord), /bad_process P20/);
  const extra = dayRec("2026-10-02"); extra.processes.P18.fields.inventado = measured("t", 1);
  assert.throws(() => parseJsonl(JSON.stringify(extra), validateDailyRecord), /unknown_field/);
  assert.throws(() => parseJsonl(JSON.stringify({ ...dayRec("2026-10-02"), schema: "v0" }), validateDailyRecord), /bad_header/);
});

test("rótulos da seção 6.4 contados em separado e nunca somados", () => {
  const recs = days("2026-10-01", 3).map((d) => dayRec(d));
  const p20 = countsByLabel(recs, "P20"), p18 = countsByLabel(recs, "P18");
  assert.equal(p20.ENSAIO_EM_PRODUCAO.complete_days, 3); assert.equal(p20.OPERACIONAL.complete_days, 0); assert.equal(p20.SINTETICA.complete_days, 0);
  assert.equal(p18.OPERACIONAL.complete_days, 3); assert.equal(p18.ENSAIO_EM_PRODUCAO.days_recorded, 0); assert.equal(p18.SINTETICA.days_recorded, 0);
});

test("metas: arquivo real é PROPOSTA (tudo PROPOSED) e válido; aprovação sem aprovador/data derruba", () => {
  validateTargets(TARGETS);
  for (const pid of PROCESS_IDS) assert.ok(TARGETS.processes[pid].length > 0 && TARGETS.processes[pid].every((t) => t.status === "PROPOSED" && t.approved_by === null), pid);
  assert.match(TARGETS.aviso, /PROPOSTA/);
  const t1 = structuredClone(TARGETS); t1.processes.P18[0].status = "APPROVED";
  assert.throws(() => validateTargets(t1), /TARGETS_MALFORMED approval/);
  const t2 = structuredClone(TARGETS); t2.processes.P18[0].approved_by = "alguem";
  assert.throws(() => validateTargets(t2), /proposed_with_approval/);
  const t3 = structuredClone(TARGETS); delete t3.processes.P22;
  assert.throws(() => validateTargets(t3), /missing P22/);
  validateTargets(approvedTargets());
});

test("estados: NAO_INICIADA -> MEDICAO_ATIVA; B0_VALIDA só com fontes completas, metas APPROVED e 14 dias", () => {
  assert.equal(computeState("P18", [], TARGETS).state, "NAO_INICIADA");
  const r13 = days("2026-10-01", 13).map((d) => dayRec(d)), r14 = days("2026-10-01", 14).map((d) => dayRec(d));
  assert.equal(computeState("P18", r13, approvedTargets()).state, "MEDICAO_ATIVA", "13 dias não bastam");
  const proposed = computeState("P18", r14, TARGETS);
  assert.equal(proposed.state, "MEDICAO_ATIVA", "meta PROPOSED bloqueia");
  assert.ok(proposed.reasons.some((r) => /metas não aprovadas/.test(r)));
  const ok = computeState("P22", r14, approvedTargets());
  assert.equal(ok.state, "B0_VALIDA");
  assert.equal(ok.start_date_utc, "2026-10-01");
  assert.ok(ok.reasons.some((r) => /prova operacional/.test(r)), "B0_VALIDA nunca vira APTO sem prova operacional");
  assert.equal(computeState("P03", r14, approvedTargets()).state, "MEDICAO_ATIVA", "P03: Search Console MISSING bloqueia");
  assert.equal(computeState("P19", r14, approvedTargets()).state, "MEDICAO_ATIVA", "P19: Neon/Workers MISSING bloqueia");
  assert.equal(computeState("P20", r14, approvedTargets()).state, "MEDICAO_ATIVA", "P20: ensaio mensal MISSING bloqueia");
  assert.equal(computeState("P06", r14, approvedTargets()).state, "MEDICAO_ATIVA");
  assert.equal(computeState("P06", r14, approvedTargets()).consecutive_complete_days, 0);
  assert.equal(computeState("P22", r14, approvedTargets(), { days: 14, real_executions: 29 }).state, "B0_VALIDA", "29 execuções não bastam");
  assert.equal(computeState("P22", r14, approvedTargets(), { days: 14, real_executions: 30 }).state, "APTO_A_CERTIFICACAO");
  assert.equal(computeState("P22", r14, approvedTargets(), { days: 13, real_executions: 300 }).state, "B0_VALIDA", "14 dias E 30 execuções");
  const p18 = computeState("P18", r14, approvedTargets(), { days: 14, real_executions: 300 });
  assert.equal(p18.state, "MEDICAO_ATIVA", "P18: sem gatilho secundário independente (seção 11) nunca vira B0_VALIDA");
  assert.ok(p18.reasons.some((r) => /independent_secondary_trigger/.test(r)));
});

test("registro: janela mínima de avaliação, nunca data de certificação; nada nasce B0_VALIDA com a PROPOSTA atual", () => {
  const reg = buildRegister([dayRec("2026-10-26")], TARGETS, "2026-10-27T01:00:00Z");
  assert.equal(reg.processes.P18.primeira_janela_de_avaliacao_min, "2026-11-08");
  assert.equal(reg.processes.P06.primeira_janela_de_avaliacao_min, "2026-11-09", "dia incompleto empurra a janela");
  assert.match(reg.note, /nunca data de certificação/);
  for (const pid of PROCESS_IDS) {
    assert.equal(reg.processes[pid].state, "MEDICAO_ATIVA", pid);
    assert.ok(reg.processes[pid].targets.every((t) => t.status === "PROPOSED"));
    assert.ok(Array.isArray(reg.processes[pid].sources) && reg.processes[pid].scope);
  }
  assert.ok(reg.processes.P15.scope.not_proven.some((s) => /conversão: NOT_PROVEN/.test(s)));
  assert.ok(reg.processes.P22.scope.not_proven.some((s) => /ciclo financeiro completo/.test(s)));
  assert.ok(reg.processes.P06.scope.not_proven.some((s) => /WhatsApp/.test(s)));
  assert.ok(reg.processes.P20.sources.some((s) => s.id === "monthly_full_restore_drill" && s.status === "MISSING"));
});

test("parsers fail-closed: anotações malformadas, cota fora do fim do dia, backup, sitemap e pa11y", () => {
  assert.equal(parseCommandCenter("{truncad", "2026-10-25").ok, false);
  const cc = { at: "2026-10-25T23:17:05.539Z", kvQuota: { verified: true, day: "2026-10-25", writes: 311, reads: 12401, limit: 1000, pct: 31 }, visitors7: 79, visitors7Raw: 79 };
  const p = parseCommandCenter(JSON.stringify(cc), "2026-10-25");
  assert.equal(p.kv.ok, true); assert.equal(p.kv.v.writes, 311); assert.equal(p.visits.v.visitors7_clean, 79);
  assert.equal(parseCommandCenter(JSON.stringify({ ...cc, at: "2026-10-25T12:18:05.539Z" }), "2026-10-25").kv.reason, "snapshot_not_end_of_day");
  assert.equal(parseCommandCenter(JSON.stringify({ ...cc, kvQuota: { ...cc.kvQuota, verified: false } }), "2026-10-25").kv.reason, "kv_quota_unverified");
  assert.equal(parseCommandCenter(JSON.stringify({ ...cc, visitors7: 90 }), "2026-10-25").visits.ok, false, "limpo > bruto é incoerente");
  assert.equal(parseFunnelDiag(JSON.stringify({ at: cc.at, sources: { direto: { views: -1, intents: 0 } }, leads7: 0, checkouts7: 0 })).ok, false);
  assert.equal(parseFunnelDiag(JSON.stringify({ at: cc.at, sources: { direto: { views: 3, intents: 2 }, youtube: { views: 1, intents: 1 } }, leads7: 0, checkouts7: 0 })).interest.intents_total, 3);
  const bk = { ok: true, neon: { tables: 53 }, restore: { neon: { ok: 53 }, kv: { sampleOk: true } }, failures: [] };
  const run = { created_at: "2026-10-25T09:47:17Z", conclusion: "success" };
  assert.equal(parseDataBackup(JSON.stringify(bk), run, "2026-10-26T01:00:00Z").v.age_hours_at_collection, 15.2);
  assert.equal(parseDataBackup(JSON.stringify(bk), { ...run, conclusion: "failure" }, "2026-10-26T01:00:00Z").v.ok, false, "run falho nunca é ok");
  assert.equal(parseDataBackup(JSON.stringify({ ok: true }), run, "2026-10-26T01:00:00Z").ok, false);
  const sm = parseSitemap('<urlset><url><loc>https://vendas.zevanory.api.br/solucoes?x=1</loc></url><url><loc>https://vendas.zevanory.api.br/comprar/ZEV-IA-011</loc></url></urlset>');
  assert.deepEqual(sm.urls, ["https://vendas.zevanory.api.br/solucoes"], "sem query e nunca /comprar");
  assert.equal(parseSitemap("<urlset><url><loc>https://outro.example/</loc></url></urlset>").ok, false);
  assert.equal(parseSitemap("<html></html>").ok, false);
  const a11y = { schema: SCHEMA_A11Y, tool: "pa11y@9.0.1", pages: SALES_PAGES.map((url) => ({ url, evaluated: true, errors: 0 })) };
  assert.equal(parseA11y(a11y).ok, true);
  assert.equal(parseA11y({ ...a11y, pages: a11y.pages.map((x, i) => (i ? x : { url: x.url, evaluated: false })) }).reason, "page_unevaluated", "página não avaliada nunca vira 0 erros");
  assert.equal(parseA11y({ ...a11y, pages: a11y.pages.slice(1) }).reason, "page_missing");
});

test("P22: validade = PROVEN e idade <= 65 min; fail-safe detecta prova inválida com venda liberada", () => {
  const now = Date.parse("2026-10-25T12:00:00Z");
  const body = (state, min, allowed = false, sales = "closed") => ({ commercial_metrics_provenance: { state, measured_at: min == null ? null : new Date(now - min * 60000).toISOString(), commercial_release_allowed: allowed }, sales_authorization: { state: sales } });
  assert.equal(readP22(body("PROVEN", 30), now).valid, true);
  assert.equal(readP22(body("PROVEN", 66), now).valid, false, "66 min expira");
  assert.equal(readP22(body("UNVERIFIED_FAIL_CLOSED", null), now).valid, false);
  assert.equal(readP22(body("UNVERIFIED_FAIL_CLOSED", null), now).fail_safe_ok, true, "inválida com venda fechada é o fail-safe correto");
  assert.equal(readP22(body("PROVEN", 90, true, "open_authorized"), now).fail_safe_ok, false);
  assert.equal(readP22({ gate: "G2" }, now).readable, false);
  assert.equal(readP22(body("PROVEN", 30), now).readable, true);
  assert.equal(JSON.stringify(readP22(body("PROVEN", 30), now)).includes("@"), false);
});

const probe = (at, up, p22 = { readable: true, valid: false, fail_safe_ok: true }) => ({ schema: SCHEMA_PROBE, at, up, targets: [{ id: "vendas.zevanory.api.br/", ok: up, status: up ? 200 : 503 }], p22 });

test("agregação P18/P22: cobertura mínima de 80%, disponibilidade e maior intervalo entre sondagens", () => {
  const all = Array.from({ length: 288 }, (_, i) => probe(new Date(Date.parse("2026-10-25T00:02:00Z") + i * 300000).toISOString(), i !== 7));
  const a = aggregateProbes(all, "2026-10-25");
  assert.equal(a.enough, true); assert.equal(a.p18.down, 1); assert.equal(a.p18.availability, 0.9965); assert.equal(a.p18.max_gap_min, 5);
  assert.equal(a.p22.invalid, 288); assert.equal(a.p22.fail_safe_violations, 0);
  const withConfirm = aggregateProbes([...all, { ...probe("2026-10-25T00:38:30Z", false), kind: "confirm" }], "2026-10-25");
  assert.equal(withConfirm.p18.probes, 288, "re-sondagem de confirmação não conta na cobertura nem na disponibilidade");
  assert.equal(withConfirm.p18.down, 1);
  const sparse = aggregateProbes(all.filter((_, i) => i % 2 === 0), "2026-10-25");
  assert.equal(sparse.enough, false, "144/288 sondagens: dia incompleto");
  assert.equal(sparse.p18.max_gap_min, 10);
  assert.equal(aggregateProbes(all, "2026-10-26").p18.probes, 0, "nada de outro dia");
});

test("alerta P18: só issue do bot com o título exato; sondagem incoerente derruba", () => {
  const down = probe("2026-10-25T00:10:00Z", false);
  assert.equal(findOpenAlert([{ number: 1, title: ALERT_TITLE, pull_request: {} }, { number: 2, title: "outro" }]), null);
  assert.equal(findOpenAlert([{ number: 3, title: ALERT_TITLE, state: "open" }]).number, 3);
  assert.throws(() => validateProbe({ ...down, up: true }), /probe_up_mismatch/);
});

// ---- ponta a ponta com rede falsa e diretório temporário (nunca rede real) --------------------------------
function tmp() { return mkdtempSync(join(tmpdir(), "zev-b0-")); }
const res = (body, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
function fakeNet({ ccMessage, statusBody, pagesDown = false, ctl = null }) {
  const calls = [], issues = [];
  const down = () => (ctl ? ctl.down : pagesDown);
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET" });
    const u = new URL(String(url));
    if (u.host === "api.github.com") {
      if (/command-center-snapshot\.yml\/runs/.test(u.pathname)) return res({ workflow_runs: [{ id: 11, head_branch: "gh-pages", event: "schedule", status: "completed", conclusion: "success", path: ".github/workflows/command-center-snapshot.yml", created_at: "2026-10-25T23:17:00Z" }] });
      if (/data-backup\.yml\/runs/.test(u.pathname)) return res({ workflow_runs: [{ id: 22, head_branch: "gh-pages", event: "schedule", status: "completed", conclusion: "success", path: ".github/workflows/data-backup.yml", created_at: "2026-10-25T09:47:17Z" }] });
      if (/\/runs\/11\/jobs/.test(u.pathname)) return res({ jobs: [{ id: 111 }] });
      if (/\/runs\/22\/jobs/.test(u.pathname)) return res({ jobs: [{ id: 222 }] });
      if (/check-runs\/111\/annotations/.test(u.pathname)) return res([{ title: "COMMAND_CENTER", annotation_level: "notice", message: ccMessage }, { title: "FUNNEL_DIAG", annotation_level: "notice", message: JSON.stringify({ at: "2026-10-25T23:17:01Z", sources: { direto: { views: 5, intents: 1 } }, leads7: 0, checkouts7: 0 }) }]);
      if (/check-runs\/222\/annotations/.test(u.pathname)) return res([{ title: "DATA_BACKUP", annotation_level: "notice", message: JSON.stringify({ ok: true, neon: { tables: 53 }, restore: { neon: { ok: 53 }, kv: { sampleOk: true } }, failures: [] }) }]);
      if (ctl?.githubDown && /\/issues/.test(u.pathname)) return res({}, 503);
      if (u.pathname.endsWith("/issues") && (init.method || "GET") === "GET") return res(issues.filter((i) => i.state === "open"));
      if (u.pathname.endsWith("/issues")) { const b = JSON.parse(init.body); const i = { number: 9 + issues.length, title: b.title, state: "open" }; issues.push(i); return res(i, 201); }
      const m = /\/issues\/(\d+)$/.exec(u.pathname);
      if (m && init.method === "PATCH") { const i = issues.find((x) => x.number === Number(m[1])); const b = JSON.parse(init.body); if (b.state) i.state = b.state; return res(i); }
      if (/\/issues\/\d+\/comments$/.test(u.pathname)) return res({ id: 1 }, 201);
      return res({}, 404);
    }
    if (u.pathname === "/sitemap.xml") return res(`<urlset><url><loc>https://${u.host}/solucoes</loc></url><url><loc>https://${u.host}/comprar/X</loc></url></urlset>`);
    if (u.pathname === "/api/status") return res(statusBody ?? { commercial_metrics_provenance: { state: "UNVERIFIED_FAIL_CLOSED", measured_at: null, commercial_release_allowed: false }, sales_authorization: { state: "closed" } });
    return res("<html>ok</html>", down() ? 503 : 200);
  };
  return { calls, fetchImpl, issues };
}
const envFor = (dir, extra = {}) => ({ EVIDENCE_DIR: dir, GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "fake", GITHUB_RUN_ID: "7", TARGETS_FILE: "docs/b0/metas-propostas.json", A11Y_FILE: join(dir, "nao-existe.json"), ...extra });
const CC = JSON.stringify({ at: "2026-10-25T23:17:05.539Z", kvQuota: { verified: true, day: "2026-10-25", writes: 311, reads: 12401, limit: 1000, pct: 31 }, visitors7: 79, visitors7Raw: 80 });

test("coletor ponta a ponta: P06/P08/P03-a11y NOT_AVAILABLE explícitos, anotação truncada vira NOT_AVAILABLE, só GET em produção", async () => {
  const dir = tmp();
  try {
    const net = fakeNet({ ccMessage: CC });
    const { record, register } = await collect({ env: envFor(dir), fetchImpl: net.fetchImpl, now: new Date("2026-10-26T01:30:00Z"), pause: async () => {}, log: () => {} });
    assert.equal(record.day, "2026-10-25");
    assert.equal(record.processes.P06.fields.publication_duplicate_audit.value, NA);
    assert.equal(record.processes.P08.fields.lead_consent_counts.value, NA);
    assert.equal(record.processes.P03.fields.a11y_wcag2aa.value, NA, "sem arquivo do pa11y: NOT_AVAILABLE, nunca 0 erros");
    assert.equal(record.processes.P03.fields.public_pages_http.value.checked, 2, "duas URLs, /comprar excluída");
    assert.equal(record.processes.P15.complete, true); assert.equal(record.processes.P19.complete, true); assert.equal(record.processes.P20.complete, true);
    assert.equal(record.processes.P18.complete, false, "sem sondagens P18 no ramo: incompleto");
    assert.equal(register.processes.P15.state, "MEDICAO_ATIVA");
    assert.ok(net.calls.filter((c) => !c.url.startsWith("https://api.github.com/")).every((c) => c.method === "GET" && !/comprar|checkout/.test(c.url)));
    assert.ok(net.calls.filter((c) => c.url.startsWith("https://api.github.com/")).every((c) => c.method === "GET"), "coletor só lê a API do GitHub");
    assert.ok(existsSync(join(dir, "b0", "register-v1.json")));
    const lines = readTextNormalized(join(dir, "b0", "baseline-v1.jsonl")).trim().split("\n");
    assert.equal(lines.length, 1);
    const trunc = fakeNet({ ccMessage: CC.slice(0, 40) });
    const r2 = await collect({ env: envFor(dir), fetchImpl: trunc.fetchImpl, now: new Date("2026-10-26T02:00:00Z"), pause: async () => {}, log: () => {} });
    assert.equal(r2.record.processes.P19.fields.kv_quota.value, NA);
    assert.match(r2.record.processes.P19.fields.kv_quota.reason, /malformed_source/);
    assert.equal(r2.record.processes.P15.complete, false);
    assert.equal(r2.register.processes.P15.consecutive_complete_days, 0, "a reexecução (última do dia) vale e está incompleta");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("coletor: histórico malformado ou metas inválidas derrubam antes de gravar qualquer linha", async () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, "b0"), { recursive: true });
    writeFileSync(join(dir, "b0", "baseline-v1.jsonl"), "{nao-json\n");
    const net = fakeNet({ ccMessage: CC });
    await assert.rejects(collect({ env: envFor(dir), fetchImpl: net.fetchImpl, now: new Date("2026-10-26T01:30:00Z"), log: () => {} }), /HISTORY_MALFORMED/);
    assert.equal(net.calls.length, 0, "nenhuma rede antes de validar o histórico");
    assert.equal(readTextNormalized(join(dir, "b0", "baseline-v1.jsonl")), "{nao-json\n", "nada acrescentado");
    const bad = join(dir, "metas.json"); writeFileSync(bad, JSON.stringify({ schema: "zevanory.b0.metas.v1", processes: {} }));
    rmSync(join(dir, "b0"), { recursive: true });
    await assert.rejects(collect({ env: envFor(dir, { TARGETS_FILE: bad }), fetchImpl: net.fetchImpl, now: new Date("2026-10-26T01:30:00Z"), log: () => {} }), /TARGETS_MALFORMED/);
    await assert.rejects(collect({ env: envFor(dir, { B0_DAY: "2026-10-26" }), fetchImpl: net.fetchImpl, now: new Date("2026-10-26T01:30:00Z"), log: () => {} }), /B0_DAY_INVALID/, "nunca coleta o dia corrente");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- Sol 246.09/246.14: latência auditada, confirmação na mesma execução, vigia e NOT_PROVEN em lacunas ------
const T = (hms, day = "2026-10-25") => new Date(`${day}T${hms}Z`).toISOString();
const inc0 = (o = {}) => ({ schema: SCHEMA_INCIDENT, incident_id: "p18-x", last_ok_observed_at: T("10:00:00"), first_failure_observed_at: T("10:05:10"), confirmed_at: T("10:06:20"), confirmed_by: "in_run_reprobe", down_targets: [], recovered_at: null, ...o });

test("[LAT] latência por incidente: detecção, alerta, limite superior e veredito da seção 9 (borda de 600 s)", () => {
  const a = finalizeIncident(inc0(), { alertEmittedAt: T("10:06:25"), alertIssue: 9 });
  assert.equal(a.detection_seconds, 70, "LAT-detection");
  assert.equal(a.latency_seconds, 75, "LAT-latency");
  assert.equal(a.upper_bound_latency_seconds, 385, "LAT-upper");
  assert.equal(a.s9, "MET", "LAT-met");
  assert.equal(finalizeIncident(inc0(), { alertEmittedAt: T("10:15:10") }).s9, "NOT_PROVEN", "LAT-edge-600: latência de exatamente 600 s não é NOT_MET; limite superior de 910 s deixa NOT_PROVEN");
  assert.equal(finalizeIncident(inc0({ last_ok_observed_at: T("10:05:00") }), { alertEmittedAt: T("10:15:00") }).s9, "MET", "LAT-upper-edge-600");
  assert.equal(finalizeIncident(inc0({ last_ok_observed_at: T("10:05:00") }), { alertEmittedAt: T("10:15:01") }).s9, "NOT_PROVEN", "LAT-upper-601");
  const late = finalizeIncident(inc0(), { alertEmittedAt: T("10:15:11") });
  assert.equal(late.latency_seconds, 601); assert.equal(late.s9, "NOT_MET", "LAT-latency-601 é falha certa");
  const none = finalizeIncident(inc0(), { alertError: "github_http_503" });
  assert.equal(none.latency_seconds, null); assert.equal(none.s9, "NOT_MET", "LAT-no-alert"); assert.equal(none.alert_error, "github_http_503");
  assert.equal(finalizeIncident(inc0({ last_ok_observed_at: null }), { alertEmittedAt: T("10:06:25") }).s9, "NOT_PROVEN", "LAT-unknown-lastok");
  assert.equal(validateIncident(structuredClone(a)).s9, "MET");
  assert.throws(() => validateIncident({ ...a, s9: "MET", latency_seconds: 10 }), /incident_metrics_mismatch/, "LAT-forged");
  assert.throws(() => validateIncident({ ...late, s9: "MET" }), /incident_metrics_mismatch/, "LAT-forged-s9");
  assert.throws(() => validateIncident(finalizeIncident(inc0({ last_ok_observed_at: T("10:05:10") }), { alertEmittedAt: T("10:06:25") })), /incident_time_order/);
  const rec = withRecovery(a, T("10:20:10"));
  assert.equal(rec.outage_observed_seconds, 900); assert.equal(validateIncident(rec).recovered_at, T("10:20:10"));
});

const pr = (hms, up, kind = "scheduled") => ({ ...probe(T(hms), up), kind });
test("[CONF] confirmação: 1ª falha fica pendente; 2ª falha >= 60 s depois confirma na mesma execução; transitória não alerta", () => {
  assert.deepEqual(decideIncident({ seq: [pr("10:00:05", true), pr("10:05:05", false)], open: null }), { action: "pending", first_failure_observed_at: T("10:05:05") }, "CONF-pending");
  const c = decideIncident({ seq: [pr("10:00:05", true), pr("10:05:05", false), pr("10:06:15", false, "confirm")], open: null });
  assert.equal(c.action, "confirm", "CONF-inrun");
  assert.equal(c.incident.confirmed_by, "in_run_reprobe");
  assert.equal(c.incident.first_failure_observed_at, T("10:05:05")); assert.equal(c.incident.last_ok_observed_at, T("10:00:05")); assert.equal(c.incident.confirmed_at, T("10:06:15"));
  assert.equal(decideIncident({ seq: [pr("10:00:05", true), pr("10:05:05", false), pr("10:05:35", false, "confirm")], open: null }).action, "pending", "CONF-spacing-30s");
  assert.equal(decideIncident({ seq: [pr("10:00:05", true), pr("10:05:05", false), pr("10:06:05", false, "confirm")], open: null }).action, "confirm", "CONF-spacing-60s");
  assert.deepEqual(decideIncident({ seq: [pr("10:00:05", true), pr("10:05:05", false), pr("10:06:15", true, "confirm")], open: null }), { action: "none" }, "CONF-transient");
  const x = decideIncident({ seq: [pr("10:00:05", true), pr("10:05:05", false), pr("10:10:05", false)], open: null });
  assert.equal(x.action, "confirm", "CONF-crossrun"); assert.equal(x.incident.confirmed_by, "cross_run");
  assert.equal(decideIncident({ seq: [pr("10:05:05", false), pr("10:06:15", false, "confirm")], open: null }).incident.last_ok_observed_at, null, "CONF-no-lastok");
  const open = finalizeIncident(c.incident, { alertEmittedAt: T("10:06:16") });
  assert.deepEqual(decideIncident({ seq: [pr("10:11:00", false)], open }), { action: "update" }, "CONF-update");
  assert.deepEqual(decideIncident({ seq: [pr("10:11:00", false)], open: finalizeIncident(c.incident, { alertError: "x" }) }), { action: "alert_retry" }, "CONF-retry");
  const r = decideIncident({ seq: [pr("10:11:00", true)], open });
  assert.equal(r.action, "recover", "CONF-recover"); assert.equal(r.incident.recovered_at, T("10:11:00")); assert.equal(r.incident.outage_observed_seconds, 355);
  assert.equal(openIncident([open, r.incident]), null, "última linha do incidente vale");
  assert.equal(openIncident([open]).incident_id, open.incident_id);
});

function clockEnv(dir, extra = {}) { return envFor(dir, { GITHUB_EVENT_NAME: "schedule", ...extra }); }
test("[E2E] monitor: confirma e alerta DENTRO de uma execução, mede latência e atraso do agendador, fecha na recuperação", async () => {
  const dir = tmp();
  try {
    const ctl = { down: true };
    const net = fakeNet({ ccMessage: CC, ctl });
    let clock = Date.parse(T("10:02:40"));
    const now = () => clock, sleep = async (ms) => { clock += ms; }, pause = async () => {};
    const a = await monitorMain({ env: clockEnv(dir, { GITHUB_RUN_ID: "101" }), fetchImpl: net.fetchImpl, now, sleep, pause, log: () => {} });
    assert.equal(a.action, "confirm", "E2E-inrun: confirmada na mesma execução");
    assert.equal(a.probes.length, 2, "E2E-reprobe"); assert.equal(a.probes[1].kind, "confirm");
    assert.equal(a.incident.first_failure_observed_at, T("10:02:40")); assert.equal(a.incident.confirmed_at, T("10:03:40"));
    assert.equal(a.incident.alert_emitted_at, T("10:03:40")); assert.equal(a.incident.latency_seconds, 60, "E2E-latency");
    assert.equal(a.incident.last_ok_observed_at, null); assert.equal(a.incident.s9, "NOT_PROVEN", "E2E-s9-unknown: sem sondagem boa anterior, limite superior desconhecido");
    assert.equal(a.run.start_delay_s, 40, "E2E-delay: slot 10:02, início 10:02:40"); assert.equal(a.run.sched_slot_at, T("10:02:00"));
    assert.equal(net.issues.length, 1); assert.equal(net.issues[0].title, ALERT_TITLE);
    const hb1 = JSON.parse(readTextNormalized(join(dir, "p18", "heartbeat.json")));
    assert.equal(hb1.last_success_at, T("10:03:40")); assert.equal(hb1.open_incident, a.incident.incident_id);
    clock = Date.parse(T("10:07:55"));
    const b = await monitorMain({ env: clockEnv(dir, { GITHUB_RUN_ID: "102" }), fetchImpl: net.fetchImpl, now, sleep, pause, log: () => {} });
    assert.equal(b.action, "update"); assert.equal(b.probes.length, 1, "incidente aberto: sem nova espera"); assert.equal(b.run.prev_gap_s, 315);
    assert.equal(net.issues.length, 1, "nunca uma segunda issue");
    ctl.down = false; clock = Date.parse(T("10:12:10"));
    const c = await monitorMain({ env: clockEnv(dir, { GITHUB_RUN_ID: "103" }), fetchImpl: net.fetchImpl, now, sleep, pause, log: () => {} });
    assert.equal(c.action, "recover"); assert.equal(c.incident.recovered_at, T("10:12:10")); assert.equal(net.issues[0].state, "closed", "E2E-close");
    const incs = readTextNormalized(join(dir, "p18", "incidents-2026-10.jsonl")).trim().split("\n").map((l) => validateIncident(JSON.parse(l)));
    assert.equal(incs.length, 2); assert.equal(incs[1].recovered_at, T("10:12:10")); assert.equal(incs[1].alert_emitted_at, T("10:03:40"));
    const runs = readTextNormalized(join(dir, "p18", "runs-2026-10.jsonl")).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(runs.map((r) => r.decision), ["confirm", "update", "recover"]);
    // Transitória: falha na 1ª sondagem e passa na re-sondagem -> nenhum alerta (proteção contra falso positivo).
    let flips = 0;
    const flaky = fakeNet({ ccMessage: CC, ctl: { get down() { flips += 1; return flips <= SALES_PAGES.length * 2; } } });
    clock = Date.parse(T("10:17:05"));
    const d = await monitorMain({ env: clockEnv(dir, { GITHUB_RUN_ID: "104" }), fetchImpl: flaky.fetchImpl, now, sleep, pause, log: () => {} });
    assert.equal(d.probes.length, 2); assert.equal(d.action, "none", "E2E-transient"); assert.equal(flaky.issues.length, 0);
    assert.ok([...net.calls, ...flaky.calls].every((c) => c.url.startsWith("https://api.github.com/") || c.method === "GET"), "produção só por GET");
    assert.ok([...net.calls, ...flaky.calls].every((c) => !/comprar|checkout|pagamento/.test(c.url)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("[E2E] monitor: falha ao emitir o alerta grava alert_emitted_at nulo, não grava batimento e a próxima execução reemite", async () => {
  const dir = tmp();
  try {
    const ctl = { down: false, githubDown: false };
    const net = fakeNet({ ccMessage: CC, ctl });
    let clock = Date.parse(T("11:02:10"));
    const now = () => clock, sleep = async (ms) => { clock += ms; }, pause = async () => {};
    await monitorMain({ env: clockEnv(dir), fetchImpl: net.fetchImpl, now, sleep, pause, log: () => {} });
    const hb0 = readTextNormalized(join(dir, "p18", "heartbeat.json"));
    ctl.down = true; ctl.githubDown = true; clock = Date.parse(T("11:07:10"));
    await assert.rejects(monitorMain({ env: clockEnv(dir), fetchImpl: net.fetchImpl, now, sleep, pause, log: () => {} }), /P18_ALERT_FAILED/);
    assert.equal(readTextNormalized(join(dir, "p18", "heartbeat.json")), hb0, "E2E-nohb: sem batimento novo");
    assert.ok(existsSync(join(dir, "p18", "incidents-2026-10.jsonl")), "E2E-incfile: incidente confirmado e gravado mesmo sem alerta");
    let incs = readTextNormalized(join(dir, "p18", "incidents-2026-10.jsonl")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(incs.length, 1); assert.equal(incs[0].alert_emitted_at, null); assert.equal(incs[0].s9, "NOT_MET", "E2E-nometric"); assert.equal(incs[0].last_ok_observed_at, T("11:02:10"));
    ctl.githubDown = false; clock = Date.parse(T("11:12:10"));
    const r = await monitorMain({ env: clockEnv(dir), fetchImpl: net.fetchImpl, now, sleep, pause, log: () => {} });
    assert.equal(r.action, "alert_retry"); assert.equal(r.incident.alert_emitted_at, T("11:12:10"));
    assert.equal(r.incident.latency_seconds, 300, "E2E-retry: a latência inclui o atraso da reemissão"); assert.equal(r.incident.upper_bound_latency_seconds, 600, "E2E-retry-upper"); assert.equal(r.incident.s9, "MET", "E2E-retry-s9");
    incs = readTextNormalized(join(dir, "p18", "incidents-2026-10.jsonl")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(incs.length, 2);
    writeFileSync(join(dir, "p18", "incidents-2026-10.jsonl"), JSON.stringify({ ...incs[1], s9: "MET", latency_seconds: 1 }) + "\n");
    await assert.rejects(monitorMain({ env: clockEnv(dir), fetchImpl: net.fetchImpl, now, sleep, pause, log: () => {} }), /HISTORY_MALFORMED/, "incidente forjado derruba");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("[WD] vigia: batimento mais velho que 15 min alerta (borda 900/901 s); ausente, malformado e no futuro também", async () => {
  const hb = (iso) => ({ schema: SCHEMA_HEARTBEAT, last_success_at: iso });
  const now = Date.parse(T("12:00:00"));
  assert.equal(evaluateHeartbeat(hb(T("11:45:00")), now).state, "FRESH", "WD-900");
  assert.equal(evaluateHeartbeat(hb(T("11:44:59")), now).state, "STALE", "WD-901");
  assert.equal(evaluateHeartbeat(hb(T("11:44:59")), now).alert, true);
  assert.equal(evaluateHeartbeat(hb(T("11:44:59")), now).age_s, 901);
  assert.equal(evaluateHeartbeat(hb(T("11:59:00")), now).alert, false);
  assert.equal(evaluateHeartbeat(null, now).state, "MISSING", "WD-missing"); assert.equal(evaluateHeartbeat(null, now).alert, true, "WD-missing-alert");
  assert.equal(evaluateHeartbeat({ last_success_at: T("11:59:00") }, now).state, "MALFORMED", "WD-schema");
  assert.equal(evaluateHeartbeat(hb(T("12:05:00")), now).state, "FUTURE", "WD-future");
  assert.equal(HEARTBEAT_STALE_MIN, 15);
  // Ponta a ponta com rede falsa: lê só o ramo de evidência, issue com título PRÓPRIO (canal distinto do de vendas).
  let content = null; const calls = [], issues = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET" });
    const u = new URL(String(url));
    if (u.pathname.endsWith("/contents/p18/heartbeat.json")) return content === null ? res({ message: "Not Found" }, 404) : res(content);
    if (u.pathname.endsWith("/issues") && !init.method) return res(issues.filter((i) => i.state === "open"));
    if (u.pathname.endsWith("/issues")) { const i = { number: 50, title: JSON.parse(init.body).title, state: "open" }; issues.push(i); return res(i, 201); }
    if (/\/issues\/50$/.test(u.pathname)) { const b = JSON.parse(init.body); if (b.state) issues[0].state = b.state; return res(issues[0]); }
    if (/\/comments$/.test(u.pathname)) return res({}, 201);
    return res({}, 404);
  };
  const env = { GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "fake", GITHUB_RUN_ID: "9" };
  const w1 = await watchdog({ env, fetchImpl, now: () => now, log: () => {} });
  assert.equal(w1.ev.state, "MISSING"); assert.equal(w1.action, "open", "WD-open");
  assert.equal(issues[0].title, WATCHDOG_TITLE); assert.notEqual(WATCHDOG_TITLE, ALERT_TITLE, "WD-distinct");
  content = hb(T("11:30:00"));
  assert.equal((await watchdog({ env, fetchImpl, now: () => now, log: () => {} })).action, "update");
  content = hb(T("11:58:00"));
  const w3 = await watchdog({ env, fetchImpl, now: () => now, log: () => {} });
  assert.equal(w3.action, "close", "WD-close"); assert.equal(issues[0].state, "closed");
  assert.ok(calls.every((c) => c.url.startsWith("https://api.github.com/repos/o/r/")), "só a API do GitHub do próprio repositório");
  assert.ok(calls.filter((c) => /contents/.test(c.url)).every((c) => c.url.includes("ref=evidence%2Fb0-baseline") && c.method === "GET"));
  await assert.rejects(watchdog({ env: { ...env, EVIDENCE_BRANCH: "gh-pages" }, fetchImpl, now: () => now, log: () => {} }), /EVIDENCE_BRANCH_REFUSED/);
});

const dayProbes = (day, stepMin, skip = () => false) => Array.from({ length: Math.floor(1440 / stepMin) }, (_, i) => i)
  .filter((i) => !skip(i)).map((i) => probe(new Date(Date.parse(day + "T00:02:00Z") + i * stepMin * 60000).toISOString(), true));
const dayRuns = (day, delays) => delays.map((d, i) => {
  const slot = Date.parse(day + "T00:02:00Z") + i * 300000, started = slot + d * 1000;
  return { schema: SCHEMA_RUN, run_id: String(i), event: "schedule", started_at: new Date(started).toISOString(), sched_slot_at: new Date(slot).toISOString(), start_delay_s: d,
    prev_run_started_at: null, prev_gap_s: i ? 300 + d - delays[i - 1] : null, outcome: "ok" };
});
test("[GAP] veredito diário da seção 9: NOT_PROVEN com lacuna > 10 min (ou lacuna + confirmação > 10 min); NOT_MET com incidente; MET só sem pendência", () => {
  const D = "2026-10-25";
  const full = aggregateLatency({ probes: dayProbes(D, 5), runs: dayRuns(D, [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]), incidents: [], day: D });
  assert.equal(full.s9_10min, "MET", "GAP-met"); assert.equal(full.max_check_gap_s, 300, "GAP-gapvalue"); assert.equal(full.capability_bound_s, 300 + CONFIRM_BUDGET_S);
  assert.equal(full.max_start_delay_s, 100, "GAP-maxdelay"); assert.equal(full.p95_start_delay_s, 100, "GAP-p95delay"); assert.equal(full.scheduled_runs, 10);
  assert.equal(full.max_run_gap_s, 310); assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], 0.95), 19, "GAP-p95");
  assert.ok(fieldOk("alert_latency", measured("t", full)));
  const g11 = aggregateLatency({ probes: dayProbes(D, 1).filter((p) => { const m = (Date.parse(p.at) - Date.parse(D + "T00:00:00Z")) / 60000; return m < 300 || m >= 310; }), runs: [], incidents: [], day: D });
  assert.equal(g11.s9_10min, "NOT_PROVEN", "GAP-11min"); assert.match(g11.s9_reasons.join(";"), /check_gap_over_10min max=660s/, "GAP-11min-reason");
  const g10 = aggregateLatency({ probes: dayProbes(D, 1).filter((p) => { const m = (Date.parse(p.at) - Date.parse(D + "T00:00:00Z")) / 60000; return m < 300 || m >= 309; }), runs: [], incidents: [], day: D });
  assert.equal(g10.s9_10min, "NOT_PROVEN", "GAP-10min: 600 s + confirmação já passa do limite");
  assert.match(g10.s9_reasons.join(";"), /gap_plus_confirmation_over_10min 600s\+176s/, "GAP-10min-reason");
  const gapOf = (min) => aggregateLatency({ probes: dayProbes(D, 1).filter((p) => { const m = (Date.parse(p.at) - Date.parse(D + "T00:00:00Z")) / 60000; return m < 300 || m >= 300 + min; }), runs: [], incidents: [], day: D });
  assert.equal(gapOf(7).max_check_gap_s, 480); assert.equal(gapOf(7).s9_10min, "NOT_PROVEN", "GAP-8min: 480+176 > 600");
  assert.equal(gapOf(6).max_check_gap_s, 420); assert.equal(gapOf(6).s9_10min, "MET", "GAP-7min: 420+176 = 596 <= 600");
  // Lacuna que atravessa a meia-noite: última sondagem do dia anterior às 23:50, primeira do dia às 00:02.
  const cross = aggregateLatency({ probes: [probe("2026-10-24T23:50:00Z", true), ...dayProbes(D, 5)], runs: [], incidents: [], day: D });
  assert.equal(cross.max_check_gap_s, 720, "GAP-midnight-gap"); assert.equal(cross.s9_10min, "NOT_PROVEN", "GAP-midnight");
  const bad = finalizeIncident(inc0({ first_failure_observed_at: T("10:05:10", D), last_ok_observed_at: T("10:00:00", D), confirmed_at: T("10:06:20", D) }), { alertEmittedAt: T("10:20:00", D) });
  const nm = aggregateLatency({ probes: dayProbes(D, 5), runs: [], incidents: [bad], day: D });
  assert.equal(nm.s9_10min, "NOT_MET", "GAP-incident-notmet"); assert.equal(nm.incidents, 1); assert.equal(nm.max_alert_latency_s, 890, "GAP-maxlat");
  const miss = aggregateLatency({ probes: dayProbes(D, 5), runs: [], incidents: [finalizeIncident(inc0(), { alertError: "x" })], day: D });
  assert.equal(miss.alerts_missing, 1); assert.equal(miss.s9_10min, "NOT_MET", "GAP-alert-missing");
  const ok = finalizeIncident(inc0({ last_ok_observed_at: T("10:02:00") }), { alertEmittedAt: T("10:06:30") });
  const met = aggregateLatency({ probes: dayProbes(D, 5), runs: [], incidents: [ok, withRecovery(ok, T("10:30:00"))], day: D });
  assert.equal(met.s9_10min, "MET"); assert.equal(met.incidents, 1, "última linha do incidente vale"); assert.equal(met.max_upper_bound_latency_s, 270, "GAP-maxupper");
  assert.equal(fieldOk("alert_latency", measured("t", { ...g11, s9_10min: "MET" })), false, "GAP-forged-met: MET com lacuna derruba");
  assert.equal(fieldOk("alert_latency", measured("t", { ...nm, s9_10min: "MET", s9_reasons: [] })), false, "MET com limite superior > 600 derruba");
  assert.equal(fieldOk("alert_latency", measured("t", { ...full, s9_10min: "NOT_PROVEN" })), false, "NOT_PROVEN sem motivo derruba");
});

test("[COL] coletor: dia com sondagens a cada 5 min, execuções e incidente vira P18 completo com veredito da seção 9", async () => {
  const dir = tmp();
  try {
    const D = "2026-10-25";
    mkdirSync(join(dir, "p18"), { recursive: true });
    const ps = [...dayProbes(D, 5), probe("2026-10-26T00:02:00Z", true)];
    writeFileSync(join(dir, "p18", "probes-2026-10.jsonl"), ps.map((p) => JSON.stringify(p)).join("\n") + "\n");
    writeFileSync(join(dir, "p18", "runs-2026-10.jsonl"), dayRuns(D, [5, 15, 25]).map((r) => JSON.stringify(r)).join("\n") + "\n");
    const ok = finalizeIncident(inc0({ last_ok_observed_at: T("10:02:00") }), { alertEmittedAt: T("10:06:30") });
    writeFileSync(join(dir, "p18", "incidents-2026-10.jsonl"), JSON.stringify(ok) + "\n");
    const net = fakeNet({ ccMessage: CC });
    const { record } = await collect({ env: envFor(dir), fetchImpl: net.fetchImpl, now: new Date("2026-10-26T01:45:00Z"), pause: async () => {}, log: () => {} });
    assert.equal(record.processes.P18.complete, true, "COL-complete");
    const v = record.processes.P18.fields.alert_latency.value;
    assert.equal(v.s9_10min, "MET"); assert.equal(v.incidents, 1); assert.equal(v.max_alert_latency_s, 80, "COL-maxlat"); assert.equal(v.max_start_delay_s, 25); assert.equal(v.max_check_gap_s, 300, "COL-gap");
    writeFileSync(join(dir, "p18", "runs-2026-10.jsonl"), JSON.stringify({ ...dayRuns(D, [5])[0], start_delay_s: 1 }) + "\n");
    await assert.rejects(collect({ env: envFor(dir), fetchImpl: net.fetchImpl, now: new Date("2026-10-26T01:50:00Z"), pause: async () => {}, log: () => {} }), /HISTORY_MALFORMED/, "atraso forjado derruba");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("workflows B0/P18: agendados, só GITHUB_TOKEN, gravam só no ramo evidence/b0-baseline, sem POST em produção", () => {
  const wf = (n) => readTextNormalized(new URL("../.github/workflows/" + n, import.meta.url));
  const col = wf("b0-baseline-collector.yml"), mon = wf("p18-external-monitor.yml"), tst = wf("b0-baseline-tests.yml");
  for (const [name, t] of [["collector", col], ["monitor", mon]]) {
    assert.match(t, /schedule:/, name);
    assert.doesNotMatch(t, /secrets\.(?!GITHUB_TOKEN)/, name + ": nenhum segredo além do GITHUB_TOKEN");
    assert.doesNotMatch(t, /pull_request/, name + ": não roda em PR");
    assert.match(t, /evidence\/b0-baseline/, name);
    assert.doesNotMatch(t, /push[^\n]*\bgh-pages\b|HEAD:gh-pages/, name + ": nunca grava em gh-pages");
    assert.doesNotMatch(t, /-X\s*POST|--data|wrangler/, name);
    assert.match(t, /runs-on: ubuntu-latest/, name + ": nuvem, nunca self-hosted/Windows do proprietário");
  }
  assert.match(mon, /cron: '2-59\/5 \* \* \* \*'/, "Sol 246.09: cadência de 5 min");
  assert.match(mon, /timeout-minutes: 8\b/, "cabe a re-sondagem de confirmação");
  // AVAL Sol 253/254: pedido externo por janela, concorrência limitada, inputs só por env (nunca no script).
  assert.match(mon, /workflow_dispatch:\n    inputs:\n      window_id:/, "WF-inputs");
  for (const k of ["window_id", "dispatched_at", "dispatch_source"]) assert.match(mon, new RegExp("P18_" + k.toUpperCase() + ": \\$\\{\\{ inputs\\." + k + " \\}\\}"), "WF-env " + k);
  assert.match(mon, /concurrency:\n  group: p18-external-monitor\n  cancel-in-progress: false\n/, "WF-concurrency");
  assert.doesNotMatch(mon, /queue: max/, "WF-single-pending: no máximo 1 rodando + 1 pendente");
  assert.ok(mon.split("\n").filter((l) => /inputs\./.test(l)).every((l) => /^\s+P18_[A-Z_]+: \$\{\{ inputs\.[a-z_]+ \}\}$/.test(l) || /^run-name: /.test(l)), "WF-no-input-in-script");
  const wd = wf("p18-monitor-watchdog.yml");
  assert.match(wd, /cron: '4,14,24,34,44,54 \* \* \* \*'/);
  assert.match(wd, /contents: read/); assert.doesNotMatch(wd, /contents: write|secrets\.(?!GITHUB_TOKEN)|pull_request|wrangler|-X\s*POST/);
  assert.match(wd, /issues: write/); assert.match(wd, /runs-on: ubuntu-latest/); assert.match(wd, /p18-watchdog\.mjs/);
  assert.match(wd, /P18_CF_DISPATCH_EXPECTED: \$\{\{ vars\.P18_CF_DISPATCH_EXPECTED \}\}/, "WF-cf-expected-var");
  assert.doesNotMatch(tst, /branches:/, "testes também em PR empilhado");
  assert.match(mon, /issues: write/);
  assert.doesNotMatch(col, /issues: write/);
  assert.match(tst, /pull_request:/); assert.match(tst, /contents: read/); assert.doesNotMatch(tst, /contents: write|schedule:/);
});

// ---- gatilho externo (AVAL Sol 253/254): janela de 5 min, idempotência, metadados do pedido, vigia do caminho CF ----
test("[WIN] id de janela: alinhado ao minuto 0, estrito; slot :02 do agendador cai na janela :00; limites -60 min / +2 min", () => {
  assert.equal(windowIdOf(Date.parse(T("10:04:59"))), "p18w-20261025T1000Z", "WIN-floor");
  assert.equal(windowIdOf(Date.parse(T("10:05:00"))), "p18w-20261025T1005Z", "WIN-edge");
  assert.equal(windowIdOf(schedSlotMs(Date.parse(T("10:02:40")))), "p18w-20261025T1000Z", "WIN-sched-same-window");
  assert.equal(parseWindowId("p18w-20261025T1005Z"), Date.parse(T("10:05:00")), "WIN-parse");
  for (const bad of ["p18w-20261025T1003Z", "p18w-20261325T1000Z", "p18w-20261025T2460Z", "p18w-20261025T1000", "x", "", null, "p18w-20261025T1000Z;rm"])
    assert.equal(parseWindowId(bad), null, "WIN-strict " + bad);
  const S0 = Date.parse(T("10:00:20"));
  const ok = resolveDispatch({ windowId: "p18w-20261025T1000Z", dispatchedAt: T("10:00:01"), source: "cloudflare-cron", startedMs: S0 });
  assert.deepEqual(ok, { window_id: "p18w-20261025T1000Z", start_window_id: "p18w-20261025T1000Z", dispatch_source: "cloudflare-cron", dispatched_at: T("10:00:01"), dispatch_to_start_s: 19, window_rejected: null }, "WIN-accept");
  assert.equal(resolveDispatch({ windowId: "p18w-20261025T1005Z", startedMs: Date.parse(T("10:03:00")) }).window_id, "p18w-20261025T1005Z", "WIN-future-120-edge");
  assert.equal(resolveDispatch({ windowId: "p18w-20261025T1005Z", startedMs: Date.parse(T("10:02:59")) }).window_rejected, "window_in_future", "WIN-future-121");
  assert.equal(resolveDispatch({ windowId: "p18w-20261025T0900Z", startedMs: Date.parse(T("10:00:00")) }).window_id, "p18w-20261025T0900Z", "WIN-old-3600-edge");
  assert.equal(resolveDispatch({ windowId: "p18w-20261025T0900Z", startedMs: Date.parse(T("10:00:01")) }).window_rejected, "window_too_old", "WIN-old-3601");
  assert.equal(resolveDispatch({ windowId: "p18w-20261025T1000Z", dispatchedAt: T("09:59:59"), startedMs: S0 }).window_rejected, "bad_dispatched_at", "WIN-dispatch-before-window");
  assert.equal(resolveDispatch({ windowId: "p18w-20261025T1000Z", dispatchedAt: "ontem", startedMs: S0 }).window_rejected, "bad_dispatched_at", "WIN-dispatch-garbage");
  assert.equal(resolveDispatch({ windowId: "p18w-20261025T1000Z", dispatchedAt: T("10:02:21"), startedMs: S0 }).window_rejected, "bad_dispatched_at", "WIN-dispatch-after-start");
  const rej = resolveDispatch({ windowId: "lixo", source: "atacante", startedMs: S0 });
  assert.equal(rej.window_id, null, "WIN-reject-null"); assert.equal(rej.start_window_id, "p18w-20261025T1000Z", "WIN-reject-falls-back"); assert.equal(rej.dispatch_source, null, "WIN-source-allowlist");
});

test("[IDEM] pedido por janela: 1ª execução sonda; repetição (pedido ou agendador) na mesma janela não sonda nem alerta; id forjado não suprime", async () => {
  const dir = tmp();
  try {
    const net = fakeNet({ ccMessage: CC, ctl: { down: false } });
    let clock = 0; const now = () => clock, sleep = async (ms) => { clock += ms; }, pause = async () => {};
    const disp = (w, at, run) => envFor(dir, { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ID: run, P18_WINDOW_ID: w, P18_DISPATCHED_AT: at, P18_DISPATCH_SOURCE: "cloudflare-cron" });
    clock = Date.parse(T("10:00:20"));
    const a = await monitorMain({ env: disp("p18w-20261025T1000Z", T("10:00:01"), "201"), fetchImpl: net.fetchImpl, now, sleep, pause, log: () => {} });
    assert.equal(a.action, "none", "IDEM-first-probes"); assert.equal(a.run.window_id, "p18w-20261025T1000Z", "IDEM-run-window"); assert.equal(a.run.dispatch_to_start_s, 19, "IDEM-dispatch-to-start");
    const hb1 = readTextNormalized(join(dir, "p18", "heartbeat.json"));
    assert.equal(JSON.parse(hb1).window_id, "p18w-20261025T1000Z", "IDEM-hb-window"); assert.equal(JSON.parse(hb1).dispatch_to_start_s, 19, "IDEM-hb-d2s");
    const cf1 = JSON.parse(readTextNormalized(join(dir, "p18", "cf-dispatch.json")));
    assert.equal(cf1.schema, SCHEMA_CF_DISPATCH, "IDEM-cf-first"); assert.equal(cf1.started_at, T("10:00:20"), "IDEM-cf-first-start"); assert.equal(cf1.duplicate, false, "IDEM-cf-first-dup");
    const callsAfterFirst = net.calls.length;
    // Agendador do GitHub no slot :02 da MESMA janela: duplicada.
    clock = Date.parse(T("10:02:31"));
    const b = await monitorMain({ env: envFor(dir, { GITHUB_EVENT_NAME: "schedule", GITHUB_RUN_ID: "202" }), fetchImpl: net.fetchImpl, now, sleep, pause, log: () => {} });
    assert.equal(b.action, "skip", "IDEM-sched-skip"); assert.equal(net.calls.length, callsAfterFirst, "IDEM-no-network");
    assert.equal(readTextNormalized(join(dir, "p18", "heartbeat.json")), hb1, "IDEM-no-heartbeat");
    // Mesmo pedido entregue de novo e iniciado tarde (janela do início já é outra): o id pedido já sondado manda.
    clock = Date.parse(T("10:06:10"));
    const c = await monitorMain({ env: disp("p18w-20261025T1000Z", T("10:00:01"), "203"), fetchImpl: net.fetchImpl, now, sleep, pause, log: () => {} });
    assert.equal(c.action, "skip", "IDEM-repeat-skip"); assert.equal(c.run.dispatch_to_start_s, 369, "IDEM-late-d2s");
    assert.equal(JSON.parse(readTextNormalized(join(dir, "p18", "cf-dispatch.json"))).duplicate, true, "IDEM-cf-dup-recorded");
    // Próxima janela pedida: sonda; o intervalo conta da última execução que SONDOU, não da duplicada.
    clock = Date.parse(T("10:06:40"));
    const d = await monitorMain({ env: disp("p18w-20261025T1005Z", T("10:05:02"), "204"), fetchImpl: net.fetchImpl, now, sleep, pause, log: () => {} });
    assert.equal(d.action, "none", "IDEM-next-window-probes"); assert.equal(d.run.prev_gap_s, 380, "IDEM-gap-from-probing-run");
    // Id forjado para o futuro (10:20 pedido às 10:11): descartado, sonda a janela do início e NÃO suprime a janela 10:20.
    clock = Date.parse(T("10:11:00"));
    const e = await monitorMain({ env: disp("p18w-20261025T1020Z", "", "205"), fetchImpl: net.fetchImpl, now, sleep, pause, log: () => {} });
    assert.equal(e.action, "none", "IDEM-forged-still-probes"); assert.equal(e.run.window_rejected, "window_in_future", "IDEM-forged-rejected"); assert.equal(e.run.window_id, null, "IDEM-forged-null");
    clock = Date.parse(T("10:20:05"));
    const f = await monitorMain({ env: disp("p18w-20261025T1020Z", T("10:20:01"), "206"), fetchImpl: net.fetchImpl, now, sleep, pause, log: () => {} });
    assert.equal(f.action, "none", "IDEM-forged-no-suppress");
    const runs = readTextNormalized(join(dir, "p18", "runs-2026-10.jsonl")).trim().split("\n").map((l) => validateRun(JSON.parse(l)));
    assert.deepEqual(runs.map((r) => r.outcome), ["ok", "duplicate_window", "duplicate_window", "ok", "ok", "ok"], "IDEM-ledger");
    assert.deepEqual(runs.map((r) => r.run_id), ["201", "202", "203", "204", "205", "206"], "toda execução que iniciou fica registrada");
    assert.equal(isDuplicateWindow(runs, resolveDispatch({ windowId: "p18w-20261025T1020Z", startedMs: Date.parse(T("10:24:00")) })), true, "IDEM-covered");
    // Linha adulterada derruba (HISTORY_MALFORMED na próxima execução).
    assert.throws(() => validateRun({ ...runs[1], probes_at: [T("10:02:31")] }), /run_duplicate_probed/, "IDEM-dup-cannot-probe");
    assert.throws(() => validateRun({ ...runs[0], dispatch_to_start_s: 1 }), /run_dispatch_mismatch/, "IDEM-d2s-tamper");
    assert.throws(() => validateRun({ ...runs[0], start_window_id: "p18w-20261025T1005Z" }), /run_window_mismatch/, "IDEM-window-tamper");
    assert.ok(net.calls.every((c) => c.url.startsWith("https://api.github.com/") || c.method === "GET"), "produção só por GET");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("[WD-CF] vigia do caminho Cloudflare: > 15 min sem início pedido pela Cloudflare alerta só quando esperado; issue própria; fecha quando volta", async () => {
  const doc = (iso) => ({ schema: SCHEMA_CF_DISPATCH, started_at: iso, run_id: "1", window_id: null, dispatched_at: null, dispatch_to_start_s: null, duplicate: false });
  const now = Date.parse(T("12:00:00"));
  assert.equal(CF_DISPATCH_STALE_MIN, 15, "WDCF-15");
  assert.equal(evaluateCfDispatch(doc(T("11:45:00")), now).state, "FRESH", "WDCF-900");
  assert.equal(evaluateCfDispatch(doc(T("11:44:59")), now).state, "STALE", "WDCF-901");
  assert.equal(evaluateCfDispatch(null, now).alert, true, "WDCF-missing");
  assert.equal(evaluateCfDispatch({ started_at: T("11:59:00") }, now).state, "MALFORMED", "WDCF-malformed");
  let hbDoc = { schema: SCHEMA_HEARTBEAT, last_success_at: T("11:58:00") }, cfDoc = null; const issues = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/contents/p18/heartbeat.json")) return res(hbDoc);
    if (u.pathname.endsWith("/contents/p18/cf-dispatch.json")) return cfDoc === null ? res({ message: "Not Found" }, 404) : res(cfDoc);
    if (u.pathname.endsWith("/issues") && !init.method) return res(issues.filter((i) => i.state === "open"));
    if (u.pathname.endsWith("/issues")) { const i = { number: 60 + issues.length, title: JSON.parse(init.body).title, state: "open" }; issues.push(i); return res(i, 201); }
    const m = /\/issues\/(\d+)$/.exec(u.pathname);
    if (m) { const i = issues.find((x) => x.number === Number(m[1])); const b = JSON.parse(init.body); if (b.state) i.state = b.state; return res(i); }
    if (/\/comments$/.test(u.pathname)) return res({}, 201);
    return res({}, 404);
  };
  const env = { GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "fake", GITHUB_RUN_ID: "9" };
  const w0 = await watchdog({ env, fetchImpl, now: () => now, log: () => {} });
  assert.equal(w0.cfAction, "none", "WDCF-not-expected"); assert.equal(w0.cfEv.alert, false, "WDCF-not-expected-alert"); assert.equal(issues.length, 0, "WDCF-not-expected-issue");
  const w1 = await watchdog({ env: { ...env, P18_CF_DISPATCH_EXPECTED: "true" }, fetchImpl, now: () => now, log: () => {} });
  assert.equal(w1.cfAction, "open", "WDCF-open"); assert.equal(issues[0].title, WATCHDOG_CF_TITLE, "WDCF-title");
  assert.notEqual(WATCHDOG_CF_TITLE, WATCHDOG_TITLE, "WDCF-distinct"); assert.notEqual(WATCHDOG_CF_TITLE, ALERT_TITLE);
  assert.equal(w1.action, "none", "batimento do monitor fresco: só o caminho CF acusa");
  cfDoc = doc(T("11:57:00"));
  const w2 = await watchdog({ env: { ...env, P18_CF_DISPATCH_EXPECTED: "true" }, fetchImpl, now: () => now, log: () => {} });
  assert.equal(w2.cfAction, "close", "WDCF-close"); assert.equal(issues[0].state, "closed", "WDCF-closed");
});
