#!/usr/bin/env node
// ZEVANORY | P01 Fase A: resumo interno SOMENTE LEITURA das métricas da lista de espera, sem dado pessoal.
// Uso (operador, com a URL do banco no ambiente; nada é gravado):
//   DATABASE_URL=postgres://... node scripts/fase_a/resumo.mjs --janela <FASE_A_WINDOW_ID> --since AAAA-MM-DD --until AAAA-MM-DD [--violacao nicho,...]
// Executa as MESMAS consultas agregadas do Worker (SUMMARY_SQL e QUALIFIED_SQL em worker/waitlist.mjs)
// numa transação "read only" via psql (resolvido de forma portátil) e imprime, por nicho: pessoas
// experimentais confirmadas, inscrições na mesma unidade, Wilson 95%, oráculo (reconciliação), análise
// de sensibilidade com/sem filtros de ASN/UA, bloqueios e a decisão da regra pré-registrada.
// Nenhuma coluna de contato, nome ou referência é lida.
import { execFileSync } from "node:child_process";
import { resolvePsql, parseCsv } from "./tools.mjs";
import { SUMMARY_SQL, QUALIFIED_SQL, WAITLIST_NICHES, summarize } from "../../worker/waitlist.mjs";

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
let rows = [], qualified = [];
if (present && present.ok === "t") { rows = parseCsv(run(bind(SUMMARY_SQL))); qualified = parseCsv(run(bind(QUALIFIED_SQL))); }
else rows = WAITLIST_NICHES.map((niche) => ({ niche, raw: "{}" }));
process.stdout.write(JSON.stringify(summarize(rows, { windowId, since, until, qualified, complianceViolations: violations }), null, 2) + "\n");
