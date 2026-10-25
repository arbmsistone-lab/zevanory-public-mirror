// ZEVANORY | P20: testes do ensaio mensal de restauração completa (evidência SINTETICA; nunca rede real, nunca
// banco real). Cobre: integridade por tabela contra o manifesto, fail-closed (fonte malformada = NOT_AVAILABLE,
// nunca APROVADO), rótulo ENSAIO_EM_PRODUCAO só com a cópia real lida, alvo só efêmero, leitura só GET,
// RPO/RTO, registro estrito sem dado de linha e workflow (producao-critica, evidência fora do gh-pages).
// A restauração real num Postgres (código real do Worker + restore_full) está em tests/test_p20_restore_drill.py.
import test from "node:test";
import assert from "node:assert/strict";
import { readTextNormalized } from "./helpers/text.mjs";
import {
  assertEphemeralTarget, decideLabel, rpoHours, buildRecord, validateRecord, parseDrillHistory,
  validateInventory, byClass, REPORT_KEY, partReportKey, bundleKeyFor, NOT_COVERED,
} from "../scripts/p20/restore-drill-lib.mjs";
import { kvReader, runDrill, CF_ACCOUNT, NAMESPACE } from "../scripts/p20/restore-drill.mjs";
import { recordOrNotAvailable } from "../scripts/p20/publish-drill.mjs";
import { makeBackup, SEGREDO, DAY } from "./helpers/p20-backup-fixture.mjs";

const INVENTORY = JSON.parse(readTextNormalized(new URL("../docs/p20/inventario-estado-critico.json", import.meta.url)));

const mutate = (kv, key, fn) => { const o = JSON.parse(kv[key]); fn(o); kv[key] = JSON.stringify(o); return kv; };
const ENV = { PGHOST: "localhost", PGDATABASE: "p20_drill", GITHUB_RUN_ID: "9", GITHUB_SHA: "abc" };
const okRestore = (calls = []) => async ({ tablesJson, env }) => { calls.push({ tables: Object.keys(tablesJson).sort(), env }); return { ok: true, tables: Object.fromEntries(Object.entries(tablesJson).map(([t, js]) => [t, JSON.parse(js).length])), preserved_without_schema: [], worker_schema_ready: true }; };
let tick = 0;
const clock = () => (tick += 2500);
const nowAt = (iso) => () => new Date(iso);
const drill = (kv, extra = {}) => runDrill({ mode: "sintetica", env: ENV, fixture: kv, restoreImpl: okRestore(), now: nowAt("2026-11-02T07:23:00.000Z"), clock, inventory: INVENTORY, ...extra });

test("D1 cópia íntegra: todas as tabelas conferidas contra o manifesto, restauração completa, APROVADO e SINTETICA", async () => {
  const calls = [];
  const rec = await drill(makeBackup(), { restoreImpl: okRestore(calls) });
  assert.equal(rec.verdict, "APROVADO", "[D1.1]");
  assert.equal(rec.label, "SINTETICA", "[D1.2] fixture nunca vira ENSAIO_EM_PRODUCAO");
  assert.equal(rec.integrity.tables_checked, 6, "[D1.3]");
  assert.equal(rec.integrity.tables_hash_ok, 6, "[D1.4]");
  assert.equal(rec.restore.tables, 6, "[D1.5] restauração de TODAS as tabelas");
  assert.deepEqual(calls[0].tables, ["knowledge_documents", "orders", "product_support_cases", "service_fulfillment", "telemetry_events", "zevanory_leads"], "[D1.6]");
  assert.equal(rec.backup.rows, 6, "[D1.7]");
  assert.equal(rec.scope_complete_9_1, false, "[D1.8] escopo da seção 9.1 nunca declarado completo com pendências");
  assert.deepEqual(rec.not_covered, [...NOT_COVERED], "[D1.9]");
  assert.deepEqual(rec.backup.excluded_by_policy, ["provider_oauth_credentials"]);
});

