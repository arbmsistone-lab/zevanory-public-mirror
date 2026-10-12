// ZEVANORY support knowledge: grounded answers about the public catalog.
// Every fact here mirrors what is published on vendas.zevanory.api.br (approved
// 2026-10-02) and the refund policy (CDC art. 49). No generation, no guessing:
// unknown questions return a handoff instead of an invented answer.

const SALES_ORIGIN = "https://vendas.zevanory.api.br";
const SUPPORT_EMAIL = "suporte@zevanory.api.br";

const DELIVERY = "Entrega digital: após o pagamento ser confirmado pelo Mercado Pago, você recebe por e-mail um link seguro (válido por 72 horas) para baixar o material. Perdeu o e-mail ou o link expirou? Peça um novo link com o código do pedido e o e-mail da compra. Se você comprou pela Hotmart, o acesso chega pelo e-mail da Hotmart e fica em Minhas compras, na sua conta Hotmart.";
const REFUND = "Direito de arrependimento: você pode desistir em até 7 dias após a compra e recebe o reembolso integral pelo mesmo meio de pagamento (art. 49 do Código de Defesa do Consumidor). Para pedir, use o link de reembolso com o código do pedido (está no e-mail de entrega) e o e-mail do pagamento. Se você comprou pela Hotmart, peça o reembolso em Minhas compras, na sua conta Hotmart.";

export const SUPPORT_PRODUCTS = Object.freeze({
  "ia-na-pratica": { name: "IA na Prática", price_brl: 197, content: "Conteúdo prático para transformar IA em processos claros, repetíveis e úteis no trabalho e no negócio." },
  "vendas-na-pratica": { name: "Vendas na Prática", price_brl: 197, content: "Método prático para organizar prospecção, atendimento, oferta, follow-up e melhoria comercial com clareza de próxima ação." },
  "lucro-e-caixa": { name: "Lucro & Caixa", price_brl: 247, content: "Material prático para acompanhar entradas, saídas, margem e caixa com linguagem objetiva e rotina de decisão." },
  "combo-ia-vendas": { name: "Combo IA + Vendas", price_brl: 297, content: "Combina o método de IA e o processo de vendas para organizar prospecção, atendimento, oferta, follow-up e produção comercial." },
  "negocio-completo": { name: "Negócio Completo", price_brl: 397, content: "Pacote integrado para organizar uso de IA, processo comercial e gestão prática de lucro e caixa em uma única jornada." },
  "conteudo-pronto": { name: "Conteúdo Pronto (assinatura mensal)", price_brl: 197, content: "Serviço mensal automático: depois de assinar pela Hotmart, você responde um formulário curto e recebe por e-mail, em minutos, 12 posts com legenda, 4 mensagens de venda para WhatsApp e um calendário de 30 dias, no tom do seu negócio. Renovação mensal automática; cancelamento e reembolso (7 dias) pela sua conta Hotmart." },
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

export function answerSupportQuestion({ product, question } = {}) {
  const q = String(question || "").slice(0, 500);
  const slug = resolveProduct(product) || resolveProduct(q);
  const intent = (INTENTS.find(([, re]) => re.test(q)) || [null])[0];
  if (!intent) {
    return { answered: false, intent: null, product: slug, answer: `Não tenho uma resposta segura para isso. Fale com o suporte em ${SUPPORT_EMAIL}.`, handoff: true };
  }
  if (slug === "conteudo-pronto" && (intent === "refund" || intent === "delivery")) {
    const answer = intent === "refund"
      ? "Conteúdo Pronto: você tem 7 dias de garantia com reembolso integral, pedido direto na sua conta Hotmart (Minhas compras). Cancelar a assinatura também é pela Hotmart, quando quiser, sem multa."
      : "Conteúdo Pronto: depois do pagamento na Hotmart, você recebe por e-mail um link seguro para um formulário curto; em poucos minutos o pacote do mês chega no mesmo e-mail, também com um link seguro para consulta online.";
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
