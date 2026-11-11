#!/usr/bin/env node
// Mutantes do relatório diário real + Diagnosticador v1 (CANAL_PARADO) + índice real de autonomia + hotmart_view
// separado no aviso público (Plano Mestre v1.2, seções 2, 4, 6 e 9). Cada mutante troca uma âncora exata (1 ocorrência,
// EOL normalizado) numa CÓPIA descartável da árvore, roda tests/diagnostico-diario.test.mjs (TAP) e só conta KILLED se:
// rc != 0, contagem igual à linha de base, falha de ASSERÇÃO e o teste esperado (rótulo declarado ANTES de rodar) está
// entre os "not ok". Qualquer outra coisa é SURVIVED/INCONCLUSIVE e o runner sai 1. Offline, sem segredos, sem rede.
// Uso: node scripts/ci/mutants_diagnostico_diario.mjs
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SUITE = "tests/diagnostico-diario.test.mjs";
const BASE_COUNT = 10;
const COPY = ["worker", "data", "scripts/audit", "scripts/channels", "tests/helpers", SUITE];
const DG = "worker/diagnostico-diario.mjs", RL = "worker/relatorio-diario.mjs", FN = "worker/funnel.mjs", SN = "scripts/audit/command-center-snapshot.mjs", AQ = "worker/acquisition-engine.mjs";
const TR = "trigger:", LD = "relatório: funil e vendas rotulados", CP2 = "worker/cloudflare-worker.compat.mjs", TG = "Telegram desligado", R = "regras versionadas", CP = "CANAL_PARADO", AU = "autonomia real", HV = "vendas Hotmart", REL = "relatório das 20h", FU = "funil:", AV = "aviso público";
// [id, rótulo do teste esperado, [[arquivo, de, para], ...]]
const MUTANTS = [
  ["DD01_hora_limite_ignorada", R, [[DG, "  if (!(Number(hour) >= Number(c.hora_limite))) return 0;\n", ""]]],
  ["DD02_dias_da_semana_ignorados", R, [[DG, "  if (!(Array.isArray(c.dias_semana) && c.dias_semana.includes(weekdayOf(day)))) return 0;\n", ""]]],
  ["DD03_canal_desligado_vira_ativo", R, [[DG, '{ ativo: false, desligado: true, motivo: c.motivo_desligado || "desligado" }', "{ ativo: true, motivo: null }"]]],
  ["DD04_credencial_nao_exigida", R, [[DG, "out[canal] = row?.configured === true ?", "out[canal] = true ?"]]],
  ["DD05_canal_parado_nunca_diagnostica", CP, [[DG, "    if (publicadas >= esperadas) continue;\n", "    continue;\n"]]],
  ["DD06_motivo_do_gate_do_blog_ignorado", CP, [[DG, 'if (blogStatus?.resultado === "rejeitado") return', "if (false) return"]]],
  ["DD07_regra_desligada_ainda_diagnostica", CP, [[DG, 'r.id === "CANAL_PARADO" && r.ativa === true', 'r.id === "CANAL_PARADO"']]],
  ["DD08_canal_inativo_diagnosticado", CP, [[DG, "    if (ativos[canal]?.ativo !== true) continue;\n    const esperadas", "    const esperadas"]]],
  ["DD09_classe_D_ignorada", R, [[DG, '? "D" : "B";', '? "B" : "B";']]],
  ["DD10_falha_de_leitura_vira_sem_registro", CP, [[DG, 'const fonte = !estado.ok ? "falha_leitura" :', 'const fonte = !estado.ok ? "sem_registro" :']]],
  ["DD11_autonomia_sem_fonte_medida", AU, [[DG, "if (!fonteOk || d === 0) return {", "if (d === 0) return {"]]],
  ["DD12_trigger_ausente_conta_como_autonomo", TR, [[DG, "row?.trigger === TRIGGER_AUTONOMO && ", 'row?.trigger !== "manual" && ']]],
  ["DD13_concluidas_sem_limite", AU, [[DG, "c = Math.min(d, Math.max(0, Number(concluidas) || 0));", "c = Math.max(0, Number(concluidas) || 0);"]]],
  ["DD14_janela_conta_dia_sem_registro", AU, [[DG, "if (!entries || !Object.keys(entries).length) continue;", "if (!entries) continue;"]]],
  ["DD15_aguardando_credencial_devido", AU, [[DG, '(!e || AGUARDANDO.test(String(e.status || "")))', "!e"]]],
  ["DD16_schema_do_ledger_ignorado", HV, [[RL, 'if (!s || s.schema !== "zevanory-sales/v1") return', "if (!s) return"]]],
  ["DD17_pendente_vira_comprovado", HV, [[RL, 'if (s.integrity === "reconciled" && s.reconciledDays?.includes?.(day)) return', "if (true) return"]]],
  ["DD18_inconclusivo_vira_nao_testado", HV, [[RL, 'if (!leitura?.ok) return { estado: "INCONCLUSIVO"', 'if (false) return { estado: "INCONCLUSIVO"']]],
  ["DD19_relatorio_volta_a_sem_dados", REL, [[RL, "`• Vendas aprovadas Hotmart: ${vendas.texto}`", '"• Vendas aprovadas Hotmart: sem dados"']]],
  ["DD20_falhas_omitidas", REL, [[RL, '/^(erro|pending)$/.test(String(s.status || ""))', "false"]]],
  ["DD21_decisoes_D_omitidas", REL, [[RL, '.filter(([, a]) => !a.ativo && /^aguardando/.test(String(a.motivo || "")))', ".filter(() => false)"]]],
  ["DD22_recibo_sem_diagnosticos", REL, [[AQ, "diagnosticos:report.diagnosticos,", "diagnosticos:[],"]]],
  ["DD23_funil_mistura_hotmart_view", FU, [[FN, 'else if (m === "hotmart_view") b.hotmart_view += n;', 'else if (m === "hotmart_view") b.views_br += n;']]],
  ["DD24_funil_ignora_views_br", FU, [[FN, "if (brClasses.includes(m)) b.views_br += n;", "if (false) b.views_br += n;"]]],
  ["DD25_aviso_mistura_hotmart_na_serie_antiga", AV, [[SN, "b.legacyMixedClicks = (b.legacyMixedClicks || 0) + (v?.checkout_intent || 0) + (v?.subscribe_click || 0);", "b.legacyMixedClicks = (b.legacyMixedClicks || 0) + (v?.checkout_intent || 0) + (v?.hotmart_view || 0) + (v?.subscribe_click || 0);"]]],
  ["DD26_linha_hotmart_view_removida", AV, [[SN, 'console.log("::notice title=HOTMART_VIEW::"', 'void ("::notice title=HOTMART_VIEW::"']]],
  // Telegram desligado por decisão do proprietário (F0 nº 7; auditoria do #1019, NC-5).
  ["DD28_desligada_volta_a_ser_devida", TG, [[DG, 'if (!c || c.ativacao === "desligada") return 0;', "if (!c) return 0;"]]],
  ["DD29_desligado_sem_decisao_do_proprietario", TG, [[RL, '? "decisão do proprietário" : a.motivo', "? a.motivo : a.motivo"]]],
  ["DD30_desligado_exibido_como_inativo", TG, [[RL, "const linha = desligado ? desligado :", "const linha = false ? desligado :"]]],
  ["DD31_credencial_religa_canal_desligado", TG, [[DG, 'else if (c.ativacao === "desligada") out[canal] =', 'else if (c.ativacao === "desligada" && false) out[canal] =']]],
  // Auditoria do #1021: trigger cron/manual, custo não medido, dia local, amostras de revisão do blog.
  ["DD32_workflow_dispatch_e_externo_contam", TR, [[DG, "row?.trigger === TRIGGER_AUTONOMO && ", '[TRIGGER_AUTONOMO, "workflow_dispatch", "externo"].includes(row?.trigger) && ']]],
  // NC-F1-A4-01 (contra-auditoria GPT-6): origem só do recibo/outcome do canal, nunca herdada do estado da execução.
  ["DD33_herda_trigger_do_estado", TR, [[DG, "trigger: row0.trigger ?? resumo?.trigger ?? null", "trigger: row0.trigger ?? resumo?.trigger ?? estado.v?.trigger ?? null"]]],
  ["DD43_outcome_do_canal_ignorado", TR, [[DG, "trigger: row0.trigger ?? resumo?.trigger ?? null", "trigger: row0.trigger ?? null"]]],
  ["DD44_snapshot_herda_trigger_do_estado", TR, [[SN, "e.trigger = o?.trigger || null;", "e.trigger = o?.trigger || st?.trigger || null;"]]],
  // NC-F1-A4-02: rótulo UTC obrigatório, mesmo com as datas coincidindo.
  ["DD45_rotulo_utc_removido", REL, [[RL, "`FUNIL E VENDAS (dia UTC ${day}; intervalo diferente do dia America/Sao_Paulo", "`FUNIL E VENDAS (dia ${day}, America/Sao_Paulo"]]],
  ["DD34_motor_assume_cron_por_padrao", TR, [[AQ, 'trigger=ENGINE_TRIGGERS.includes(triggerOpt)?triggerOpt:"manual";', 'trigger=ENGINE_TRIGGERS.includes(triggerOpt)?triggerOpt:"cron";']]],
  ["DD35_motor_nao_preserva_primeiro_trigger", TR, [[AQ, 'trigger:o.status==="publicado"&&priorTrigger[o.channel]?priorTrigger[o.channel]:trigger', "trigger"]]],
  ["DD36_cron_do_worker_sem_trigger", TR, [[CP2, 'runAcquisitionEngine(normalized,new Date(),undefined,{trigger:"cron"})', 'runAcquisitionEngine(normalized,new Date(),undefined,{trigger:"manual"})']]],
  ["DD37_snapshot_perde_trigger", TR, [[SN, "e.trigger = o?.trigger || null;", "e.trigger = null;"]]],
  ["DD38_custo_volta_a_zero_fixo", LD, [[RL, '"Custo do dia: não medido (sem fonte de custo)",', '"Custo do dia: R$ 0,00 (sem fonte de custo)",']]],
  ["DD39_funil_pelo_dia_utc", LD, [[RL, "funilDoDia(await readJson(kv, FUNNEL_SUMMARY_KEY), day,", "funilDoDia(await readJson(kv, FUNNEL_SUMMARY_KEY), now.toISOString().slice(0, 10),"]]],
  ["DD40_vendas_pelo_dia_utc", LD, [[RL, "estadoVendasHotmart(await readJson(kv, SALES_SUMMARY_KEY), day)", "estadoVendasHotmart(await readJson(kv, SALES_SUMMARY_KEY), now.toISOString().slice(0, 10))"]]],
  ["DD41_amostras_nao_listadas", LD, [[RL, 'if (st?.resultado === "ok" && st.amostra_revisao === true) amostras.push', "if (false) amostras.push"]]],
  ["DD42_amostras_sem_filtro", LD, [[RL, '&& st.amostra_revisao === true) amostras.push', ") amostras.push"]]],
  ["DD27_autonomia_falsa_100", AV, [[SN, 'pct: autonomiaReal.valor ?? "não medido"', "pct: autonomiaReal.valor ?? 100"]]],
];

