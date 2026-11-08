// P12 (roteiro v4.9.1, seção 5 e 12-B.2): onboarding orientado a resultado, com MICROVITÓRIA em até 24 h depois
// da entrega, com base legal registrada (12-B.5). Módulo PURO e INATIVO:
//   * não é importado por nenhuma rota, cron ou webhook; não faz fetch; não grava nada;
//   * a flag ONBOARDING_MICROVITORIA_ENABLED só liga com o valor EXATO "true" (ou o booleano true); ausente,
//     vazio, "1", "TRUE", "yes" ou qualquer outro valor = desligada;
//   * mesmo com a flag ligada, ONBOARDING_SEND_ENABLED (constante de código, false) impede qualquer envio real:
//     ligar o envio exige mudança de código, nova auditoria e decisão do proprietário (fase de envio fora deste PR).
// DEC-06: a entrega é imediata e integral na área de compras da Hotmart (Minhas compras); "entregue" = aprovação
// do pagamento informada pelo postback autenticado. A mensagem é transacional: orienta o primeiro uso do produto
// comprado, sem oferta, sem preço, sem próximo produto e sem promessa de ganho (12-B.1).
// Privacidade: o plano carrega só a referência pseudônima da transação (hash), nunca o e-mail, o nome ou o
// identificador bruto da Hotmart. O destinatário só entra no momento do envio, que este módulo não executa.
import { bannedPolicyHits, hasCheckoutCta, SUPPORT_EMAIL } from "./politica-unica.mjs";

export const ONBOARDING_FLAG = "ONBOARDING_MICROVITORIA_ENABLED";
export const ONBOARDING_SEND_ENABLED = false;
const HOUR = 3_600_000;
// Janela: a mensagem fica elegível 2 h depois da entrega (tempo para o primeiro download) e vence em 24 h.
export const MICROVITORIA_SEND_AFTER_MS = 2 * HOUR;
export const MICROVITORIA_DEADLINE_MS = 24 * HOUR;
export const MICROVITORIA_STEP = "mv1";
const APPROVED = new Set(["PURCHASE_APPROVED", "PURCHASE_COMPLETE"]);
const REF = /^[a-f0-9]{16,64}$/;

// Registro da base legal (12-B.5): o inventário de tratamento referencia este objeto.
export const BASE_LEGAL_MICROVITORIA = Object.freeze({
  fluxo: "onboarding_pos_entrega",
  finalidade: "orientar o primeiro uso do produto comprado (microvitória em até 24 h)",
  // Mesma base declarada na política de privacidade publicada ("Acompanhamento pós-compra": legítimo interesse,
  // art. 7º, IX, com descadastro em um clique). A documentação corresponde ao tratamento (12-B.5); o teste E11 confere.
  base_legal: "legitimo_interesse",
  referencia: "LGPD art. 7º, IX",
  politica_publicada: "Acompanhamento pós-compra",
  natureza: "transacional, sem oferta",
  dados: "e-mail do comprador informado pela Hotmart, usado só no envio; o registro guarda só hash da transação",
  retencao: "marcador por pedido e etapa por 30 dias",
  oposicao: "descadastro em 1 clique e " + SUPPORT_EMAIL,
  inventario: "roteiro 12-B.5 (fluxo venda)",
  situacao: "PROPOSTA: depende da confirmação do proprietário e de a política de privacidade citar este tratamento",
});

// Uma ação concreta, curta e verificável por produto, usando só arquivos que a página de venda promete.
export const MICROVITORIAS = Object.freeze({
  "ia-na-pratica": Object.freeze({ nome: "IA na Prática", arquivo: "Arquivo de comandos prontos para IA",
    acao: "Escolha uma tarefa real de hoje, use um dos comandos prontos e anote o resultado na planilha de aplicação." }),
  "vendas-na-pratica": Object.freeze({ nome: "Vendas na Prática", arquivo: "Modelos de mensagens de venda e follow-up",
    acao: "Escolha um modelo de follow-up, adapte ao seu negócio e registre o contato na planilha de acompanhamento comercial." }),
  "lucro-e-caixa": Object.freeze({ nome: "Lucro & Caixa", arquivo: "Planilha de caixa e margem",
    acao: "Lance as entradas e saídas da última semana na planilha de caixa e margem e veja o saldo do período." }),
  "combo-ia-vendas": Object.freeze({ nome: "Combo IA + Vendas", arquivo: "IA na Prática: arquivo de comandos prontos",
    acao: "Comece por IA na Prática: escolha uma tarefa real de hoje, use um dos comandos prontos e anote o resultado." }),
  "negocio-completo": Object.freeze({ nome: "Negócio Completo", arquivo: "Plano integrado de 30 dias",
    acao: "Abra o Plano integrado de 30 dias e faça a primeira etapa; depois, lance a última semana na planilha de caixa e margem." }),
});

export function onboardingEnabled(env) {
  const value = env?.[ONBOARDING_FLAG];
  return value === true || value === "true";
}

export function microvitoriaKey(transactionRef, step = MICROVITORIA_STEP) {
  if (typeof transactionRef !== "string" || !REF.test(transactionRef)) throw new Error("onboarding_ref_invalida");
  return "onb-mv/v1/" + transactionRef + "/" + step;
}

