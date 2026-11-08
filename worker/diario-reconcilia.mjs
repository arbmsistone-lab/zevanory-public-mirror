// ZEVANORY | P20 diário D1, PR 4: reconciliação diária Neon × diário (docs/p20/diario-d1.md, seção "Reconciliação
// diária"). Roteiro Mestre v4.7, seção 9.1: "Reconciliação diária Neon × diário: divergência é falha de P20."
//
// Para a janela [T−48h, T−1h]:
//  1. deriva do Neon o conjunto de event_key esperado, passando cada linha pelos MESMOS construtores dos ganchos
//     (worker/diario-sombra.mjs: eventoPedidoCriado, eventoPagamento, eventoEntrega, eventoReembolso,
//     eventoConsentimento). Nenhuma regra de chave é reescrita aqui: a normalização (techRef, parte) é a dos ganchos;
//  2. lê do D1 as linhas da janela numa consulta paginada por seq (limites da janela por ts_ms, mais uma linha-âncora
//     antes do início) e revalida o trecho da cadeia (verifyChain a partir da âncora);
//  3. compara: faltando = esperado no Neon e ausente no diário; sobrando = no diário e sem origem no Neon.
//
// Fase: DIARIO_FASE = "sombra" (PR 3). Em sombra a divergência vira ALERTA no relatório (warnings), nunca falha; o
// corte para "ativo" (divergência = falha de P20) é uma mudança de código revisada, depois de 7 dias seguidos em sombra
// com estado "ok" (docs/p20/diario-d1.md). Sem env.DIARIO: estado "nao_configurado", sem falha e sem alerta em sombra;
// em ativo, falha de P20 (diario_nao_configurado).
//
// Relatório sem PII: só contagens, tipos e uma amostra de event_key (ids técnicos normalizados e HMAC de titular, que
// já são a forma gravada no diário). Nenhum e-mail, nome ou payload.
import { verifyChain } from "./diario-p20.mjs";
import { eventoPedidoCriado, eventoPagamento, eventoEntrega, eventoReembolso, eventoConsentimento, LEAD_EVENTO_TIPO, REF_PREFIX, neonTsMs } from "./diario-sombra.mjs";

export const DIARIO_FASE = "sombra";
export const FASES = Object.freeze(["sombra", "ativo"]);
const HORA = 3600 * 1000;
export const JANELA_INICIO_MS = 48 * HORA; // T−48h
export const JANELA_FIM_MS = 1 * HORA; // T−1h (eventos da última hora podem ainda estar na fila do isolate)
// O ts_ms do diário é o relógio do Worker no gancho; o do Neon é o now() da transação. A diferença é de segundos.
// Para não acusar falta ou sobra na borda da janela, o lado contrário é lido com esta margem a mais.
export const MARGEM_MS = 15 * 60 * 1000;
export const PAGINA_D1 = 500;
export const MAX_PAGINAS_D1 = 40; // 20 mil linhas por janela; acima disso o resultado é "incompleto", nunca "ok"
export const AMOSTRA = 20;
// Tipos que os ganchos derivam do Neon. Os demais (erase, fiscal_ref) e os eventos Hotmart (vivem no KV e no
// provedor, não no Neon) ficam fora do escopo desta reconciliação e aparecem contados em fora_escopo.
export const RECONCILIAVEIS = Object.freeze(["order_created", "payment_status", "delivery_sent", "refund", "consent_given", "consent_confirmed", "consent_revoked"]);
const RECON_SET = new Set(RECONCILIAVEIS);