test("D2 hash de uma tabela diferente do manifesto: REPROVADO e nada é restaurado", async () => {
  const kv = makeBackup();
  mutate(kv, bundleKeyFor(DAY, 1), (b) => { b.service_fulfillment = JSON.stringify([{ id: 1 }, { id: 3 }]); });
  const calls = [];
  const rec = await drill(kv, { restoreImpl: okRestore(calls) });
  assert.equal(rec.verdict, "REPROVADO", "[D2.1]");
  assert.ok(rec.failures.includes("hash_mismatch:service_fulfillment"), "[D2.2]");
  assert.deepEqual(rec.integrity.tables_hash_failed, ["service_fulfillment"], "[D2.3]");
  assert.equal(calls.length, 0, "[D2.4] cópia adulterada nunca é restaurada");
  assert.equal(rec.rto_seconds, null, "[D2.5] RTO só existe com ensaio aprovado");
});

test("D3 manifesto e bundle divergentes (tabela a mais, a menos ou sem hash) e resumo do manifesto: REPROVADO", async () => {
  const extra = mutate(makeBackup(), bundleKeyFor(DAY, 2), (b) => { b.tabela_fantasma = "[]"; });
  const r1 = await drill(extra);
  assert.equal(r1.verdict, "REPROVADO", "[D3.1]");
  assert.ok(r1.failures.includes("table_without_manifest_hash:tabela_fantasma"), "[D3.2]");
  const missing = mutate(makeBackup(), bundleKeyFor(DAY, 0), (b) => { delete b.orders; });
  const r2 = await drill(missing);
  assert.ok(r2.failures.includes("table_in_manifest_missing_from_bundle:orders"), "[D3.3]");
  assert.equal(r2.verdict, "REPROVADO", "[D3.4]");
  const digest = mutate(makeBackup(), partReportKey(1), (p) => { p.neon.manifest = "f".repeat(16); });
  const r3 = await drill(digest);
  assert.ok(r3.failures.includes("part_manifest_digest_mismatch:1"), "[D3.5]");
  assert.equal(r3.verdict, "REPROVADO", "[D3.6]");
  const rows = mutate(makeBackup(), partReportKey(0), (p) => { p.neon.rows = 5; });
  assert.ok((await drill(rows)).failures.includes("part_row_count_mismatch:0"), "[D3.7]");
});

test("D4 cópia não íntegra no relatório: parte de outro dia, parte falha, consolidado não ok ou bundle ausente: REPROVADO", async () => {
  const otherDay = mutate(makeBackup(), partReportKey(2), (p) => { p.day = "2026-11-01"; });
  const r1 = await drill(otherDay);
  assert.ok(r1.failures.includes("part_day_mismatch:2"), "[D4.1]");
  assert.equal(r1.verdict, "REPROVADO", "[D4.2]");
  const notOk = mutate(makeBackup(), REPORT_KEY, (c) => { c.ok = false; });
  const r2 = await drill(notOk);
  assert.ok(r2.failures.includes("combined_report_not_ok"), "[D4.3]");
  assert.equal(r2.verdict, "REPROVADO", "[D4.4]");
  const partFail = mutate(makeBackup(), partReportKey(1), (p) => { p.ok = false; p.failures = ["neon_restore:x"]; });
  assert.ok((await drill(partFail)).failures.includes("part_not_ok:1"), "[D4.5]");
  const noBundle = makeBackup(); delete noBundle[bundleKeyFor(DAY, 0)];
  const r4 = await drill(noBundle);
  assert.ok(r4.failures.includes("bundle_missing:0"), "[D4.6]");
  assert.equal(r4.verdict, "REPROVADO", "[D4.7]");
  const wrongKey = mutate(makeBackup(), partReportKey(0), (p) => { p.fp.bundleKey = bundleKeyFor("2026-10-30", 0); });
  assert.ok((await drill(wrongKey)).failures.includes("bundle_key_mismatch:0"), "[D4.8]");
});