const eol = (s) => s.replace(/\r\n/g, "\n");
function stage() {
  const d = mkdtempSync(join(tmpdir(), "zev-blog-mut-"));
  for (const rel of COPY) { mkdirSync(dirname(join(d, rel)), { recursive: true }); cpSync(join(ROOT, rel), join(d, rel), { recursive: true }); }
  return d;
}
function run(d) {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-reporter-destination=stdout", SUITE], { cwd: d, encoding: "utf8", timeout: 240000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  const out = eol(String(r.stdout || ""));
  const tests = Number((out.match(/^# tests (\d+)$/m) || [])[1] ?? -1);
  const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  return { rc: r.status, out, tests, failed };
}

let d = stage();
const base = run(d);
rmSync(d, { recursive: true, force: true });
if (base.rc !== 0 || base.tests !== BASE_COUNT || base.failed.length) { console.log(`BASELINE FAIL rc=${base.rc} tests=${base.tests}`); console.log(base.out.slice(-3000)); process.exit(2); }
console.log(`BASELINE PASS tests=${BASE_COUNT}`);
const bad = [];
for (const [id, label, edits] of MUTANTS) {
  d = stage();
  let verdict = "", why = "";
  for (const [file, from, to] of edits) {
    const f = join(d, file), text = eol(readFileSync(f, "utf8"));
    const n = text.split(from).length - 1;
    if (n !== 1) { verdict = "INCONCLUSIVE"; why = `${file} anchor_count=${n}`; break; }
    writeFileSync(f, text.replace(from, to));
  }
  if (!verdict) {
    const r = run(d);
    const hit = r.failed.some((t) => t.startsWith(label));
    if (r.rc === 0) { verdict = "SURVIVED"; why = "suite passed"; }
    else if (r.tests !== BASE_COUNT) { verdict = "INCONCLUSIVE"; why = `tests=${r.tests}`; }
    else if (!/AssertionError|ERR_ASSERTION/.test(r.out)) { verdict = "INCONCLUSIVE"; why = "non-assertion failure"; }
    else if (!hit) { verdict = "INCONCLUSIVE"; why = "expected test not failed: " + label + " | failed=" + JSON.stringify(r.failed); }
    else { verdict = "KILLED"; why = "by=" + JSON.stringify(r.failed); }
  }
  rmSync(d, { recursive: true, force: true });
  if (verdict !== "KILLED") bad.push(id);
  console.log(`MUTANT ${id} ${verdict} ${why}`);
}
const killed = MUTANTS.length - bad.length;
console.log(bad.length ? `MUTANTS FAIL killed=${killed}/${MUTANTS.length} not_killed=${bad.join(",")}` : `MUTANTS PASS killed=${killed}/${MUTANTS.length}`);
process.exit(bad.length ? 1 : 0);