// ---------------------------------------------------------------------------------------------------------
// Neon: uma consulta por fonte, cada uma limitada à janela larga. ts_ms usa neonTsMs (mesma expressão do gancho de
// consentimento). Nenhuma coluna pessoal é lida (nem e-mail, nem evidence_ref: só um teste de padrão no banco).
const DESDE = "to_timestamp($1::double precision / 1000)";
const ATE = "to_timestamp($2::double precision / 1000)";
export const NEON_FONTES = Object.freeze({
  orders: `select order_id::text as order_id, provider, ${neonTsMs("created_at")} as ts_ms from orders where created_at >= ${DESDE} and created_at <= ${ATE}`,
  financial_events: `select order_id::text as order_id, provider, provider_payment_id as payment_id, provider_status as status, refunded_total::text as refunded_total, ${neonTsMs("received_at")} as ts_ms from financial_events where order_id is not null and received_at >= ${DESDE} and received_at <= ${ATE}`,
  service_fulfillment: `select sf.order_id::text as order_id, ${neonTsMs("sf.delivered_at")} as ts_ms from service_fulfillment sf join orders o on o.order_id = sf.order_id where o.provider = 'mercadopago' and sf.status = 'delivered' and sf.evidence_ref::text ~ '"email_status"\\s*:\\s*"sent"' and sf.delivered_at >= ${DESDE} and sf.delivered_at <= ${ATE}`,
  refund_provider_claims: `select order_id::text as order_id, stage, reconciled_status, ${neonTsMs("claimed_at")} as ts_claim, ${neonTsMs("reconciled_at")} as ts_rec from refund_provider_claims where (stage <> 'legacy_unknown' and claimed_at >= ${DESDE} and claimed_at <= ${ATE}) or (reconciled_status = 'approved' and reconciled_at >= ${DESDE} and reconciled_at <= ${ATE})`,
  zevanory_lead_events: `select subject_ref, event, consent_version, ${neonTsMs("at")} as ts_ms from zevanory_lead_events where subject_ref is not null and event = any($3::text[]) and at >= ${DESDE} and at <= ${ATE}`,
});
const tabelaAusente = (e) => e?.code === "42P01" || /relation .* does not exist/i.test(String(e?.message || ""));
const tsNum = (v) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };

// Esperado = {key} (chave exata) ou {prefix} (estorno aprovado: o id do estorno do provedor não fica no Neon, só no KV;
// o construtor sem refundId dá a chave-base, e qualquer chave do diário "<base>:<refund_ref>" satisfaz).
function esperadosDaLinha(fonte, r) {
  const out = [];
  const add = (ev, ts, prefixo = false) => {
    if (!ev || !ts) return;
    out.push(prefixo ? { tipo: ev.tipo, prefix: ev.event_key + ":", ts } : { tipo: ev.tipo, key: ev.event_key, ts });
  };
  if (fonte === "orders") add(eventoPedidoCriado({ orderId: r.order_id, provider: r.provider, ts: tsNum(r.ts_ms) }), tsNum(r.ts_ms));
  else if (fonte === "financial_events") add(eventoPagamento({ orderId: r.order_id, provider: r.provider, paymentId: r.payment_id, status: r.status, refundedTotal: r.refunded_total, ts: tsNum(r.ts_ms) }), tsNum(r.ts_ms));
  else if (fonte === "service_fulfillment") add(eventoEntrega({ orderId: r.order_id, provider: "mercadopago", channel: "email", ts: tsNum(r.ts_ms) }), tsNum(r.ts_ms));
  else if (fonte === "refund_provider_claims") {
    if (r.stage !== "legacy_unknown" && tsNum(r.ts_claim)) add(eventoReembolso({ orderId: r.order_id, provider: "mercadopago", stage: "provider_call_may_have_been_sent", ts: tsNum(r.ts_claim) }), tsNum(r.ts_claim));
    if (r.reconciled_status === "approved" && tsNum(r.ts_rec)) add(eventoReembolso({ orderId: r.order_id, provider: "mercadopago", stage: "approved", ts: tsNum(r.ts_rec) }), tsNum(r.ts_rec), true);
  } else if (fonte === "zevanory_lead_events") add(eventoConsentimento({ event: r.event, subjectRef: r.subject_ref, consentVersion: r.consent_version, ts: tsNum(r.ts_ms) }), tsNum(r.ts_ms));
  return out;
}

export async function esperadosDoNeon(sql, de, ate) {
  const fontes = {};
  const esperados = [];
  for (const [fonte, texto] of Object.entries(NEON_FONTES)) {
    const params = fonte === "zevanory_lead_events" ? [de, ate, Object.keys(LEAD_EVENTO_TIPO)] : [de, ate];
    let rows;
    try { rows = await sql.query(texto, params); } catch (e) {
      // Tabela criada sob demanda e ainda inexistente = nenhum evento daquela fonte. Outro erro: resultado incompleto.
      fontes[fonte] = tabelaAusente(e) ? "ausente" : "erro";
      continue;
    }
    let n = 0;
    for (const r of Array.isArray(rows) ? rows : []) {
      let itens = [];
      try { itens = esperadosDaLinha(fonte, r); } catch { itens = []; fontes[fonte + ":linha_invalida"] = (fontes[fonte + ":linha_invalida"] || 0) + 1; }
      for (const it of itens) { esperados.push(it); n++; }
    }
    fontes[fonte] = n;
  }
  return { esperados, fontes };
}

