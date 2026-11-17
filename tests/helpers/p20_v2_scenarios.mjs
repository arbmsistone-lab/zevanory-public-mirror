// ZEVANORY | P20 v2: cenários do teste oficial de restauração integral (tests/test_p20_restauracao_integral.py), com o
// CÓDIGO REAL do Worker (worker/data-backup.mjs) contra um PostgreSQL descartável e KV em memória.
// Uso: PGHOST=... PGDATABASE=<origem> P20_BACKUP_KEY=<sintética> node tests/helpers/p20_v2_scenarios.mjs <cenário> <saida.json> <agora-iso>
// Cenários:
//   normal              plano -> todas as partes -> consolidação (o caminho de produção).
//   esquema_alterado    uma coluna é criada entre o plano e a parte 1: a parte tem de falhar (inventory_changed) sem gravar.
//   escrita_concorrente uma linha entra na tabela z_conc entre a estatística e a exportação da parte dela: a contagem do
//                       relatório tem de ser a do conteúdo copiado.
//   reenvio_plano_divergente  execução válida completa; depois o esquema muda e a parte 1 é reenviada com o plano
//                       antigo (e com um plan_id forjado): as duas chamadas são rejeitadas e o KV fica BYTE A BYTE igual.
//   coluna_entre_validacao_e_exportacao  na parte de z_conc, o tipo de uma coluna muda DEPOIS da validação do plano e
//                       ANTES da exportação: a parte é rejeitada sem gravar e o dia não fecha.
//   coluna_aba          na parte de z_conc, uma coluna é criada depois da validação e REMOVIDA depois da exportação (o
//                       inventário volta ao do plano): a conferência das colunas do conteúdo exportado rejeita a parte.
//   fk_entre_partes     depois que a parte de z_fk_a_pai foi copiada, entram um pai novo e um filho que aponta para ele (na
//                       parte de z_fk_b_filho): a restauração tem de reportar inconsistencia_entre_tabelas.
// Saída: o KV (só zpc:backup:v1:*) em <saida.json> e um resumo JSON (sem dados de linha) na última linha do stdout.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { psqlSql, memoryKv, syntheticKvSeed } from "./p20_worker_backup_fixture.mjs";
import { runDataBackup, finalizeBackup, planBackup, computePlan, assignParts, REPORT_KEY } from "../../worker/data-backup.mjs";

const [scenario, out, nowIso] = process.argv.slice(2);
const now = Date.parse(nowIso);
const base = psqlSql(process.env);
const kv = memoryKv(syntheticKvSeed(now));
const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "postgres://fixture-local-only", P20_BACKUP_KEY: process.env.P20_BACKUP_KEY };
if (!env.P20_BACKUP_KEY) { console.error("P20_BACKUP_KEY ausente"); process.exit(2); }

// sql do Worker com ganchos (cada um dispara UMA vez):
//   afterStats       depois da instrução de estatística da parte (escrita concorrente);
//   afterInventory   depois da leitura de inventário que VALIDA o plano na parte (esquema muda após a validação);
//   afterExport      depois da instrução de exportação (json_agg) da parte (desfaz a mudança antes da reconferência).
let afterStats = null, afterInventory = null, afterExport = null;
const once = async (h) => { const f = h; await f(); };
const sql = {
  async query(text, params) {
    const r = await base.query(text, params);
    const q = String(text);
    if (afterStats && /count\(\*\) as c from public\.%I/.test(q)) { const f = afterStats; afterStats = null; await once(f); }
    if (afterInventory && /information_schema\.tables t\s+where t\.table_schema = 'public'/.test(q)) { const f = afterInventory; afterInventory = null; await once(f); }
    if (afterExport && /json_agg\(x\)/.test(q)) { const f = afterExport; afterExport = null; await once(f); }
    return r;
  },
};
const runId = randomBytes(16).toString("hex");
const kvSnapshot = () => JSON.stringify([...kv.m.entries()].filter(([k]) => k.startsWith("zpc:backup:v1:")).sort());
const day = new Date(now).toISOString().slice(0, 10);
const plan = await planBackup(env, { sqlFactory: () => sql, now });
if (!plan.ok) { console.log(JSON.stringify({ scenario, plan })); process.exit(1); }
const full = await computePlan({ sql, env, day });
const assigned = assignParts(full.plan.eligible, full.plan.parts);
const partOf = (t) => assigned.findIndex((a) => a.includes(t));
const info = { scenario, parts: plan.parts, eligible: plan.eligible };

