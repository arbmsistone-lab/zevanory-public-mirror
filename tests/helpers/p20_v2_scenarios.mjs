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
const reports = [];
for (let part = 0; part < plan.parts; part++) {
  if (scenario === "esquema_alterado" && part === 1) await base.query("alter table z_conc add column coluna_nova text");
  if (scenario === "escrita_concorrente" && part === partOf("z_conc")) {
    afterStats = async () => { await base.query("insert into z_conc(txt) values ('linha concorrente ç \"aspas\" R$ 9,90')"); };
  }
  if ((scenario === "coluna_entre_validacao_e_exportacao" || scenario === "coluna_aba") && part === partOf("z_conc")) {
    info.part_alterada = part;
    if (scenario === "coluna_entre_validacao_e_exportacao") afterInventory = async () => { await base.query("alter table z_conc alter column txt type varchar(500)"); };
    else {
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
let final = await finalizeBackup(env, { parts: plan.parts, now, planId: plan.plan_id, runId });
if (scenario === "reenvio_plano_divergente") {
  // A execução válida já fechou o dia. Reenvios tardios da parte 1, ambos de OUTRA execução:
  //   (1) esquema mudou e a chamada traz o plano antigo (plan_id agora divergente);
  //   (2) plan_id forjado (64 hex que não é o do plano).
  // Nenhum dos dois pode gravar: o KV (relatórios e bundles) tem de continuar byte a byte igual.
  info.final_antes = { ok: final.ok, failures: final.failures };
  const antes = kvSnapshot();
  await base.query("alter table z_conc add column coluna_tardia text");
  const outra = randomBytes(16).toString("hex");
  const r1 = await runDataBackup(env, { sqlFactory: () => sql, now, part: 1, parts: plan.parts, planId: plan.plan_id, runId: outra });
  const r2 = await runDataBackup(env, { sqlFactory: () => sql, now, part: 1, parts: plan.parts, planId: "f".repeat(64), runId: outra });
  info.reenvio = { failures: [r1.failures, r2.failures], rejected: [Boolean(r1.rejected), Boolean(r2.rejected)] };
  info.kv_intacto = kvSnapshot() === antes;
  // A consolidação da execução válida continua aprovando (os relatórios dela não foram tocados).
  final = await finalizeBackup(env, { parts: plan.parts, now, planId: plan.plan_id, runId });
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
