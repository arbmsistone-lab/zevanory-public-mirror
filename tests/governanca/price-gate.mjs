// ZEVANORY | NC-1006-02 (contra-auditoria GPT-6): gate de consistência de preços.
//
// Fonte canônica ÚNICA: data/products.json (reservado ao proprietário, classe marcos_irreversiveis). Este arquivo e o
// teste ao lado (tests/governanca/**) também são reservados e ficam FORA de rotina_autonoma: um PR autônomo não
// consegue mudar a tabela, nem o gate, nem a lista de exceções abaixo. O gate roda no check obrigatório
// "product-pages / static-audit" (os dois emissores canônicos), então um preço diferente da tabela em QUALQUER
// arquivo de produção (worker/**, scripts/**, sales-public/**, páginas, data/**, blog, e-mails) deixa o CI vermelho.
//
// Regras (todas sobre o texto normalizado: escapes \xHH/\uHHHH e entidades HTML decodificados, tags HTML removidas):
//   R1 VALOR_EM_REAIS: cada "R$ <n>" (ou "<n> reais") cujo produto mais próximo (antes, até WINDOW_BEFORE caracteres;
//      senão depois, até WINDOW_AFTER) seja conhecido precisa estar no conjunto permitido desse produto: preço da
//      tabela, e para os pacotes também os valores DERIVADOS da tabela (soma dos itens separados e economia). Um
//      item de pacote citado junto do pacote herda o conjunto do pacote ("Combo reúne IA na Prática e Vendas...").
//   R2 CAMPO_DE_PRECO: objeto/JSON com campo de preço (price, price_brl, preco, valor, amount, *_cents...) e um
//      identificador de produto (sku/slug/nome) no MESMO objeto precisa ter o preço da tabela (centavos = x100).
//   R3 MAPA_DE_PRECO: "<sku|slug>": <n> ou "<sku|slug>": ["<nome>", <n>] precisa ter o preço da tabela.
// Exceções: só as de EXCECOES (arquivo + regra + produto + valor + quantidade EXATA + motivo). Ocorrência a mais,
// a menos ou exceção que deixou de existir = falha (a lista não pode virar curinga nem ficar velha).
// Uso: node tests/governanca/price-gate.mjs [--root DIR] [--json]   (rc 0 = PASS, 1 = FAIL, 2 = entrada inválida)
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const WINDOW_BEFORE = 200;
export const WINDOW_AFTER = 25;
export const WINDOW_BEFORE_HTML = 700;
// Valores derivados documentados (não são preço): comissão de afiliado = 50% do preço da tabela, só com "comissão" ao lado.
export const AFFILIATE_RATE = 0.5;
const SAVINGS_CTX = /(economi|separad|custaria|avulso|somad|em vez de|comprar os|\bcompletos\b)/i;
const COMMISSION_CTX = /comiss/i;
const BRAND = /\bZEVANORY\b/;
const OFFER_CTX = /\b(por|custa|pre[cç]o|valor|investimento|apenas|s[oó])\b[\s:(]*(R\$\s*)?$/i;
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

// Produção = tudo que é versionado e publicado/executado, MENOS o que é teste, evidência, documentação, workflow
// (reservado à parte) e os mutantes de CI (que de propósito contêm preços errados).
export const INCLUDE_EXT = /\.(mjs|cjs|js|json|html?|txt|xml|py|css|md|toml|ya?ml|csv)$/i;
export const EXCLUDE = [
  /^\.git\//, /(^|\/)node_modules\//, /^tests\//, /^docs\//, /^evidence\//, /^\.github\//, /^scripts\/ci\//,
  /^db\//, /^migrations\//, /^sandbox\//, /^compliance\//, /^worker\/vendor\//, /^scripts\/[^/]*_test\.mjs$/,
  /^ops\//, /^CLOUDFLARE_DEPLOY_AUTHORITY\.md$/, /^OPERACAO\.md$/,
];

// Exceções documentadas (quantidade EXATA). Só o proprietário altera (arquivo reservado).
export const EXCECOES = Object.freeze([
  // Bundle recuperado da produção antiga (byte a byte, conferido por hash em central-production-deploy): guarda a
  // hipótese de preço de 2025 com price_status "pilot_hypothesis_not_validated". Não é lido pelas superfícies de
  // venda atuais; congelado aqui para que qualquer mudança nele (inclusive "corrigir" um valor) passe pelo dono.
  ...[["ia-na-pratica", 197], ["ia-na-pratica", 147], ["vendas-na-pratica", 197], ["vendas-na-pratica", 147],
    ["lucro-e-caixa", 247], ["lucro-e-caixa", 197], ["combo-ia-vendas", 297], ["combo-ia-vendas", 247],
    ["negocio-completo", 397], ["negocio-completo", 347]].map(([produto, valor]) => Object.freeze({
    arquivo: "worker/cloudflare-worker.recovered.mjs", regra: "CAMPO_DE_PRECO", produto, valor, quantidade: 1,
    motivo: "bundle legado recuperado: table_price_brl/pilot_price_brl da hipótese de 2025 (não validada)" })),
  ...["VALOR_DA_MARCA", "CAMPO_DE_PRECO"].map((regra) => Object.freeze({
    arquivo: "worker/cloudflare-worker.recovered.mjs", regra, produto: "marca", valor: 197, quantidade: 1,
    motivo: "criativo legado do bundle recuperado (R$ 197,00 da hipótese de 2025); o criativo vivo vem do catálogo" })),
  // Prova MANUAL de sandbox (Mercado Pago usuário de teste): o resolvedor da certificação isolada usa o catálogo
  // legado acima, então o valor esperado da prova espelha table_price_brl. Não é superfície de venda.
  ...[["ia-na-pratica", 197], ["vendas-na-pratica", 197], ["lucro-e-caixa", 247], ["combo-ia-vendas", 297],
    ["negocio-completo", 397]].map(([produto, valor]) => Object.freeze({
    arquivo: "scripts/mercadopago_combo_sandbox.py", regra: "MAPA_DE_PRECO", produto, valor, quantidade: 1,
    motivo: "prova de sandbox manual espelha o catálogo legado do resolvedor de certificação" })),
  // Registro histórico de ordem do dono (o que estava em produção em 12-13/10); texto de evidência, não oferta.
  Object.freeze({ arquivo: "data/commitments.json", regra: "VALOR_EM_REAIS", produto: "ia-na-pratica", valor: 197,
    quantidade: 1, motivo: "evidência histórica do compromisso offer-0001-containment (12-13/10)" }),
]);

const ENT = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", aacute: "á", eacute: "é", iacute: "í",
  oacute: "ó", uacute: "ú", atilde: "ã", otilde: "õ", acirc: "â", ecirc: "ê", ocirc: "ô", ccedil: "ç", agrave: "à",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Atilde: "Ã", Otilde: "Õ", Ccedil: "Ç", middot: "·",
  ndash: "–", mdash: "—" };

