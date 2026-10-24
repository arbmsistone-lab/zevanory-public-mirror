// Chat do site "Fale com a ZEVANORY": atendimento próprio em HTTPS no nosso domínio, no lugar do
// WhatsApp (conta banida pela Meta em 2026-10-10 depois que webhooks forjados pelo CI fizeram o robô
// enviar mensagens reais). Critérios de aceite: AVAL Sol 111 (2026-10-23).
//
// Caminho: página de vendas (vendas.zevanory.api.br, mesma origem) -> Worker de vendas (POST /api/chat*,
// proxy) -> service binding CORE -> https://chat.internal/api/chat* -> este módulo, no Worker central,
// que já hospeda o atendente (binding Workers AI, DATABASE_URL, Resend, interruptor canônico de vendas).
//
// Garantias (cada uma com teste e mutante em tests/site-chat*.test.mjs e scripts/ci/mutants_site_chat.py):
// * DESLIGADO por padrão: SITE_CHAT_ENABLED precisa ser "true" E a chave KV de emergência
//   site-chat:kill:v1 não pode valer "off" (KV ilegível = desligado). Desligado => 503 + e-mail/formulários.
// * Chat opcional: nunca é dependência de compra, entrega, cancelamento ou reembolso.
// * Nenhuma mensagem proativa: só responde a uma requisição da própria pessoa.
// * Verdade comercial: preço, disponibilidade, desconto, entrega, reembolso e prazos vêm de campos
//   determinísticos (data/politica-unica.json, data/products.json, SUPPORT_PRODUCTS). O texto gerado por
//   modelo (desligado por padrão, SITE_CHAT_GENERATIVE) só descreve conteúdo e passa por dois validadores.
// * sales_open é lido na autoridade canônica (/api/sales/status do Worker central) a CADA resposta;
//   erro, timeout ou resposta ambígua = fechado. Fechado + pergunta de preço/condição => frase exata do Sol.
// * Nunca gera /comprar/, /assinar/, checkout externo, desconto, urgência, reserva ou promessa.
// * Escalonamento obrigatório (reclamação, arrependimento, cancelamento, reembolso, LGPD, jurídico,
//   pagamento, entrega, segurança, dado sensível, fonte ausente/conflitante, baixa confiança, segunda
//   correção, pedido de humano): protocolo idempotente por sessão, confirmação na tela e por e-mail,
//   fila exclusiva do proprietário (PostgreSQL + /api/admin/site-chat), SLA real de até 5 dias; o robô
//   nunca nega um direito do consumidor.
// * Limites em PostgreSQL (uma instrução por mensagem; ZERO escrita em KV por mensagem; a cota diária de
//   1.000 escritas KV é compartilhada): por sessão, por IP pseudônimo rotativo (HMAC diário), global,
//   turnos, tamanho, concorrência por isolate e orçamento diário de IA. Disjuntor desliga a geração.
// * Retenção: conversa não escalada 30 dias; ticket 180 dias após o encerramento (retenção legal suspende);
//   contadores 2 dias. Job diário runSiteChatRetention.
// * Logs sem conteúdo e sem dado pessoal: só evento e campos enumerados (siteChatLog).
// * Isolamento de testes: produção recusa tokens/eventos sintéticos (sbx_, cabeçalhos de teste, e-mails de
//   domínios reservados); o modo sandbox (SITE_CHAT_SANDBOX=true) exige um sink injetado e nunca usa o Resend.
import CHAT_POLICY from "../data/site-chat-policy.json" with { type: "json" };
import PRODUCTS_JSON from "../data/products.json" with { type: "json" };
import { SUPPORT_PRODUCTS, answerSupportQuestion, resolveProduct } from "./support-knowledge.mjs";
import { validateReply } from "./whatsapp-conversation.mjs";
import {
  CLOSED_LABEL, CONFIRMATION_TEXT, DELIVERY_TEXT, LEGAL_IDENTITY, REFUND_TEXT, RULE_LINE, SLA_TEXT, SUPPLIER,
  SUPPORT_DELIVERY_ANSWER, SUPPORT_REFUND_ANSWER, SUPPORT_SUBSCRIPTION_DELIVERY_ANSWER, SUPPORT_SUBSCRIPTION_REFUND_ANSWER,
  SUBSCRIPTION_DELIVERY_TEXT, SUBSCRIPTION_REFUND_TEXT, hasCheckoutCta
} from "./politica-unica.mjs";

export const CHAT = CHAT_POLICY;
const L = CHAT.limits;
export const CLOSED_PRICE_ANSWER = CHAT.closed_price_answer;
export const KILL_KV_KEY = "site-chat:kill:v1";
export const CATEGORIES_OFF_KV_KEY = "site-chat:categories-off:v1";
const SALES_ORIGIN = "https://vendas.zevanory.api.br";
const CORE_ORIGIN = "https://zevanory.api.br";
const SUPPORT_EMAIL = SUPPLIER.email;
const FROM = "ZEVANORY suporte <suporte@zevanory.api.br>";
export const FALLBACK = Object.freeze({ ...CHAT.fallback });
export const ESCALATION_CATEGORIES = Object.freeze([
  "complaint", "withdrawal", "cancellation", "refund", "lgpd", "legal", "payment", "delivery", "security",
  "sensitive_data", "source_conflict", "low_confidence", "repeated_correction", "human_request"
]);
// Categorias que o proprietário pode desligar (env SITE_CHAT_CATEGORIES_OFF ou KV site-chat:categories-off:v1,
// lista separada por vírgula). "generative" desliga o modelo; as demais trocam a resposta pelo canal de e-mail.
export const SWITCHABLE_CATEGORIES = Object.freeze(["generative", "content", "recommendation", "condition", "policy", "handoff"]);

// ---------- utilidades ----------
const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const clean = (s, max) => String(s ?? "").normalize("NFKC").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").replace(/[ \t]+/g, " ").trim().slice(0, max);
const json = (status, body, extra = {}) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-robots-tag": "noindex", ...extra }
});
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function sha256Hex(v) { return hex(await crypto.subtle.digest("SHA-256", enc.encode(String(v)))); }
async function hmacHex(secret, v) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(String(v))));
}
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fill = (s, map) => String(s).replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : m));

// Logs: só evento + campos enumerados/numéricos. Nunca mensagem, e-mail, IP, token, protocolo ou transcrição.
const LOG_FIELDS = new Set(["category", "mode", "status", "reason", "n", "created", "dep", "sandbox", "kind", "deleted"]);
export function siteChatLog(event, fields = {}) {
  const safe = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!LOG_FIELDS.has(k)) continue;
    if (typeof v === "number" || typeof v === "boolean") safe[k] = v;
    else if (typeof v === "string" && /^[a-z0-9_:.-]{0,48}$/.test(v)) safe[k] = v;
  }
  try { console.log("SITE_CHAT", JSON.stringify({ event: String(event).slice(0, 48), ...safe })); } catch {}
}

// ---------- catálogo aprovado (fonte única, versionado) ----------
// FNV-1a 64 bits síncrono: impressão digital estável do catálogo, conferida contra a aprovada.
function fnv64(str) {
  let h = 0xcbf29ce484222325n;
  const p = 0x100000001b3n, m = (1n << 64n) - 1n;
  for (const b of enc.encode(str)) { h ^= BigInt(b); h = (h * p) & m; }
  return h.toString(16).padStart(16, "0");
}
export function buildCatalog({ support = SUPPORT_PRODUCTS, products = PRODUCTS_JSON, policy = CHAT } = {}) {
  const official = new Map();
  for (const p of products?.products || []) official.set(p.slug, { name: p.name, price: Number(p.price) });
  if (products?.subscription?.slug) official.set(products.subscription.slug, { name: products.subscription.name, price: Number(products.subscription.price) });
  const items = {}, conflicts = [], missing = [];
  for (const [slug, p] of Object.entries(support || {})) {
    const o = official.get(slug);
    if (!o) { missing.push(slug); continue; }
    if (!Number.isFinite(o.price) || o.price !== Number(p.price_brl)) conflicts.push(slug);
    items[slug] = { slug, name: p.name, price: Number(p.price_brl), content: p.content, closedSummary: policy?.closed_summaries?.[slug] || p.content, page: `${SALES_ORIGIN}/${slug}` };
  }
  for (const slug of official.keys()) if (!support?.[slug]) missing.push(slug);
  const canon = Object.keys(items).sort().map((s) => [s, items[s].name, items[s].price, items[s].content, items[s].closedSummary, official.get(s)?.price].join("|")).join("\n");
  const fingerprint = fnv64(canon);
  const approved = policy?.approved_sources?.catalog_fingerprint;
  const stale = fingerprint !== approved;
  return Object.freeze({ items, conflicts, missing, fingerprint, approved, stale, ok: !stale && !conflicts.length && !missing.length });
}
export const CATALOG = buildCatalog();
// Versão das fontes registrada internamente em cada sessão (impressão do catálogo + hash da política).
export const SOURCE_VERSION = `cat:${CATALOG.fingerprint};pol:${fnv64([REFUND_TEXT, DELIVERY_TEXT, SLA_TEXT, CLOSED_PRICE_ANSWER].join("|")).slice(0, 12)}`;

