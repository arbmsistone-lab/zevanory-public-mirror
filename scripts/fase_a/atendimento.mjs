#!/usr/bin/env node
// ZEVANORY | P01 Fase A (AVAL 101 §4): atendimento a pedido do titular pelo CÓDIGO OPACO de atendimento que a página
// /lista-de-espera/meus-dados mostra ao próprio navegador (HMAC do identificador interno; nunca o cookie bruto).
// Uso (operador, com a URL do banco no ambiente):
//   DATABASE_URL=... node scripts/fase_a/atendimento.mjs --janela <FASE_A_WINDOW_ID> --localizar <código>   (somente leitura)
//   DATABASE_URL=... node scripts/fase_a/atendimento.mjs --janela <FASE_A_WINDOW_ID> --apagar <código>      (apaga e registra)
// Saída: nichos e datas do registro (sem identificador) ou a quantidade apagada; a exclusão grava
// waitlist_deletion_log (escopo "pedido") e contadores agregados, na mesma instrução.
import { execFileSync } from "node:child_process";
import { resolvePsql, parseCsv } from "./tools.mjs";
import { LOOKUP_BY_TOKEN_SQL, ERASE_BY_TOKEN_SQL } from "../../worker/waitlist.mjs";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? String(args[i + 1] || "") : null; };
const windowId = opt("--janela") || "", find = opt("--localizar"), erase = opt("--apagar");
const token = find ?? erase;
if (!/^[a-z0-9-]{1,32}$/.test(windowId) || !/^[0-9a-f]{32}$/.test(String(token || "")) || (find && erase)) { console.error("uso: --janela <id> (--localizar|--apagar) <código hex de 32>"); process.exit(2); }
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL ausente"); process.exit(2); }
const psql = resolvePsql();
const today = new Date().toISOString().slice(0, 10);
// Parâmetros validados por regex acima: literais seguros.
const bind = (q, vals) => q.replace(/\$(\d)/g, (_, n) => `'${vals[Number(n) - 1]}'`);
if (find) {
  const out = execFileSync(psql, [url, "-X", "-q", "-v", "ON_ERROR_STOP=1", "--csv", "-c", "begin transaction read only", "-c", bind(LOOKUP_BY_TOKEN_SQL, [windowId, token]), "-c", "rollback"], { encoding: "utf8" });
  const rows = parseCsv(out).map((r) => ({ niche: r.niche, first_day: r.first_day, last_day: r.last_day, days: Number(r.days) }));
  process.stdout.write(JSON.stringify({ found: rows.length > 0, rows }, null, 2) + "\n");
} else {
  const out = execFileSync(psql, [url, "-X", "-q", "-v", "ON_ERROR_STOP=1", "--csv", "-c", bind(ERASE_BY_TOKEN_SQL, [windowId, token, today])], { encoding: "utf8" });
  process.stdout.write(JSON.stringify({ erased: Number(parseCsv(out)[0]?.erased) || 0 }, null, 2) + "\n");
}