export function normalize(text, file = "") {
  let t = String(text)
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#([0-9]+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([A-Za-z]+);/g, (m, n) => ENT[n] ?? m);
  // HTML: a tag vira só os valores de atributo que são texto (data-zev-open-text="Comprar agora · R$ 97" fica junto de
  // data-zev-sku="ZEV-IA-011"); URLs e estilos saem para não afastar o nome do preço.
  if (/\.html?$/i.test(file)) t = t.replace(/<(?!\/?script)[^>]*>/g, (tag) => " " + [...tag.matchAll(/=\s*"([^"]*)"/g)]
    .map((a) => a[1]).filter((v) => !/^(https?:|mailto:|\/|#|data:)|%[0-9A-F]{2}|[{};]/i.test(v)).join(" ") + " ");
  return t.replace(/[   ]/g, " ");
}

export function loadCanon(root) {
  const d = JSON.parse(readFileSync(join(root, "data/products.json"), "utf8"));
  if (d?.schema !== "zevanory-products/v1" || !Array.isArray(d.products) || !d.products.length || !d.subscription?.slug)
    throw new Error("data/products.json inválido");
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
  return { raw: d, bySlug, kitUnion, guaranteeDays: d.guaranteeDays };
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function mentionRegex(canon) {
  const terms = [];
  for (const p of Object.values(canon.bySlug)) {
    for (const t of [p.name, p.slug, p.sku, ...(ALIASES[p.slug] || [])].filter(Boolean)) terms.push([t, p.slug]);
  }
  terms.sort((a, b) => b[0].length - a[0].length);
  const map = new Map(terms.map(([t, s]) => [t.toLowerCase(), s]));
  // nome dentro de outro nome (ex.: "Conteúdo Pronto (assinatura mensal)") continua casando pelo prefixo
  const rx = new RegExp(`(?<![A-Za-z0-9À-ÿ-])(?:${terms.map(([t]) => esc(t)).join("|")})(?![A-Za-z0-9À-ÿ]|-[a-z0-9])`, "giu");
  return { rx, map };
}

function mentions(text, mr) {
  const out = [];
  mr.rx.lastIndex = 0;
  for (const m of text.matchAll(mr.rx)) out.push({ at: m.index, end: m.index + m[0].length, slug: mr.map.get(m[0].toLowerCase()) });
  return out;
}

const AMOUNT = /R\$\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{2}))?(?![\d])|(?<![\d.,])(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{2}))?\s+reais\b/g;

function lineOf(text, at) { let n = 1; for (let i = 0; i < at && i < text.length; i++) if (text.charCodeAt(i) === 10) n++; return n; }

function nearest(ms, at, endAt, before_ = WINDOW_BEFORE) {
  let before = null, after = null;
  for (const m of ms) {
    if (m.end <= at && at - m.end <= before_) before = m;
    if (m.at >= endAt && m.at - endAt <= WINDOW_AFTER && !after) after = m;
  }
  return before || after;
}

export function scanText(file, rawText, canon, mr = mentionRegex(canon)) {
  const text = normalize(rawText, file);
  const ms = mentions(text, mr);
  const page = pageProduct(file, canon), html = /\.html?$/i.test(file);
  if (!ms.length && !page && !BRAND.test(text)) return [];
  const found = [];
  // R1
  AMOUNT.lastIndex = 0;
  for (const m of text.matchAll(AMOUNT)) {
    const inteiro = m[1] ?? m[3], cent = m[2] ?? m[4];
    const value = Number(inteiro.replace(/\./g, "")) + (cent ? Number(cent) / 100 : 0);
    // HTML: o cartão do catálogo põe o nome no topo e o preço depois da lista de itens (janela maior, sem tags)
    const near = nearest(ms, m.index, m.index + m[0].length, html ? WINDOW_BEFORE_HTML : WINDOW_BEFORE) || (page ? { slug: page } : null);
    if (!near) {
      // R1b: valor sem produto por perto mas com a marca ZEVANORY (criativo, Short, post): só preço de kit da tabela ou
      // valor derivado de pacote, quando o valor é oferta ("por/custa/preço R$ N"). Pega criativo com preço velho sem
      // nome de produto ("Organize tarefas ... por R$ 197,00" com brand:"ZEVANORY").
      if (OFFER_CTX.test(text.slice(Math.max(0, m.index - 30), m.index)) && BRAND.test(text.slice(Math.max(0, m.index - WINDOW_BEFORE), m.index + m[0].length + WINDOW_AFTER)) && !canon.kitUnion.has(value))
        found.push({ file, regra: "VALOR_DA_MARCA", produto: "marca", valor: value, linha: lineOf(text, m.index), trecho: text.slice(Math.max(0, m.index - 60), m.index + 30).replace(/\s+/g, " ") });
      continue;
    }
    const ctx = text.slice(Math.max(0, m.index - 60), m.index);
    let allowed = new Set(canon.bySlug[near.slug].allowed);
    for (const [b, parts] of Object.entries(BUNDLES)) {
      if (!parts.includes(near.slug)) continue;
      // item citado dentro do texto do pacote: na página do pacote, com o pacote por perto ou em frase de economia
      if (page === b || SAVINGS_CTX.test(ctx) || ms.some((x) => x.slug === b && Math.abs(x.at - m.index) <= WINDOW_BEFORE * 2))
        allowed = new Set([...allowed, ...canon.bySlug[b].allowed]);
    }
    if (COMMISSION_CTX.test(ctx)) allowed = new Set([...allowed, canon.bySlug[near.slug].price * AFFILIATE_RATE]);
    if (!allowed.has(value)) found.push({ file, regra: "VALOR_EM_REAIS", produto: near.slug, valor: value, linha: lineOf(text, m.index), trecho: text.slice(Math.max(0, m.index - 60), m.index + 30).replace(/\s+/g, " ") });
  }
  // R2: campo de preço dentro de um objeto com identificador de produto
  const FIELD = /["']?\b([A-Za-z_]*(?:price|preco|preço|valor|amount)[A-Za-z_]*)\b["']?\s*:\s*["']?(\d+(?:\.\d+)?)(?![\d])/gi;
  for (const m of text.matchAll(FIELD)) {
    const key = m[1].toLowerCase();
    if (/(_id|_status|_label|_text|_url|_key|count|_at|_ms|days|dias|percent|pct|_ratio|max|min|limit)$/.test(key)) continue;
    const obj = enclosingObject(text, m.index);
    if (!obj) continue;
    const ids = mentions(text.slice(obj[0], obj[1]), mr).map((x) => x.slug);
    if (!ids.length) {
      // objeto de criativo da marca sem SKU (brand:"ZEVANORY", price_brl:N): N tem de ser preço de kit da tabela
      if (/\bbrand\b["']?\s*:\s*["']ZEVANORY["']/.test(text.slice(obj[0], obj[1])) && !canon.kitUnion.has(Number(m[2])))
        found.push({ file, regra: "CAMPO_DE_PRECO", produto: "marca", valor: Number(m[2]), linha: lineOf(text, m.index), trecho: text.slice(Math.max(0, m.index - 60), m.index + 40).replace(/\s+/g, " ") });
      continue;
    }
    const uniq = [...new Set(ids)];
    // objeto que descreve vários produtos (lista inteira em uma linha) não identifica um produto só: R1/R3 cobrem
    const own = idOfObject(text.slice(obj[0], obj[1]), mr) || (uniq.length === 1 ? uniq[0] : null);
    if (!own) continue;
    const p = canon.bySlug[own];
    const v = Number(m[2]);
    const expected = /cent/.test(key) ? p.price * 100 : p.price;
    if (v !== expected) found.push({ file, regra: "CAMPO_DE_PRECO", produto: own, valor: v, linha: lineOf(text, m.index), trecho: text.slice(Math.max(0, m.index - 60), m.index + 40).replace(/\s+/g, " ") });
  }
  // R3: mapa "<sku|slug>": n  ou  "<sku|slug>": ["nome", n]
  for (const p of Object.values(canon.bySlug)) {
    for (const id of [p.sku, p.slug].filter(Boolean)) {
      const rx = new RegExp(`["']${esc(id)}["']\\s*:\\s*(?:\\[\\s*["'][^"'\\]]*["']\\s*,\\s*)?(\\d+(?:\\.\\d+)?)(?![\\d])`, "g");
      for (const m of text.matchAll(rx)) {
        if (Number(m[1]) !== p.price) found.push({ file, regra: "MAPA_DE_PRECO", produto: p.slug, valor: Number(m[1]), linha: lineOf(text, m.index), trecho: m[0] });
      }
    }
  }
  return found;
}

// Página de UM produto (sales-public/<slug>.html, <slug>/index.html, pages-mirror/...<slug>.html): o produto da página
// vale como contexto para valores sem nome por perto ("Total R$ 157").
export function pageProduct(file, canon) {
  if (!/\.html?$/i.test(file)) return null;
  const base = file.replace(/\/index\.html?$/i, "").replace(/\.html?$/i, "").split("/").pop();
  return Object.keys(canon.bySlug).find((s) => base === s || base.endsWith("-" + s) || base.endsWith("_" + s)) || null;
}

function idOfObject(objText, mr) {
  const m = objText.match(/["']?\b(sku|slug|offer_id|product_slug|id)\b["']?\s*:\s*["']([^"']+)["']/);
  if (!m) return null;
  return mr.map.get(m[2].toLowerCase()) || null;
}

function enclosingObject(text, at) {
  let depth = 0, start = -1;
  for (let i = at; i >= 0 && at - i < 1500; i--) {
    const c = text[i];
    if (c === "}") depth++;
    else if (c === "{") { if (depth === 0) { start = i; break; } depth--; }
  }
  if (start < 0) return null;
  depth = 0;
  for (let i = start; i < text.length && i - start < 3000; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return [start, i + 1]; }
  }
  return null;
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
    if (f === "data/products.json") continue; // a própria tabela
    const abs = join(root, f);
    if (!existsSync(abs)) continue;
    achados.push(...scanText(f, readFileSync(abs, "utf8"), canon, mr));
  }
  // aplica exceções com quantidade exata
  const violacoes = [], usadas = new Map();
  for (const a of achados) {
    const e = EXCECOES.find((x) => x.arquivo === a.file && x.regra === a.regra && x.produto === a.produto && x.valor === a.valor);
    if (e) { usadas.set(e, (usadas.get(e) || 0) + 1); continue; }
    violacoes.push(a);
  }
  const excecoesQuebradas = [];
  for (const e of EXCECOES) {
    const n = usadas.get(e) || 0;
    if (!list.includes(e.arquivo)) continue; // arquivo ausente (fixture parcial ou removido): nada a eximir
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
    for (const v of r.violacoes) console.log(`::error title=PRECO_FORA_DA_TABELA::${v.file}:${v.linha} ${v.regra} ${v.produto} = ${v.valor} (tabela: ${r.canon.bySlug[v.produto]?.price ?? [...r.canon.kitUnion].sort((a, b) => a - b).join('/')}) | ${v.trecho}`);
    for (const e of r.excecoesQuebradas) console.log(`::error title=EXCECAO_DE_PRECO_DIVERGENTE::${e.arquivo} ${e.regra} ${e.produto}=${e.valor}: esperado ${e.quantidade}, encontrado ${e.encontradas}`);
    console.log(`PRICE_GATE ${r.resultado} arquivos=${r.arquivos} violacoes=${r.violacoes.length} excecoes_divergentes=${r.excecoesQuebradas.length}`);
  }
  process.exit(r.resultado === "PASS" ? 0 : 1);
}