// ---------------------------------------------------------------------------------------------------------
// D1: uma consulta por página. Os limites da janela (por ts_ms, índice diario_v1_ts) ficam DENTRO da consulta; a
// linha seq_ini − 1 vem junto como âncora do trecho da cadeia.
// Os dois limites usam o intervalo fechado [de, ate] em ts_ms: assim o SQLite usa o índice de cobertura diario_v1_ts só
// no trecho da janela (com "min(seq) ... ts_ms >= ?" sozinho ele percorreria a tabela pela chave desde o início).
export const SQL_JANELA_D1 = "with b as (select (select min(seq) from diario_v1 where ts_ms >= ? and ts_ms <= ?) as ini, (select max(seq) from diario_v1 where ts_ms >= ? and ts_ms <= ?) as fim) "
  + "select d.seq, d.event_key, d.tipo, d.ts_ms, d.ref, d.payload_json, d.payload_sha, d.prev_hash, d.chain_hash, b.ini as seq_ini "
  + "from diario_v1 d, b where d.seq > ? and d.seq >= b.ini - 1 and d.seq <= b.fim order by d.seq limit ?";

export async function linhasDoDiario(db, de, ate, { pagina = PAGINA_D1, maxPaginas = MAX_PAGINAS_D1 } = {}) {
  const rows = [];
  let cursor = 0, consultas = 0, completo = false, seqIni = null;
  while (consultas < maxPaginas) {
    const res = await db.prepare(SQL_JANELA_D1).bind(de, ate, de, ate, cursor, pagina).all();
    consultas++;
    const page = Array.isArray(res?.results) ? res.results : [];
    for (const r of page) { rows.push(r); if (seqIni == null && r.seq_ini != null) seqIni = Number(r.seq_ini); }
    if (page.length < pagina) { completo = true; break; }
    cursor = Number(page[page.length - 1].seq);
  }
  return { rows, consultas, completo, seq_ini: seqIni };
}

// ---------------------------------------------------------------------------------------------------------
const provedorDe = (r) => { try { return String(JSON.parse(r.payload_json)?.provider ?? ""); } catch { return ""; } };
const hotmart = (r) => provedorDe(r) === "hotmart" || String(r.ref || "").startsWith(REF_PREFIX.hotmart);
function motivoForaEscopo(r) {
  if (!RECON_SET.has(r.tipo)) return "tipo:" + String(r.tipo);
  if ((r.tipo === "delivery_sent" || r.tipo === "refund") && hotmart(r)) return "hotmart_fora_do_neon";
  return null;
}

const conta = (m, tipo, campo) => { m[tipo] = m[tipo] || { esperados: 0, presentes: 0, faltando: 0, sobrando: 0 }; m[tipo][campo]++; };

// Compara. Exportada pura para os testes (sem Neon nem D1).
export function compara(esperados, linhasD1, { de, ate, margem = MARGEM_MS } = {}) {
  const dentro = (ts) => ts >= de && ts <= ate;
  const porTipo = {};
  const foraEscopo = {};
  const d1 = [];
  for (const r of linhasD1) {
    const motivo = motivoForaEscopo(r);
    if (motivo) { if (dentro(Number(r.ts_ms))) foraEscopo[motivo] = (foraEscopo[motivo] || 0) + 1; continue; }
    d1.push(r);
  }
  const chavesD1 = new Set(d1.map((r) => r.event_key));
  const casa = (e) => (e.key ? chavesD1.has(e.key) : d1.some((r) => r.event_key.startsWith(e.prefix)));
  const esperadosNucleo = esperados.filter((e) => dentro(e.ts));
  const faltando = [];
  for (const e of esperadosNucleo) {
    conta(porTipo, e.tipo, "esperados");
    if (!casa(e)) { faltando.push(e.key || e.prefix + "*"); conta(porTipo, e.tipo, "faltando"); }
  }
  const largo = new Set(esperados.filter((e) => e.key).map((e) => e.key));
  const prefixos = esperados.filter((e) => e.prefix).map((e) => e.prefix);
  const sobrando = [];
  let presentes = 0;
  for (const r of d1) {
    if (!dentro(Number(r.ts_ms))) continue;
    presentes++;
    conta(porTipo, r.tipo, "presentes");
    if (!largo.has(r.event_key) && !prefixos.some((p) => r.event_key.startsWith(p))) { sobrando.push(r.event_key); conta(porTipo, r.tipo, "sobrando"); }
  }
  return { esperados: esperadosNucleo.length, presentes, faltando, sobrando, por_tipo: porTipo, fora_escopo: foraEscopo, margem_ms: margem };
}

// Fase efetiva: só os dois valores conhecidos; qualquer outro valor cai para "ativo" (o lado estrito), nunca para
// um modo mais permissivo que a sombra.
const faseDe = (f) => (FASES.includes(f) ? f : "ativo");