// Textos de fonte que podem conter prazos/quantidades (o validador só aceita prazo que venha deles).
function sourceTexts(catalog) {
  const k = answerSupportQuestion({ question: "isso substitui meu contador?" }).answer;
  return [SUPPORT_REFUND_ANSWER, SUPPORT_DELIVERY_ANSWER, SUPPORT_SUBSCRIPTION_DELIVERY_ANSWER, SUPPORT_SUBSCRIPTION_REFUND_ANSWER,
    SLA_TEXT, REFUND_TEXT, DELIVERY_TEXT, CONFIRMATION_TEXT, RULE_LINE, SUBSCRIPTION_DELIVERY_TEXT, SUBSCRIPTION_REFUND_TEXT, k,
    ...Object.values(catalog.items).flatMap((i) => [i.content, i.closedSummary])].filter(Boolean).sort((a, b) => b.length - a.length);
}

// ---------- validador do site (somado ao validador do atendente WhatsApp) ----------
const ALLOWED_URL_SET = new Set([SALES_ORIGIN, `${SALES_ORIGIN}/`, `${SALES_ORIGIN}/solucoes`, `${SALES_ORIGIN}/termos`, `${SALES_ORIGIN}/privacidade`, `${SALES_ORIGIN}/reembolso`,
  `${CORE_ORIGIN}/pedir-reembolso`, `${CORE_ORIGIN}/entrega/reenviar`, ...Object.keys(SUPPORT_PRODUCTS).map((s) => `${SALES_ORIGIN}/${s}`)]);
const CHECKOUT_RE = /\/comprar\b|\/assinar\b|checkout|pay\.[a-z]|mercadopago\.com|mpago\.la|hotmart|kiwify|eduzz|monetizze|stripe|asaas|pagseguro|paypal|picpay/i;
export function validateSiteReply(text, { salesOpen = false, catalog = CATALOG } = {}) {
  const body = String(text || "").trim();
  const issues = [];
  if (!body) issues.push("empty");
  if (body.length > 1500) issues.push("too_long");
  if (hasCheckoutCta(body) || CHECKOUT_RE.test(body)) issues.push("checkout");
  for (const m of body.matchAll(/https?:\/\/[^\s)>\]]+/gi)) {
    const url = m[0].replace(/[.,;!?]+$/, "");
    if (!ALLOWED_URL_SET.has(url)) issues.push("url");
  }
  const n = norm(body);
  if (!salesOpen && (/r\$|\breais\b|\bbrl\b|\b\d+\s*(conto|pila|mil)\b|\bpreco de tabela\b/.test(n))) issues.push("money_closed");
  if (salesOpen) {
    const prices = new Set(Object.values(catalog.items).map((i) => i.price));
    for (const m of body.matchAll(/R\$\s*([\d.]+)(?:,(\d{1,2}))?/g)) if (Number(m[2] || 0) !== 0 || !prices.has(Number(m[1].replace(/\./g, "")))) issues.push("price_outside_catalog");
    if (/\b\d+([.,]\d+)?\s*(reais|conto|pila)\b/.test(n)) issues.push("money_outside_catalog");
  }
  if (/desconto|cupo(m|ns)|promoc|black friday|bonus|brinde|gratis|de graca|ultimas? vagas?|so hoje|por tempo limitado|reserv(a|ar|e)\b|garanta (ja|a sua|o seu|agora)|aproveite|condicao especial|oferta especial/.test(n)) issues.push("discount_or_urgency");
  if (!salesOpen && /\b(compre|comprar agora|pode comprar|disponivel para (compra|venda)|a venda agora|finalizar (a )?compra|garanta|assine agora|contrate agora|faca seu pedido|link de (compra|pagamento))\b/.test(n)) issues.push("transactional_closed");
  if (/\b(garanto|garantimos|prometo|prometemos|com certeza (vai|voce vai)|resultado garantido|sem risco|vai vender mais|lucro garantido)\b/.test(n)) issues.push("promise");
  if (/(nao (tem|ha|existe) (direito|reembolso|devolucao|cancelamento)|sem direito a|nao (e|eh) possivel (cancelar|reembols|devolver|desistir)|nao (fazemos|aceitamos|fazem|oferecemos) (reembolso|devolucao|cancelamento)|prazo (ja )?(expirou|acabou|passou|terminou)|fora do prazo|seu pedido (foi )?negado)/.test(n)) issues.push("right_denied");
  let rest = body;
  for (const s of sourceTexts(catalog)) rest = rest.split(s).join(" ");
  const nr = norm(rest);
  if (/\b(\d+|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|doze|quinze|vinte|trinta|quarenta|sessenta|noventa)\s*(minutos?|horas?|dias?( uteis| corridos)?|semanas?|meses|mes|anos?)\b/.test(nr)) issues.push("deadline_outside_source");
  if (/\d+\s*%/.test(rest)) issues.push("percent");
  // Validador do atendente existente (preço do catálogo, e-mail/telefone oficiais, frases de política proibidas,
  // promessa de reembolso aprovado). URLs e tamanho já são conferidos acima com regras mais estritas.
  for (const i of validateReply(body).issues) if (!/^(url:|too_long$|multiple_questions$)/.test(i)) issues.push("base:" + i.replace(/[^a-z_:]/gi, "").slice(0, 32));
  return { ok: issues.length === 0, issues: [...new Set(issues)] };
}

