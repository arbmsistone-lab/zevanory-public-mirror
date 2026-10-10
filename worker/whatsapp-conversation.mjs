// ZEVANORY WhatsApp conversation: a sales and support attendant grounded on the
// approved catalog. The model may phrase, qualify, recommend and guide, but every
// price, link and policy it states is validated against the published facts; any
// reply that fails validation is replaced by the deterministic grounded answer.
import { SUPPORT_PRODUCTS, answerSupportQuestion } from "./support-knowledge.mjs";

const SALES_ORIGIN = "https://vendas.zevanory.api.br";
const SUPPORT_EMAIL = "suporte@zevanory.api.br";
const WHATSAPP_UTM = "?utm_source=whatsapp&utm_medium=chat";
// Exact SKUs from sales-public-worker.mjs; never generate arbitrary checkout targets.
export const OFFICIAL_PURCHASE_SKUS = Object.freeze({"ia-na-pratica":"ZEV-IA-011","vendas-na-pratica":"ZEV-VEN-011","lucro-e-caixa":"ZEV-LCX-011","combo-ia-vendas":"ZEV-CMB-011","negocio-completo":"ZEV-NGC-011"});
export const purchaseLinkFor = (slug, salesOpen = false) => salesOpen === true && OFFICIAL_PURCHASE_SKUS[slug] ? `${SALES_ORIGIN}/comprar/${OFFICIAL_PURCHASE_SKUS[slug]}${WHATSAPP_UTM}` : null;
const MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct"];
const HISTORY_TURNS = 10;
const ALLOWED_PRICES = new Set(Object.values(SUPPORT_PRODUCTS).map((p) => p.price_brl));
const ALLOWED_URLS = new Set(["https://zevanory.api.br/pedir-reembolso", "https://zevanory.api.br/entrega/reenviar", SALES_ORIGIN, `${SALES_ORIGIN}/`, `${SALES_ORIGIN}/solucoes`, `${SALES_ORIGIN}/reembolso`, `${SALES_ORIGIN}/privacidade`, `${SALES_ORIGIN}/termos`, ...Object.keys(SUPPORT_PRODUCTS).map((slug) => `${SALES_ORIGIN}/${slug}`), ...Object.values(OFFICIAL_PURCHASE_SKUS).map((sku) => `${SALES_ORIGIN}/comprar/${sku}${WHATSAPP_UTM}`)]);

const brl = (n) => "R$ " + Number(n).toFixed(2).replace(".", ",");

export function catalogFacts({ salesOpen = false } = {}) {
  const lines = Object.entries(SUPPORT_PRODUCTS).map(([slug, p]) => `- ${p.name}: ${brl(p.price_brl)}. ${p.content} Página: ${SALES_ORIGIN}/${slug}${salesOpen ? `. Link de compra: ${purchaseLinkFor(slug, true)}` : ""}`);
  return [
    "CATÁLOGO OFICIAL (únicos produtos e preços que existem):",
    ...lines,
    "",
    "POLÍTICAS OFICIAIS:",
    "- Produtos 100% digitais. Após o pagamento confirmado pelo Mercado Pago, o cliente recebe por e-mail um link seguro (válido por 72 horas) para baixar o material. Novo link: https://zevanory.api.br/entrega/reenviar (código do pedido + e-mail da compra).",
    "- Direito de arrependimento: até 7 dias após a compra, reembolso integral pelo mesmo meio de pagamento (art. 49 do CDC). Pedido pelo link https://zevanory.api.br/pedir-reembolso, com o código do pedido e o e-mail do pagamento.",
    `- Suporte humano: ${SUPPORT_EMAIL}.`,
    "- Combo IA + Vendas reúne IA na Prática + Vendas na Prática. Negócio Completo reúne IA, vendas e Lucro & Caixa.",
    salesOpen
      ? "- COMPRA: as vendas estão abertas. Informe o link /comprar/SKU do produto exato, fornecido no catálogo, somente na resposta à pessoa que chamou."
      : "- COMPRA: as vendas ainda não foram abertas. Não envie link de pagamento. Diga que as compras abrem em breve e que o cliente pode voltar à página do produto ou chamar aqui a qualquer momento. Não prometa avisar depois.",
  ].join("\n");
}

