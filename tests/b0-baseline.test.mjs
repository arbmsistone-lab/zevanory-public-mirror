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
  CONFIRM_BUDGET_S, WATCHDOG_TITLE, pickMonthlyDrill,
} from "../scripts/b0/b0-lib.mjs";
import { runDrill } from "../scripts/p20/restore-drill.mjs";
import { makeBackup } from "./helpers/p20-backup-fixture.mjs";
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
  monthly_full_restore_drill: { label: "ENSAIO_EM_PRODUCAO", verdict: "APROVADO", finished_at: "2026-10-02T07:40:00.000Z", run_id: "5", age_days: 23.7, backup_day: "2026-10-02",
    rpo_hours: 2.2, rto_seconds: 95, tables_checked: 53, tables_hash_ok: 53, tables_restored: 53, scope_complete_9_1: false, not_covered_count: 4 },
};
// Registros reais do ensaio P20 (mesmo código do workflow mensal), com fixture sintética e restauração simulada.
async function drillRecord({ mode = "producao", finished = "2026-10-20T07:40:00.000Z", corrupt = false } = {}) {
  const kv = makeBackup({ day: "2026-10-20", started: "2026-10-20T05:10:00.000Z" });
  if (corrupt) { const k = "zpc:backup:v1:neon:2026-10-20:part:0"; const b = JSON.parse(kv[k]); b.orders = "[]"; kv[k] = JSON.stringify(b); }
  const fetchImpl = async (url) => { const key = decodeURIComponent(String(url).split("/values/")[1] || ""); return kv[key] == null ? new Response("", { status: 404 }) : new Response(kv[key]); };
  let t = 0;
  return runDrill({ mode, env: { PGHOST: "localhost", PGDATABASE: "p20_drill", CLOUDFLARE_API_TOKEN: "t".repeat(40) }, fetchImpl, fixture: mode === "sintetica" ? kv : null,
    restoreImpl: async ({ tablesJson }) => ({ ok: true, tables: Object.fromEntries(Object.entries(tablesJson).map(([n, js]) => [n, JSON.parse(js).length])), worker_schema_ready: true }),
    now: () => new Date(finished), clock: () => (t += 30000), inventory: null });
}
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
  assert.equal(computeState("P20", r14, approvedTargets()).state, "MEDICAO_ATIVA", "P20: cópia KV->Neon, conciliação e diário D1 MISSING bloqueiam");
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
  assert.ok(reg.processes.P20.sources.some((s) => s.id === "monthly_full_restore_drill" && s.status === "PRESENT"), "[B0P20.1] ensaio mensal existe como fonte");
  for (const id of ["kv_copy_full_restore", "provider_reconciliation", "event_journal_d1"]) assert.ok(reg.processes.P20.sources.some((s) => s.id === id && s.status === "MISSING"), "[B0P20.2] " + id);
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
    assert.equal(record.processes.P15.complete, true); assert.equal(record.processes.P19.complete, true);
    assert.equal(record.processes.P20.complete, false, "sem ensaio mensal no ramo: P20 incompleto");
    assert.equal(record.processes.P20.fields.monthly_full_restore_drill.reason, "no_drill_within_31_days");
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
  const wd = wf("p18-monitor-watchdog.yml");
  assert.match(wd, /cron: '4,14,24,34,44,54 \* \* \* \*'/);
  assert.match(wd, /contents: read/); assert.doesNotMatch(wd, /contents: write|secrets\.(?!GITHUB_TOKEN)|pull_request|wrangler|-X\s*POST/);
  assert.match(wd, /issues: write/); assert.match(wd, /runs-on: ubuntu-latest/); assert.match(wd, /p18-watchdog\.mjs/);
  assert.doesNotMatch(tst, /branches:/, "testes também em PR empilhado");
  assert.match(mon, /issues: write/);
  assert.doesNotMatch(col, /issues: write/);
  assert.match(tst, /pull_request:/); assert.match(tst, /contents: read/); assert.doesNotMatch(tst, /contents: write|schedule:/);
});

