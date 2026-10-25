// ZEVANORY | Fase B0 e P18 externo: testes da lógica do coletor e do monitor (evidência SINTETICA; nunca grava
// no ramo de evidência). Cobre: fail-closed em fonte malformada, NOT_AVAILABLE nunca conta como dia completo,
// contador de dias consecutivos, rótulos nunca misturados, estados MEDICAO_ATIVA/B0_VALIDA/APTO, alerta 2x.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTextNormalized } from "./helpers/text.mjs";
import {
  NA, PROCESSES, PROCESS_IDS, SALES_PAGES, STATUS_URL, SCHEMA_PROBE, SCHEMA_A11Y, measured, na, processEntry, buildDailyRecord,
  validateDailyRecord, parseJsonl, consecutiveCompleteDays, countsByLabel, validateTargets, computeState, buildRegister,
  parseCommandCenter, parseFunnelDiag, parseDataBackup, readP22, parseSitemap, parseA11y, aggregateProbes, decideAlert,
  findOpenAlert, ALERT_TITLE, addDays, validateProbe,
} from "../scripts/b0/b0-lib.mjs";
import { collect } from "../scripts/b0/b0-collector.mjs";
import { main as monitorMain } from "../scripts/b0/p18-monitor.mjs";

const TARGETS = JSON.parse(readTextNormalized(new URL("../docs/b0/metas-propostas.json", import.meta.url)));
const approvedTargets = () => {
  const t = structuredClone(TARGETS);
  for (const list of Object.values(t.processes)) for (const x of list) Object.assign(x, { status: "APPROVED", approved_by: "proprietario", approved_at: "2026-11-01" });
  return t;
};
const OKV = {
  sales_availability: { probes: 144, expected: 144, coverage: 1, up: 144, down: 0, availability: 1, max_gap_min: 10 },
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
  assert.equal(processEntry("P18", { sales_availability: measured("t", OKV.sales_availability) }).complete, true);
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
  const ok = computeState("P18", r14, approvedTargets());
  assert.equal(ok.state, "B0_VALIDA");
  assert.equal(ok.start_date_utc, "2026-10-01");
  assert.ok(ok.reasons.some((r) => /prova operacional/.test(r)), "B0_VALIDA nunca vira APTO sem prova operacional");
  assert.equal(computeState("P03", r14, approvedTargets()).state, "MEDICAO_ATIVA", "P03: Search Console MISSING bloqueia");
  assert.equal(computeState("P19", r14, approvedTargets()).state, "MEDICAO_ATIVA", "P19: Neon/Workers MISSING bloqueia");
  assert.equal(computeState("P20", r14, approvedTargets()).state, "MEDICAO_ATIVA", "P20: ensaio mensal MISSING bloqueia");
  assert.equal(computeState("P06", r14, approvedTargets()).state, "MEDICAO_ATIVA");
  assert.equal(computeState("P06", r14, approvedTargets()).consecutive_complete_days, 0);
  assert.equal(computeState("P18", r14, approvedTargets(), { days: 14, real_executions: 29 }).state, "B0_VALIDA", "29 execuções não bastam");
  assert.equal(computeState("P18", r14, approvedTargets(), { days: 14, real_executions: 30 }).state, "APTO_A_CERTIFICACAO");
  assert.equal(computeState("P18", r14, approvedTargets(), { days: 13, real_executions: 300 }).state, "B0_VALIDA", "14 dias E 30 execuções");
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
  const all = Array.from({ length: 144 }, (_, i) => probe(new Date(Date.parse("2026-10-25T00:05:00Z") + i * 600000).toISOString(), i !== 7));
  const a = aggregateProbes(all, "2026-10-25");
  assert.equal(a.enough, true); assert.equal(a.p18.down, 1); assert.equal(a.p18.availability, 0.9931); assert.equal(a.p18.max_gap_min, 10);
  assert.equal(a.p22.invalid, 144); assert.equal(a.p22.fail_safe_violations, 0);
  const sparse = aggregateProbes(all.filter((_, i) => i % 2 === 0), "2026-10-25");
  assert.equal(sparse.enough, false, "72/144 sondagens: dia incompleto");
  assert.equal(sparse.p18.max_gap_min, 20);
  assert.equal(aggregateProbes(all, "2026-10-26").p18.probes, 0, "nada de outro dia");
});

