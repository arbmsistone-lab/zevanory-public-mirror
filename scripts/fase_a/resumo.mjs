#!/usr/bin/env node
// ZEVANORY | P01 Fase A: resumo interno SOMENTE LEITURA das métricas da lista de espera, sem dado pessoal.
// Uso (o proprietário/operador, com a URL do banco no ambiente; nada é gravado):
//   DATABASE_URL=postgres://... node scripts/fase_a/resumo.mjs --since AAAA-MM-DD --until AAAA-MM-DD [--violacao nicho,...]
// Executa a MESMA consulta agregada do Worker (SUMMARY_SQL em worker/waitlist.mjs) dentro de uma
// transação "read only" via psql, e imprime JSON por nicho: visitantes elegíveis, inscrições,
// qualificadas, conversão, Wilson 95% e a decisão da regra pré-registrada (docs/p01/FASE_A_PROTOCOLO.md).
// Nenhuma coluna de contato, nome ou referência é lida.
import { execFileSync } from "node:child_process";
import { SUMMARY_SQL, WAITLIST_NICHES, summarize } from "../../worker/waitlist.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? String(args[i + 1] || "") : dflt; };
const since = opt("--since", "2026-01-01"), until = opt("--until", "2999-12-31");
const DATE = /^\d{4}-\d{2}-\d{2}$/;
if (!DATE.test(since) || !DATE.test(until)) { console.error("datas no formato AAAA-MM-DD"); process.exit(2); }
const violations = Object.fromEntries(opt("--violacao", "").split(",").filter((n) => WAITLIST_NICHES.includes(n)).map((n) => [n, true]));
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL ausente"); process.exit(2); }
// Parâmetros validados acima (datas por regex, nichos constantes): literais seguros.
const lit = { 1: `'${since}'`, 2: `'${until}'`, 3: `'{${WAITLIST_NICHES.join(",")}}'` };
const query = SUMMARY_SQL.replace(/\$(\d)/g, (_, n) => lit[n]);
const present = "select to_regclass('waitlist_signups') is not null and to_regclass('waitlist_visitors') is not null and to_regclass('waitlist_events') is not null";
const run = (sql) => execFileSync("psql", [url, "-X", "-q", "-v", "ON_ERROR_STOP=1", "--csv", "-c", "begin transaction read only", "-c", sql, "-c", "rollback"], { encoding: "utf8" });
const parse = (out) => { const lines = out.trim().split("\n").filter((l) => l && !/^(BEGIN|ROLLBACK)$/.test(l)); const [head, ...rows] = lines; const cols = head.split(","); return rows.map((r) => Object.fromEntries(r.split(",").map((v, i) => [cols[i], v]))); };
const exists = parse(run(present))[0];
const rows = exists && Object.values(exists)[0] === "t" ? parse(run(query)) : WAITLIST_NICHES.map((niche) => ({ niche, eligible_visitors: 0, signups: 0, qualified: 0, excluded_automation: 0, revoked: 0 }));
process.stdout.write(JSON.stringify(summarize(rows, { since, until, complianceViolations: violations }), null, 2) + "\n");
