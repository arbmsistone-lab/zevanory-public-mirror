// Relatório diário real ao proprietário (Plano Mestre ZEVANORY v1.2, seção 2, "Relatório diário": 20h, e-mail, 1 tela).
// Substitui o texto fixo "Leads, checkouts e vendas: sem dados". Monta, só com dados já existentes no KV operacional:
//   publicado hoje por canal (esperado × real, com link ou ID), views BR, cliques /hotmart (hotmart_view), leads,
//   vendas aprovadas Hotmart com estado (COMPROVADO / PENDENTE / INCONCLUSIVO; webhook sem eventos = NÃO TESTADO,
//   nunca "0 comprovado"), falhas detectadas, diagnósticos do Diagnosticador v1 (CANAL_PARADO), decisões pendentes de
//   classe D, custo do dia (R$ 0,00) e o índice REAL de autonomia. Só leitura; nenhum dado pessoal; nenhum segredo.
import { REGRAS_DIAGNOSTICO, canaisAtivos, lerStatusDoDia, diagnosticarDia, autonomiaDoDia, esperadasNoDia } from "./diagnostico-diario.mjs";
import { SALES_SUMMARY_KEY } from "./sales-ledger.mjs";

export const FUNNEL_SUMMARY_KEY = "zpc-funnel:v1:summary";
const FUNNEL_FRESH_MS = 3 * 3600_000;
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const readJson = async (kv, key, valid = object) => {
  if (!kv?.get) return { ok: false, v: null };
  try {
    const raw = await kv.get(key);
    if (raw === null) return { ok: true, v: null };
    const v = JSON.parse(String(raw));
    return valid(v) ? { ok: true, v } : { ok: false, v: null };
  } catch { return { ok: false, v: null }; }
};
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const fmt = (v) => (v == null ? "não medido" : String(v));

// Vendas aprovadas Hotmart do dia com estado (NC-06). O ledger é alimentado pelo postback autenticado (hottok), sem
// reconciliação com a API da Hotmart: o máximo é PENDENTE. Sem nenhum evento registrado, o webhook está NÃO TESTADO.
export function estadoVendasHotmart(leitura, day) {
  if (!leitura?.ok) return { estado: "INCONCLUSIVO", aprovadas: null, texto: "INCONCLUSIVO (falha ao ler o registro de vendas)" };
  const s = leitura.v;
  if (s === null) return { estado: "NAO_TESTADO", aprovadas: null, texto: "NÃO TESTADO (webhook Hotmart sem eventos registrados)" };
  if (!object(s) || s.schema !== "zevanory-sales/v1" || !object(s.byDay) || (s.byDay[day] !== undefined && (!object(s.byDay[day]) || num(s.byDay[day].approved) === null))) return {estado:"INCONCLUSIVO",aprovadas:null,texto:"INCONCLUSIVO (estrutura do registro de vendas inválida; não lido)"};
  const aprovadas = s.byDay[day]?.approved ?? 0;
  if (s.integrity === "reconciled" && s.reconciledDays?.includes?.(day)) return { estado: "COMPROVADO", aprovadas, texto: `${aprovadas} (COMPROVADO: reconciliado com a Hotmart)` };
  return { estado: "PENDENTE", aprovadas, texto: `${aprovadas} (PENDENTE: postback autenticado, sem reconciliação com a Hotmart)` };
}

// Funil do dia (resumo horário do Worker em zpc-funnel:v1:summary, bloco porDiaUtc). Ausente ou antigo = não medido.
export function funilDoDia(leitura, dia, now = Date.now()) {
  const s = leitura?.ok ? leitura.v : null;
  const at = Date.parse(String(s?.generatedAt || ""));
  const rawDay = object(s?.porDiaUtc) ? s.porDiaUtc[dia] ?? { views_br: 0, hotmart_view: 0, lead_submit: 0 } : null;
  const erro = leitura?.ok !== true || (s !== null && (!object(s) || !Number.isFinite(at) || !object(s.porDiaUtc) || !object(rawDay) || ["views_br","hotmart_view","lead_submit"].some(k=>num(rawDay[k])===null)));
  const fresco = Number.isFinite(at) && now >= at && now - at <= FUNNEL_FRESH_MS;
  const d = !erro && fresco ? rawDay : null;
  return {
    erro,
    medido: Boolean(d),
    fresco,
    geradoEm: Number.isFinite(at) ? new Date(at).toISOString() : null,
    viewsBr: d ? num(d.views_br) : null,
    hotmartView: d ? num(d.hotmart_view) : null,
    leadsFormulario: d ? num(d.lead_submit) : null,
    leadsConfirmados7: !erro && fresco ? num(s?.last7Days?.leadsConfirmed) : null,
  };
}