// Plano por pedido. Duas aprovações (APPROVED e COMPLETE, ou reentrega do mesmo postback) geram o MESMO plano.
export function planMicrovitoria({ env, event, slug, transactionRef, deliveredAtMs } = {}) {
  if (!onboardingEnabled(env)) return { status: "disabled" };
  if (!APPROVED.has(String(event || "").toUpperCase())) return { status: "ignored", reason: "evento_sem_entrega" };
  const produto = Object.hasOwn(MICROVITORIAS, String(slug)) ? MICROVITORIAS[slug] : null;
  if (!produto) return { status: "skipped", reason: "produto_desconhecido" };
  if (!Number.isSafeInteger(deliveredAtMs) || deliveredAtMs <= 0) return { status: "skipped", reason: "entrega_sem_horario" };
  let key;
  try { key = microvitoriaKey(transactionRef); } catch { return { status: "skipped", reason: "referencia_invalida" }; }
  return {
    status: "planned", slug, step: MICROVITORIA_STEP, idempotency_key: key,
    due_at_ms: deliveredAtMs + MICROVITORIA_SEND_AFTER_MS,
    deadline_ms: deliveredAtMs + MICROVITORIA_DEADLINE_MS,
    base_legal: BASE_LEGAL_MICROVITORIA,
  };
}

// Decisão a cada passada do agendador. Estorno, contestação, cancelamento ou descadastro cancelam; envio já
// registrado nunca repete; passou do prazo de 24 h vira falta registrada (alerta), nunca envio atrasado.
export function decideMicrovitoria(plan, { nowMs, sent = false, reversed = false, optedOut = false } = {}) {
  if (plan?.status !== "planned") return { action: "none", reason: plan?.status || "sem_plano" };
  if (sent) return { action: "none", reason: "ja_enviada" };
  if (reversed) return { action: "cancel", reason: "estorno_ou_cancelamento" };
  if (optedOut) return { action: "cancel", reason: "descadastro" };
  if (!Number.isSafeInteger(nowMs)) return { action: "none", reason: "relogio_invalido" };
  if (nowMs < plan.due_at_ms) return { action: "wait", reason: "antes_da_janela" };
  if (nowMs >= plan.deadline_ms) return { action: "alert", reason: "prazo_24h_perdido" };
  return { action: "send", reason: "dentro_da_janela" };
}

export function renderMicrovitoria(slug, { optOutUrl = "" } = {}) {
  const p = Object.hasOwn(MICROVITORIAS, String(slug)) ? MICROVITORIAS[slug] : null;
  if (!p) throw new Error("onboarding_produto_desconhecido");
  const subject = "Seu primeiro resultado com o " + p.nome + " (15 minutos)";
  const text = [
    "Olá!",
    "",
    // Sem o nome da plataforma em texto livre: hasCheckoutCta trata qualquer menção fora das frases oficiais
    // como chamada de compra. "Minhas compras" é o nome da área de download, citado na política (DEC-06).
    "Seu " + p.nome + " já está disponível para download na área Minhas compras.",
    "Para o primeiro resultado ainda hoje, abra o arquivo 'Comece aqui' e depois: " + p.arquivo + ".",
    p.acao,
    "",
    "Travou ou algum arquivo não abriu? Responda este e-mail ou escreva para " + SUPPORT_EMAIL + ".",
    "",
    "Equipe ZEVANORY",
    optOutUrl ? "Não quer receber orientações de uso? " + optOutUrl : "Não quer receber orientações de uso? Escreva para " + SUPPORT_EMAIL + ".",
  ].join("\n");
  return { subject, text };
}

// Conformidade do texto (12-B.1 e política única): nenhuma chamada de compra, preço, oferta ou frase proibida.
export function microvitoriaTextIssues(message) {
  const all = String(message?.subject || "") + "\n" + String(message?.text || "");
  const issues = [];
  if (hasCheckoutCta(all)) issues.push("chamada_de_compra");
  if (/R\$\s?\d/.test(all)) issues.push("preco");
  if (/garant(id[oa]|imos)\s+(de\s+)?(lucro|resultado|ganho)|ganhe\s+R?\$?|fature/i.test(all)) issues.push("promessa_de_ganho");
  for (const hit of bannedPolicyHits(all)) issues.push("frase_proibida:" + hit);
  return issues;
}

// Envio: sempre bloqueado pela constante de código. O remetente injetado nunca é chamado neste estado.
export async function dispatchMicrovitoria(plan, decision, { env, sender, recipient, optOutUrl } = {}) {
  if (!ONBOARDING_SEND_ENABLED || !onboardingEnabled(env)) return { sent: false, code: "SEND_DISABLED_BY_SOURCE" };
  if (plan?.status !== "planned" || decision?.action !== "send") return { sent: false, code: "NOT_DUE" };
  const message = renderMicrovitoria(plan.slug, { optOutUrl });
  if (microvitoriaTextIssues(message).length) return { sent: false, code: "TEXT_BLOCKED" };
  if (typeof sender !== "function") return { sent: false, code: "SENDER_MISSING" };
  const out = await sender({ to: recipient, ...message, idempotencyKey: plan.idempotency_key });
  return { sent: out?.ok === true, code: out?.ok === true ? "SENT" : "SEND_UNCERTAIN" };
}