export function systemPrompt({ salesOpen = false, voice = false, fact = "" } = {}) {
  return [
    "Você é o atendimento da ZEVANORY no WhatsApp: consultor de vendas e suporte, humano no tom, direto e gentil.",
    "Objetivo: entender a necessidade do cliente, orientar, tirar dúvidas e recomendar o produto certo do catálogo, conduzindo para a compra sem pressão.",
    "Atenda exclusivamente quem iniciou a conversa e está na janela de atendimento permitida pela Meta. Não envie mensagens frias, campanhas em massa ou seguimentos não solicitados.",
    "Regras obrigatórias:",
    "1. Responda sempre em português do Brasil.",
    "2. Use SOMENTE os fatos do catálogo e das políticas abaixo. Nunca invente produto, preço, desconto, prazo, bônus, garantia ou link.",
    "3. Se não souber, diga que vai encaminhar para o suporte humano e informe o e-mail.",
    "4. Faça no máximo uma pergunta por mensagem, para entender o negócio do cliente (ramo, objetivo, maior dificuldade).",
    "5. Ao recomendar, diga por que aquele produto resolve o problema citado e informe o preço exato do catálogo.",
    "6. Não use markdown, listas longas ou emojis em excesso. Seja curto: até 4 frases.",
    voice ? "7. A resposta será convertida em áudio: escreva como fala natural, sem links, sem símbolos; diga os valores por extenso apenas se ficar natural." : "7. Pode incluir no final o link da página do produto recomendado, exatamente como no catálogo.",
    "",
    catalogFacts({ salesOpen }),
    fact ? `\nFATO VERIFICADO PARA A PERGUNTA ATUAL (use-o): ${fact}` : "",
  ].join("\n");
}

// Every R$ value must be a catalog price and every URL must be an official page.
export function validateReply(text) {
  const body = String(text || "").trim();
  const issues = [];
  if (!body) issues.push("empty");
  if (body.length > 1200) issues.push("too_long");
  if ((body.replace(/https?:\/\/[^\s)>\]]+/gi, "").match(/\?/g)||[]).length > 1) issues.push("multiple_questions");
  for (const m of body.matchAll(/R\$\s*([\d.]+)(?:,(\d{1,2}))?/g)) {
    const value = Number(m[1].replace(/\./g, ""));
    const cents = Number(m[2] || 0);
    if (cents !== 0 || !ALLOWED_PRICES.has(value)) issues.push(`price:${m[0]}`);
  }
  for (const m of body.matchAll(/https?:\/\/[^\s)>\]]+/gi)) {
    const url = m[0].replace(/[.,;!?]+$/, "");
    if (!ALLOWED_URLS.has(url)) issues.push(`url:${url}`);
  }
  if (/\b(\d{1,3})\s*%\s*(de\s+)?(desconto|off)\b/i.test(body) || /\b(cupom|desconto|promo[cç][aã]o|gr[aá]tis|de gra[cç]a|brinde|b[oô]nus)\b/i.test(body)) issues.push("discount");
  // Prices only as "R$ <catalog value>" (checked above); any other money amount is invented.
  if (/\b\d+([.,]\d+)?\s*(reais|conto|pila)\b/i.test(body)) issues.push("money_outside_catalog");
  // The only guarantee/refund window is 7 days; never claim a refund was approved/done.
  for (const m of body.matchAll(/\b(\d{1,3})\s*dias?\b/gi)) if (Number(m[1]) !== 7 && /garant|reembols|arrepend|devolu/i.test(body)) issues.push(`days:${m[1]}`);
  if (/reembolso\s+(j[aá]\s+)?(foi\s+)?(aprovado|feito|liberado|realizado|conclu[ií]do)/i.test(body)) issues.push("refund_promise");
  // Only official contacts.
  for (const m of body.matchAll(/[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/gi)) if (!/^(suporte|contato)@zevanory\.api\.br$/i.test(m[0].replace(/[.,;!?]+$/, ""))) issues.push("email");
  if (/(\+?55\s*)?\(?\d{2}\)?\s*9?\d{4}[-\s]?\d{4}/.test(body.replace(/5588992545413|88\s*99254[-\s]?5413/g, ""))) issues.push("phone");
  return { ok: issues.length === 0, issues };
}

export function deterministicReply(question) {
  if (/\b(melhorar|aumentar|organizar|recomenda|ajud)/i.test(question) && /\bvendas?\b/i.test(question)) {
    const p = SUPPORT_PRODUCTS["vendas-na-pratica"];
    return { body: `Para melhorar suas vendas, recomendo ${p.name}, por ${brl(p.price_brl)}: ajuda a organizar prospecção, atendimento, oferta e follow-up. Qual dessas etapas é sua maior dificuldade hoje?\n\n${SALES_ORIGIN}/vendas-na-pratica`, intent: "recommendation", product: "vendas-na-pratica" };
  }
  const r = answerSupportQuestion({ question });
  if (r.answered) {
    const src = Array.isArray(r.sources) ? (r.intent === "delivery" ? r.sources[r.sources.length - 1] : r.sources[0]) : "";
    return { body: src ? `${r.answer}\n\n${src}` : r.answer, intent: r.intent, product: r.product || null };
  }
  if (r.needs_product) return { body: r.answer, intent: r.intent, product: null };
  return {
    body: "Olá! Aqui é o atendimento da ZEVANORY. Posso te ajudar a escolher entre IA na Prática, Vendas na Prática, Lucro & Caixa, Combo IA + Vendas e Negócio Completo. Me conta: qual é o seu negócio e o que mais quer melhorar hoje?",
    intent: "menu",
    product: null,
  };
}

async function sha256Hex(value) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value || "")));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function loadHistory(kv, contact) {
  if (!kv?.get || !contact) return [];
  try {
    const raw = await kv.get(`wa:conv:${await sha256Hex(contact)}`);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.slice(-HISTORY_TURNS) : [];
  } catch { return []; }
}