// ---------- classificação ----------
const RX = {
  injection: /(ignor|desconsider|esquec)\w* (as |todas as |suas |essas |tudo )?(instruc|regras|orientac|anterior)|system prompt|prompt do sistema|seu prompt|voce agora e|aja como|finja (que|ser)|modo (desenvolvedor|dev|admin)|jailbreak|<\s*\/?\s*(system|assistant)\b|\bdan\b mode/,
  human_request: /\b(falar|conversar|atendimento|atender|chamar|quero)\b.{0,24}\b(humano|humana|pessoa|atendente|alguem da equipe|gente de verdade|suporte humano)\b|^(humano|atendente|pessoa)\b/,
  complaint: /reclam|absurd|pessim|horrivel|procon|reclame aqui|golpe|fraude|engan(o|ad|ar)|insatisf|descaso|vergonha|desrespeito|palhacada/,
  withdrawal: /arrepend|desist|devolv|devoluc|garantia|nao gostar/,
  cancellation: /cancel/,
  refund: /reembols|estorn|dinheiro de volta|chargeback|contest(ar|acao)|ressarc/,
  lgpd: /\blgpd\b|meus dados|dados pessoais|(apagar|excluir|deletar|remover|corrigir|acessar|ver) (todos )?(os )?(meus )?dados|titular dos dados|\banpd\b|portabilidade|tratamento de dados|encarregado/,
  legal: /advogad|processar|processo (judicial|contra)|juridic|na justica|juizado|extrajudicial|danos morais|direitos? do consumidor|\bcdc\b|notificacao judicial|acao judicial/,
  payment: /paguei|pagamento (nao|foi|recus|pend|aprov|dupl|caiu|cai\b|sumiu|travou|deu erro)|cobranc|cobrad|cobraram|me cobr|fatura|comprovante|nota fiscal|recibo|cartao (foi|clonad|recusad)|pix (que )?(fiz|feito|enviado|pago)|boleto (pago|vencid)|valor (debitado|descontado)/,
  delivery: /nao (recebi|chegou|veio|consigo (acessar|baixar|abrir|entrar))|cade (meu|o|a) (produto|acesso|link|material|arquivo)|link (expir|venc|quebr|nao funciona|nao abre)|reenvi|nao (achei|encontro) (o )?(e-?mail|acesso|material)|arquivo (corromp|com defeito|nao abre)|ainda nao (recebi|chegou)/,
  security: /hacke|invadi|phishing|vazament|virus|malware|suspeit|clonad|roub(o|aram)|minha conta foi|senha (vazou|roubada)|e-?mail falso/,
};
const POLICY_INFO = /\b(como funciona|como (e|sera|fica) (a|o)|qual (e )?(a|o) (politica|prazo|regra)|quais (sao )?(as )?regras|quantos dias|tem garantia|politica de|posso (me )?arrepender|posso desistir|da pra (me )?arrepender|e possivel (me )?arrepender|como recebo|como (vou )?receber|como e feita|como (e|eh) a entrega|como (e|eh) o reembolso|se eu nao gostar|e se eu nao gostar|tem devolucao|como cancelo a assinatura|como cancelar a assinatura|posso cancelar)\b/;
const FIRST_PERSON_CASE = /\b(quero|preciso|exijo|solicito|pe[cç]o|meu|minha|comprei|paguei|fiz (a|o|um|uma) (compra|pedido|pagamento)|nao recebi|ja comprei)\b/;
const CORRECTION = /\b(nao (foi|era|e|eh) (isso|bem isso|o que (eu )?perguntei)|resposta errada|ta errad\w*|esta errad\w*|errou|voce nao entendeu|nao entendeu|nao respondeu|nada a ver|nao e isso)\b/;
const SLA_Q = /\b(prazo de (resposta|atendimento|retorno)|quanto tempo (voces |o suporte )?(demora|demoram|leva|levam) (para|pra) responder|em quanto tempo (voces )?respondem|\bsla\b)/;
const GREETING = /^(oi+|ola|bom dia|boa tarde|boa noite|e ai|hello|hi|hey|tudo bem|opa|salve|oie)\b[\s!?.,]*(tudo bem\??)?[\s!?.,]*$/;
const MENU_Q = /\b((quais|que) (sao (os|as) )?(produtos|solucoes|materiais)|o que voces (vendem|tem|oferecem)|o que vcs (vendem|tem)|me mostra (as )?solucoes|catalogo)\b/;
const CONDITION = /(preco|valor|quanto|custa|custo|investimento|parcel|forma(s)? de pagamento|como (eu )?(pago|pagar|faco para pagar)|aceita(m)? (pix|cartao|boleto)|desconto|cupom|promoc|black friday|bonus|brinde|gratis|de graca|\bcomprar\b|\bcompro\b|\bcompra\b|adquirir|assinar|assinatura (custa|sai)|contratar|link de (compra|pagamento)|checkout|disponivel para|tem vaga|reserv|quando (abre|abrem|volta|voltam)|abrir as vendas|vendas (abertas|fechadas)|esta a venda|ta a venda|posso pagar|pagar com|sai por|tabela)/;
const CONTENT = /(conteudo|o que (vem|tem|inclui|e|eh|ensina|aprendo|vou aprender)|inclui|incluid|modulo|material|aprend|serve para|serve pra|para quem|pra quem|publico|requisito|preciso saber|formato|como funciona o|como funciona a assinatura|do que se trata|explica|explique|me fala (do|da|sobre)|detalhes|sobre o|sobre a|fala sobre|e bom|vale a pena|diferenca|compar|qual (e )?melhor|qual escolher|qual (eu )?devo)/;
const LIMITS = /\b(substitu\w*|contador|contabilidade|contabil|consultori\w*|garant\w* que|vou vender mais|resultado garantido|vou ficar rico)/;
// Necessidade -> produto (somente para recomendar entre os itens do catálogo).
const NEEDS = [
  [/(ia e vendas|ia \+ vendas|inteligencia artificial e vendas|combo)/, "combo-ia-vendas"],
  [/(tudo|completo|todas as areas|ia, vendas e (caixa|financeiro)|pacote integrado|negocio inteiro)/, "negocio-completo"],
  [/(redes sociais|instagram|\bposts?\b|\bpostagens?\b|\blegendas?\b|calendario de conteudo|conteudo pronto|o que postar|tiktok|facebook)/, "conteudo-pronto"],
  [/(caixa|lucro|margem|dinheiro|financeir|sobra|gastos?|despesas?|fluxo|precificar|preco de venda|contas)/, "lucro-e-caixa"],
  [/(vend|cliente|prospec|atendimento|follow|oferta|fechar negocio|perco cliente|nao volta|fideliz|captar)/, "vendas-na-pratica"],
  [/(\bia\b|inteligencia artificial|chatgpt|gpt|automatiz|ferramenta de ia|comecando com ia|processos)/, "ia-na-pratica"],
];
// Dados sensíveis/proibidos: removidos ANTES de qualquer armazenamento.
const luhn = (d) => { let s = 0, alt = false; for (let i = d.length - 1; i >= 0; i--) { let x = d.charCodeAt(i) - 48; if (alt) { x *= 2; if (x > 9) x -= 9; } s += x; alt = !alt; } return s % 10 === 0; };
export function redactSensitive(text) {
  let found = false;
  let out = String(text || "");
  out = out.replace(/\b(?:\d[ .-]?){13,19}\b/g, (m) => { const d = m.replace(/\D/g, ""); if (d.length >= 13 && d.length <= 19 && luhn(d)) { found = true; return "[removido]"; } return m; });
  out = out.replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, () => { found = true; return "[removido]"; });
  out = out.replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, () => { found = true; return "[removido]"; });
  out = out.replace(/\b(senha|password|pin|cvv|codigo de seguranca|código de segurança)\b(\s*(e|é|:|=|eh)?\s*)\S+/gi, (m, k) => { found = true; return k + " [removido]"; });
  out = out.replace(/\b(rg|cnh|passaporte)\b(\s*(n[ºo°.]*|numero|número|:)?\s*)[\dA-Za-z.-]{5,}/gi, (m, k) => { found = true; return k + " [removido]"; });
  if (/\b(hiv|diagnostic\w*|doenca|doença|laudo|cid[ -]?\d|religiao|religião|orientacao sexual|orientação sexual|biometri\w*)\b/i.test(out)) found = true;
  // E-mail e telefone digitados na conversa também não ficam na transcrição (o e-mail só entra pelo formulário).
  out = out.replace(/[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/gi, "[e-mail removido]");
  out = out.replace(/\+?\d[\d\s().-]{8,}\d/g, (m) => (m.replace(/\D/g, "").length >= 10 ? "[telefone removido]" : m));
  return { text: out, sensitive: found };
}

export function classify(message, { corrections = 0 } = {}) {
  const n = norm(message);
  if (!n) return { kind: "empty" };
  const red = redactSensitive(message);
  if (red.sensitive) return { kind: "escalate", category: "sensitive_data" };
  if (RX.injection.test(n)) return { kind: "injection" };
  if (CORRECTION.test(n) && corrections + 1 >= 2) return { kind: "escalate", category: "repeated_correction", correction: true };
  const correction = CORRECTION.test(n);
  for (const cat of ["human_request", "security", "legal", "lgpd", "complaint", "payment"]) if (RX[cat].test(n)) return { kind: "escalate", category: cat, correction };
  for (const cat of ["withdrawal", "cancellation", "refund", "delivery"]) {
    const strong = RX[cat].test(n);
    const weak = cat === "delivery" && (/\b(entrega\w*|acesso|acessar|acesso ao|download|baixar)\b/.test(n) || /como (vou |eu )?receb/.test(n));
    if (!strong && !weak) continue;
    // Pergunta informativa ("posso me arrepender?", "como é a entrega?") recebe a política e o botão humano;
    // pedido ou problema ("quero cancelar", "não recebi", "comprei e onde acesso?") escalona com protocolo.
    const info = POLICY_INFO.test(n) || !strong;
    if (info && !FIRST_PERSON_CASE.test(n)) return { kind: "policy", topic: cat === "delivery" ? "delivery" : "refund", correction };
    return { kind: "escalate", category: cat, correction };
  }
  if (SLA_Q.test(n)) return { kind: "policy", topic: "sla", correction };
  if (LIMITS.test(n)) return { kind: "limits", correction };
  if (CONDITION.test(n)) return { kind: "condition", correction };
  if (GREETING.test(n)) return { kind: "greeting", correction };
  const slug = resolveProduct(n);
  if (mentionedProducts(n).length >= 2 && /(diferenca|compar|\bou\b|\bvs\b|versus|o que muda|qual (e )?melhor|qual escolher)/.test(n)) return { kind: "compare", correction };
  if (slug && (CONTENT.test(n) || n.split(" ").length <= 6)) return { kind: "content", slug, correction };
  // Pacotes (combo/completo) citados pela necessidade vencem a menção isolada de um tema; depois o produto
  // citado; depois a necessidade descrita.
  const bundle = NEEDS.slice(0, 2).find(([re]) => re.test(n));
  const need = bundle || (slug ? [null, slug] : NEEDS.find(([re]) => re.test(n)));
  if (need && /(recomend|indica|melhor|ajud|preciso|quero|tenho|minha|meu|perco|nao sobra|sobra|como (melhorar|aumentar|organizar)|o que voces tem|o que vcs tem|serve|qual)/.test(n)) return { kind: "recommend", slug: need[1], correction };
  if (MENU_Q.test(n) || (CONTENT.test(n) && /produt|materia|catalog|o que voces (vendem|tem|oferecem)|solucoes/.test(n))) return { kind: "menu", correction };
  if (correction) return { kind: "correction" };
  return { kind: "escalate", category: "low_confidence" };
}

