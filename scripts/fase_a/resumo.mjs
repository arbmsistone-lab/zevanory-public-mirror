#!/usr/bin/env node
// ZEVANORY | P01 Fase A: resumo interno SOMENTE LEITURA das métricas da lista de espera, sem dado pessoal.
// Uso (operador, com a URL do banco no ambiente; nada é gravado):
//   DATABASE_URL=postgres://... node scripts/fase_a/resumo.mjs --janela <FASE_A_WINDOW_ID> --since AAAA-MM-DD --until AAAA-MM-DD [--violacao nicho,...]
//   DATABASE_URL=postgres://... node scripts/fase_a/resumo.mjs --janela <id> --anonimo   (células < 5 suprimidas)
//   DATABASE_URL=postgres://... node scripts/fase_a/resumo.mjs --semana-teste --since AAAA-MM-DD --until AAAA-MM-DD
// Executa as MESMAS consultas agregadas do Worker (SUMMARY_SQL e QUALIFIED_SQL em worker/waitlist.mjs)
// numa transação "read only" via psql (resolvido de forma portátil) e imprime, por nicho: navegadores
// navegadores/dispositivos pseudônimos confirmados, inscrições na mesma unidade, Wilson 95%, oráculo (reconciliação), análise
// de sensibilidade com/sem filtros de ASN/UA, bloqueios e a decisão da regra pré-registrada.
// Nenhuma coluna de contato, nome ou referência é lida.
import { execFileSync } from "node:child_process";
import { resolvePsql, parseCsv } from "./tools.mjs";
import { SUMMARY_SQL, QUALIFIED_SQL, SOURCE_SQL, CROSS_NICHE_SQL, TEST_WEEK_SQL, WAITLIST_NICHES, summarize, testWeekSummary, anonymousAggregate } from "../../worker/waitlist.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? String(args[i + 1] || "") : dflt; };
const windowId = opt("--janela", ""), since = opt("--since", "2026-01-01"), until = opt("--until", "2999-12-31");
const DATE = /^\d{4}-\d{2}-\d{2}$/;
if (!DATE.test(since) || !DATE.test(until) || (windowId && !/^[a-z0-9-]{1,32}$/.test(windowId))) { console.error("datas AAAA-MM-DD e janela [a-z0-9-]"); process.exit(2); }
const violations = Object.fromEntries(opt("--violacao", "").split(",").filter((n) => WAITLIST_NICHES.includes(n)).map((n) => [n, true]));
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL ausente"); process.exit(2); }
const psql = resolvePsql();
// Parâmetros validados acima (regex) e nichos constantes: literais seguros.
const lit = { 1: `'${windowId}'`, 2: `'${since}'`, 3: `'${until}'`, 4: `'{${WAITLIST_NICHES.join(",")}}'` };
const bind = (q) => q.replace(/\$(\d)/g, (_, n) => lit[n]);
const run = (sql) => execFileSync(psql, [url, "-X", "-q", "-v", "ON_ERROR_STOP=1", "--csv", "-c", "begin transaction read only", "-c", sql, "-c", "rollback"], { encoding: "utf8" });
const present = parseCsv(run("select (to_regclass('waitlist_signups') is not null and to_regclass('waitlist_persons') is not null and to_regclass('waitlist_raw_daily') is not null) as ok"))[0];
if (args.includes("--semana-teste")) {
  // Semana de teste (protocolo v3): $1/$2 = período; lê só contagens agregadas do funil.
  const tw = parseCsv(run(TEST_WEEK_SQL.replace("$1", `'${since}'`).replace("$2", `'${until}'`)));
  process.stdout.write(JSON.stringify(testWeekSummary(tw, { since, until }), null, 2) + "\n");
  process.exit(0);
}
let rows = [], qualified = [], sources = [], crossNiche = null;
if (present && present.ok === "t") { rows = parseCsv(run(bind(SUMMARY_SQL))); qualified = parseCsv(run(bind(QUALIFIED_SQL))); sources = parseCsv(run(bind(SOURCE_SQL))); crossNiche = parseCsv(run(bind(CROSS_NICHE_SQL)))[0] || null; }
else rows = WAITLIST_NICHES.map((niche) => ({ niche, raw: "{}" }));
const summary = summarize(rows, { windowId, since, until, qualified, sources, crossNiche, complianceViolations: violations });
// --anonimo: agregado com supressão de células pequenas (único formato que sobrevive ao fim da finalidade).
process.stdout.write(JSON.stringify(args.includes("--anonimo") ? anonymousAggregate(summary) : summary, null, 2) + "\n");
