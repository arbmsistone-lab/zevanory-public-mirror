// ZEVANORY | P20 diário D1 (docs/p20/diario-d1.md, seção "Ensaio mensal lê o diário"): reconstrução, no Postgres
// efêmero do ensaio, dos eventos críticos posteriores à cópia restaurada (Roteiro Mestre v4.7, seção 9.1: "a
// restauração precisa reconstruir os eventos posteriores à última cópia íntegra").
//
// Entrada: a leitura do diário (scripts/p20/diario-d1-read.mjs: cabeça + todas as linhas, somente SELECT) e o banco
// p20_drill* já restaurado e conferido. Prova, nesta ordem (qualquer falha = "nao_provado", nunca "provado"):
//  1. cadeia: verifyChain de TODAS as linhas, da genesis até a cabeça lida (worker/diario-p20.mjs);
//  2. reaplicação mínima: as linhas com ts_ms > corte − margem (corte = início mais antigo das partes da cópia) são
//     gravadas na tabela p20_diario_reconstruido do banco efêmero e relidas; a releitura tem de ser idêntica, coluna a
//     coluna, às linhas do diário;
//  3. conjunto: na janela [corte − 48 h, leitura do diário], restaurado ∪ reconstruído = diário. "Restaurado" são as
//     event_key que o banco restaurado gera pelas MESMAS consultas e construtores da reconciliação diária
//     (worker/diario-reconcilia.mjs: NEON_FONTES + construtores dos ganchos). Falta = evento do diário sem origem na
//     cópia nem na reconstrução; sobra = evento da cópia que o diário não tem.
// rpo_critico_medido_s = falha simulada (início do ensaio) − instante da leitura do diário, só com a prova completa.
// Nada aqui imprime dado de linha: o registro leva contagens, booleanos, seq e até 10 event_key (ids técnicos e HMAC).
import { spawnSync } from "node:child_process";
import { verifyChain } from "../../worker/diario-p20.mjs";
import { esperadosDoNeon, compara, JANELA_INICIO_MS, MARGEM_MS, DIARIO_FASE } from "../../worker/diario-reconcilia.mjs";
import { SCHEMA_LEITURA } from "./diario-d1-read.mjs";
import { diarioNaoLido } from "./restore-drill-lib.mjs";

export const TABELA_RECONSTRUCAO = "p20_diario_reconstruido";
export const COLUNAS = Object.freeze(["seq", "event_key", "tipo", "ts_ms", "ref", "payload_json", "payload_sha", "prev_hash", "chain_hash"]);
export const AMOSTRA = 10;
export { DIARIO_FASE };
const clean = (s) => String(s || "").replace(/[^A-Za-z0-9_.:,= -]/g, "").slice(0, 160);
const isIso = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));

export function lerArquivoLeitura(text) {
  let o;
  try { o = JSON.parse(String(text)); } catch { return { estado: "erro", motivo: "leitura_ilegivel", rows: [] }; }
  if (!o || o.schema !== SCHEMA_LEITURA || !Array.isArray(o.rows)) return { estado: "erro", motivo: "leitura_malformada", rows: [] };
  return o;
}