// Todos os produtos citados numa frase (para comparar). Ordem do catálogo.
export function mentionedProducts(message) {
  const n = norm(message);
  const out = [];
  if (/\bia na pratica\b|\bia\b(?! ?(e|\+) ?vendas)|inteligencia artificial/.test(n) && !/combo/.test(n.replace(/\bia na pratica\b/g, ""))) out.push("ia-na-pratica");
  if (/vendas na pratica|\bvendas\b(?! na pratica)/.test(n) && !/(ia ?(e|\+) ?vendas|combo)/.test(n.replace(/vendas na pratica/g, ""))) out.push("vendas-na-pratica");
  if (/lucro|caixa/.test(n)) out.push("lucro-e-caixa");
  if (/combo|ia ?(e|\+) ?vendas/.test(n)) out.push("combo-ia-vendas");
  if (/completo/.test(n)) out.push("negocio-completo");
  if (/conteudo pronto|assinatura/.test(n)) out.push("conteudo-pronto");
  return out;
}

// ---------- respostas determinísticas ----------
const PRODUCT_LIST = "IA na Prática, Vendas na Prática, Lucro & Caixa, Combo IA + Vendas, Negócio Completo e Conteúdo Pronto";
const MENU = `Olá! Sou o assistente automático da ZEVANORY. Posso explicar ${PRODUCT_LIST}, comparar os materiais e as políticas de entrega e arrependimento. Sobre o que você quer saber?`;
const INJECTION_REPLY = `Só posso ajudar com os produtos e as políticas oficiais da ZEVANORY. Quer saber sobre ${PRODUCT_LIST}?`;
const CORRECTION_REPLY = "Desculpe se não entendi. Pode me dizer de outro jeito o que você quer saber? Se preferir, uma pessoa da equipe continua por e-mail.";
const HANDOFF_ASK = "Informe seu e-mail abaixo para receber a confirmação e a resposta da equipe.";
const PROTO = "{protocolo}";
const ESC_TEXT = {
  human_request: `Certo, encaminhei para uma pessoa da equipe da ZEVANORY (protocolo ${PROTO}). ${SLA_TEXT}`,
  complaint: `Sinto muito pelo problema. Registrei para a equipe humana da ZEVANORY (protocolo ${PROTO}). ${SLA_TEXT}`,
  withdrawal: `Seu pedido foi encaminhado à equipe humana (protocolo ${PROTO}). {refund}`,
  cancellation: `Seu pedido de cancelamento foi encaminhado à equipe humana (protocolo ${PROTO}). {refund}`,
  refund: `Seu pedido foi encaminhado à equipe humana (protocolo ${PROTO}). {refund}`,
  delivery: `Encaminhei à equipe humana (protocolo ${PROTO}). {delivery} Você também pode pedir um novo link em ${CORE_ORIGIN}/entrega/reenviar`,
  payment: `Questões de pagamento são tratadas por uma pessoa da equipe (protocolo ${PROTO}). Não envie dados de cartão por aqui. ${SLA_TEXT}`,
  lgpd: `Pedidos sobre os seus dados pessoais (LGPD) são tratados por uma pessoa da equipe (protocolo ${PROTO}), nos prazos da lei. Você também pode escrever para ${SUPPORT_EMAIL}. Detalhes em ${SALES_ORIGIN}/privacidade`,
  legal: `Assuntos jurídicos são tratados por uma pessoa da equipe (protocolo ${PROTO}). ${SLA_TEXT}`,
  security: `Encaminhei com prioridade à equipe humana (protocolo ${PROTO}). Não envie senhas nem códigos por aqui. ${SLA_TEXT}`,
  sensitive_data: `Por segurança, removi da conversa os dados sensíveis que você enviou. Não envie senha, cartão, documentos ou dados sensíveis por aqui. Encaminhei à equipe humana (protocolo ${PROTO}). ${SLA_TEXT}`,
  source_conflict: `Não consigo confirmar essa informação com segurança agora. Encaminhei sua dúvida à equipe humana (protocolo ${PROTO}). ${SLA_TEXT}`,
  low_confidence: `Não tenho uma resposta segura para isso. Encaminhei sua dúvida à equipe humana (protocolo ${PROTO}). ${SLA_TEXT}`,
  repeated_correction: `Desculpe por não ter ajudado. Encaminhei sua conversa à equipe humana (protocolo ${PROTO}). ${SLA_TEXT}`,
};
function policyAnswer(topic, slug) {
  const q = topic === "delivery" ? "como recebo o acesso" : "quero reembolso";
  return answerSupportQuestion({ question: q, product: slug || "" }).answer;
}
const waitlistAction = (slug, catalog) => {
  const name = catalog.items[slug]?.name || "produto";
  return { type: "waitlist", label: "Entrar na lista de espera por e-mail", href: `mailto:${CHAT.waitlist.email}?subject=${encodeURIComponent(fill(CHAT.waitlist.subject, { produto: name }))}&body=${encodeURIComponent(fill(CHAT.waitlist.body, { produto: name }))}` };
};

