// ZEVANORY support knowledge: grounded answers about the public catalog.
// Every fact here mirrors what is published on vendas.zevanory.api.br (approved
// 2026-10-02). No generation, no guessing: unknown questions return a handoff instead of an
// invented answer.
// P13c: prazo, entrega e reembolso vêm SÓ de data/politica-unica.json (worker/politica-unica.mjs):
// a regra dos 7 dias (customer_wording.rule_7d),
// link de 72 h / um download com reenvio sem custo, confirmação imediata, Mercado Pago avisado
// imediatamente (só checkout próprio; compras em outra plataforma são reembolsadas por ela, sem nomear a
// Hotmart: hasCheckoutCta), crédito no prazo do emissor e resposta conclusiva em até 5 dias. Nenhuma resposta
// traz chamada de compra (/comprar, /assinar, Hotmart); com vendas fechadas (interruptor do
// proprietário, worker/sales-control.mjs) preço e conteúdo avisam que as vendas estão fechadas.
import { CLOSED_LABEL, SUPPORT_DELIVERY_ANSWER, SUPPORT_REFUND_ANSWER, SUPPORT_SUBSCRIPTION_DELIVERY_ANSWER, SUPPORT_SUBSCRIPTION_REFUND_ANSWER } from "./politica-unica.mjs";
import { readSalesSwitch } from "./sales-control.mjs";

const SALES_ORIGIN = "https://vendas.zevanory.api.br";
const SUPPORT_EMAIL = "suporte@zevanory.api.br";

const DELIVERY = SUPPORT_DELIVERY_ANSWER;
const REFUND = SUPPORT_REFUND_ANSWER;

export const SUPPORT_PRODUCTS = Object.freeze({
  "ia-na-pratica": { name: "IA na Prática", price_brl: 197, content: "Conteúdo prático para transformar IA em processos claros, repetíveis e úteis no trabalho e no negócio." },
  "vendas-na-pratica": { name: "Vendas na Prática", price_brl: 197, content: "Método prático para organizar os pedidos e oportunidades que chegam: atendimento, oferta e follow-up, com clareza de próxima ação." },
  "lucro-e-caixa": { name: "Lucro & Caixa", price_brl: 247, content: "Material prático para acompanhar entradas, saídas, margem e caixa com linguagem objetiva e rotina de decisão." },
  "combo-ia-vendas": { name: "Combo IA + Vendas", price_brl: 297, content: "Reúne IA na Prática e Vendas na Prática completos: os dois treinamentos, que se complementam e podem ser usados de forma independente." },
  "negocio-completo": { name: "Negócio Completo", price_brl: 397, content: "Pacote integrado para organizar uso de IA, processo comercial e gestão prática de lucro e caixa em uma única jornada." },
  "conteudo-pronto": { name: "Conteúdo Pronto (assinatura mensal)", price_brl: 197, content: "Serviço mensal automático: depois da confirmação do pagamento, você responde um formulário curto e recebe por e-mail, em minutos, 12 posts com legenda, 4 roteiros multicanal de venda e acompanhamento (cada um com versão curta e versão de e-mail, para canais autorizados pelos seus clientes, como e-mail, Instagram Direct, Telegram ou chat do site) e um calendário de 30 dias, no tom do seu negócio. Você revisa antes de usar; não há disparo automático. Renovação mensal automática, sem fidelidade: cancele quando quiser." },
});

// Most specific first: "como recebo o acesso depois de pagar" is delivery, not price.
const INTENTS = [
  ["refund", /\b(reembols|devolu|devolv|cancel|arrepend|garantia|desist|estorn)|dinheiro de volta/i],
  ["limits", /\b(substitu\w*|contador|contabilidade|contábil|consultori\w*|garant\w* que)/i],
  ["delivery", /\b(entreg|acesso|acessar|receb|download|baixar|chega|n[aã]o (veio|chegou))/i],
  ["price", /\b(pre[cç]o|valor|quanto|custa|custo|pagar|parcel)/i],
  ["content", /\b(conte[uú]do|inclui|inclu[ií]d|o que (vem|tem)|m[oó]dulo|material|aprend|serve)/i],
];