// ---------------------------------------------------------------------------------------------------------
// Postgres efêmero (o mesmo alvo da restauração, já conferido por assertEphemeralTarget): psql com parâmetros como
// literais e o resultado agregado num único JSON pelo próprio banco.
const lit = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (Array.isArray(v)) return "ARRAY[" + v.map(lit).join(",") + "]::text[]";
  if (typeof v === "number") { if (!Number.isFinite(v)) throw new Error("param_invalido"); return String(v); }
  return "'" + String(v).replace(/'/g, "''") + "'";
};
function psql(env, sqlText) {
  const r = spawnSync("psql", ["-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-f", "-"], { input: sqlText + ";\n", env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error("psql_failed " + String(r.stderr || "").replace(/ERROR:\s*/g, "").slice(0, 200));
  return String(r.stdout || "");
}
export function psqlJson(env) {
  return {
    async query(text, params = []) {
      const sqlText = "select coalesce(json_agg(q), '[]'::json) from (" + String(text).replace(/\$(\d+)(?![0-9])/g, (_, n) => lit(params[Number(n) - 1])) + ") q";
      return JSON.parse(psql(env, sqlText).trim() || "[]");
    },
  };
}
// Reaplicação mínima: cria a tabela de reconstrução, grava as linhas e devolve a releitura ordenada por seq.
export function reconstruirNoPostgres(env) {
  return async (rows) => {
    const tag = "p20d" + Math.random().toString(36).slice(2, 10);
    const json = JSON.stringify(rows.map((r) => Object.fromEntries(COLUNAS.map((c) => [c, r[c] ?? null]))));
    if (json.includes("$" + tag + "$")) throw new Error("tag_colide");
    psql(env, `drop table if exists ${TABELA_RECONSTRUCAO};
      create table ${TABELA_RECONSTRUCAO} (seq bigint primary key, event_key text not null unique, tipo text not null, ts_ms bigint not null, ref text,
        payload_json text not null, payload_sha text not null, prev_hash text not null, chain_hash text not null unique);
      insert into ${TABELA_RECONSTRUCAO} select * from json_populate_recordset(null::${TABELA_RECONSTRUCAO}, $${tag}$${json}$${tag}$::json)`);
    return psqlJson(env).query(`select ${COLUNAS.join(", ")} from ${TABELA_RECONSTRUCAO} order by seq`);
  };
}

const igual = (a, b) => COLUNAS.every((c) => (c === "seq" || c === "ts_ms" ? Number(a?.[c]) === Number(b?.[c]) : (a?.[c] ?? null) === (b?.[c] ?? null)));

// ---------------------------------------------------------------------------------------------------------
// -> resumo do diário para o registro do ensaio. estado: "provado" | "nao_provado" | "nao_lido".
export async function provarDiario({ leitura, corteIso, falhaIso, restoreOk, restauradoSql, reconstruir, fase = DIARIO_FASE }) {
  const base = { fase, tabela: TABELA_RECONSTRUCAO, rpo_critico_medido_s: null };
  const naoLido = diarioNaoLido(leitura, fase);
  if (naoLido) return naoLido;
  const nao = (motivo, extra = {}) => ({ ...base, estado: "nao_provado", motivo, ...extra });
  const rows = leitura.rows;
  const head = leitura.head;
  if (!isIso(leitura.lido_em) || !head || !Number.isSafeInteger(Number(head.seq))) return nao("leitura_malformada");
  const comum = { lido_em: leitura.lido_em, head_seq: Number(head.seq), linhas: rows.length };
  const cadeia = await verifyChain(rows, { head });
  if (cadeia.ok !== true) return nao("cadeia_quebrada", { ...comum, cadeia_ok: false, cadeia: { broken_at: cadeia.broken_at ?? null, reason: cadeia.reason ?? null } });
  if (!restoreOk) return nao("restauracao_nao_aprovada", { ...comum, cadeia_ok: true });
  if (!isIso(corteIso) || !isIso(falhaIso)) return nao("corte_indefinido", { ...comum, cadeia_ok: true });
  const corte = Date.parse(corteIso), lido = Date.parse(leitura.lido_em), falha = Date.parse(falhaIso);
  // 2. reaplicação mínima
  const cauda = rows.filter((r) => Number(r.ts_ms) > corte - MARGEM_MS);
  let relidas;
  try { relidas = await reconstruir(cauda); } catch (e) { return nao("reconstrucao_falhou:" + clean(e?.message).slice(0, 60), { ...comum, cadeia_ok: true }); }
  const reconstrucaoOk = Array.isArray(relidas) && relidas.length === cauda.length && cauda.every((r, i) => igual(r, relidas[i]));
  // 3. conjunto: restaurado ∪ reconstruído = diário, na janela [corte − 48 h, leitura]
  const de = corte - JANELA_INICIO_MS;
  let restaurado;
  try { restaurado = await esperadosDoNeon(restauradoSql, de - MARGEM_MS, corte + MARGEM_MS); } catch (e) { return nao("restaurado_ilegivel", { ...comum, cadeia_ok: true }); }
  const fontesErro = Object.entries(restaurado.fontes).filter(([, v]) => v === "erro").map(([k]) => k);
  const c = compara(restaurado.esperados, rows, { de, ate: corte });
  const reconstruidas = new Set((relidas || []).map((r) => r.event_key));
  const sobrando = c.sobrando.filter((k) => !reconstruidas.has(k)); // diário até o corte sem origem na cópia nem na reconstrução
  const faltando = c.faltando; // cópia com evento que o diário não tem
  const posteriores = cauda.filter((r) => Number(r.ts_ms) > corte).length;
  const conjuntoIgual = reconstrucaoOk && faltando.length === 0 && sobrando.length === 0 && fontesErro.length === 0;
  const rpo = Math.max(0, Math.round((falha - lido) / 1000));
  const resumo = {
    ...base, ...comum,
    cadeia_ok: true,
    corte: new Date(corte).toISOString(),
    janela: { de: new Date(de).toISOString(), ate: leitura.lido_em, margem_ms: MARGEM_MS },
    reconstruidos: cauda.length, posteriores_ao_corte: posteriores, reconstrucao_ok: reconstrucaoOk,
    restaurados: c.esperados, presentes_ate_corte: c.presentes,
    faltando: faltando.length, sobrando: sobrando.length, fora_escopo: c.fora_escopo,
    neon_fontes: restaurado.fontes,
    conjunto_igual: conjuntoIgual,
    amostra: { faltando: faltando.slice(0, AMOSTRA), sobrando: sobrando.slice(0, AMOSTRA) },
  };
  if (!conjuntoIgual) return { ...resumo, estado: "nao_provado", motivo: !reconstrucaoOk ? "reconstrucao_divergente" : fontesErro.length ? "restaurado_fonte_erro:" + fontesErro.join(",") : "conjunto_divergente" };
  return { ...resumo, estado: "provado", motivo: null, rpo_critico_medido_s: rpo };
}
