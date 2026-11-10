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
const readJson = async (kv, key) => {
  if (!kv?.get) return { ok: false, v: null };
  try { return { ok: true, v: JSON.parse(String((await kv.get(key)) || "null")) }; } catch { return { ok: false, v: null }; }
};
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const fmt = (v) => (v == null ? "não medido" : String(v));

// Vendas aprovadas Hotmart do dia com estado (NC-06). O ledger é alimentado pelo postback autenticado (hottok), sem
// reconciliação com a API da Hotmart: o máximo é PENDENTE. Sem nenhum evento registrado, o webhook está NÃO TESTADO.
export function estadoVendasHotmart(leitura, day) {
  if (!leitura?.ok) return { estado: "INCONCLUSIVO", aprovadas: null, texto: "INCONCLUSIVO (falha ao ler o registro de vendas)" };
  const s = leitura.v;
  if (!s || s.schema !== "zevanory-sales/v1") return { estado: "NAO_TESTADO", aprovadas: null, texto: "NÃO TESTADO (webhook Hotmart sem eventos registrados)" };
  const aprovadas = Math.max(0, Number(s.byDay?.[day]?.approved) || 0);
  if (s.integrity === "reconciled" && s.reconciledDays?.includes?.(day)) return { estado: "COMPROVADO", aprovadas, texto: `${aprovadas} (COMPROVADO: reconciliado com a Hotmart)` };
  return { estado: "PENDENTE", aprovadas, texto: `${aprovadas} (PENDENTE: postback autenticado, sem reconciliação com a Hotmart)` };
}

// Funil do dia (resumo horário do Worker em zpc-funnel:v1:summary, bloco porDiaUtc). Ausente ou antigo = não medido.
export function funilDoDia(leitura, dayUtc, now = Date.now()) {
  const s = leitura?.ok ? leitura.v : null;
  const at = Date.parse(String(s?.generatedAt || ""));
  const d = s?.porDiaUtc && typeof s.porDiaUtc === "object" ? s.porDiaUtc[dayUtc] || { views_br: 0, hotmart_view: 0, lead_submit: 0 } : null;
  const fresco = Number.isFinite(at) && now - at <= FUNNEL_FRESH_MS;
  return {
    medido: Boolean(d),
    fresco,
    geradoEm: Number.isFinite(at) ? new Date(at).toISOString() : null,
    viewsBr: d ? num(d.views_br) : null,
    hotmartView: d ? num(d.hotmart_view) : null,
    leadsFormulario: d ? num(d.lead_submit) : null,
    leadsConfirmados7: s ? num(s.last7Days?.leadsConfirmed) : null,
  };
}

export async function montarRelatorioDiario(env = {}, { day, hour = 20, now = new Date(), checklist = [], agendaAmanha = null, regras = REGRAS_DIAGNOSTICO } = {}) {
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  const ativos = canaisAtivos(checklist, regras);
  const status = await lerStatusDoDia(kv, day, regras);
  const diagnosticos = diagnosticarDia({ day, hour, ativos, status, regras });
  const autonomia = autonomiaDoDia({ day, hour, ativos, status, regras });
  const dayUtc = now.toISOString().slice(0, 10);
  const funil = funilDoDia(await readJson(kv, FUNNEL_SUMMARY_KEY), dayUtc, now.getTime());
  const vendas = estadoVendasHotmart(await readJson(kv, SALES_SUMMARY_KEY), dayUtc);

  const publicacoes = Object.keys(regras.canais || {}).map((canal) => {
    const a = ativos[canal], s = status.porCanal[canal] || {};
    const esperadas = a?.ativo ? esperadasNoDia(canal, day, hour, regras) : 0;
    const publicadas = s.publicadas || 0;
    const extra = s.url ? s.url : s.id ? "id " + s.id : publicadas < esperadas ? s.motivo : s.status && s.status !== "publicado" ? s.status : null;
    const desligado = a?.desligado === true ? `• ${canal}: desligado (${/propriet[aá]rio/i.test(String(a.motivo || "")) ? "decisão do proprietário" : a.motivo})` : null;
    const linha = desligado ? desligado : !a?.ativo ? `• ${canal}: inativo (${a?.motivo || "sem regra"})` : `• ${canal}: esperado ${esperadas} × real ${publicadas}` + (extra ? ` — ${extra}` : "");
    return { canal, ativo: a?.ativo === true, esperadas, publicadas, url: s.url || null, id: s.id || null, linha };
  });

  const falhas = [];
  for (const [canal, s] of Object.entries(status.porCanal)) if (ativos[canal]?.ativo && /^(erro|pending)$/.test(String(s.status || ""))) falhas.push(`• ${canal}: ${s.status} — ${s.motivo || "sem código"}`);
  if (status.fonte === "falha_leitura") falhas.push("• registro do motor de aquisição: falha de leitura");
  if (!funil.medido) falhas.push("• funil: resumo do dia ausente (views, cliques e leads não medidos)");
  else if (!funil.fresco) falhas.push(`• funil: resumo desatualizado (gerado em ${funil.geradoEm || "?"})`);
  if (vendas.estado === "INCONCLUSIVO") falhas.push("• vendas Hotmart: leitura do registro falhou");

  const decisoesD = [
    ...Object.entries(ativos).filter(([, a]) => !a.ativo && /^aguardando/.test(String(a.motivo || ""))).map(([canal, a]) => `• ${canal}: ${a.motivo} (credencial é classe D; a central não cria nem vê credencial)`),
    ...diagnosticos.filter((d) => d.classe === "D").map((d) => `• ${d.canal}: ${d.motivo} (renovar ou trocar a credencial)`),
  ];
  const diag = diagnosticos.map((d) => `• ${d.regra} ${d.canal}: ${d.publicadas}/${d.esperadas} — motivo: ${d.motivo} — classe ${d.classe}; ação automática: nenhuma (v1 só diagnostica)`);

  const lines = [
    `ZEVANORY | Relatório do dia ${day} (${String(hour).padStart(2, "0")}h, America/Sao_Paulo)`,
    "",
    "PUBLICADO HOJE (esperado × real)",
    ...publicacoes.map((p) => p.linha),
    "",
    `FUNIL E VENDAS (dia UTC ${dayUtc}${funil.geradoEm ? `, resumo das ${funil.geradoEm.slice(11, 16)}Z` : ""})`,
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
    "Custo do dia: R$ 0,00 (custo zero; nenhum gasto autorizado)",
    `Autonomia real: ${autonomia.texto}`,
    ...(agendaAmanha ? ["Agenda de amanhã: " + agendaAmanha] : []),
    "Painel: https://controle.zevanory.api.br",
  ];
  return {
    subject: `ZEVANORY | Relatório do dia ${day}`,
    text: lines.join("\n"),
    publicacoes: publicacoes.map(({ linha, ...p }) => p),
    funil, vendas, falhas: falhas.length, diagnosticos, decisoesD: decisoesD.length, autonomia, custoDiaBRL: 0, regras: regras.versao,
  };
}