test("P20 ensaio mensal no B0: só ENSAIO_EM_PRODUCAO em 31 dias conta; SINTETICA, NOT_AVAILABLE, antigo ou histórico malformado nunca completam", async () => {
  const real = await drillRecord();
  assert.equal(real.label, "ENSAIO_EM_PRODUCAO"); assert.equal(real.verdict, "APROVADO");
  const ok = pickMonthlyDrill([real], "2026-10-25");
  assert.equal(ok.ok, true, "[B0P20.3]");
  assert.equal(ok.v.age_days, 5.7); assert.equal(ok.v.tables_restored, 6);
  assert.equal(processEntry("P20", { backup_restore_sample: measured("t", OKV.backup_restore_sample), monthly_full_restore_drill: measured("t", ok.v) }).complete, true, "[B0P20.4]");
  const synth = await drillRecord({ mode: "sintetica" });
  assert.equal(synth.label, "SINTETICA");
  assert.equal(pickMonthlyDrill([synth], "2026-10-25").reason, "drill_label_SINTETICA_not_counted", "[B0P20.5] sintético nunca conta");
  assert.equal(pickMonthlyDrill([real], "2026-11-20").reason, "no_drill_within_31_days", "[B0P20.6] mais de 31 dias: não há ensaio do mês");
  assert.equal(pickMonthlyDrill([real], "2026-10-19").reason, "no_drill_within_31_days", "[B0P20.7] ensaio posterior ao dia D não conta para D");
  const notAvail = await runDrill({ mode: "producao", env: {}, now: () => new Date("2026-10-21T07:00:00Z"), inventory: null });
  assert.equal(notAvail.verdict, "NOT_AVAILABLE");
  assert.match(pickMonthlyDrill([notAvail], "2026-10-25").reason, /^latest_drill_not_available:cloudflare_token_unavailable/, "[B0P20.8]");
  assert.equal(pickMonthlyDrill([real, notAvail], "2026-10-25").ok, true, "ensaio real no mês continua valendo depois de uma falta de leitura");
  const bad = await drillRecord({ corrupt: true });
  assert.equal(bad.verdict, "REPROVADO");
  const rep = pickMonthlyDrill([bad], "2026-10-25");
  assert.equal(rep.ok, true, "[B0P20.9] reprovado medido é dia completo com resultado ruim");
  assert.equal(rep.v.verdict, "REPROVADO");
  const forged = { ...ok.v, label: "SINTETICA" };
  assert.equal(processEntry("P20", { backup_restore_sample: measured("t", OKV.backup_restore_sample), monthly_full_restore_drill: measured("t", forged) }).complete, false, "[B0P20.10]");
  const forged2 = { ...ok.v, tables_restored: 3 };
  assert.equal(processEntry("P20", { backup_restore_sample: measured("t", OKV.backup_restore_sample), monthly_full_restore_drill: measured("t", forged2) }).complete, false, "[B0P20.11] aprovado com restauração parcial é malformado");
  const forged3 = { ...ok.v, age_days: 40 };
  assert.equal(processEntry("P20", { backup_restore_sample: measured("t", OKV.backup_restore_sample), monthly_full_restore_drill: measured("t", forged3) }).complete, false, "[B0P20.12]");

  const dir = tmp();
  try {
    const net = fakeNet({ ccMessage: CC });
    mkdirSync(join(dir, "p20"), { recursive: true });
    writeFileSync(join(dir, "p20", "restore-drills-v1.jsonl"), JSON.stringify(real) + "\n");
    const r1 = await collect({ env: envFor(dir), fetchImpl: net.fetchImpl, now: new Date("2026-10-26T01:30:00Z"), pause: async () => {}, log: () => {} });
    assert.equal(r1.record.processes.P20.complete, true, "[B0P20.13] coletor lê o ensaio do ramo de evidência");
    assert.equal(r1.register.processes.P20.state, "MEDICAO_ATIVA", "[B0P20.14] fontes MISSING e metas PROPOSED mantêm P20 fora de B0_VALIDA");
    writeFileSync(join(dir, "p20", "restore-drills-v1.jsonl"), "{lixo\n");
    const r2 = await collect({ env: envFor(dir), fetchImpl: net.fetchImpl, now: new Date("2026-10-26T02:00:00Z"), pause: async () => {}, log: () => {} });
    assert.equal(r2.record.processes.P20.fields.monthly_full_restore_drill.reason, "drill_history_malformed", "[B0P20.15]");
    assert.equal(r2.record.processes.P20.complete, false, "[B0P20.16]");
    assert.equal(r2.record.processes.P15.complete, true, "histórico P20 malformado não derruba os outros processos");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evolução do esquema: linha antiga sem o campo novo é relida como incompleta (nunca completa) e não derruba", () => {
  const old = dayRec("2026-10-24");
  delete old.processes.P20.fields.monthly_full_restore_drill;
  old.processes.P20.complete = true;
  const [back] = parseJsonl(JSON.stringify(old), validateDailyRecord);
  assert.equal(back.processes.P20.complete, false, "[B0P20.17]");
  const forged = dayRec("2026-10-24");
  forged.processes.P20.fields.backup_restore_sample = measured("t", { ok: true });
  forged.processes.P20.complete = true;
  assert.throws(() => parseJsonl(JSON.stringify(forged), validateDailyRecord), /complete_flag_mismatch P20/, "[B0P20.18]");
});