const brl = (n) => "R$ " + Number(n).toFixed(2).replace(".", ",");

export function resolveProduct(text) {
  const t = String(text || "").toLowerCase();
  if (SUPPORT_PRODUCTS[t]) return t;
  if (/conte[uú]do pronto|assinatura|posts? (prontos?|para redes)/.test(t)) return "conteudo-pronto";
  if (/combo/.test(t)) return "combo-ia-vendas";
  if (/completo/.test(t)) return "negocio-completo";
  if (/lucro|caixa/.test(t)) return "lucro-e-caixa";
  if (/vendas?\s+na\s+pr[aá]tica/.test(t)) return "vendas-na-pratica";
  if (/\bia\b|intelig[eê]ncia/.test(t)) return "ia-na-pratica";
  return null;
}

export function answerSupportQuestion({ product, question, salesOpen } = {}) {
  const q = String(question || "").slice(0, 500);
  const slug = resolveProduct(product) || resolveProduct(q);
  const intent = (INTENTS.find(([, re]) => re.test(q)) || [null])[0];
  if (!intent) {
    return { answered: false, intent: null, product: slug, answer: `Não tenho uma resposta segura para isso. Fale com o suporte em ${SUPPORT_EMAIL}.`, handoff: true };
  }
  if (slug === "conteudo-pronto" && (intent === "refund" || intent === "delivery")) {
    const answer = intent === "refund" ? SUPPORT_SUBSCRIPTION_REFUND_ANSWER : SUPPORT_SUBSCRIPTION_DELIVERY_ANSWER;
    return { answered: true, intent, product: slug, answer, sources: [`${SALES_ORIGIN}/conteudo-pronto`], handoff: false };
  }
  if (intent === "limits") {
    return { answered: true, intent, product: slug, answer: "Não. Os materiais da ZEVANORY ajudam na gestão do dia a dia, mas não substituem contador, obrigações fiscais nem consultoria individual, e não prometem resultado financeiro: o resultado depende da aplicação no seu negócio.", sources: [slug ? `${SALES_ORIGIN}/${slug}` : `${SALES_ORIGIN}/solucoes`], handoff: false };
  }
  if (intent === "refund" || intent === "delivery") {
    return { answered: true, intent, product: slug, answer: intent === "refund" ? REFUND : DELIVERY, sources: [intent === "refund" ? "https://zevanory.api.br/pedir-reembolso" : "https://zevanory.api.br/entrega/reenviar", slug ? `${SALES_ORIGIN}/${slug}` : `${SALES_ORIGIN}/solucoes`], handoff: false };
  }
  if (!slug) {
    return { answered: false, intent, product: null, answer: "Sobre qual produto? IA na Prática, Vendas na Prática, Lucro & Caixa, Combo IA + Vendas ou Negócio Completo.", handoff: false, needs_product: true };
  }
  const p = SUPPORT_PRODUCTS[slug];
  const base = intent === "price" ? `${p.name} custa ${brl(p.price_brl)} (preço de tabela).` : `${p.name}: ${p.content}`;
  // Fail-closed only when the caller knows the switch is closed (false); unknown leaves the fact as is.
  const answer = salesOpen === false ? `${base} No momento, ${CLOSED_LABEL}.` : base;
  return { answered: true, intent, product: slug, answer, sources: [`${SALES_ORIGIN}/${slug}`], handoff: false };
}

export async function handleSupportKnowledge(request, env = {}) {
  const url = new URL(request.url);
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-zevanory-support-contract": "knowledge-v1" };
  if (request.method !== "GET") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: { ...headers, allow: "GET" } });
  const question = url.searchParams.get("q") || "";
  if (!question.trim()) {
    return new Response(JSON.stringify({ service: "zevanory-support-knowledge", products: Object.keys(SUPPORT_PRODUCTS), usage: "/api/support/knowledge?product=<slug>&q=<pergunta>" }), { status: 200, headers });
  }
  const salesOpen = (await readSalesSwitch(env).catch(() => null))?.enabled === true;
  const result = answerSupportQuestion({ product: url.searchParams.get("product") || "", question, salesOpen });
  return new Response(JSON.stringify(result), { status: 200, headers });
}
