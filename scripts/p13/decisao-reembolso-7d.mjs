// P13 Pós-venda (roteiro v4.9.1, seções 5, 7.1 H-6 e 7.3): núcleo PURO de decisão para pedidos de reembolso e
// arrependimento recebidos por qualquer canal (Hotmart, suporte@, /atendimento, /pedir-reembolso legado).
// Não faz rede, não grava, não reembolsa. Devolve a decisão, o motivo, os prazos e se exige revisão humana.
// Regras (política de 7 dias "sem exceção não autorizada"):
//   * o prazo é o da política única (data/politica-unica.json, refundWindow), avaliado na DATA DA SOLICITAÇÃO,
//     nunca na data em que o pedido é tratado (12-B.4: pedido feito durante indisponibilidade vale da solicitação);
//   * DEC-06: na Hotmart o recebimento é imediato, então recebimento = aprovação do pagamento;
//   * dentro do prazo: aprovar, sem pedir justificativa, devolução integral (CDC art. 49);
//   * fora do prazo: nunca aprovar automaticamente. Vício ou falha de entrega vai para revisão humana (CDC
//     arts. 18 e 20); exceção à regra só com autorização registrada do proprietário; sem ela, bloqueada;
//   * já reembolsado ou em andamento: nunca uma segunda reversão; contestação aberta: segue o procedimento 7.3,
//     sem reembolso paralelo;
//   * pedido repetido (mesmo protocolo ou mesmo pedido já decidido): devolve a decisão registrada (idempotente);
//   * assunto jurídico ou dado pessoal: revisão humana obrigatória, qualquer que seja a decisão.
import { refundWindow } from "../../worker/politica-unica.mjs";

const DAY = 86_400_000;
// H-6 (Política de Pagamentos da Hotmart, item 3.6, segundo a auditoria suprema; NÃO VERIFICADO na conta real).
export const HOTMART_RESPOSTA_DIAS = 5;
// Decreto 7.962/2013 e política publicada: resposta conclusiva em até 5 dias.
export const RESPOSTA_CONCLUSIVA_DIAS = 5;
export const CANAIS_PEDIDO = Object.freeze(new Set(["hotmart", "suporte_email", "atendimento", "pedir_reembolso"]));
export const ESTADOS_PEDIDO = Object.freeze(new Set(["pago", "reembolsado", "reembolso_em_andamento", "contestado", "cancelado"]));
const MOTIVOS_VICIO = new Set(["defeito", "falha_entrega", "arquivo_corrompido"]);
const MOTIVOS_SENSIVEIS = new Set(["juridico", "dado_pessoal"]);
const PROTOCOLO = /^[A-Z0-9][A-Z0-9-]{5,40}$/;

const ms = (v) => { if (v == null || v === "") return null; const t = typeof v === "number" ? v : Date.parse(String(v)); return Number.isFinite(t) ? t : null; };

export function excecaoValida(excecao) {
  return Boolean(excecao && excecao.autorizada_por === "proprietario" &&
    typeof excecao.registro === "string" && excecao.registro.trim().length >= 8 &&
    typeof excecao.motivo === "string" && excecao.motivo.trim().length >= 8);
}

export function decidirReembolso({ pedido, solicitacao, decisaoAnterior = null, excecao = null, agora } = {}) {
  const aprovado = ms(pedido?.aprovado_em);
  const solicitado = ms(solicitacao?.solicitado_em);
  const now = ms(agora);
  if (aprovado == null || solicitado == null || now == null || solicitado < aprovado || now < solicitado ||
      !ESTADOS_PEDIDO.has(pedido?.estado) || !CANAIS_PEDIDO.has(solicitacao?.canal) ||
      typeof solicitacao?.protocolo !== "string" || !PROTOCOLO.test(solicitacao.protocolo))
    return { decisao: "invalido", revisao_humana: true, motivo: "dados_insuficientes_ou_incoerentes" };
  const prazos = {
    resposta_conclusiva_ate: new Date(solicitado + RESPOSTA_CONCLUSIVA_DIAS * DAY).toISOString(),
    resposta_hotmart_ate: solicitacao.canal === "hotmart" ? new Date(solicitado + HOTMART_RESPOSTA_DIAS * DAY).toISOString() : null,
  };
  const alertas = [];
  if (now > solicitado + RESPOSTA_CONCLUSIVA_DIAS * DAY) alertas.push("prazo_resposta_conclusiva_estourado");
  if (solicitacao.canal === "hotmart" && now > solicitado + HOTMART_RESPOSTA_DIAS * DAY) alertas.push("prazo_hotmart_h6_estourado");
  const sensivel = MOTIVOS_SENSIVEIS.has(solicitacao.motivo);
  const out = (decisao, motivo, extra = {}) => ({
    decisao, motivo, prazos, alertas,
    revisao_humana: Boolean(extra.revisao_humana || sensivel),
    ...(sensivel ? { revisao_motivo: "assunto_sensivel:" + solicitacao.motivo } : {}),
    alimenta: ["P24", "P25"],
    ...extra,
  });
  // Idempotência: a mesma solicitação (ou o mesmo pedido já decidido) devolve a decisão registrada.
  if (decisaoAnterior && typeof decisaoAnterior.decisao === "string" && decisaoAnterior.decisao !== "invalido")
    return { ...decisaoAnterior, duplicado: true };
  if (pedido.estado === "reembolsado") return out("ja_reembolsado", "nenhuma_segunda_reversao");
  if (pedido.estado === "reembolso_em_andamento") return out("em_andamento", "aguardar_conclusao_sem_novo_pedido_ao_provedor");
  if (pedido.estado === "contestado") return out("contestacao_em_andamento", "seguir_procedimento_7_3_sem_reembolso_paralelo", { revisao_humana: true });
  if (pedido.estado === "cancelado") return out("ja_cancelado", "cobranca_nao_concluida");
  // DEC-06: o recebimento na Hotmart é imediato (= aprovação); o legado pode informar o recebimento real.
  const recebido = ms(pedido.recebido_em) ?? aprovado;
  const janela = refundWindow({ paidAt: aprovado, deliveredAt: recebido, now: solicitado });
  if (janela.eligible) return out("aprovar_arrependimento", "dentro_do_prazo_na_data_da_solicitacao",
    { prazo_ate: janela.ends_at, integral: true, pedir_justificativa: false });
  if (excecao) {
    if (excecaoValida(excecao)) return out("excecao_autorizada", "fora_do_prazo_com_autorizacao_registrada",
      { revisao_humana: true, prazo_ate: janela.ends_at, excecao_registro: excecao.registro });
    return out("excecao_nao_autorizada", "fora_do_prazo_sem_autorizacao_registrada", { revisao_humana: true, prazo_ate: janela.ends_at });
  }
  if (MOTIVOS_VICIO.has(solicitacao.motivo)) return out("fora_do_prazo_vicio", "analise_de_vicio_ou_falha_de_entrega",
    { revisao_humana: true, prazo_ate: janela.ends_at });
  return out("fora_do_prazo", "encaminhar_ao_suporte_sem_reembolso_automatico", { prazo_ate: janela.ends_at });
}