// env: precisa de DIARIO (binding D1) e DATABASE_URL. opts.sqlFactory(url) -> {query(text, params)}.
export async function reconciliaDiario(env = {}, { sqlFactory, now = Date.now(), fase = DIARIO_FASE } = {}) {
  const de = now - JANELA_INICIO_MS, ate = now - JANELA_FIM_MS;
  const base = { schema: "zevanory-diario-reconciliacao/v1", fase: faseDe(fase), janela: { de: new Date(de).toISOString(), ate: new Date(ate).toISOString(), margem_ms: MARGEM_MS } };
  let db = null;
  try { db = env?.DIARIO ?? null; } catch { db = null; }
  if (!db || typeof db.prepare !== "function") return { ...base, estado: "nao_configurado", cadeia_ok: null };
  if (!env.DATABASE_URL || typeof sqlFactory !== "function") return { ...base, estado: "incompleto", motivo: "neon_indisponivel", cadeia_ok: null };
  let neon;
  try { neon = await esperadosDoNeon(sqlFactory(String(env.DATABASE_URL)), de - MARGEM_MS, ate + MARGEM_MS); } catch { return { ...base, estado: "incompleto", motivo: "neon_indisponivel", cadeia_ok: null }; }
  let lido;
  try { lido = await linhasDoDiario(db, de - MARGEM_MS, ate + MARGEM_MS); } catch { return { ...base, estado: "incompleto", motivo: "d1_indisponivel", neon: { fontes: neon.fontes }, cadeia_ok: null }; }
  // Âncora: a linha seq_ini − 1 (quando existe) prende o trecho à cadeia anterior; sem ela, o trecho começa na genesis.
  let trecho = lido.rows, from;
  if (lido.seq_ini != null && lido.seq_ini > 1 && trecho.length && Number(trecho[0].seq) === lido.seq_ini - 1) {
    from = { seq: Number(trecho[0].seq), chain_hash: trecho[0].chain_hash };
    trecho = trecho.slice(1);
  } else if (lido.seq_ini != null && lido.seq_ini > 1) {
    from = { seq: lido.seq_ini - 1, chain_hash: null }; // âncora ausente: a cadeia não fecha
  }
  const cadeia = from && from.chain_hash == null ? { ok: false, broken_at: lido.seq_ini, reason: "ancora_ausente" } : await verifyChain(trecho, from ? { from } : {});
  const c = compara(neon.esperados, trecho, { de, ate });
  // Linha do Neon que os construtores recusam (fonte:linha_invalida) é fonte com erro: o esperado daquela linha não
  // foi derivado, então o resultado é "incompleto", nunca "ok".
  const fontesErro = Object.entries(neon.fontes).filter(([k, v]) => v === "erro" || (k.endsWith(":linha_invalida") && v > 0)).map(([k]) => k);
  const incompleto = !lido.completo || fontesErro.length > 0;
  const divergente = c.faltando.length > 0 || c.sobrando.length > 0 || cadeia.ok !== true;
  return {
    ...base,
    estado: incompleto ? "incompleto" : divergente ? "divergente" : "ok",
    ...(incompleto ? { motivo: !lido.completo ? "d1_paginas_excedidas" : "neon_fonte_erro:" + fontesErro.join(",") } : {}),
    esperados: c.esperados,
    presentes: c.presentes,
    faltando: c.faltando.length,
    sobrando: c.sobrando.length,
    cadeia_ok: cadeia.ok === true,
    cadeia: { broken_at: cadeia.broken_at ?? null, reason: cadeia.reason ?? null, linhas: trecho.length },
    por_tipo: c.por_tipo,
    fora_escopo: c.fora_escopo,
    amostra: { faltando: c.faltando.slice(0, AMOSTRA), sobrando: c.sobrando.slice(0, AMOSTRA) },
    neon: { fontes: neon.fontes },
    d1: { consultas: lido.consultas, linhas: lido.rows.length },
  };
}

// Efeito no relatório do backup. "ok": nada. "nao_configurado" (sem binding DIARIO): nada em sombra; em ativo, falha
// de P20 (o diário é obrigatório depois do corte). Divergência ou resultado incompleto: em sombra, alerta; em ativo,
// falha de P20.
export function efeitoNoRelatorio(diario) {
  if (!diario || diario.estado === "ok") return { falha: null, alerta: null };
  if (diario.estado === "nao_configurado" && faseDe(diario.fase) === "sombra") return { falha: null, alerta: null };
  const code = "diario_" + diario.estado;
  return faseDe(diario.fase) === "sombra" ? { falha: null, alerta: code + ":sombra" } : { falha: code, alerta: null };
}