// Núcleo puro: decide a resposta. Não toca rede nem banco. `ai` só é usado se `generative` e a categoria permitir.
export async function composeReply({ message, salesOpen = false, session = {}, catalog = CATALOG, ai = null, generative = false, categoriesOff = new Set(), onAiFailure = () => {} } = {}) {
  const c = classify(message, session);
  const slug = c.slug || resolveProduct(norm(message));
  const off = (cat) => categoriesOff.has(cat);
  const emailOnly = { body: FALLBACK.message, mode: "category_off", category: "category_off", actions: [{ type: "email", href: `mailto:${SUPPORT_EMAIL}` }] };
  const escalate = (category) => {
    if (off("handoff")) return { ...emailOnly, category, escalate: null };
    const known = slug ? catalog.items[slug] : null;
    const isSub = known?.slug === "conteudo-pronto";
    const body = fill(ESC_TEXT[category] || ESC_TEXT.low_confidence, {
      refund: isSub ? SUPPORT_SUBSCRIPTION_REFUND_ANSWER : SUPPORT_REFUND_ANSWER,
      delivery: isSub ? SUPPORT_SUBSCRIPTION_DELIVERY_ANSWER : SUPPORT_DELIVERY_ANSWER,
    }) + " " + HANDOFF_ASK;
    return { body, mode: "escalation", category, escalate: { category }, actions: [{ type: "handoff" }] };
  };
  if (c.kind === "empty") return { body: MENU, mode: "menu", category: "menu", actions: [] };
  if (c.kind === "escalate") return { ...escalate(c.category), correction: Boolean(c.correction) };
  if (c.kind === "injection") return { body: INJECTION_REPLY, mode: "injection_refused", category: "injection", actions: [] };
  if (c.kind === "correction") return { body: CORRECTION_REPLY, mode: "correction", category: "correction", correction: true, actions: [{ type: "handoff" }] };
  if (c.kind === "greeting" || c.kind === "menu") return { body: MENU, mode: "menu", category: "menu", correction: Boolean(c.correction), actions: [] };
  // Fonte ausente, vencida ou conflitante: recusa factual e escalonamento (nada de preço ou descrição).
  const needsCatalog = ["condition", "content", "compare", "recommend"].includes(c.kind);
  if (needsCatalog && (!catalog.ok || (slug && catalog.conflicts.includes(slug)))) return escalate("source_conflict");
  if (c.kind === "policy") {
    if (off("policy")) return emailOnly;
    if (c.topic === "sla") return { body: `${SLA_TEXT} O atendimento humano é pelo e-mail ${SUPPORT_EMAIL}.`, mode: "policy", category: "policy", actions: [{ type: "handoff" }] };
    return { body: `${policyAnswer(c.topic, slug)} Se quiser, uma pessoa da equipe continua por e-mail.`, mode: "policy", category: "policy", actions: [{ type: "handoff" }] };
  }
  if (c.kind === "limits") {
    const k = answerSupportQuestion({ question: "isso substitui meu contador?", product: slug || "" });
    return { body: k.answer, mode: "limits", category: "limits", actions: [] };
  }
  if (c.kind === "condition") {
    if (off("condition")) return emailOnly;
    if (!salesOpen) return { body: CLOSED_PRICE_ANSWER, mode: "closed_condition", category: "condition", actions: [waitlistAction(slug, catalog)] };
    if (!slug) return { body: `Sobre qual produto? ${PRODUCT_LIST}.`, mode: "ask_product", category: "condition", actions: [] };
    const it = catalog.items[slug];
    return { body: `${it.name}: R$ ${it.price},00 (preço de tabela). Os detalhes e a contratação estão na página do produto: ${it.page}`, mode: "price_field", category: "condition", actions: [] };
  }
  const describe = (it) => `${it.name}: ${salesOpen ? it.content : it.closedSummary} Página: ${it.page}`;
  const closedTail = salesOpen ? "" : ` No momento, ${CLOSED_LABEL}.`;
  let det;
  if (c.kind === "compare") {
    if (off("content")) return emailOnly;
    const slugs = mentionedProducts(message).filter((s) => catalog.items[s]);
    const pick = slugs.length >= 2 ? slugs.slice(0, 3) : ["ia-na-pratica", "vendas-na-pratica", "lucro-e-caixa"];
    det = { body: pick.map((s) => describe(catalog.items[s])).join(" ") + closedTail, mode: "compare", category: "content", product: null };
  } else if (c.kind === "content") {
    if (off("content")) return emailOnly;
    det = { body: describe(catalog.items[c.slug]) + closedTail, mode: "content", category: "content", product: c.slug };
  } else if (c.kind === "recommend") {
    if (off("recommendation")) return emailOnly;
    const it = catalog.items[c.slug];
    det = { body: `Pelo que você contou, o mais indicado é ${describe(it)}${closedTail}`, mode: "recommendation", category: "recommendation", product: c.slug };
  } else {
    return escalate("low_confidence");
  }
  const actions = salesOpen ? [] : [waitlistAction(det.product, catalog)];
  // Geração (desligada por padrão): só reescreve descrição/recomendação; preço/condição nunca passam aqui.
  if (generative && ai?.run && !off("generative")) {
    const gen = await generate({ ai, message, salesOpen, catalog, product: det.product });
    if (gen.error) onAiFailure(gen.error);
    if (gen.text && validateSiteReply(gen.text, { salesOpen, catalog }).ok) return { body: gen.text, mode: "ai_grounded", category: det.category, actions, model: gen.model };
    return { ...det, mode: det.mode + "_grounded_fallback", actions };
  }
  return { ...det, actions };
}

const MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct-fp8-fast"];
function generationPrompt({ salesOpen, catalog }) {
  const lines = Object.values(catalog.items).map((i) => `- ${i.name}: ${salesOpen ? i.content : i.closedSummary} Página: ${i.page}`);
  return [
    "Você é o assistente automático do site da ZEVANORY. Responda em português do Brasil, em até 3 frases, sem markdown.",
    "Use SOMENTE as descrições abaixo. Nunca mencione preço, valor, desconto, condição de pagamento, prazo, garantia, bônus, urgência ou link de compra.",
    "Nunca prometa resultado. Nunca diga que algo está disponível para compra. Pode incluir a página do produto exatamente como abaixo.",
    salesOpen ? "" : `As vendas estão fechadas (${CLOSED_LABEL}).`,
    "CATÁLOGO APROVADO:", ...lines,
  ].filter(Boolean).join("\n");
}
async function generate({ ai, message, salesOpen, catalog }) {
  for (const model of MODELS) {
    let timer;
    try {
      const out = await Promise.race([
        ai.run(model, { messages: [{ role: "system", content: generationPrompt({ salesOpen, catalog }) }, { role: "user", content: String(message).slice(0, L.message_max_chars) }], max_tokens: 220, temperature: 0.2 }),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("ai_timeout")), L.ai_timeout_ms); }),
      ]);
      const text = String(out?.response ?? out?.result?.response ?? out?.choices?.[0]?.message?.content ?? "").replace(/\*\*/g, "").trim();
      if (text) return { text, model };
    } catch (e) {
      return { error: String(e?.message || "ai_error").slice(0, 40) };
    } finally { clearTimeout(timer); }
  }
  return { text: "" };
}

// Guarda final sobre QUALQUER resposta (determinística ou gerada): reprovou => resposta segura + escalonamento.
export function guardReply(reply, { salesOpen, catalog = CATALOG }) {
  const v = validateSiteReply(reply.body, { salesOpen, catalog });
  if (v.ok) return { ...reply, guard: [] };
  return { body: fill(ESC_TEXT.low_confidence, {}) + " " + HANDOFF_ASK, mode: "guard_blocked", category: "low_confidence", escalate: { category: "low_confidence" }, actions: [{ type: "handoff" }], guard: v.issues };
}

// ---------- estado do isolate: disjuntor e concorrência ----------
const breaker = { fails: [], openUntil: 0, dbOpenUntil: 0 };
let inflight = 0;
export function resetSiteChatState() { breaker.fails = []; breaker.openUntil = 0; breaker.dbOpenUntil = 0; inflight = 0; flagCache.at = 0; schemaReady = false; }
function breakerFailure(dep, now = Date.now()) {
  breaker.fails = breaker.fails.filter((t) => now - t < 60_000).concat(now);
  if (breaker.fails.length >= 3) breaker.openUntil = now + 120_000;
  siteChatLog("dependency_failure", { dep, n: breaker.fails.length });
}
export const generationBreakerOpen = (now = Date.now()) => now < breaker.openUntil;

// ---------- interruptores ----------
const flagCache = { at: 0, killed: true, cats: "" };
export async function readSiteChatFlags(env = {}, { now = Date.now() } = {}) {
  const enabledEnv = String(env.SITE_CHAT_ENABLED || "").toLowerCase() === "true";
  const sandbox = String(env.SITE_CHAT_SANDBOX || "").toLowerCase() === "true";
  let killed = true, catsKv = "";
  if (enabledEnv) {
    if (now - flagCache.at < 30_000) { killed = flagCache.killed; catsKv = flagCache.cats; }
    else {
      const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
      try {
        if (!kv?.get) throw new Error("kv_missing");
        const [k, c] = await Promise.all([kv.get(KILL_KV_KEY), kv.get(CATEGORIES_OFF_KV_KEY)]);
        killed = String(k || "").trim().toLowerCase() === "off";
        catsKv = String(c || "");
      } catch { killed = true; }
      Object.assign(flagCache, { at: now, killed, cats: catsKv });
    }
  }
  const categoriesOff = new Set(`${env.SITE_CHAT_CATEGORIES_OFF || ""},${catsKv}`.split(",").map((s) => s.trim()).filter((s) => SWITCHABLE_CATEGORIES.includes(s)));
  const enabled = enabledEnv && !killed;
  const generative = enabled && String(env.SITE_CHAT_GENERATIVE || "").toLowerCase() === "true" && !categoriesOff.has("generative") && Boolean(env.AI?.run);
  return { enabled, generative, categoriesOff, sandbox };
}

// ---------- isolamento de testes ----------
const SYNTH_EMAIL = /@([a-z0-9-]+\.)*(example\.(com|org|net)|test|invalid|localhost|example|sandbox\.zevanory\.api\.br)$|^(teste?|test|synthetic|sintetic\w*|fake|dummy|noreply|no-reply)[+._-]/i;
export function syntheticMarker(request, body = {}, { sandbox = false } = {}) {
  const h = request.headers;
  for (const k of ["x-zevanory-synthetic", "x-zevanory-test", "x-synthetic-test", "x-zev-synthetic"]) if (h.get(k)) return sandbox ? "" : "synthetic_header";
  const token = String(body.session || "");
  if (token && sandbox && !token.startsWith("sbx_")) return "production_token_in_sandbox";
  if (token && !sandbox && !token.startsWith("zc_")) return "synthetic_token";
  if (!sandbox && body.email && SYNTH_EMAIL.test(String(body.email).trim())) return "synthetic_email";
  return "";
}