export async function saveHistory(kv, contact, history) {
  if (!kv?.put || !contact) return;
  try {
    await kv.put(`wa:conv:${await sha256Hex(contact)}`, JSON.stringify(history.slice(-HISTORY_TURNS)), { expirationTtl: 60 * 60 * 24 * 14 });
  } catch {}
}

function aiText(result) {
  if (typeof result === "string") return result;
  return String(result?.response ?? result?.result?.response ?? result?.choices?.[0]?.message?.content ?? "");
}

// A model can invent *another valid SKU* or include a checkout URL during a
// closed sale. Catalog allowlisting alone cannot authorize sending that link.
const checkoutUrls = (body) => [...String(body || "").matchAll(/https?:\/\/[^\s)>\]]+/gi)]
  .map(([url]) => url.replace(/[.,;!?]+$/, ""))
  .filter((url) => url.startsWith(`${SALES_ORIGIN}/comprar/`));
export function checkoutLinksAreAuthorized(body, { product = null, salesOpen = false, voice = false } = {}) {
  const links = checkoutUrls(body);
  if (links.length === 0) return true;
  const permitted = voice ? null : purchaseLinkFor(product, salesOpen);
  return Boolean(permitted && links.length === 1 && links[0] === permitted);
}

// Only the requested SKU can be sent, and never in a closed/voice reply.
// Unsafe model output gets a neutral, catalog-only response, not its proposed URL.
export function withVerifiedPurchaseLink(reply, { salesOpen = false, voice = false } = {}) {
  if (!reply?.body) return reply;
  if (!checkoutLinksAreAuthorized(reply.body, { product: reply.product, salesOpen, voice })) {
    return { ...reply, body: "Posso explicar os produtos e seus preços oficiais. Qual material você quer conhecer?", mode: "checkout_link_guarded" };
  }
  const link = purchaseLinkFor(reply.product, salesOpen);
  if (!link || voice || reply.body.includes(link)) return reply;
  const body = `${reply.body}\n\nComprar: ${link}`;
  return validateReply(body).ok ? { ...reply, body } : reply;
}

// Returns { body, mode, intent, product, model?, issues? }. Never throws.
export async function converse({ ai, question, history = [], salesOpen = false, voice = false } = {}) {
  const q = String(question || "").trim().slice(0, 2000);
  const grounded = deterministicReply(q);
  if (!ai?.run || !q) return withVerifiedPurchaseLink({ ...grounded, mode: "grounded" }, { salesOpen, voice });
  const known = answerSupportQuestion({ question: q });
  const fact = known.answered ? known.answer : "";
  const messages = [
    { role: "system", content: systemPrompt({ salesOpen, voice, fact }) },
    ...history.map((h) => ({ role: h.r === "a" ? "assistant" : "user", content: String(h.t || "").slice(0, 1200) })),
    { role: "user", content: q },
  ];
  const tried = [];
  for (const model of MODELS) {
    let timer;
    try {
      const out = await Promise.race([
        ai.run(model, { messages, max_tokens: 320, temperature: 0.4 }),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("ai_timeout")), 20000); }),
      ]);
      const text = aiText(out).replace(/\*\*/g, "").trim();
      const check = validateReply(text);
      if (check.ok && checkoutLinksAreAuthorized(text, { product: known.product || null, salesOpen, voice })) {
        return withVerifiedPurchaseLink({ body: text, mode: "ai_grounded", model, intent: known.intent || "conversation", product: known.product || null }, { salesOpen, voice });
      }
      tried.push(`${model}:${[...check.issues, ...(check.ok ? ["checkout_link_scope"] : [])].join("|")}`);
    } catch (error) {
      tried.push(`${model}:${String(error?.message || error).slice(0, 80)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return withVerifiedPurchaseLink({ ...grounded, mode: "grounded_fallback", issues: tried }, { salesOpen, voice });
}

// Text suitable for speech: no URLs or markdown.
export function speechText(body) {
 const text=String(body||"")
  .replace(/https?:\/\/\S+/g,"")
  .replace(/R\$\s*([\d.]+),00/g,(_,v)=>v.replace(/\./g,"")+" reais")
  .replace(/[*_#`>]/g,"")
  .replace(/\s+/g," ").trim();
 if(text.length<=350)return text;
 const head=text.slice(0,300);
 const sentenceEnd=Math.max(head.lastIndexOf("."),head.lastIndexOf("!"),head.lastIndexOf("?"));
 const summary=sentenceEnd>=80?head.slice(0,sentenceEnd+1):head.slice(0,head.lastIndexOf(" ")).replace(/[,;:]$/,"")+".";
 return summary+" Os detalhes estão na mensagem de texto.";
}

// Catalog voice must not vary with the AI's phrasing; written replies stay conversational.
export function voiceReplyBody(question, aiBody) {
  const known = answerSupportQuestion({ question });
  return known.answered && ["price", "delivery", "refund"].includes(known.intent)
    ? deterministicReply(question).body : aiBody;
}