test("D5 fonte malformada ou ausente: NOT_AVAILABLE, rótulo null, sem RPO/RTO, nunca APROVADO", async () => {
  const trunc = makeBackup(); trunc[REPORT_KEY] = trunc[REPORT_KEY].slice(0, 30);
  const r1 = await drill(trunc);
  assert.equal(r1.verdict, "NOT_AVAILABLE", "[D5.1]");
  assert.equal(r1.label, null, "[D5.2]");
  assert.equal(r1.rpo_hours, null, "[D5.3]");
  assert.match(r1.reason, /combined_report_unreadable/);
  const absent = makeBackup(); delete absent[REPORT_KEY];
  const r2 = await drill(absent);
  assert.equal(r2.verdict, "NOT_AVAILABLE", "[D5.4]");
  assert.match(r2.reason, /combined_report_absent/);
  const badPart = makeBackup(); badPart[partReportKey(1)] = "{\"schema\":\"zevanory-backup/v1\"}";
  assert.equal((await drill(badPart)).verdict, "NOT_AVAILABLE", "[D5.5]");
  const calls = [];
  await drill(trunc, { restoreImpl: okRestore(calls) });
  assert.equal(calls.length, 0, "[D5.6]");
});

test("D6 produção: rótulo ENSAIO_EM_PRODUCAO só com a cópia real lida; só GET, só api.cloudflare.com, só chaves do backup", async () => {
  const kv = makeBackup();
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url: String(url), method: init.method });
    const key = decodeURIComponent(String(url).split("/values/")[1] || "");
    return kv[key] == null ? new Response("{}", { status: 404 }) : new Response(kv[key], { status: 200 });
  };
  const rec = await runDrill({ mode: "producao", env: { ...ENV, CLOUDFLARE_API_TOKEN: "t".repeat(40) }, fetchImpl, restoreImpl: okRestore(), now: nowAt("2026-11-02T07:23:00.000Z"), clock, inventory: INVENTORY });
  assert.equal(rec.label, "ENSAIO_EM_PRODUCAO", "[D6.1]");
  assert.equal(rec.verdict, "APROVADO", "[D6.2]");
  assert.equal(seen.length, 7, "[D6.3] 1 consolidado + 3 manifestos + 3 bundles");
  assert.ok(seen.every((c) => c.method === "GET"), "[D6.4] nunca grava no KV de produção");
  assert.ok(seen.every((c) => c.url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/storage/kv/namespaces/${NAMESPACE}/values/zpc%3Abackup%3Av1%3A`)), "[D6.5]");
  const noToken = await runDrill({ mode: "producao", env: ENV, fetchImpl, restoreImpl: okRestore(), now: nowAt("2026-11-02T07:23:00.000Z"), clock, inventory: INVENTORY });
  assert.equal(noToken.verdict, "NOT_AVAILABLE", "[D6.6]");
  assert.equal(noToken.label, null, "[D6.7] sem leitura real não há ENSAIO_EM_PRODUCAO");
  assert.match(noToken.reason, /cloudflare_token_unavailable/);
  const http500 = await runDrill({ mode: "producao", env: { ...ENV, CLOUDFLARE_API_TOKEN: "t".repeat(40) }, fetchImpl: async () => new Response("x", { status: 500 }), restoreImpl: okRestore(), now: nowAt("2026-11-02T07:23:00.000Z"), clock, inventory: INVENTORY });
  assert.equal(http500.verdict, "NOT_AVAILABLE", "[D6.8]");
  assert.throws(() => kvReader({ mode: "producao", token: "t".repeat(40), fixture: kv }), /fixture_forbidden_in_producao/, "[D6.9] fixture nunca rotulada como produção");
  const get = kvReader({ mode: "producao", token: "t".repeat(40), fetchImpl });
  await assert.rejects(get("zpc:sales:v1:open"), /key_outside_backup_namespace/, "[D6.10]");
  assert.equal(decideLabel("producao", false), null, "[D6.11]");
  assert.equal(decideLabel("sintetica", true), "SINTETICA", "[D6.12]");
});

test("D7 alvo só efêmero: host não local, URL de banco real no ambiente ou banco fora de p20_drill* recusam antes de restaurar", async () => {
  assert.equal(assertEphemeralTarget({ PGHOST: "localhost", PGDATABASE: "p20_drill" }), true);
  assert.throws(() => assertEphemeralTarget({ PGHOST: "ep-x.neon.tech", PGDATABASE: "p20_drill" }), /TARGET_NOT_EPHEMERAL host/, "[D7.1]");
  assert.throws(() => assertEphemeralTarget({ PGHOST: "localhost", PGDATABASE: "p20_drill", DATABASE_URL: "postgres://x" }), /TARGET_NOT_EPHEMERAL DATABASE_URL/, "[D7.2]");
  assert.throws(() => assertEphemeralTarget({ PGHOST: "localhost", PGDATABASE: "neondb" }), /TARGET_NOT_EPHEMERAL database/, "[D7.3]");
  assert.throws(() => assertEphemeralTarget({ PGHOST: "localhost", PGHOSTADDR: "10.0.0.5", PGDATABASE: "p20_drill" }), /hostaddr/, "[D7.4]");
  assert.throws(() => assertEphemeralTarget({ PGHOST: "localhost", PGDATABASE: "p20_drill", RESTORE_TARGET_DATABASE_URL: "postgres://x" }), /RESTORE_TARGET_DATABASE_URL/, "[D7.5]");
  const calls = [];
  const rec = await drill(makeBackup(), { env: { ...ENV, PGHOST: "db.example.com" }, restoreImpl: okRestore(calls) });
  assert.equal(calls.length, 0, "[D7.6] restauração nunca chamada com alvo real");
  assert.equal(rec.verdict, "REPROVADO", "[D7.7]");
  assert.ok(rec.failures.some((f) => /restore_failed:TARGET_NOT_EPHEMERAL/.test(f)), "[D7.8]");
});

test("D8 RPO = falha simulada - início mais antigo das partes; > 26 h sinalizado, > 48 h crítico; RTO medido só se APROVADO", async () => {
  assert.equal(rpoHours(["2026-11-02T05:10:00.000Z", "2026-11-02T05:00:00.000Z"], "2026-11-02T07:00:00.000Z"), 2, "[D8.1] parte mais antiga define o RPO");
  assert.equal(rpoHours([], "2026-11-02T07:00:00.000Z"), null, "[D8.2]");
  assert.equal(rpoHours(["2026-11-02T08:00:00.000Z"], "2026-11-02T07:00:00.000Z"), null, "[D8.3] cópia no futuro é incoerente");
  const future = await drill(makeBackup({ started: "2026-11-02T09:00:00.000Z" }));
  assert.equal(future.verdict, "REPROVADO", "[D8.11] cópia datada no futuro nunca é aprovada");
  assert.ok(future.failures.includes("rpo_not_computable"), "[D8.12]");
  const old = await drill(makeBackup({ started: "2026-10-31T05:10:00.000Z" }));
  assert.equal(old.rpo_hours, 50.22, "[D8.4]");
  assert.equal(old.rpo_over_26h, true, "[D8.5]");
  assert.equal(old.rpo_over_48h_critical, true, "[D8.6]");
  tick = 0;
  const ok = await drill(makeBackup());
  assert.equal(ok.rpo_over_26h, false);
  assert.equal(ok.rto_seconds, 2.5, "[D8.7] RTO = início do ensaio até a restauração conferida");
  assert.ok(ok.by_class.pedidos_pagamentos.rpo_medido_h === ok.rpo_hours, "[D8.8]");
  const failing = await drill(makeBackup(), { restoreImpl: async () => ({ ok: false, error: "count_mismatch orders 1!=2" }) });
  assert.equal(failing.verdict, "REPROVADO", "[D8.9] restauração com divergência reprova");
  assert.equal(failing.rto_seconds, null, "[D8.10]");
  assert.ok(failing.failures.some((f) => f.startsWith("restore_failed:count_mismatch orders")));
});

test("D9 registro estrito: veredito forjado, rótulo trocado ou NOT_AVAILABLE com valores derrubam; histórico malformado derruba", async () => {
  const ok = await drill(makeBackup());
  validateRecord(structuredClone(ok));
  const f1 = structuredClone(ok); f1.failures = ["hash_mismatch:orders"];
  assert.throws(() => validateRecord(f1), /approved_with_failures/, "[D9.1]");
  const f2 = structuredClone(ok); f2.label = "ENSAIO_EM_PRODUCAO";
  assert.throws(() => validateRecord(f2), /label_mode_mismatch/, "[D9.2] sintético nunca vira ensaio em produção");
  const f3 = structuredClone(ok); f3.restore = { executed: false, ok: false };
  assert.throws(() => validateRecord(f3), /approved_without_full_restore/, "[D9.3]");
  const f4 = structuredClone(ok); f4.restore.tables = 5;
  assert.throws(() => validateRecord(f4), /approved_without_full_restore/, "[D9.4] restauração parcial nunca é aprovada");
  const f5 = structuredClone(ok); f5.scope_complete_9_1 = true;
  assert.throws(() => validateRecord(f5), /bad_scope/, "[D9.5]");
  const na = buildRecord({ mode: "producao", sourceRead: false, assessment: null, restore: null, startedAt: "2026-11-02T07:00:00Z", finishedAt: "2026-11-02T07:00:01Z", notAvailableReason: "x" });
  validateRecord(structuredClone(na));
  const f6 = structuredClone(na); f6.rpo_hours = 3;
  assert.throws(() => validateRecord(f6), /not_available_with_values/, "[D9.6]");
  const f7 = structuredClone(na); f7.verdict = "APROVADO";
  assert.throws(() => validateRecord(f7), /unlabelled_measurement/, "[D9.7]");
  assert.equal(parseDrillHistory(JSON.stringify(ok) + "\n\n").length, 1);
  assert.throws(() => parseDrillHistory(JSON.stringify(ok) + "\n{x"), /DRILL_HISTORY_MALFORMED line 2/, "[D9.8]");
  assert.throws(() => parseDrillHistory(JSON.stringify(f1)), /DRILL_HISTORY_MALFORMED line 1: approved_with_failures/, "[D9.9]");
});

test("D10 publicação: registro ausente, inválido ou de outro modo vira NOT_AVAILABLE explícito; nenhum dado de linha no registro", async () => {
  const now = "2026-11-02T08:00:00.000Z";
  const a = recordOrNotAvailable(null, { mode: "producao", now });
  assert.equal(a.verdict, "NOT_AVAILABLE", "[D10.1]");
  assert.match(a.reason, /drill_job_produced_no_record/);
  assert.equal(recordOrNotAvailable("{lixo", { mode: "producao", now }).verdict, "NOT_AVAILABLE", "[D10.2]");
  const ok = await drill(makeBackup());
  const forged = { ...ok, verdict: "APROVADO", failures: ["x"] };
  assert.match(recordOrNotAvailable(JSON.stringify(forged), { mode: "sintetica", now }).reason, /record_invalid/, "[D10.3]");
  assert.match(recordOrNotAvailable(JSON.stringify(ok), { mode: "producao", now }).reason, /record_mode_mismatch/, "[D10.4] sintético nunca publicado como produção");
  assert.equal(recordOrNotAvailable(JSON.stringify(ok), { mode: "sintetica", now }).verdict, "APROVADO");
  const text = JSON.stringify(ok);
  assert.ok(!text.includes(SEGREDO) && !text.includes('"total":47'), "[D10.5] sem dado de linha");
  assert.ok(!/[0-9a-f]{64}/.test(text), "[D10.6] nenhum SHA-256 completo de tabela no registro (só booleano/prefixo)");
});

test("D11 inventário 9.1: arquivo real é PROPOSTA válida; classes cobrem pedidos, pagamentos, entregas, leads, atendimento e catálogo", () => {
  validateInventory(structuredClone(INVENTORY));
  assert.equal(INVENTORY.status, "PROPOSTA");
  assert.ok(INVENTORY.classes.every((c) => c.status === "PROPOSTA"), "[D11.1]");
  for (const id of ["pedidos_pagamentos", "entregas", "leads_consentimentos", "atendimento", "catalogo_conteudo", "reembolsos_avaliacoes", "estado_comercial_kv"]) {
    const c = INVENTORY.classes.find((x) => x.id === id);
    assert.ok(c && c.fonte_da_verdade && c.backup && "rpo_objetivo_h" in c && "rto_objetivo_h" in c, "[D11.2] " + id);
  }
  const dup = structuredClone(INVENTORY); dup.classes[1].tables.push("orders");
  assert.throws(() => validateInventory(dup), /duplicate orders/, "[D11.3]");
  const appr = structuredClone(INVENTORY); appr.status = "APPROVED";
  assert.throws(() => validateInventory(appr), /approval/, "[D11.4] aprovação exige aprovador e data");
  const prop = structuredClone(INVENTORY); prop.approved_by = "alguem";
  assert.throws(() => validateInventory(prop), /approval/, "[D11.5]");
  const cls = byClass([{ table: "orders", hash_ok: true, rows: 1 }, { table: "tabela_nova", hash_ok: true, rows: 0 }], ["orders", "tabela_nova"], INVENTORY, 3);
  assert.deepEqual(cls.unclassified, ["tabela_nova"], "[D11.6] tabela sem classe é listada, nunca escondida");
  assert.equal(cls.classes.pedidos_pagamentos.rpo_medido_h, 3);
});

test("D12 workflow mensal: producao-critica só no ensaio, publicação sem segredo, evidência só em evidence/b0-baseline, nunca gh-pages", () => {
  const wf = readTextNormalized(new URL("../.github/workflows/p20-monthly-restore-drill.yml", import.meta.url));
  assert.match(wf, /schedule:\n\s+- cron: '23 7 2 \* \*'/, "[D12.1] mensal");
  const [drillJob, publishJob] = wf.split(/\n  publish:\n/);
  assert.match(drillJob, /environment: producao-critica/, "[D12.2]");
  assert.match(drillJob, /--mode producao/);
  assert.doesNotMatch(drillJob, /contents: write/, "[D12.3]");
  assert.doesNotMatch(publishJob, /environment:|secrets\./, "[D12.4] publicação sem segredo nem Environment");
  assert.match(publishJob, /contents: write/);
  assert.match(wf, /EVIDENCE_BRANCH: evidence\/b0-baseline/, "[D12.5]");
  assert.doesNotMatch(wf, /HEAD:gh-pages|push[^\n]*gh-pages|wrangler|-X\s*(POST|PUT|DELETE)/, "[D12.6]");
  assert.equal((wf.match(/secrets\./g) || []).length, 1, "[D12.7] um único segredo (token do Cloudflare para GET no KV)");
  assert.doesNotMatch(wf, /pull_request/, "[D12.8]");
  const src = readTextNormalized(new URL("../scripts/p20/restore-drill.mjs", import.meta.url));
  assert.doesNotMatch(src, /method:\s*"(PUT|POST|DELETE|PATCH)"/, "[D12.9] leitor do KV só faz GET");
});