if (scenario === "fk_entre_partes" && !(partOf("z_fk_a_pai") >= 0 && partOf("z_fk_a_pai") < partOf("z_fk_b_filho"))) {
  // A prova exige o pai copiado ANTES do filho (partes diferentes). O teste acrescenta uma tabela de enchimento e repete.
  console.log(JSON.stringify({ scenario, fk_order_unsuitable: true, part_pai: partOf("z_fk_a_pai"), part_filho: partOf("z_fk_b_filho") }));
  process.exit(3);
}
// Corrida (contra-auditoria 17/11, terceira rodada): B é PAUSADA logo depois da sua verificação de posse do dia (a
// instrução atômica em zevanory_backup_day); A roda; B é retomada. O sql de B tem o próprio gancho de pausa.
const snapAll = () => new Map([...kv.m.entries()].filter(([k]) => k.startsWith("zpc:backup:v1:")));
const diffKeys = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).sort();
function pausedSql() {
  let release; const gate = new Promise((r) => (release = r)); let hit = false;
  const s = { async query(text, params) {
    const r = await sql.query(text, params);
    if (!hit && /insert into zevanory_backup_day/.test(String(text))) { hit = true; s.gateResult = (r || []).length === 1 ? "posse_obtida" : "posse_recusada"; await gate; }
    return r;
  } };
  s.release = release; s.wasHit = () => hit;
  return s;
}
const runA = async (rid) => {
  const rs = [];
  for (let part = 0; part < plan.parts; part++) rs.push(await runDataBackup(env, { sqlFactory: () => sql, now, part, parts: plan.parts, planId: plan.plan_id, runId: rid }));
  return { parts: rs, final: await finalizeBackup(env, { parts: plan.parts, now, planId: plan.plan_id, runId: rid, sqlFactory: () => sql }) };
};
if (scenario === "corrida_a_conclui_b_pausada" || scenario === "corrida_b_pausada_com_posse") {
  const runIdA = randomBytes(16).toString("hex"), runIdB = randomBytes(16).toString("hex");
  const bSql = pausedSql();
  const bPart = 1 % plan.parts;
  let bPromise, a0 = null;
  if (scenario === "corrida_a_conclui_b_pausada") {
    // A começa (parte 0 obtém a posse); B entra, passa pela verificação e PAUSA; A conclui o dia; B é retomada.
    a0 = await runDataBackup(env, { sqlFactory: () => sql, now, part: 0, parts: plan.parts, planId: plan.plan_id, runId: runIdA });
    bPromise = runDataBackup(env, { sqlFactory: () => bSql, now, part: bPart, parts: plan.parts, planId: plan.plan_id, runId: runIdB });
    while (!bSql.wasHit()) await new Promise((r) => setTimeout(r, 5));
    const rest = [];
    for (let part = 1; part < plan.parts; part++) rest.push(await runDataBackup(env, { sqlFactory: () => sql, now, part, parts: plan.parts, planId: plan.plan_id, runId: runIdA }));
    const finA = await finalizeBackup(env, { parts: plan.parts, now, planId: plan.plan_id, runId: runIdA, sqlFactory: () => sql });
    const depoisA = snapAll();
    bSql.release();
    const b = await bPromise;
    // B depois de retomada tenta também consolidar (a execução B inteira).
    const finB = await finalizeBackup(env, { parts: plan.parts, now, planId: plan.plan_id, runId: runIdB, sqlFactory: () => sql });
    const depoisB = snapAll();
    writeFileSync(out, JSON.stringify(Object.fromEntries(depoisB)));
    console.log(JSON.stringify({ scenario, parts: plan.parts, eligible: plan.eligible, ok: finA.ok, auth: finA.auth?.state ?? null, failures: finA.failures,
      a_parts_ok: [a0, ...rest].map((r) => r.ok), b_gate: bSql.gateResult, b_part: { ok: b.ok, failures: b.failures, rejected: Boolean(b.rejected) },
      b_finalize: { ok: finB.ok, failures: finB.failures }, kv_alteradas_por_b: diffKeys(depoisA, depoisB) }));
  } else {
    // B passa pela verificação PRIMEIRO (obtém a posse) e pausa; A tenta o dia inteiro; B é retomada e termina.
    bPromise = runDataBackup(env, { sqlFactory: () => bSql, now, part: bPart, parts: plan.parts, planId: plan.plan_id, runId: runIdB });
    while (!bSql.wasHit()) await new Promise((r) => setTimeout(r, 5));
    const antesA = snapAll();
    const a = await runA(runIdA);
    const depoisA = snapAll();
    bSql.release();
    const b = await bPromise;
    console.log(JSON.stringify({ scenario, parts: plan.parts, b_gate: bSql.gateResult,
      a_parts: a.parts.map((r) => ({ ok: r.ok, failures: r.failures })), a_final: { ok: a.final.ok, failures: a.final.failures },
      kv_alteradas_por_a: diffKeys(antesA, depoisA), b_part: { ok: b.ok, failures: b.failures } }));
  }
  process.exit(0);
}
// ---- quarta rodada (contra-auditoria 17/11 sobre c9847e12): recuperação da publicação, reserva e posse expirada ----
const dayRow = async () => {
  const r = (await base.query("select run_id, state, (report is not null) as tem_relatorio from zevanory_backup_day where day = $1::date", [day]))[0];
  return r ? { ...r, tem_relatorio: r.tem_relatorio === true || r.tem_relatorio === "t" } : null;
};
const aged = () => base.query("update zevanory_backup_day set updated_at = now() - interval '31 minutes' where day = $1::date", [day]);
const finishArchive = (extra) => { writeFileSync(out, JSON.stringify(Object.fromEntries(snapAll()))); console.log(JSON.stringify({ scenario, parts: plan.parts, eligible: plan.eligible, ...extra })); process.exit(0); };
if (scenario === "queda_entre_pg_e_kv") {
  // A conclui as partes; na consolidação, a execução MORRE depois de fechar o dia no PostgreSQL e antes de publicar no
  // KV (a gravação do relatório principal nunca retorna). O condutor é reiniciado: plano -> consolidação de verificação.
  const runIdA = randomBytes(16).toString("hex");
  const partsA = [];
  for (let part = 0; part < plan.parts; part++) partsA.push(await runDataBackup(env, { sqlFactory: () => sql, now, part, parts: plan.parts, planId: plan.plan_id, runId: runIdA }));
  const deadKv = { ...kv, m: kv.m, get: kv.get.bind(kv), list: kv.list.bind(kv), delete: kv.delete.bind(kv),
    put: (k, ...r) => (k === REPORT_KEY ? new Promise(() => {}) : kv.put(k, ...r)) };
  finalizeBackup({ ...env, ZEVANORY_PRIVATE_ARTIFACTS: deadKv }, { parts: plan.parts, now, planId: plan.plan_id, runId: runIdA, sqlFactory: () => sql });
  for (let i = 0; i < 2000 && (await dayRow())?.state !== "complete"; i++) await new Promise((r) => setTimeout(r, 5));
  const aposQueda = { linha: await dayRow(), relatorio_no_kv: kv.m.has(REPORT_KEY) };
  // Reinício (o que o condutor faz): o plano diz "dia concluído" e devolve plan_id/partes; a consolidação de verificação
  // de uma execução NOVA republica o relatório guardado no banco.
  const plan2 = await planBackup(env, { sqlFactory: () => sql, now });
  const fin2 = await finalizeBackup(env, { parts: plan2.parts, now, planId: plan2.plan_id, runId: randomBytes(16).toString("hex"), sqlFactory: () => sql });
  const fin3 = await finalizeBackup(env, { parts: plan2.parts, now, planId: plan2.plan_id, runId: randomBytes(16).toString("hex"), sqlFactory: () => sql });
  const rep = JSON.parse(kv.m.get(REPORT_KEY) || "null");
  finishArchive({ partes_a_ok: partsA.every((r) => r.ok), apos_queda: aposQueda, plano_reinicio: { day_complete: plan2.day_complete, plan_id_igual: plan2.plan_id === plan.plan_id, parts: plan2.parts },
    reinicio: { failures: fin2.failures, publicacao: fin2.publicacao, report_ok: fin2.report_ok }, segunda_verificacao: fin3.publicacao,
    ok: rep ? rep.ok : null, auth: rep?.auth?.state ?? null });
}
if (scenario === "chamada_rejeitada_nao_reserva") {
  // Uma chamada autenticada com plano inválido (forjado) chega PRIMEIRO; depois a execução legítima roda o dia inteiro.
  const r0 = await runDataBackup(env, { sqlFactory: () => sql, now, part: 0, parts: plan.parts, planId: "e".repeat(64), runId: randomBytes(16).toString("hex") });
  const r1 = await runDataBackup(env, { sqlFactory: () => sql, now, part: plan.parts, parts: plan.parts + 1, planId: plan.plan_id, runId: randomBytes(16).toString("hex") });
  const linhaDepois = await dayRow();
  const runIdA = randomBytes(16).toString("hex");
  const partsA = [];
  for (let part = 0; part < plan.parts; part++) partsA.push(await runDataBackup(env, { sqlFactory: () => sql, now, part, parts: plan.parts, planId: plan.plan_id, runId: runIdA }));
  const fin = await finalizeBackup(env, { parts: plan.parts, now, planId: plan.plan_id, runId: runIdA, sqlFactory: () => sql });
  finishArchive({ rejeitadas: [r0.failures, r1.failures], linha_depois_das_rejeitadas: linhaDepois, partes_ok: partsA.every((r) => r.ok), ok: fin.ok, auth: fin.auth?.state ?? null, failures: fin.failures });
}
if (scenario === "posse_expirada_execucao_antiga") {
  // A (antiga) faz a parte 0 e começa a parte 1: obtém a posse e PAUSA. A posse expira (31 min sem renovar). B (nova)
  // assume, roda o dia inteiro e conclui. A é retomada (resto da parte 1, depois parte 2 e consolidação): nenhuma
  // gravação de A pode alterar os arquivos de B.
  const runIdA = randomBytes(16).toString("hex"), runIdB = randomBytes(16).toString("hex");
  const a0 = await runDataBackup(env, { sqlFactory: () => sql, now, part: 0, parts: plan.parts, planId: plan.plan_id, runId: runIdA });
  const aSql = pausedSql();
  const aP = runDataBackup(env, { sqlFactory: () => aSql, now, part: 1, parts: plan.parts, planId: plan.plan_id, runId: runIdA });
  while (!aSql.wasHit()) await new Promise((r) => setTimeout(r, 5));
  await aged();
  const b = await runA(runIdB);
  const depoisB = snapAll();
  const linhaB = await dayRow();
  aSql.release();
  const a1 = await aP;
  const aRest = [];
  for (let part = 2; part < plan.parts; part++) aRest.push(await runDataBackup(env, { sqlFactory: () => sql, now, part, parts: plan.parts, planId: plan.plan_id, runId: runIdA }));
  const aFin = await finalizeBackup(env, { parts: plan.parts, now, planId: plan.plan_id, runId: runIdA, sqlFactory: () => sql });
  finishArchive({ a0_ok: a0.ok, a_gate: aSql.gateResult, b_partes_ok: b.parts.map((r) => r.ok), ok: b.final.ok, auth: b.final.auth?.state ?? null, failures: b.final.failures,
    dono_apos_b: linhaB ? { igual_b: linhaB.run_id === runIdB, state: linhaB.state } : null,
    a_retomada: { parte1: a1.failures, resto: aRest.map((r) => r.failures), finalize: aFin.failures },
    kv_alteradas_por_a: diffKeys(depoisB, snapAll()) });
}
const reports = [];
for (let part = 0; part < plan.parts; part++) {
  if (scenario === "esquema_alterado" && part === 1) await base.query("alter table z_conc add column coluna_nova text");
  if (scenario === "escrita_concorrente" && part === partOf("z_conc")) {
    afterStats = async () => { await base.query("insert into z_conc(txt) values ('linha concorrente ç \"aspas\" R$ 9,90')"); };
  }
  if (["coluna_entre_validacao_e_exportacao", "coluna_aba", "tipo_aba"].includes(scenario) && part === partOf("z_conc")) {
    info.part_alterada = part;
    if (scenario === "coluna_entre_validacao_e_exportacao") afterInventory = async () => { await base.query("alter table z_conc alter column txt type varchar(500)"); };
    else if (scenario === "tipo_aba") {
      // O tipo muda depois da validação e VOLTA depois da exportação: nomes iguais, inventário relido igual ao do plano.
      afterInventory = async () => { await base.query("alter table z_conc alter column txt type varchar(500)"); };
      afterExport = async () => { await base.query("alter table z_conc alter column txt type text"); };
    } else {
      afterInventory = async () => { await base.query("alter table z_conc add column coluna_aba text default 'aba'"); };
      afterExport = async () => { await base.query("alter table z_conc drop column coluna_aba"); };
    }
  }
  if (scenario === "fk_entre_partes" && part === partOf("z_fk_b_filho")) {
    info.fk = { part_pai: partOf("z_fk_a_pai"), part_filho: partOf("z_fk_b_filho") };
    await base.query("insert into z_fk_a_pai(id) values (900001); insert into z_fk_b_filho(id, pai_id) values (900001, 900001)");
  }
  reports.push(await runDataBackup(env, { sqlFactory: () => sql, now, part, parts: plan.parts, planId: plan.plan_id, runId }));
}
if (scenario === "reenvio_plano_divergente") {
  // Todas as partes da execução A passaram; ANTES da consolidação, reenvios tardios da parte 1 de OUTRA execução:
  //   (1) esquema mudou e a chamada traz o plano antigo (plan_id agora divergente);
  //   (2) plan_id forjado (64 hex que não é o do plano).
  // Nenhum dos dois pode gravar: o KV (relatórios das partes e bundles) tem de continuar byte a byte igual.
  info.partes_a_ok = reports.every((r) => r.ok);
  const antes = kvSnapshot();
  await base.query("alter table z_conc add column coluna_tardia text");
  const outra = randomBytes(16).toString("hex");
  const r1 = await runDataBackup(env, { sqlFactory: () => sql, now, part: 1, parts: plan.parts, planId: plan.plan_id, runId: outra });
  const r2 = await runDataBackup(env, { sqlFactory: () => sql, now, part: 1, parts: plan.parts, planId: "f".repeat(64), runId: outra });
  info.reenvio = { failures: [r1.failures, r2.failures], rejected: [Boolean(r1.rejected), Boolean(r2.rejected)] };
  info.kv_intacto = kvSnapshot() === antes;
}
// A consolidação da execução A (no reenvio, aprova porque os relatórios dela não foram tocados).
let final = await finalizeBackup(env, { parts: plan.parts, now, planId: plan.plan_id, runId, sqlFactory: () => sql });
if (scenario === "dia_concluido_b_falha") {
  // A concluiu e aprovou o dia. Uma execução B no MESMO dia (plano, partes, consolidação; e chamadas legadas v1) tem de
  // ser rejeitada sem gravar: relatório principal, relatórios das partes, bundles e cópia do KV byte a byte iguais.
  info.final_a = { ok: final.ok, auth: final.auth?.state ?? null };
  const antes = kvSnapshot();
  const runB = randomBytes(16).toString("hex");
  const planB = await planBackup(env, { sqlFactory: () => sql, now });
  const partsB = [];
  for (let part = 0; part < plan.parts; part++) partsB.push(await runDataBackup(env, { sqlFactory: () => sql, now, part, parts: plan.parts, planId: plan.plan_id, runId: runB }));
  const finB = await finalizeBackup(env, { parts: plan.parts, now, planId: plan.plan_id, runId: runB, sqlFactory: () => sql });
  // A PRÓPRIA execução A reenviando uma parte e a consolidação depois de concluir (repetição do condutor): também recusadas.
  const aAgain = await runDataBackup(env, { sqlFactory: () => sql, now, part: 0, parts: plan.parts, planId: plan.plan_id, runId });
  const aFinAgain = await finalizeBackup(env, { parts: plan.parts, now, planId: plan.plan_id, runId, sqlFactory: () => sql });
  info.b = {
    plan: planB.failures, parts: partsB.map((r) => r.failures), finalize: finB.failures, a_de_novo: [aAgain.failures, aFinAgain.failures],
    ok: [planB.ok, ...partsB.map((r) => r.ok), finB.ok, aAgain.ok, aFinAgain.ok],
  };
  info.kv_intacto = kvSnapshot() === antes;
}
if (scenario === "reuso_esquema_mudou") {
  // Dia D aprovado. Muda o TIPO de z_conc sem mudar o conteúdo em JSON (text -> varchar): a impressão digital do
  // conteúdo é a mesma. No dia D+1, o conteúdo antigo NÃO pode ser reaproveitado (foi exportado sob outro esquema).
  info.final_d = { ok: final.ok };
  await base.query("alter table z_conc alter column txt type varchar(500)");
  const now2 = now + 86400000;
  const plan2 = await planBackup(env, { sqlFactory: () => sql, now: now2 });
  const run2 = randomBytes(16).toString("hex");
  const k = partOf("z_conc");
  const r2 = [];
  for (let part = 0; part < plan2.parts; part++) r2.push(await runDataBackup(env, { sqlFactory: () => sql, now: now2, part, parts: plan2.parts, planId: plan2.plan_id, runId: run2 }));
  const fin2 = await finalizeBackup(env, { parts: plan2.parts, now: now2, planId: plan2.plan_id, runId: run2, sqlFactory: () => sql });
  info.d1 = { ok: fin2.ok, failures: fin2.failures, part_z_conc: k, transfer: r2[k].transfer, tables_in_part: Object.keys(r2[k].tables || {}).length,
    outras_partes_reaproveitadas: r2.filter((_, i) => i !== k).every((r) => r.transfer && r.transfer.dumped === 0) };
}
writeFileSync(out, JSON.stringify(Object.fromEntries([...kv.m.entries()].filter(([k]) => k.startsWith("zpc:backup:v1:")))));
const conc = reports.flatMap((r) => Object.entries(r.tables || {})).find(([t]) => t === "z_conc");
console.log(JSON.stringify({
  ...info, ok: final.ok, auth: final.auth?.state ?? null, failures: final.failures,
  part_failures: reports.map((r) => r.failures), part_wrote_bundle: reports.map((r) => Boolean(r.bundle)),
  part_rejected: reports.map((r) => Boolean(r.rejected)),
  part_report_in_kv: reports.map((r, i) => kv.m.has(REPORT_KEY + ":part:" + i)),
  z_conc_rows_reported: conc ? conc[1].rows : null,
}));