// ---------- PostgreSQL ----------
let schemaReady = false;
export async function ensureSiteChatSchema(sql) {
  if (schemaReady) return;
  await sql.query(`create table if not exists zevanory_site_chat_sessions (
    session_hash text primary key, created_at timestamptz not null default now(), last_at timestamptz not null default now(),
    turns integer not null default 0, corrections integer not null default 0, source_version text, sandbox boolean not null default false)`, []);
  await sql.query(`create table if not exists zevanory_site_chat_messages (
    id bigserial primary key, session_hash text not null, role text not null check (role in ('u','a')),
    body text not null, created_at timestamptz not null default now())`, []);
  await sql.query("create index if not exists zevanory_site_chat_messages_session_idx on zevanory_site_chat_messages (session_hash, id)", []);
  await sql.query(`create table if not exists zevanory_site_chat_tickets (
    protocol text primary key, session_hash text not null unique, category text not null, categories text[] not null,
    status text not null default 'open' check (status in ('open','closed')), contact_email text,
    created_at timestamptz not null default now(), due_at timestamptz not null, closed_at timestamptz,
    legal_hold boolean not null default false, owner_notified_at timestamptz, customer_confirmed_at timestamptz,
    source_version text, sandbox boolean not null default false)`, []);
  await sql.query(`create table if not exists zevanory_site_chat_counters (
    bucket text not null, window_start timestamptz not null, n integer not null default 0, primary key (bucket, window_start))`, []);
  schemaReady = true;
}
const minuteWin = (now) => new Date(Math.floor(now / 60_000) * 60_000).toISOString();
const dayWin = (now) => new Date(now).toISOString().slice(0, 10) + "T00:00:00.000Z";
// Uma instrução para todos os contadores da requisição. Excedeu qualquer um => recusa.
export async function hitLimits(sql, buckets) {
  const rows = await sql.query(`insert into zevanory_site_chat_counters (bucket, window_start, n)
    select b, w::timestamptz, 1 from unnest($1::text[], $2::text[]) as t(b, w)
    on conflict (bucket, window_start) do update set n = zevanory_site_chat_counters.n + 1
    returning bucket, n`, [buckets.map((b) => b[0]), buckets.map((b) => b[1])]);
  const counts = new Map((rows || []).map((r) => [String(r.bucket), Number(r.n)]));
  const over = buckets.find(([b, , max]) => !(counts.get(b) <= max));
  return over ? over[0].replace(/:[0-9a-f]{16,}/g, "") : "";
}

async function ipKey(env, request, now) {
  const ip = String(request.headers.get("x-zev-client-ip") || "").trim() || "unknown";
  const secret = String(env.SITE_CHAT_HASH_SECRET || env.LEAD_PRIVACY_SECRET || "");
  if (secret.length < 16) return "";
  return (await hmacHex("site-chat-ip-v1:" + secret, dayWin(now) + "|" + ip)).slice(0, 32);
}
const sessionHash = (token) => sha256Hex("site-chat-session-v1:" + token);
const newToken = (sandbox) => (sandbox ? "sbx_" : "zc_") + b64url(crypto.getRandomValues(new Uint8Array(32)));
const PROTOCOL_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function newProtocol(now = Date.now(), sandbox = false) {
  const r = crypto.getRandomValues(new Uint8Array(6));
  return (sandbox ? "SBX-" : "ZC-") + new Date(now).toISOString().slice(0, 10).replace(/-/g, "") + "-" + [...r].map((b) => PROTOCOL_ALPHABET[b % 32]).join("");
}
async function openTicket(sql, { sess, category, now, sandbox }) {
  const rows = await sql.query(`insert into zevanory_site_chat_tickets (protocol, session_hash, category, categories, due_at, source_version, sandbox)
    values ($1, $2, $3, array[$3]::text[], $4::timestamptz, $5, $6)
    on conflict (session_hash) do update set categories = array(select distinct unnest(zevanory_site_chat_tickets.categories || excluded.categories))
    returning protocol, due_at, contact_email, customer_confirmed_at`, [newProtocol(now, sandbox), sess, category, new Date(now + CHAT.sla_days * 864e5).toISOString(), SOURCE_VERSION, sandbox]);
  return rows?.[0] || null;
}
// Ticket já aberto nesta sessão: reusar não gasta o limite de escalonamentos (idempotência).
async function sessionHasTicket(sql, sess) {
  return Boolean((await sql.query("select protocol from zevanory_site_chat_tickets where session_hash = $1", [sess]))?.length);
}
const dueLabel = (due) => { const d = new Date(due); return Number.isFinite(d.getTime()) ? d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) : ""; };

// ---------- e-mail (fila do proprietário + confirmação ao cliente) ----------
// Interface do encaminhamento: { send({ kind, to, subject, text, replyTo, idempotencyKey }) -> { ok, id } }.
// Produção: Resend (mesma conta do suporte@; a chegada em suporte@ ao proprietário é o fluxo do PR #894).
// Sandbox: SÓ um sink injetado (deps.mailer); sem sink => nenhum envio.
export function resendMailer(env, fetchImpl = globalThis.fetch) {
  return {
    async send({ to, subject, text, replyTo, idempotencyKey }) {
      const key = String(env.RESEND_API_KEY || "");
      if (!key) return { ok: false, reason: "mailer_unconfigured" };
      const r = await fetchImpl("https://api.resend.com/emails", {
        method: "POST", signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify({ from: FROM, to: [to], subject, text, ...(replyTo ? { reply_to: [replyTo] } : {}) }),
      }).catch(() => null);
      let id = "";
      try { id = String((await r?.json())?.id || ""); } catch {}
      return { ok: Boolean(r?.ok && id), id };
    }
  };
}
function ownerNotice(t, { categories, sandbox }) {
  // Sem conteúdo da conversa (AVAL Sol 111): protocolo, categorias, prazo e link autenticado da fila.
  return {
    subject: `${sandbox ? "[SANDBOX] " : ""}[ZEVANORY chat] Protocolo ${t.protocol}`,
    text: [`Novo atendimento do chat do site: protocolo ${t.protocol}.`, `Categorias: ${categories.join(", ")}.`, `Prazo de resposta conclusiva: ${dueLabel(t.due_at)} (até ${CHAT.sla_days} dias).`,
      `Conversa e contato (acesso de administrador): ${CHAT.admin_ticket_url}${t.protocol}`, "Responder a este e-mail responde direto ao cliente (Reply-To).", "", LEGAL_IDENTITY].join("\n"),
  };
}
function customerConfirmation(t) {
  return {
    subject: `Recebemos seu pedido de atendimento — protocolo ${t.protocol}`,
    text: ["Olá,", "", `Recebemos seu pedido de atendimento pelo chat do site da ZEVANORY. Protocolo: ${t.protocol}.`, `${SLA_TEXT} Prazo: até ${dueLabel(t.due_at)}.`, "",
      `Para reembolso ou arrependimento, você também pode usar ${CORE_ORIGIN}/pedir-reembolso. Para um novo link de acesso, ${CORE_ORIGIN}/entrega/reenviar.`, "",
      "Esta é uma confirmação automática. Não responda com senha, cartão ou documentos.", "", "ZEVANORY", LEGAL_IDENTITY].join("\n"),
  };
}

// ---------- autoridade canônica de vendas ----------
async function salesOpenNow(deps) {
  if (typeof deps.salesOpen !== "function") return false;
  let timer;
  try {
    const v = await Promise.race([deps.salesOpen(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("timeout")), L.sales_status_timeout_ms); })]);
    return v === true;
  } catch { breakerFailure("sales_status"); return false; }
  finally { clearTimeout(timer); }
}

