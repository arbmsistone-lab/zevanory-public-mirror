// ZEVANORY | NC-1006-02 / NC-1008-01 / NC-1008-03 (contra-auditorias GPT-6): gate de consistência de preços.
//
// Fonte canônica ÚNICA: data/products.json (preços) e data/affiliates.json (comissões), ambos reservados ao proprietário.
// Este arquivo e o teste ao lado (tests/governanca/**) também são reservados e ficam FORA de rotina_autonoma. O gate roda
// no check obrigatório "product-pages / static-audit" (os dois emissores canônicos): preço/condição diferente da tabela
// em QUALQUER arquivo de produção deixa o CI vermelho.
//
// Texto normalizado (escapes \xHH/\uHHHH, entidades HTML). HTML é lido só por NÓS DE TEXTO (tags inline somem sem deixar
// atributo no meio: `R$ <b class="v">47</b>` = "R$ 47"), mais os valores de atributo que citam dinheiro (cada tag como um
// trecho separado) e os blocos JSON-LD (lidos como JSON).
//   T1 VALOR_EM_REAIS     "R$ N", "BRL N", "N reais", "N,NN" e valor por extenso ("quarenta e sete reais") atribuído a um
//                         produto: produto na MESMA frase (antes ou depois, sem limite de distância), senão o mais próximo
//                         antes (WINDOW_BEFORE; HTML WINDOW_BEFORE_HTML), senão o produto da página. Tem de estar no
//                         conjunto permitido: preço da tabela; pacote também soma/economia DERIVADAS; item citado com o
//                         pacote herda o conjunto do pacote; comissão derivada SÓ nas páginas de afiliado reservadas.
//   T2 PAGINA_DE_PRODUTO  página de UM produto (sales-public/<slug>.html, <slug>/index.html, pages-mirror/...): TODO valor
//                         monetário da página tem de estar no conjunto permitido daquele produto.
//   T3 JSON_LD            offers.price/lowPrice/highPrice (aninhado) = tabela do produto do objeto (ou da página).
//   T4 VALOR_DA_MARCA     oferta "por/custa/preço R$ N" com a marca ZEVANORY por perto e sem produto: N tem de ser de kit.
//   T5 DESCONTO           cupom/desconto/promoção/"% off"/"por cento"/"N%" na mesma frase de um produto (ou em página de
//                         produto), fora de arquivo reservado.
//   T6 COMISSAO_PCT       percentual de AFILIADO (F0 item 4), em QUALQUER arquivo de produção (reservado ou não), inclusive
//                         meta/og/twitter: "N%", "N %", "N por cento", número por extenso ("cinquenta por cento") e "metade",
//                         com ou sem "até"/"em comissão", numa frase com contexto de afiliado (afiliad*, indicação/indicad*,
//                         link de divulgação, venda indicada, programa de afiliados; em página de afiliado reservada também
//                         basta "comiss"; NC-1014-03: "comiss" + hotmart/divulg/parceir também, salvo frase de meio de
//                         pagamento), tem de ser uma das taxas de data/affiliates.json. Fora desse contexto (ex.: "comissão
//                         de 4% da maquininha", "comissão do cartão na Hotmart") e desconto ("N% off") não contam. Divisão
//                         declarada "30% afiliado / 70% produtor" (complemento da taxa válida, com "produtor" ao lado) é aceita.
//   C1 CAMPO_DE_PRECO     campo price/preco/valor/amount (inclusive aninhado: {sku, offer:{price:N}}) em objeto cujo
//                         produto (o próprio objeto ou um ancestral) é conhecido: = tabela (centavos = x100).
//   C2 MAPA_DE_PRECO      "<sku|slug>": N | "N" | ["nome", N], par ["<sku|slug>", N] (Map/array de pares).
//   J1 ARITMETICA_DE_PRECO  (JS de produção não reservado) priceBy*/PRICE_BY_SKU/PRICES/*price* com - * / % ou + número.
//   J2 LITERAL_DE_PRECO     (idem) qualquer literal numérico em propriedade price/preco/valor/amount, par [sku|slug, N],
//                           variável com nome de preço = literal, variável = literal usada em "R$ "+x / `R$ ${x}` /
//                           campo de preço, e literal direto em "R$ " + N / `R$ ${N}` (NC-1008-04).
//   J1 também cobre toda variável que recebe priceBy*/PRICE_BY_SKU/PRICES/bundle* (const ia = priceBySlug(..); ia + 100).
// Exceções: só as de EXCECOES (arquivo + regra + produto + valor + quantidade EXATA + motivo).
// Uso: node tests/governanca/price-gate.mjs [--root DIR] [--json]   (rc 0 = PASS, 1 = FAIL, 2 = entrada inválida)
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const WINDOW_BEFORE = 200;
export const WINDOW_BEFORE_HTML = 700;
const SAVINGS_CTX = /(economi|separad|custaria|avulso|somad|em vez de|comprar os|\bcompletos\b)/i;
const COMMISSION_CTX = /comiss/i;
// T6 (ver cabeçalho). NUM_WORDS é declarado abaixo; PCT_RX é montado sob demanda.
export const AFFILIATE_CTX = /afiliad|indica[cç](?:[aã]o|[oõ]es)|\bindicad[ao]s?\b|link\s+de\s+divulga|venda\s+indicada|programa\s+de\s+afiliad|\?ref=/i;
const PCT_NOT_COMMISSION_AFTER = /^\s*(?:off\b|de\s+desconto|desconto|em\s+desconto)/i;
// NC-1014-03: "comiss" + hotmart/divulg/parceir também é contexto de afiliado, exceto em frase de meio de pagamento
export const AFFILIATE_WEAK_CTX = /hotmart|divulg|parceir/i;
export const PAYMENT_CTX = /maquininha|cart[aã]o|adquirente|gateway|\bpix\b|boleto|desconto|cupom/i;
const BRAND = /\bZEVANORY\b/;
const OFFER_CTX = /\b(por|custa|pre[cç]o|valor|investimento|apenas|s[oó])\b[\s:(]*((R\$|BRL)\s*)?$/i;
const DISCOUNT = /\b(cupom|cupons|cupon|coupon|coupons|descontos?|promo[cç](?:[aã]o|[oõ]es)|black friday|liquida[cç][aã]o|por cento)\b|\d+(?:,\d+)?\s*%(?:\s*off\b)?/gi;
// não é oferta: negação ("não é desconto", "sem cupom") e o nome oficial do serviço ("promoção de vendas", Conteúdo Pronto v3)
const DISCOUNT_OK_BEFORE = /\b(n[aã]o(?: [eé]| h[aá]| tem| existe| oferecemos)?|sem|nunca|nem|nenhum|nenhuma)\s*(?:\w+\s+){0,2}$/i;
const DISCOUNT_OK_AFTER = /^\s+de\s+vendas\b/i;
const DISCOUNT_EXEMPT = [/^data\/site-chat-eval\//]; // perguntas de avaliação do chat ("Tem desconto no X?"), não oferta
// Composição dos pacotes (definição de produto). Valores derivados = soma dos itens e economia, nunca literais.
export const BUNDLES = Object.freeze({
  "combo-ia-vendas": Object.freeze(["ia-na-pratica", "vendas-na-pratica"]),
  "negocio-completo": Object.freeze(["ia-na-pratica", "vendas-na-pratica", "lucro-e-caixa"]),
});
// Variações de grafia do nome que aparecem em texto (sem acento, "e" no lugar de "&"/"+").
const ALIASES = Object.freeze({
  "ia-na-pratica": ["IA na Pratica"],
  "vendas-na-pratica": ["Vendas na Pratica"],
  "lucro-e-caixa": ["Lucro e Caixa"],
  "combo-ia-vendas": ["Combo IA e Vendas", "Combo IA & Vendas"],
  "negocio-completo": ["Negocio Completo"],
  "conteudo-pronto": ["Conteudo Pronto", '"assinatura"'],
});

// Produção = tudo que é versionado e publicado/executado, MENOS teste, evidência, documentação, workflow (reservado à
// parte) e os mutantes de CI (que de propósito contêm preços errados).
export const INCLUDE_EXT = /\.(mjs|cjs|js|json|html?|txt|xml|py|css|md|toml|ya?ml|csv)$/i;
export const EXCLUDE = [
  /^\.git\//, /(^|\/)node_modules\//, /^tests\//, /^docs\//, /^evidence\//, /^\.github\//, /^scripts\/ci\//,
  /^db\//, /^migrations\//, /^sandbox\//, /^compliance\//, /^worker\/vendor\//, /^scripts\/[^/]*_test\.mjs$/,
  /^ops\//, /^CLOUDFLARE_DEPLOY_AUTHORITY\.md$/, /^OPERACAO\.md$/,
];
const JS = /\.(mjs|cjs|js)$/i;

// Exceções documentadas (quantidade EXATA). Só o proprietário altera (arquivo reservado).
const legacy = (arquivo, regra, pares, motivo) => pares.map(([produto, valor, quantidade = 1]) => Object.freeze({ arquivo, regra, produto, valor, quantidade, motivo }));
export const EXCECOES = Object.freeze([
  // Bundle recuperado da produção antiga (byte a byte, conferido por hash em central-production-deploy): guarda a
  // hipótese de preço de 2025 com price_status "pilot_hypothesis_not_validated". Não é lido pelas superfícies de
  // venda atuais; congelado aqui para que qualquer mudança nele (inclusive "corrigir" um valor) passe pelo dono.
  ...legacy("worker/cloudflare-worker.recovered.mjs", "CAMPO_DE_PRECO", [["ia-na-pratica", 197], ["ia-na-pratica", 147],
    ["vendas-na-pratica", 197], ["vendas-na-pratica", 147], ["lucro-e-caixa", 247], ["lucro-e-caixa", 197],
    ["combo-ia-vendas", 297], ["combo-ia-vendas", 247], ["negocio-completo", 397], ["negocio-completo", 347], ["marca", 197, 2]],
    "bundle legado recuperado: table_price_brl/pilot_price_brl e criativo da hipótese de 2025 (não validada)"),
  ...legacy("worker/cloudflare-worker.recovered.mjs", "VALOR_DA_MARCA", [["marca", 197]],
    "criativo legado do bundle recuperado (R$ 197,00 da hipótese de 2025); o criativo vivo vem do catálogo"),
  // Mesmo bundle: catálogo ARBM (outra marca, não ZEVANORY) e a conta de margem do motor financeiro legado.
  ...legacy("worker/cloudflare-worker.recovered.mjs", "LITERAL_DE_PRECO", [["-", 0], ["-", 1197], ["-", 79.9], ["-", 19.9]],
    "catálogo ARBM ZERO/PRO/CONTINUITY/BOOST do bundle legado recuperado (não é produto ZEVANORY)"),
  ...legacy("worker/cloudflare-worker.recovered.mjs", "ARITMETICA_DE_PRECO", [["-", "product.expected_price_brl", 3]],
    "margem bruta (preço - custo) do motor financeiro legado do bundle recuperado; não altera preço de venda"),
  // Prova MANUAL de sandbox (Mercado Pago usuário de teste): o resolvedor da certificação isolada usa o catálogo
  // legado acima, então o valor esperado da prova espelha table_price_brl. Não é superfície de venda.
  ...legacy("scripts/mercadopago_combo_sandbox.py", "MAPA_DE_PRECO", [["ia-na-pratica", 197], ["vendas-na-pratica", 197],
    ["lucro-e-caixa", 247], ["combo-ia-vendas", 297], ["negocio-completo", 397]],
    "prova de sandbox manual espelha o catálogo legado do resolvedor de certificação"),
  // Prova de sandbox v2: valor sintético congelado de pedido de teste antigo (comentado no código como "NOT current catalog price").
  ...legacy("worker/sandbox-proof-v2.mjs", "LITERAL_DE_PRECO", [["SANDBOX_AMOUNT_BRL", 297]],
    "valor sintético congelado da prova de sandbox v2 (pedido de teste legado), não é preço de catálogo"),
  // Registro histórico de ordem do dono (o que estava em produção em 12-13/10); texto de evidência, não oferta.
  ...legacy("data/commitments.json", "VALOR_EM_REAIS", [["ia-na-pratica", 197]],
    "evidência histórica do compromisso offer-0001-containment (12-13/10)"),
]);

const ENT = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", aacute: "á", eacute: "é", iacute: "í",
  oacute: "ó", uacute: "ú", atilde: "ã", otilde: "õ", acirc: "â", ecirc: "ê", ocirc: "ô", ccedil: "ç", agrave: "à",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Atilde: "Ã", Otilde: "Õ", Ccedil: "Ç", middot: "·",
  ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»" };

export function decode(text) {
  return String(text)
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#([0-9]+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([A-Za-z]+);/g, (m, n) => ENT[n] ?? m)
    .replace(/[    ]/g, " ");
}
export const normalize = (text) => decode(text);

const INLINE = /^(a|abbr|b|bdi|bdo|cite|code|data|del|dfn|em|font|i|ins|kbd|mark|q|s|samp|small|span|strong|sub|sup|time|u|var|wbr)$/i;
// HTML -> { text (só nós de texto), attrs [trechos de atributo com dinheiro], jsonld [objetos], scripts [código] }
export function htmlParts(html) {
  const jsonld = [], scripts = [], attrs = [], pctAttrs = [];
  let h = String(html).replace(/<!--[\s\S]*?-->/g, " ");
  h = h.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_, a, body) => {
    if (/application\/ld\+json/i.test(a)) { try { jsonld.push(JSON.parse(decode(body))); } catch { jsonld.push({ __invalido__: body.slice(0, 80) }); } }
    else scripts.push(body);
    return " ";
  }).replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  h = h.replace(/<\/?([A-Za-z][\w-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (_, n, a) => {
    const vals = [...a.matchAll(/=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => decode(m[1] ?? m[2]));
    if (vals.some((v) => /R\$|BRL|\breais\b/i.test(v))) attrs.push(vals.filter((v) => !/^(https?:|mailto:|\/|#|data:)/i.test(v)).join(" · "));
    for (const v of vals) if (/%|por\s+cento|metade/i.test(v) && !/^(https?:|mailto:|\/|#|data:)/i.test(v)) pctAttrs.push(v);
    return INLINE.test(n) ? "" : "\n";
  });
  return { text: decode(h), attrs, jsonld, scripts, pctAttrs };
}

export function loadCanon(root) {
  const d = JSON.parse(readFileSync(join(root, "data/products.json"), "utf8"));
  if (d?.schema !== "zevanory-products/v1" || !Array.isArray(d.products) || !d.products.length || !d.subscription?.slug)
    throw new Error("data/products.json inválido");
  const af = JSON.parse(readFileSync(join(root, "data/affiliates.json"), "utf8"));
  const pcts = [af?.hotmart_commission_pct, af?.own_program_commission_pct];
  if (af?.schema !== "zevanory-affiliates/v1" || !pcts.every((x) => Number.isInteger(x) && x > 0 && x < 100) || !Array.isArray(af.pages) || !af.pages.length)
    throw new Error("data/affiliates.json inválido");
  const items = [...d.products, { ...d.subscription, sku: null }];
  const bySlug = {};
  for (const p of items) {
    if (!p.slug || !p.name || !Number.isInteger(p.price) || p.price <= 0) throw new Error("produto inválido: " + JSON.stringify(p));
    bySlug[p.slug] = { slug: p.slug, sku: p.sku || null, name: p.name, price: p.price };
  }
  for (const [b, parts] of Object.entries(BUNDLES)) {
    if (!bySlug[b] || parts.some((s) => !bySlug[s])) throw new Error("pacote sem item na tabela: " + b);
    const separado = parts.reduce((a, s) => a + bySlug[s].price, 0);
    bySlug[b].separado = separado;
    bySlug[b].economia = separado - bySlug[b].price;
    if (bySlug[b].economia <= 0) throw new Error("pacote sem economia: " + b);
  }
  for (const p of Object.values(bySlug)) {
    p.allowed = new Set([p.price]);
    if (BUNDLES[p.slug]) {
      p.allowed.add(p.separado); p.allowed.add(p.economia);
      for (const s of BUNDLES[p.slug]) p.allowed.add(bySlug[s].price);
    }
  }
  const kitUnion = new Set();
  for (const p of d.products) for (const v of bySlug[p.slug].allowed) kitUnion.add(v);
  let reservedGlobs = [];
  try {
    const r = JSON.parse(readFileSync(join(root, "ops/owner-reserved-paths.json"), "utf8"));
    reservedGlobs = Object.values(r.classes || {}).flatMap((c) => c.globs || []).map(globRx);
  } catch { /* fixture sem a lista: nada é reservado (mais rígido) */ }
  return { raw: d, bySlug, kitUnion, guaranteeDays: d.guaranteeDays, commissionPcts: pcts, affiliatePages: new Set(af.pages), reservedGlobs };
}

export function globRx(g) {
  let o = "", i = 0;
  while (i < g.length) {
    if (g.startsWith("**/", i)) { o += "(?:.*/)?"; i += 3; }
    else if (g.startsWith("**", i)) { o += ".*"; i += 2; }
    else if (g[i] === "*") { o += "[^/]*"; i++; }
    else if (g[i] === "?") { o += "[^/]"; i++; }
    else { o += g[i].replace(/[.+^${}()|[\]\\]/g, "\\$&"); i++; }
  }
  return new RegExp("^" + o + "$", "s");
}
const reserved = (file, canon) => canon.reservedGlobs.some((rx) => rx.test(file));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function mentionRegex(canon) {
  const terms = [];
  for (const p of Object.values(canon.bySlug)) {
    for (const t of [p.name, p.slug, p.sku, ...(ALIASES[p.slug] || [])].filter(Boolean)) terms.push([t, p.slug]);
  }
  terms.sort((a, b) => b[0].length - a[0].length);
  const map = new Map(terms.map(([t, s]) => [t.toLowerCase(), s]));
  const rx = new RegExp(`(?<![A-Za-z0-9À-ÿ-])(?:${terms.map(([t]) => esc(t)).join("|")})(?![A-Za-z0-9À-ÿ]|-[a-z0-9])`, "giu");
  return { rx, map };
}
function mentions(text, mr) {
  const out = [];
  for (const m of text.matchAll(mr.rx)) out.push({ at: m.index, end: m.index + m[0].length, slug: mr.map.get(m[0].toLowerCase()) });
  return out;
}

// --- valores por extenso ---
const NUM_WORDS = { um: 1, uma: 1, dois: 2, duas: 2, "três": 3, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9,
  dez: 10, onze: 11, doze: 12, treze: 13, quatorze: 14, catorze: 14, quinze: 15, dezesseis: 16, dezessete: 17, dezoito: 18,
  dezenove: 19, vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, "cinqüenta": 50, sessenta: 60, setenta: 70, oitenta: 80,
  noventa: 90, cem: 100, cento: 100, duzentos: 200, trezentos: 300, quatrocentos: 400, quinhentos: 500, seiscentos: 600,
  setecentos: 700, oitocentos: 800, novecentos: 900, mil: 1000 };
const WORD = Object.keys(NUM_WORDS).sort((a, b) => b.length - a.length).join("|");
const EXTENSO = new RegExp(`(?<![\\wÀ-ÿ])((?:(?:${WORD})(?:\\s+e\\s+|\\s+))*(?:${WORD}))\\s+reais\\b`, "giu");
export function parseExtenso(s) {
  let total = 0, cur = 0;
  for (const w of s.toLowerCase().split(/\s+/).filter((x) => x !== "e")) {
    const v = NUM_WORDS[w]; if (v === undefined) return null;
    if (v === 1000) { total += (cur || 1) * 1000; cur = 0; } else cur += v;
  }
  return total + cur;
}

// Valores monetários de um texto: [{at, end, value, raw}]
const MONEY = /(?:R\$|BRL)\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{2}))?(?![\d])|(?<![\d.,])(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{2}))?\s*(?:reais\b|BRL\b)|(?<![\d.,R$])(\d{1,3}(?:\.\d{3})+|\d+),(\d{2})(?![\d%]|,\d|\s*%)/gi;
export function moneyIn(text) {
  const out = [];
  for (const m of text.matchAll(MONEY)) {
    const i = m[1] ?? m[3] ?? m[5], c = m[2] ?? m[4] ?? m[6];
    out.push({ at: m.index, end: m.index + m[0].length, value: Number(i.replace(/\./g, "")) + (c ? Number(c) / 100 : 0), raw: m[0], bare: m[5] !== undefined });
  }
  for (const m of text.matchAll(EXTENSO)) {
    const v = parseExtenso(m[1]); if (v) out.push({ at: m.index, end: m.index + m[0].length, value: v, raw: m[0] });
  }
  return out.sort((a, b) => a.at - b.at);
}

const BOUNDARY = /[.!?;](?=\s)|\n|\||•/g;
function sentence(text, at, end) {
  let s = 0, e = text.length;
  for (const m of text.matchAll(BOUNDARY)) { if (m.index < at) s = m.index + 1; else if (m.index >= end) { e = m.index; break; } }
  return [s, e];
}

// Página de UM produto: o produto da página vale para todo valor da página.
export function pageProduct(file, canon) {
  if (!/\.html?$/i.test(file)) return null;
  const base = file.replace(/\/index\.html?$/i, "").replace(/\.html?$/i, "").split("/").pop();
  return Object.keys(canon.bySlug).find((s) => base === s || base.endsWith("-" + s) || base.endsWith("_" + s)) || null;
}

function allowedFor(slug, canon, { ms, at, ctx, page, file }) {
  let allowed = new Set(canon.bySlug[slug].allowed);
  for (const [b, parts] of Object.entries(BUNDLES)) {
    if (!parts.includes(slug)) continue;
    if (page === b || SAVINGS_CTX.test(ctx) || ms.some((x) => x.slug === b && Math.abs(x.at - at) <= WINDOW_BEFORE * 2))
      allowed = new Set([...allowed, ...canon.bySlug[b].allowed]);
  }
  // comissão derivada (taxa da fonte reservada data/affiliates.json) só nas páginas de afiliado reservadas
  if (canon.affiliatePages.has(file) && COMMISSION_CTX.test(ctx))
    for (const pct of canon.commissionPcts) allowed.add(Math.round(canon.bySlug[slug].price * pct) / 100);
  return allowed;
}

const push = (found, file, regra, produto, valor, text, at, extra = {}) =>
  found.push({ file, regra, produto, valor, linha: lineOf(text, at), trecho: text.slice(Math.max(0, at - 70), at + 40).replace(/\s+/g, " "), ...extra });
function lineOf(text, at) { let n = 1; for (let i = 0; i < at && i < text.length; i++) if (text.charCodeAt(i) === 10) n++; return n; }

// T6: percentuais (algarismo, extenso, "metade") com contexto de afiliado na mesma frase
let PCT_RX = null;
function pctRegex() {
  if (PCT_RX) return PCT_RX;
  const w = Object.keys(NUM_WORDS).filter((k) => NUM_WORDS[k] < 1000).sort((a, b) => b.length - a.length).join("|");
  PCT_RX = new RegExp(`(?<![\\d.,])(\\d{1,3}(?:[.,]\\d+)?)\\s*(?:%|por\\s+cento\\b)|(?<![\\wÀ-ÿ])((?:${w})(?:\\s+e\\s+(?:${w}))*)\\s+por\\s+cento\\b|(?<![\\wÀ-ÿ])(metade)(?![\\wÀ-ÿ])`, "giu");
  return PCT_RX;
}
export function commissionPctIn(file, text, canon, found) {
  const affPage = canon.affiliatePages.has(file);
  for (const m of text.matchAll(pctRegex())) {
    const pct = m[1] !== undefined ? Number(m[1].replace(",", ".")) : m[2] !== undefined ? parseExtenso(m[2]) : 50;
    if (pct === null) continue;
    if (PCT_NOT_COMMISSION_AFTER.test(text.slice(m.index + m[0].length, m.index + m[0].length + 20))) continue;
    const [s, e] = sentence(text, m.index, m.index + m[0].length);
    const frase = text.slice(s, e);
    if (m[3] !== undefined && !COMMISSION_CTX.test(frase)) continue; // "metade" só como fração de comissão
    const fraco = COMMISSION_CTX.test(frase) && AFFILIATE_WEAK_CTX.test(frase) && !PAYMENT_CTX.test(frase);
    if (!(AFFILIATE_CTX.test(frase) || fraco || (affPage && COMMISSION_CTX.test(frase)))) continue;
    if (canon.commissionPcts.includes(pct)) continue;
    // divisão declarada: "30% para o afiliado e 70% para o produtor" (o outro lado da taxa válida, na mesma frase)
    const perto = text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30);
    if (/produtor/i.test(perto) && canon.commissionPcts.some((v) => v + pct === 100) &&
        [...frase.matchAll(pctRegex())].some((x) => x[1] !== undefined && canon.commissionPcts.includes(Number(x[1].replace(",", "."))))) continue;
    push(found, file, "COMISSAO_PCT", "afiliado", pct, text, m.index);
  }
}

// T1/T2/T4/T5 sobre um trecho de texto
function scanProse(file, text, canon, mr, { page, html, isReserved }, found) {
  const ms = mentions(text, mr);
  for (const m of moneyIn(text)) {
    const [s, e] = sentence(text, m.at, m.end);
    const inSent = ms.filter((x) => x.at >= s && x.end <= e);
    let near = [...inSent].reverse().find((x) => x.end <= m.at) || inSent.find((x) => x.at >= m.end) || null;
    if (!near) { const lim = html ? WINDOW_BEFORE_HTML : WINDOW_BEFORE; near = [...ms].reverse().find((x) => x.end <= m.at && m.at - x.end <= lim) || null; }
    const ctx = text.slice(Math.max(0, m.at - 60), m.at);
    if (page) {
      // T2: na página de um produto, todo valor pertence ao conjunto daquele produto (ou do produto citado que é item do pacote da página)
      const ok = allowedFor(page, canon, { ms, at: m.at, ctx, page, file });
      if (!ok.has(m.value)) push(found, file, "PAGINA_DE_PRODUTO", page, m.value, text, m.at);
      continue;
    }
    if (near) {
      if (m.bare && !inSent.length) continue; // "N,NN" sem moeda só conta na mesma frase de um produto
      const ok = allowedFor(near.slug, canon, { ms, at: m.at, ctx, page, file });
      if (!ok.has(m.value)) push(found, file, "VALOR_EM_REAIS", near.slug, m.value, text, m.at);
      continue;
    }
    if (!m.bare && OFFER_CTX.test(text.slice(Math.max(0, m.at - 30), m.at)) && BRAND.test(text.slice(Math.max(0, m.at - WINDOW_BEFORE), m.end + 80)) && !canon.kitUnion.has(m.value))
      push(found, file, "VALOR_DA_MARCA", "marca", m.value, text, m.at);
  }
  commissionPctIn(file, text, canon, found); // T6 (inclusive em página de afiliado reservada)
  if (isReserved) return;
  if (DISCOUNT_EXEMPT.some((rx) => rx.test(file))) return;
  for (const d of text.matchAll(DISCOUNT)) {
    if (DISCOUNT_OK_BEFORE.test(text.slice(Math.max(0, d.index - 40), d.index)) || DISCOUNT_OK_AFTER.test(text.slice(d.index + d[0].length, d.index + d[0].length + 15))) continue;
    const [s, e] = sentence(text, d.index, d.index + d[0].length);
    const hit = page || ms.find((x) => x.at >= s && x.end <= e)?.slug;
    if (hit) push(found, file, "DESCONTO", hit, d[0], text, d.index);
  }
}

// T3: JSON-LD (e JSON em geral) — campos de preço com produto do objeto/ancestral (ou da página)
const PRICE_KEY = /^(?:[a-z_]*(?:price|preco|preço|valor|amount)[a-z_]*|lowprice|highprice)$/i;
const SKIP_KEY = /(_id|_status|_label|_text|_url|_key|count|_at|_ms|days|dias|months|meses|percent|pct|_ratio|max|min|limit|currency)$/i;
function ownProduct(o, mr) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  for (const k of ["sku", "slug", "offer_id", "product_slug", "productID", "id", "name", "product", "url", "@id"]) {
    const v = o[k];
    if (typeof v !== "string") continue;
    const m = mentions(v, mr);
    if (m.length) return m[0].slug;
  }
  return null;
}
function walkJson(node, chain, visit) {
  if (Array.isArray(node)) { node.forEach((x) => walkJson(x, chain, visit)); return; }
  if (!node || typeof node !== "object") return;
  const next = [...chain, node];
  for (const [k, v] of Object.entries(node)) { visit(k, v, next); if (v && typeof v === "object") walkJson(v, next, visit); }
}
function scanJson(file, obj, canon, mr, { page, regra }, found, text = "") {
  walkJson(obj, [], (k, v, chain) => {
    const num = typeof v === "number" ? v : typeof v === "string" && /^\d+(?:\.\d+)?$/.test(v.trim()) ? Number(v) : null;
    if (num === null) return;
    // mapa "<sku|slug>": N
    const mk = mentions(k, mr);
    const ident = mk.length && mk[0].at === 0 && mk[0].end === k.length && (k === canon.bySlug[mk[0].slug].sku || k === mk[0].slug);
    if (ident) {
      if (num !== canon.bySlug[mk[0].slug].price) found.push({ file, regra: "MAPA_DE_PRECO", produto: mk[0].slug, valor: num, linha: 0, trecho: `${k}: ${v}` });
      return;
    }
    if (!PRICE_KEY.test(k) || SKIP_KEY.test(k)) return;
    // mapa de contagens ({entrada: 7, preco: 31, margem: 35, ...}) não é preço
    const host = chain[chain.length - 1];
    if (host && Object.entries(host).filter(([kk, vv]) => typeof vv === "number" && !PRICE_KEY.test(kk)).length >= 3) return;
    let own = null;
    for (let i = chain.length - 1; i >= 0 && !own; i--) own = ownProduct(chain[i], mr);
    own = own || page;
    if (!own) return;
    const expected = /cent/i.test(k) ? canon.bySlug[own].price * 100 : canon.bySlug[own].price;
    if (num !== expected) found.push({ file, regra, produto: own, valor: num, linha: 0, trecho: `${k}: ${v}` });
  });
}

// C1/C2 em código (JS/Python): objeto literal com campo de preço e produto no objeto ou em objeto ancestral
const FIELD = /["']?\b([A-Za-z_]*(?:price|preco|preço|valor|amount)[A-Za-z_]*)\b["']?\s*:\s*["']?(-?\d+(?:\.\d+)?)(?![\d])/gi;
function enclosing(text, at) {
  let depth = 0;
  for (let i = at; i >= 0 && at - i < 2000; i--) {
    const c = text[i];
    if (c === "}") depth++;
    else if (c === "{") { if (depth === 0) { let d = 0; for (let j = i; j < text.length && j - i < 4000; j++) { if (text[j] === "{") d++; else if (text[j] === "}") { d--; if (d === 0) return [i, j + 1]; } } return null; } depth--; }
  }
  return null;
}
function idOfObject(objText, mr) {
  const m = objText.match(/["']?\b(sku|slug|offer_id|product_slug|id|product)\b["']?\s*:\s*["']([^"']+)["']/);
  if (!m) return null;
  const x = mentions(m[2], mr); return x.length ? x[0].slug : null;
}
// Código sem comentários e sem o conteúdo de strings (expressões ${...} de template ficam): J1 olha só operadores reais.
export function stripJs(src) {
  let out = "", i = 0, prev = "";
  const n = src.length, stack = [];
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (stack.length && stack[stack.length - 1] === "tpl") {
      if (c === "\\") { out += "  "; i += 2; continue; }
      if (c === "`") { stack.pop(); out += c; i++; prev = c; continue; }
      if (c === "$" && d === "{") { stack.push("expr"); out += "${"; i += 2; continue; }
      out += c === "\n" ? "\n" : " "; i++; continue;
    }
    if (c === "}" && stack.length && stack[stack.length - 1] === "expr") { stack.pop(); out += c; i++; continue; }
    if (c === "{" && stack.length) { stack.push("brace"); out += c; i++; continue; }
    if (c === "}" && stack.length && stack[stack.length - 1] === "brace") { stack.pop(); out += c; i++; continue; }
    if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") { out += " "; i++; } continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); const j = e < 0 ? n : e + 2; out += src.slice(i, j).replace(/[^\n]/g, " "); i = j; continue; }
    if (c === '"' || c === "'") { let j = i + 1; while (j < n && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1; out += c + " ".repeat(Math.max(0, j - i - 1)) + c; i = j + 1; prev = c; continue; }
    if (c === "`") { stack.push("tpl"); out += c; i++; continue; }
    if (c === "/" && /[(,=:[!&|?{};+\-*%<>~^]|^$/.test(prev)) { let j = i + 1, cls = false; while (j < n && src[j] !== "\n" && (src[j] !== "/" || cls)) { if (src[j] === "\\") j++; else if (src[j] === "[") cls = true; else if (src[j] === "]") cls = false; j++; } out += "/" + " ".repeat(Math.max(0, j - i - 1)) + "/"; i = j + 1; prev = "/"; continue; }
    out += c; if (!/\s/.test(c)) prev = c; i++;
  }
  return out;
}

function scanCode(file, text, canon, mr, { isReserved }, found) {
  const js = JS.test(file);
  for (const m of text.matchAll(FIELD)) {
    const key = m[1].toLowerCase();
    if (SKIP_KEY.test(key)) continue;
    const v = Number(m[2]);
    // objeto do campo e ancestrais (até 4 níveis): o primeiro com identificador de produto define o produto
    let obj = enclosing(text, m.index), own = null, brand = false, lvl = 0;
    while (obj && !own && lvl++ < 4) {
      const body = text.slice(obj[0], obj[1]);
      own = idOfObject(body, mr);
      if (!own) { const u = [...new Set(mentions(body, mr).map((x) => x.slug))]; if (u.length === 1 && lvl === 1) own = u[0]; }
      brand = brand || /\bbrand\b["']?\s*:\s*["']ZEVANORY["']/.test(body);
      obj = obj[0] > 0 ? enclosing(text, obj[0] - 1) : null;
    }
    if (own) {
      const expected = /cent/.test(key) ? canon.bySlug[own].price * 100 : canon.bySlug[own].price;
      if (v !== expected) push(found, file, "CAMPO_DE_PRECO", own, v, text, m.index);
    } else if (brand && !canon.kitUnion.has(v)) push(found, file, "CAMPO_DE_PRECO", "marca", v, text, m.index);
    // J2: em JS de produção não reservado, preço só por import de worker/product-prices.mjs
    else if (js && !isReserved && /price|preco|preço/i.test(key)) push(found, file, "LITERAL_DE_PRECO", "-", v, text, m.index);
  }
  // C2: mapas e pares
  for (const p of Object.values(canon.bySlug)) {
    for (const id of [p.sku, p.slug].filter(Boolean)) {
      const NUM = `(?:"(\\d+(?:\\.\\d+)?)"|'(\\d+(?:\\.\\d+)?)'|(\\d+(?:\\.\\d+)?)(?![\\w.]))`;
      const rx = new RegExp(`["']${esc(id)}["']\\s*:\\s*(?:\\[\\s*["'][^"'\\]]*["']\\s*,\\s*)?${NUM}|\\[\\s*["']${esc(id)}["']\\s*,\\s*${NUM}\\s*\\]`, "g");
      for (const m of text.matchAll(rx)) { const v = Number(m.slice(1).find((x) => x !== undefined)); if (v !== p.price) push(found, file, "MAPA_DE_PRECO", p.slug, v, text, m.index); }
    }
  }
  if (!js || isReserved) return;
  // J2: par [sku|slug|id, N] com identificador em variável (new Map([[sku, 47]]))
  for (const m of text.matchAll(/\[\s*(sku|slug|productSlug|offerId|offer_id)\s*,\s*["']?(\d+(?:\.\d+)?)\s*["']?\s*\]/g))
    push(found, file, "LITERAL_DE_PRECO", "-", Number(m[2]), text, m.index);
  // NC-1008-04 (2): literal direto em string de dinheiro — "R$ " + 47, "R$ " + (..., `R$ ${47}` — no código BRUTO
  for (const m of text.matchAll(/(?:R\$|BRL)\s*["']\s*\+\s*[\d(]|(?:R\$|BRL)\s*\$\{\s*[\d(]/g))
    push(found, file, "LITERAL_DE_PRECO", "-", m[0], text, m.index);
  const code = stripJs(text);
  // NC-1008-04 (1): variável que recebe literal numérico e tem nome de preço, ou entra em texto/campo de preço
  const literalVars = new Set();
  for (const m of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=(?![=>])\s*\(?\s*-?(\d+(?:\.\d+)?)\s*\)?(?=\s*(?:[;,)}\]]|\n|$))/g)) {
    const [, id, v] = m;
    const uso = new RegExp(`(?:R\\$|BRL)\\s*["']\\s*\\+\\s*${esc(id)}\\s*(?=[+;,)\\n]|$)|(?:R\\$|BRL)\\s*\\$\\{\\s*${esc(id)}\\s*\\}|\\b[\\w$]*(?:price|preco|valor|amount)[\\w$]*["']?\\s*:\\s*${esc(id)}\\s*(?=[,}\\n])`, "i");
    if (/price|preco|valor|amount/i.test(id) || uso.test(text)) { literalVars.add(id); push(found, file, "LITERAL_DE_PRECO", id, Number(v), text, m.index); }
  }
  // NC-1008-04 (3): todo identificador que recebe priceBy*/PRICE_BY_SKU/PRICES/bundle* é expressão de preço
  const tainted = new Set();
  for (const m of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=(?![=>])\s*(?:\b(?:priceBySlug|priceBySku|bundleSeparateTotal|bundleSavings)\s*\(|\b(?:PRICE_BY_SKU|PRICES|BLOG_TABLE_C_PRICES)\s*\[)/g))
    if (!/^(PRICES|BLOG_TABLE_C_PRICES|PRICE_BY_SKU)$/.test(m[1])) tainted.add(m[1]);
  // J1: aritmética sobre preço (inclusive += -= *= /= em nome de preço ou variável tingida)
  const TAINT = tainted.size ? `|(?<![\\w$.])(?:${[...tainted].map(esc).join("|")})(?![\\w$])` : "";
  const PRICE_EXPR = new RegExp(`(?:\\b(?:priceBySlug|priceBySku|bundleSeparateTotal|bundleSavings)\\s*\\((?:[^()]|\\([^()]*\\))*\\)|\\b(?:PRICE_BY_SKU|PRICES|BLOG_TABLE_C_PRICES)\\s*\\[[^\\]]*\\]|(?<![\\w$])[A-Za-z_$][\\w$]*(?:\\.[\\w$]+)*?(?:\\.|\\b|_)(?:[a-z_]*price[a-z_]*|[A-Za-z]*Price[A-Za-z_]*|PRICE[A-Z_]*)(?![\\w$])(?:\\[[^\\]]*\\])?${TAINT})`, "g");
  for (const m of code.matchAll(PRICE_EXPR)) {
    if (/^(import|export)$/.test(m[0])) continue;
    const after = code.slice(m.index + m[0].length, m.index + m[0].length + 12), before = code.slice(Math.max(0, m.index - 12), m.index);
    if (/^\s*\(/.test(after) && !/\)$/.test(m[0])) continue; // chamada de função com nome de preço (ex.: priceFor(...))
    const opAfter = /^\s*(?:[-*/%](?![-=*/>])|\+\s*(?:\d|\()|[-+*/%]=(?!=))/.test(after);
    const opBefore = /(?:[\d)]\s*[-+*/%]|(?<![+\-*/%=!<>&|?:,(\[{]\s*)[-*/%])\s*$/.test(before) || /(?:^|[^+])[*/%]\s*$/.test(before) || /\d\s*[-+]\s*$/.test(before);
    if (opAfter || opBefore) push(found, file, "ARITMETICA_DE_PRECO", "-", m[0], text, m.index);
  }
}

export function scanText(file, rawText, canon, mr = mentionRegex(canon)) {
  const found = [], isReserved = reserved(file, canon);
  const page = pageProduct(file, canon);
  if (/\.html?$/i.test(file)) {
    const parts = htmlParts(rawText);
    scanProse(file, parts.text, canon, mr, { page, html: true, isReserved }, found);
    for (const a of parts.attrs) scanProse(file, a, canon, mr, { page, html: true, isReserved }, found);
    for (const a of parts.pctAttrs) commissionPctIn(file, a, canon, found); // T6 em meta/og/twitter/aria/title
    for (const j of parts.jsonld) {
      scanJson(file, j, canon, mr, { page, regra: "JSON_LD" }, found);
      // textos do JSON-LD (FAQ, descrição) também são prosa da página
      const textos = []; walkJson(j, [], (k, v) => { if (typeof v === "string" && /\d/.test(v)) textos.push(v); });
      for (const t of textos) scanProse(file, decode(t), canon, mr, { page, html: true, isReserved }, found);
    }
    for (const s of parts.scripts) { const t = decode(s); scanProse(file, t, canon, mr, { page: null, html: false, isReserved }, found); scanCode(file + "#script", t, canon, mr, { isReserved: true }, found); }
    return found;
  }
  const text = decode(rawText);
  if (/\.json$/i.test(file)) {
    let obj = null; try { obj = JSON.parse(rawText); } catch { /* JSON inválido: só texto */ }
    if (obj) scanJson(file, obj, canon, mr, { page: null, regra: "CAMPO_DE_PRECO" }, found);
    scanProse(file, text, canon, mr, { page: null, html: false, isReserved }, found);
    return found;
  }
  scanProse(file, text, canon, mr, { page: null, html: false, isReserved }, found);
  if (/\.(mjs|cjs|js|py)$/i.test(file)) scanCode(file, text, canon, mr, { isReserved }, found);
  return found;
}

export function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = relative(root, abs).split(sep).join("/");
      let st; try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) { if (!EXCLUDE.some((rx) => rx.test(rel + "/"))) walk(abs); continue; }
      if (!st.isFile() || !INCLUDE_EXT.test(name) || EXCLUDE.some((rx) => rx.test(rel)) || st.size > 8 * 1024 * 1024) continue;
      out.push(rel);
    }
  };
  walk(root);
  return out.sort();
}

export function runGate(root, { files } = {}) {
  const canon = loadCanon(root);
  const mr = mentionRegex(canon);
  const list = files || listFiles(root);
  const achados = [];
  for (const f of list) {
    if (f === "data/products.json" || f === "data/affiliates.json") continue; // as próprias tabelas
    const abs = join(root, f);
    if (!existsSync(abs)) continue;
    achados.push(...scanText(f, readFileSync(abs, "utf8"), canon, mr));
  }
  const violacoes = [], usadas = new Map();
  for (const a of achados) {
    const e = EXCECOES.find((x) => x.arquivo === a.file && x.regra === a.regra && x.produto === a.produto && x.valor === a.valor);
    if (e) { usadas.set(e, (usadas.get(e) || 0) + 1); continue; }
    violacoes.push(a);
  }
  const excecoesQuebradas = [];
  for (const e of EXCECOES) {
    if (!list.includes(e.arquivo)) continue; // arquivo ausente (fixture parcial ou removido): nada a eximir
    const n = usadas.get(e) || 0;
    if (n !== e.quantidade) excecoesQuebradas.push({ ...e, encontradas: n });
  }
  return { resultado: violacoes.length || excecoesQuebradas.length ? "FAIL" : "PASS", arquivos: list.length,
    violacoes, excecoesQuebradas, canon };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--root");
  const root = i >= 0 ? args[i + 1] : fileURLToPath(new URL("../..", import.meta.url));
  let r;
  try { r = runGate(root); } catch (e) { console.log(JSON.stringify({ resultado: "FAIL", erro: String(e.message || e) })); process.exit(2); }
  const out = { resultado: r.resultado, arquivos: r.arquivos, violacoes: r.violacoes, excecoesQuebradas: r.excecoesQuebradas };
  if (args.includes("--json")) console.log(JSON.stringify(out, null, 1));
  else {
    const tab = (p) => r.canon.bySlug[p]?.price ?? "-";
    for (const v of r.violacoes) console.log(`::error title=PRECO_FORA_DA_TABELA::${v.file}:${v.linha} ${v.regra} ${v.produto} = ${v.valor} (tabela: ${tab(v.produto)}) | ${v.trecho}`);
    for (const e of r.excecoesQuebradas) console.log(`::error title=EXCECAO_DE_PRECO_DIVERGENTE::${e.arquivo} ${e.regra} ${e.produto}=${e.valor}: esperado ${e.quantidade}, encontrado ${e.encontradas}`);
    console.log(`PRICE_GATE ${r.resultado} arquivos=${r.arquivos} violacoes=${r.violacoes.length} excecoes_divergentes=${r.excecoesQuebradas.length}`);
  }
  process.exit(r.resultado === "PASS" ? 0 : 1);
}
