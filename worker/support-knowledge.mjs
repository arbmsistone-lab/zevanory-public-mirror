// ZEVANORY support knowledge: grounded answers about the public catalog.
// Every fact here mirrors what is published on vendas.zevanory.api.br (approved
// 2026-10-02) and the refund policy (CDC art. 49). No generation, no guessing:
// unknown questions return a handoff instead of an invented answer.

const SALES_ORIGIN = "https://vendas.zevanory.api.br";
const SUPPORT_EMAIL = "suporte@zevanory.api.br";

const DELIVERY = "Entrega digital: após o pagamento ser confirmado pelo Mercado Pago, você recebe por e-mail um link seguro e temporário para baixar o material.";
const REFUND = "Direito de arrependimento: você pode desistir em até 7 dias após a compra e recebe o reembolso integral pelo mesmo meio de pagamento (art. 49 do Código de Defesa do Consumidor). Basta pedir pelo suporte.";

export const SUPPORT_PRODUCTS = Object.freeze({
  "ia-na-pratica": { name: "IA na Prática", price_brl: 197, content: "Conteúdo prático para transformar IA em processos claros, repetíveis e úteis no trabalho e no negócio." },
  "vendas-na-pratica": { name: "Vendas na Prática", price_brl: 197, content: "Método prático para organizar prospecção, atendimento, oferta, follow-up e melhoria comercial com clareza de próxima ação." },
  "lucro-e-caixa": { name: "Lucro & Caixa", price_brl: 247, content: "Material prático para acompanhar entradas, saídas, margem e caixa com linguagem objetiva e rotina de decisão." },
  "combo-ia-vendas": { name: "Combo IA + Vendas", price_brl: 297, content: "Combina o método de IA e o processo de vendas para organizar prospecção, atendimento, oferta, follow-up e produção comercial." },
  "negocio-completo": { name: "Negócio Completo", price_brl: 397, content: "Pacote integrado para organizar uso de IA, processo comercial e gestão prática de lucro e caixa em uma única jornada." },
});

// Most specific first: "como recebo o acesso depois de pagar" is delivery, not price.
const INTENTS = [
  ["refund", /\b(reembols|devolu|devolv|cancel|arrepend|garantia|desist)/i],
  ["delivery", /\b(entreg|acesso|acessar|receb|download|baixar|link|chega)/i],
  ["price", /\b(pre[cç]o|valor|quanto|custa|custo|pagar|parcel)/i],
  ["content", /\b(conte[uú]do|inclui|inclu[ií]d|o que (vem|tem)|m[oó]dulo|material|aprend|serve)/i],
];

const brl = (n) => "R$ " + Number(n).toFixed(2).replace(".", ",");

export function resolveProduct(text) {
  const t = String(text || "").toLowerCase();
  if (SUPPORT_PRODUCTS[t]) return t;
  if (/combo/.test(t)) return "combo-ia-vendas";
  if (/completo/.test(t)) return "negocio-completo";
  if (/lucro|caixa/.test(t)) return "lucro-e-caixa";
  if (/vendas?\s+na\s+pr[aá]tica/.test(t)) return "vendas-na-pratica";
  if (/\bia\b|intelig[eê]ncia/.test(t)) return "ia-na-pratica";
  return null;
}

export function answerSupportQuestion({ product, question } = {}) {
  const q = String(question || "").slice(0, 500);
  const slug = resolveProduct(product) || resolveProduct(q);
  const intent = (INTENTS.find(([, re]) => re.test(q)) || [null])[0];
  if (!intent) {
    return { answered: false, intent: null, product: slug, answer: `Não tenho uma resposta segura para isso. Fale com o suporte em ${SUPPORT_EMAIL}.`, handoff: true };
  }
  if (intent === "refund" || intent === "delivery") {
    return { answered: true, intent, product: slug, answer: intent === "refund" ? REFUND : DELIVERY, sources: [`${SALES_ORIGIN}/reembolso`, slug ? `${SALES_ORIGIN}/${slug}` : `${SALES_ORIGIN}/solucoes`], handoff: false };
  }
  if (!slug) {
    return { answered: false, intent, product: null, answer: "Sobre qual produto? IA na Prática, Vendas na Prática, Lucro & Caixa, Combo IA + Vendas ou Negócio Completo.", handoff: false, needs_product: true };
  }
  const p = SUPPORT_PRODUCTS[slug];
  const answer = intent === "price" ? `${p.name} custa ${brl(p.price_brl)} (preço de tabela).` : `${p.name}: ${p.content}`;
  return { answered: true, intent, product: slug, answer, sources: [`${SALES_ORIGIN}/${slug}`], handoff: false };
}

export function handleSupportKnowledge(request) {
  const url = new URL(request.url);
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-zevanory-support-contract": "knowledge-v1" };
  if (request.method !== "GET") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: { ...headers, allow: "GET" } });
  const question = url.searchParams.get("q") || "";
  if (!question.trim()) {
    return new Response(JSON.stringify({ service: "zevanory-support-knowledge", products: Object.keys(SUPPORT_PRODUCTS), usage: "/api/support/knowledge?product=<slug>&q=<pergunta>" }), { status: 200, headers });
  }
  const result = answerSupportQuestion({ product: url.searchParams.get("product") || "", question });
  return new Response(JSON.stringify(result), { status: 200, headers });
}