// ---------- handler HTTP (somente via service binding: host chat.internal) ----------
export async function handleSiteChat(request, env = {}, deps = {}) {
  const url = new URL(request.url);
  if (url.hostname !== "chat.internal" || !url.pathname.startsWith("/api/chat")) return null;
  const now = typeof deps.now === "function" ? deps.now() : Date.now();
  const flags = await readSiteChatFlags(env, { now });
  if (url.pathname === "/api/chat/status") {
    if (request.method !== "GET") return json(405, { error: "method_not_allowed" }, { allow: "GET" });
    if (!flags.enabled) return json(503, { enabled: false, error: "site_chat_disabled", fallback: FALLBACK });
    const notice = Object.fromEntries(Object.entries(CHAT.notice).map(([k, v]) => [k, fill(v, { legal_identity: LEGAL_IDENTITY })]));
    return json(200, { enabled: true, generative: flags.generative, idle_minutes: L.session_idle_minutes, message_max_chars: L.message_max_chars, notice, fallback: FALLBACK });
  }
  if (!flags.enabled) { siteChatLog("disabled"); return json(503, { error: "site_chat_disabled", fallback: FALLBACK }); }
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" }, { allow: "POST" });
  const raw = await request.text().catch(() => "");
  if (raw.length > L.request_max_bytes) return json(413, { error: "too_large" });
  let body = {};
  try { body = JSON.parse(raw || "{}"); } catch { return json(400, { error: "invalid_json" }); }
  if (!body || typeof body !== "object") return json(400, { error: "invalid_json" });
  const synthetic = syntheticMarker(request, body, flags);
  if (synthetic) { siteChatLog("synthetic_rejected", { reason: synthetic }); return json(422, { error: "synthetic_rejected" }); }
  if (now < breaker.dbOpenUntil) return json(503, { error: "site_chat_unavailable", fallback: FALLBACK });
  if (inflight >= L.concurrency_per_isolate) return json(503, { error: "busy", fallback: FALLBACK }, { "retry-after": "5" });
  inflight += 1;
  try {
    const ip = await ipKey(env, request, now);
    if (!ip) { siteChatLog("unavailable", { reason: "hash_secret_missing" }); return json(503, { error: "site_chat_unavailable", fallback: FALLBACK }); }
    if (!deps.sqlFactory || !env.DATABASE_URL) return json(503, { error: "site_chat_unavailable", fallback: FALLBACK });
    let sql;
    try { sql = deps.sqlFactory(env.DATABASE_URL); await ensureSiteChatSchema(sql); }
    catch { breaker.dbOpenUntil = now + 30_000; siteChatLog("dependency_failure", { dep: "database" }); return json(503, { error: "site_chat_unavailable", fallback: FALLBACK }); }
    try {
      if (url.pathname === "/api/chat/session") return await sessionRoute(sql, env, body, { ip, now, flags });
      if (url.pathname === "/api/chat") return await messageRoute(sql, env, body, deps, { ip, now, flags });
      if (url.pathname === "/api/chat/handoff") return await handoffRoute(sql, env, body, deps, { ip, now, flags });
      return json(404, { error: "not_found" });
    } catch {
      breaker.dbOpenUntil = now + 30_000;
      siteChatLog("dependency_failure", { dep: "database" });
      return json(503, { error: "site_chat_unavailable", fallback: FALLBACK });
    }
  } finally { inflight -= 1; }
}

const TOKEN_RE = /^(zc|sbx)_[A-Za-z0-9_-]{43}$/;
async function loadSession(sql, token, now) {
  if (!TOKEN_RE.test(String(token || ""))) return { error: json(401, { error: "session_invalid" }) };
  const sess = await sessionHash(token);
  const row = (await sql.query("select session_hash, turns, corrections, last_at from zevanory_site_chat_sessions where session_hash = $1", [sess]))?.[0];
  if (!row) return { error: json(401, { error: "session_invalid" }) };
  if (now - Date.parse(row.last_at) > L.session_idle_minutes * 60_000) return { error: json(401, { error: "session_expired" }) };
  return { sess, row: { turns: Number(row.turns) || 0, corrections: Number(row.corrections) || 0 } };
}

async function sessionRoute(sql, env, body, { ip, now, flags }) {
  if (body.renew) {
    const s = await loadSession(sql, body.renew, now);
    if (s.error) return s.error;
    const over = await hitLimits(sql, [[`s:${s.sess}:m`, minuteWin(now), L.per_session_per_minute]]);
    if (over) return json(429, { error: "rate_limited", fallback: FALLBACK }, { "retry-after": "60" });
    await sql.query("update zevanory_site_chat_sessions set last_at = $2::timestamptz where session_hash = $1", [s.sess, new Date(now).toISOString()]);
    return json(200, { session: body.renew, idle_minutes: L.session_idle_minutes });
  }
  const over = await hitLimits(sql, [[`i:${ip}:sess:d`, dayWin(now), L.sessions_per_ip_per_day], ["g:sess:d", dayWin(now), L.global_sessions_per_day]]);
  if (over) { siteChatLog("rate_limited", { reason: over }); return json(429, { error: "rate_limited", fallback: FALLBACK }, { "retry-after": "3600" }); }
  const token = newToken(flags.sandbox);
  await sql.query("insert into zevanory_site_chat_sessions (session_hash, last_at, source_version, sandbox) values ($1, $2::timestamptz, $3, $4)", [await sessionHash(token), new Date(now).toISOString(), SOURCE_VERSION, flags.sandbox]);
  siteChatLog("session_created", { sandbox: flags.sandbox });
  return json(200, { session: token, idle_minutes: L.session_idle_minutes });
}