test("alerta P18: 1a falha não alerta; 2a consecutiva abre; seguintes atualizam; recuperação fecha", () => {
  const down = probe("2026-10-25T00:10:00Z", false), up = probe("2026-10-25T00:20:00Z", true);
  assert.deepEqual(decideAlert(up, down, null), { action: "none" });
  assert.deepEqual(decideAlert(null, down, null), { action: "none" });
  assert.deepEqual(decideAlert(down, down, null), { action: "open" });
  assert.deepEqual(decideAlert(down, down, { number: 5 }), { action: "update", number: 5 });
  assert.deepEqual(decideAlert(down, up, { number: 5 }), { action: "close", number: 5 });
  assert.deepEqual(decideAlert(down, up, null), { action: "none" });
  assert.equal(findOpenAlert([{ number: 1, title: ALERT_TITLE, pull_request: {} }, { number: 2, title: "outro" }]), null);
  assert.equal(findOpenAlert([{ number: 3, title: ALERT_TITLE, state: "open" }]).number, 3);
  assert.throws(() => validateProbe({ ...down, up: true }), /probe_up_mismatch/);
});

// ---- ponta a ponta com rede falsa e diretório temporário (nunca rede real) --------------------------------
function tmp() { return mkdtempSync(join(tmpdir(), "zev-b0-")); }
const res = (body, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
function fakeNet({ ccMessage, statusBody, pagesDown = false }) {
  const calls = [];
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
      if (u.pathname.endsWith("/issues") && (init.method || "GET") === "GET") return res([]);
      if (u.pathname.endsWith("/issues")) return res({ number: 9 }, 201);
      return res({}, 404);
    }
    if (u.pathname === "/sitemap.xml") return res(`<urlset><url><loc>https://${u.host}/solucoes</loc></url><url><loc>https://${u.host}/comprar/X</loc></url></urlset>`);
    if (u.pathname === "/api/status") return res(statusBody ?? { commercial_metrics_provenance: { state: "UNVERIFIED_FAIL_CLOSED", measured_at: null, commercial_release_allowed: false }, sales_authorization: { state: "closed" } });
    return res("<html>ok</html>", pagesDown ? 503 : 200);
  };
  return { calls, fetchImpl };
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

test("monitor ponta a ponta: grava sondagem, abre UMA issue na 2a falha seguida, nunca POST em produção", async () => {
  const dir = tmp();
  try {
    const net = fakeNet({ ccMessage: CC, pagesDown: true });
    const t0 = Date.parse("2026-10-25T10:00:00Z");
    const a = await monitorMain({ env: envFor(dir), fetchImpl: net.fetchImpl, now: () => t0, log: () => {}, pause: async () => {} });
    assert.equal(a.cur.up, false); assert.equal(a.action, "none", "primeira falha não alerta");
    const b = await monitorMain({ env: envFor(dir), fetchImpl: net.fetchImpl, now: () => t0 + 600000, log: () => {}, pause: async () => {} });
    assert.equal(b.action, "open");
    const posts = net.calls.filter((c) => c.method !== "GET");
    assert.equal(posts.length, 1); assert.match(posts[0].url, /^https:\/\/api\.github\.com\/repos\/o\/r\/issues$/);
    assert.ok(net.calls.every((c) => !/comprar|checkout|pagamento/.test(c.url)));
    const urls = new Set(net.calls.filter((c) => !c.url.startsWith("https://api.github.com/")).map((c) => c.url));
    assert.deepEqual([...urls].sort(), [...SALES_PAGES, STATUS_URL].sort());
    const lines = readTextNormalized(join(dir, "p18", "probes-2026-10.jsonl")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2); assert.equal(lines[1].p22.readable, true); assert.equal(lines[1].p22.valid, false);
    writeFileSync(join(dir, "p18", "probes-2026-10.jsonl"), "lixo\n");
    await assert.rejects(monitorMain({ env: envFor(dir), fetchImpl: net.fetchImpl, now: () => t0 + 1200000, log: () => {}, pause: async () => {} }), /HISTORY_MALFORMED/);
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
  assert.match(mon, /cron: '\*\/10 \* \* \* \*'/);
  assert.match(mon, /issues: write/);
  assert.doesNotMatch(col, /issues: write/);
  assert.match(tst, /pull_request:/); assert.match(tst, /contents: read/); assert.doesNotMatch(tst, /contents: write|schedule:/);
});