export async function montarRelatorioDiario(env = {}, { day, hour = 20, now = new Date(), checklist = [], agendaAmanha = null, regras = REGRAS_DIAGNOSTICO } = {}) {
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  const ativos = canaisAtivos(checklist, regras);
  const status = await lerStatusDoDia(kv, day, regras);
  const diagnosticos = diagnosticarDia({ day, hour, ativos, status, regras });
  const autonomia = autonomiaDoDia({ day, hour, ativos, status, regras });
  // Funil e vendas: os baldes do funil e do ledger Hotmart são agregados por dia UTC. O relatório lê o balde com a
  // data do dia local e, enquanto a agregação for UTC, SEMPRE rotula (NC-F1-A4-02, contra-auditoria GPT-6):
  // "dia UTC; intervalo diferente do dia America/Sao_Paulo", mesmo quando as datas coincidem.
  const funil = funilDoDia(await readJson(kv, FUNNEL_SUMMARY_KEY), day, now.getTime());
  const vendas = estadoVendasHotmart(await readJson(kv, SALES_SUMMARY_KEY), day);
  // Revisão por amostragem do blog (auditoria do #1020): publicações marcadas amostra_revisao nos últimos 7 dias locais.
  const chaveBlog = regras.canais?.blog?.chave_status;
  const amostras = [], errosAmostras = [];
  if (chaveBlog) for (let i = 0; i < 7; i++) {
    const d = new Date(Date.parse(day + "T12:00:00Z") - i * 86400000).toISOString().slice(0, 10);
    const leitura = await readJson(kv, String(chaveBlog).replace("{dia}", d), v=>object(v)&&["ok","rejeitado"].includes(v.resultado));
    if(!leitura.ok) errosAmostras.push(`• blog ${d}: amostra não lida (erro de leitura ou estrutura)`);
    const st = leitura.v;
    if (st?.resultado === "ok" && st.amostra_revisao === true) amostras.push(`• ${d}: ${st.url || st.slug || "sem URL"}`);
  }

  const publicacoes = Object.keys(regras.canais || {}).map((canal) => {
    const a = ativos[canal], s = status.porCanal[canal] || {};
    const esperadas = a?.ativo ? esperadasNoDia(canal, day, hour, regras) : 0;
    // Sem leitura ou sem evidência = null ("não lido"/"sem evidência"), nunca 0 (NC-G6-1021-01).
    const publicadas = s.leitura === "erro" || s.leitura === "ausente" || !Number.isInteger(s.publicadas) ? null : s.publicadas;
    const extra = s.url ? s.url : s.id ? "id " + s.id : publicadas < esperadas ? s.motivo : s.status && s.status !== "publicado" ? s.status : null;
    const desligado = a?.desligado === true ? `• ${canal}: desligado (${/propriet[aá]rio/i.test(String(a.motivo || "")) ? "decisão do proprietário" : a.motivo})` : null;
    const linha = desligado ? desligado : !a?.ativo ? `• ${canal}: inativo (${a?.motivo || "sem regra"})` : `• ${canal}: esperado ${esperadas} × real ${publicadas === null ? (s.leitura === "erro" ? "não lido" : "sem evidência") : publicadas}` + (extra ? ` — ${extra}` : "");
    return { canal, ativo: a?.ativo === true, esperadas, publicadas, url: s.url || null, id: s.id || null, linha };
  });

  const falhas = [...errosAmostras];
  for (const [canal, s] of Object.entries(status.porCanal)) if (ativos[canal]?.ativo && /^(erro|pending)$/.test(String(s.status || ""))) falhas.push(`• ${canal}: ${s.status} — ${s.motivo || "sem código"}`);
  if (status.fonte === "falha_leitura") falhas.push("• registro do motor de aquisição: falha de leitura");
  if (funil.erro) falhas.push("• funil: não lido (erro de leitura ou estrutura)");
  else if (!funil.fresco && funil.geradoEm) falhas.push(`• funil: resumo desatualizado (gerado em ${funil.geradoEm})`);
  else if (!funil.medido) falhas.push("• funil: resumo do dia ausente (views, cliques e leads não medidos)");
  else if (!funil.fresco) falhas.push(`• funil: resumo desatualizado (gerado em ${funil.geradoEm || "?"})`);
  if (vendas.estado === "INCONCLUSIVO") falhas.push("• vendas Hotmart: leitura do registro falhou");

  const decisoesD = [
    ...Object.entries(ativos).filter(([, a]) => !a.ativo && /^aguardando/.test(String(a.motivo || ""))).map(([canal, a]) => `• ${canal}: ${a.motivo} (credencial é classe D; a central não cria nem vê credencial)`),
    ...diagnosticos.filter((d) => d.classe === "D").map((d) => `• ${d.canal}: ${d.motivo} (renovar ou trocar a credencial)`),
  ];
  const diag = diagnosticos.map((d) => `• ${d.regra} ${d.canal}: ${d.publicadas === null ? (d.regra === "SEM_EVIDENCIA" ? "sem evidência" : "não lido") : d.publicadas}/${d.esperadas} — motivo: ${d.motivo} — classe ${d.classe}; ação automática: nenhuma (v1 só diagnostica)`);

  const lines = [
    `ZEVANORY | Relatório do dia ${day} (${String(hour).padStart(2, "0")}h, America/Sao_Paulo)`,
    "",
    "PUBLICADO HOJE (esperado × real)",
    ...publicacoes.map((p) => p.linha),
    "",
    `FUNIL E VENDAS (dia UTC ${day}; intervalo diferente do dia America/Sao_Paulo${funil.geradoEm ? `; resumo das ${funil.geradoEm.slice(11, 16)}Z` : ""})`,
    `• Views BR (filtro de robôs e datacenter): ${fmt(funil.viewsBr)}`,
    `• Cliques /hotmart (hotmart_view): ${fmt(funil.hotmartView)}`,
    `• Leads: ${fmt(funil.leadsFormulario)} no formulário hoje; ${fmt(funil.leadsConfirmados7)} confirmados em 7 dias`,
    `• Vendas aprovadas Hotmart: ${vendas.texto}`,
    "",
    "FALHAS DETECTADAS",
    ...(falhas.length ? falhas : ["• nenhuma"]),
    "",
    `DIAGNÓSTICO (Diagnosticador v1, regras ${regras.versao})`,
    ...(diag.length ? diag : ["• nenhum canal ativo abaixo do esperado"]),
    "",
    "DECISÕES PENDENTES (CLASSE D)",
    ...(decisoesD.length ? decisoesD : ["• nenhuma"]),
    "",
    "AMOSTRA PARA REVISÃO (blog, 1 de cada 3 publicações, últimos 7 dias)",
    ...(amostras.length || errosAmostras.length ? [...amostras,...errosAmostras] : ["• nenhuma"]),
    "",
    // Auditoria do #1021: sem fonte de custo medida, o custo não é afirmado (nunca R$ 0,00 fixo).
    "Custo do dia: não medido (sem fonte de custo)",
    `Autonomia real: ${autonomia.texto}`,
    ...(agendaAmanha ? ["Agenda de amanhã: " + agendaAmanha] : []),
    "Painel: https://controle.zevanory.api.br",
  ];
  return {
    subject: `ZEVANORY | Relatório do dia ${day}`,
    text: lines.join("\n"),
    publicacoes: publicacoes.map(({ linha, ...p }) => p),
    funil, vendas, falhas: falhas.length, diagnosticos, decisoesD: decisoesD.length, autonomia, custoDiaBRL: null, amostrasRevisao: amostras.length, regras: regras.versao,
  };
}