async function messageRoute(sql, env, body, deps, { ip, now, flags }) {
  const message = clean(body.message, L.message_max_chars + 1);
  if (!message) return json(400, { error: "empty_message" });
  if (message.length > L.message_max_chars) return json(413, { error: "message_too_long", max: L.message_max_chars });
  const s = await loadSession(sql, body.session, now);
  if (s.error) return s.error;
  const over = await hitLimits(sql, [
    [`s:${s.sess}:m`, minuteWin(now), L.per_session_per_minute], [`i:${ip}:m`, minuteWin(now), L.per_ip_per_minute], [`i:${ip}:d`, dayWin(now), L.per_ip_per_day],
    ["g:m", minuteWin(now), L.global_per_minute], ["g:d", dayWin(now), L.global_per_day],
  ]);
  if (over) { siteChatLog("rate_limited", { reason: over }); return json(429, { error: "rate_limited", fallback: FALLBACK }, { "retry-after": "60" }); }
  if (s.row.turns >= L.turns_max) {
    return json(200, { reply: `Esta conversa chegou ao limite de mensagens. Para continuar, fale com uma pessoa da equipe ou escreva para ${SUPPORT_EMAIL}.`, category: "turn_limit", actions: [{ type: "handoff" }] });
  }
  // Autoridade canônica a CADA resposta; erro/timeout = fechado.
  const salesOpen = await salesOpenNow(deps);
  let generative = flags.generative && !generationBreakerOpen(now);
  if (generative) {
    const budget = await hitLimits(sql, [["g:ai:d", dayWin(now), L.ai_daily_budget]]);
    if (budget) generative = false;
  }
  const composed = await composeReply({ message, salesOpen, session: s.row, catalog: deps.catalog || CATALOG, ai: env.AI, generative, categoriesOff: flags.categoriesOff, onAiFailure: (dep) => breakerFailure("ai:" + dep, now) });
  const reply = guardReply(composed, { salesOpen, catalog: deps.catalog || CATALOG });
  let protocol = null, due = null;
  if (reply.escalate) {
    const lim = (await sessionHasTicket(sql, s.sess)) ? "" : await hitLimits(sql, [[`i:${ip}:h:d`, dayWin(now), L.handoffs_per_ip_per_day], ["g:h:d", dayWin(now), L.handoffs_global_per_day]]);
    if (lim) {
      siteChatLog("rate_limited", { reason: lim });
    } else {
      const t = await openTicket(sql, { sess: s.sess, category: reply.escalate.category, now, sandbox: flags.sandbox });
      protocol = t?.protocol || null; due = t?.due_at || null;
    }
  }
  const finalBody = protocol ? reply.body.replaceAll(PROTO, protocol)
    : reply.body.replace(` (protocolo ${PROTO})`, "").replace(`(protocolo ${PROTO})`, "").replaceAll(PROTO, "");
  const stored = redactSensitive(message).text;
  await sql.query("insert into zevanory_site_chat_messages (session_hash, role, body) values ($1, 'u', $2), ($1, 'a', $3)", [s.sess, stored, finalBody]);
  await sql.query("update zevanory_site_chat_sessions set turns = turns + 1, corrections = corrections + $2, last_at = $3::timestamptz, source_version = $4 where session_hash = $1", [s.sess, composed.correction ? 1 : 0, new Date(now).toISOString(), SOURCE_VERSION]);
  siteChatLog("reply", { category: reply.category, mode: reply.mode, created: Boolean(protocol) });
  const out = { reply: finalBody, category: reply.category, actions: reply.actions || [] };
  if (reply.escalate) out.escalation = { category: reply.escalate.category, protocol, due_date: due ? dueLabel(due) : null, sla_days: CHAT.sla_days, needs_email: true };
  return json(200, out);
}

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
async function handoffRoute(sql, env, body, deps, { ip, now, flags }) {
  const email = String(body.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return json(400, { error: "email_invalid" });
  const s = await loadSession(sql, body.session, now);
  if (s.error) return s.error;
  if (flags.categoriesOff.has("handoff")) return json(200, { reply: FALLBACK.message, category: "category_off", actions: [{ type: "email", href: `mailto:${SUPPORT_EMAIL}` }] });
  const known = await sessionHasTicket(sql, s.sess);
  const over = await hitLimits(sql, [[`s:${s.sess}:m`, minuteWin(now), L.per_session_per_minute], ...(known ? [] : [[`i:${ip}:h:d`, dayWin(now), L.handoffs_per_ip_per_day], ["g:h:d", dayWin(now), L.handoffs_global_per_day]])]);
  if (over) { siteChatLog("rate_limited", { reason: over }); return json(429, { error: "rate_limited", fallback: FALLBACK }, { "retry-after": "3600" }); }
  const t = await openTicket(sql, { sess: s.sess, category: "human_request", now, sandbox: flags.sandbox });
  if (!t?.protocol) return json(503, { error: "site_chat_unavailable", fallback: FALLBACK });
  await sql.query("update zevanory_site_chat_tickets set contact_email = $2 where protocol = $1", [t.protocol, email]);
  // Idempotente: confirmação e aviso ao dono saem uma vez por protocolo (marcadores no banco + Idempotency-Key).
  let confirmed = Boolean(t.customer_confirmed_at);
  let mailStatus = confirmed ? "already_sent" : "not_sent";
  if (!confirmed) {
    const mailer = flags.sandbox ? deps.mailer : (deps.mailer || resendMailer(env, deps.fetchImpl));
    if (!mailer?.send) { mailStatus = "sandbox_sink_missing"; }
    else {
      const cats = (await sql.query("select categories from zevanory_site_chat_tickets where protocol = $1", [t.protocol]))?.[0]?.categories;
      const categories = Array.isArray(cats) ? cats : String(cats || "human_request").replace(/[{}]/g, "").split(",").filter(Boolean);
      const owner = ownerNotice(t, { categories, sandbox: flags.sandbox });
      const sentOwner = await mailer.send({ kind: "owner_queue", to: CHAT.owner_queue_to, subject: owner.subject, text: owner.text, replyTo: email, idempotencyKey: `site-chat/${t.protocol}/owner` }).catch(() => ({ ok: false }));
      const cust = customerConfirmation(t);
      const sentCustomer = await mailer.send({ kind: "customer_confirmation", to: email, subject: cust.subject, text: cust.text, replyTo: SUPPORT_EMAIL, idempotencyKey: `site-chat/${t.protocol}/customer` }).catch(() => ({ ok: false }));
      if (sentOwner?.ok) await sql.query("update zevanory_site_chat_tickets set owner_notified_at = coalesce(owner_notified_at, now()) where protocol = $1", [t.protocol]);
      if (sentCustomer?.ok) { await sql.query("update zevanory_site_chat_tickets set customer_confirmed_at = coalesce(customer_confirmed_at, now()) where protocol = $1", [t.protocol]); confirmed = true; }
      mailStatus = sentCustomer?.ok ? "sent" : "send_failed";
    }
  }
  siteChatLog("handoff", { status: mailStatus, sandbox: flags.sandbox });
  const dueDate = dueLabel(t.due_at);
  const reply = confirmed
    ? `Pronto! Seu protocolo é ${t.protocol}. Enviamos a confirmação para o seu e-mail. ${SLA_TEXT} Prazo: até ${dueDate}.`
    : `Pronto! Seu protocolo é ${t.protocol}. Não conseguimos enviar a confirmação por e-mail agora; guarde este número. ${SLA_TEXT} Prazo: até ${dueDate}.`;
  return json(200, { reply, protocol: t.protocol, due_date: dueDate, sla_days: CHAT.sla_days, email_confirmation: confirmed ? "sent" : "pending" });
}

// ---------- fila do proprietário (autenticada) ----------
export async function handleSiteChatAdmin(request, env = {}, { sqlFactory, isAdminAuthorized } = {}) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/admin/site-chat/")) return null;
  if (typeof isAdminAuthorized !== "function" || !isAdminAuthorized(request, env)) return json(401, { error: "unauthorized" }, { "www-authenticate": 'Basic realm="ZEVANORY"' });
  if (!sqlFactory || !env.DATABASE_URL) return json(503, { error: "database_unavailable" });
  const sql = sqlFactory(env.DATABASE_URL);
  await ensureSiteChatSchema(sql);
  const m = url.pathname.match(/^\/api\/admin\/site-chat\/tickets(?:\/((?:ZC|SBX)-\d{8}-[A-Z2-9]{6}))?(?:\/(close|hold))?$/);
  if (!m) return json(404, { error: "not_found" });
  const [, protocol, action] = m;
  if (!protocol && request.method === "GET") {
    const rows = await sql.query("select protocol, categories, status, created_at, due_at, (contact_email is not null) as has_contact, legal_hold from zevanory_site_chat_tickets where status = 'open' order by due_at asc limit 200", []);
    return json(200, { tickets: rows || [] });
  }
  if (protocol && !action && request.method === "GET") {
    const t = (await sql.query("select protocol, session_hash, categories, status, contact_email, created_at, due_at, closed_at, legal_hold, source_version from zevanory_site_chat_tickets where protocol = $1", [protocol]))?.[0];
    if (!t) return json(404, { error: "not_found" });
    const msgs = await sql.query("select role, body, created_at from zevanory_site_chat_messages where session_hash = $1 order by id asc", [t.session_hash]);
    const { session_hash, ...ticket } = t;
    return json(200, { ticket, transcript: msgs || [] });
  }
  if (protocol && action && request.method === "POST") {
    const q = action === "close" ? "update zevanory_site_chat_tickets set status = 'closed', closed_at = coalesce(closed_at, now()) where protocol = $1 returning protocol"
      : "update zevanory_site_chat_tickets set legal_hold = true where protocol = $1 returning protocol";
    const r = await sql.query(q, [protocol]);
    return r?.length ? json(200, { ok: true, action }) : json(404, { error: "not_found" });
  }
  return json(405, { error: "method_not_allowed" });
}

// ---------- retenção (job diário; roda mesmo com o chat desligado) ----------
export async function runSiteChatRetention(env = {}, { sqlFactory } = {}) {
  if (!sqlFactory || !env.DATABASE_URL) return { ok: false, reason: "unconfigured" };
  const sql = sqlFactory(env.DATABASE_URL);
  const exists = await sql.query("select to_regclass('public.zevanory_site_chat_sessions') is not null as t", []);
  if (!(exists?.[0]?.t === true || exists?.[0]?.t === "t")) return { ok: true, reason: "no_tables", deleted: 0 };
  await ensureSiteChatSchema(sql);
  const R = CHAT.retention;
  const tickets = await sql.query(`delete from zevanory_site_chat_tickets where status = 'closed' and not legal_hold
    and closed_at < now() - make_interval(days => $1::int) returning session_hash`, [R.ticket_days_after_closure]);
  const msgs = await sql.query(`delete from zevanory_site_chat_messages m where (m.created_at < now() - make_interval(days => $1::int)
      and not exists (select 1 from zevanory_site_chat_tickets t where t.session_hash = m.session_hash))
    or m.session_hash = any($2::text[]) returning 1`, [R.transcript_days, (tickets || []).map((r) => r.session_hash)]);
  const sessions = await sql.query(`delete from zevanory_site_chat_sessions s where (s.last_at < now() - make_interval(days => $1::int)
      and not exists (select 1 from zevanory_site_chat_tickets t where t.session_hash = s.session_hash))
    or s.session_hash = any($2::text[]) returning 1`, [R.transcript_days, (tickets || []).map((r) => r.session_hash)]);
  const counters = await sql.query("delete from zevanory_site_chat_counters where window_start < now() - make_interval(days => $1::int) returning 1", [R.counters_days]);
  const out = { ok: true, tickets: (tickets || []).length, messages: (msgs || []).length, sessions: (sessions || []).length, counters: (counters || []).length };
  siteChatLog("retention", { deleted: out.tickets + out.messages + out.sessions + out.counters });
  return out;
}
