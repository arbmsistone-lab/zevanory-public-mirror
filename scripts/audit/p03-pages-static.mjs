// P03 | Auditoria estática de TODAS as páginas HTML de sales-public/ (sem rede, sem navegador, só leitura).
// Complementa scripts/audit/p03-pages-browser.mjs (axe, teclado, alvos e overflow no Chromium).
// Inventário: os arquivos *.html de sales-public/ precisam ser EXATAMENTE as rotas de HTML_ROUTES
// (scripts/build_sales_public.py) mais index.html (cópia física de /solucoes) e 404.html (servida pelo
// Worker para rotas desconhecidas); as rotas do Worker (htmlRoutes) precisam ser as mesmas do gerador.
// Cada página: lang, title, h1, main, skip-link, viewport, links internos, canonical/meta, sitemap e
// coerência comercial (preços da tabela C, aviso de vendas fechadas, sem depoimento/avaliação
// fabricados, sem preço "de" fictício). Cada achado tem um código estável (S01...S21).
// S20/S21 (P03 O2): toda página que cita preço da tabela C traz um aviso que nunca mente: nas páginas que o
// Worker atualiza pelo interruptor (SALES_TOGGLE_PAGES), o aviso de vendas fechadas data-zev-closed (que o
// Worker remove quando abre); em todas as outras, o aviso neutro .price-note, verdadeiro nos dois estados.
// Um data-zev-closed fora das páginas do interruptor ficaria falso com as vendas abertas (S21).
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export const SALES_ORIGIN = "https://vendas.zevanory.api.br";
// Tabela C (roteiro, preços de tabela vigentes): fonte desta auditoria; conferida contra
// data/products.json, o COMMERCE do gerador e o PRICES do Worker.
export const TABLE_C = Object.freeze({
  "ia-na-pratica": ["IA na Prática", 97], "vendas-na-pratica": ["Vendas na Prática", 97],
  "lucro-e-caixa": ["Lucro & Caixa", 147], "combo-ia-vendas": ["Combo IA + Vendas", 157],
  "negocio-completo": ["Negócio Completo", 247],
});
// Valores derivados que o próprio material declara (soma separada, economia, comissão de 30% de data/affiliates.json).
export const DERIVED = Object.freeze({ "combo-ia-vendas": [194, 37, 47.1], "negocio-completo": [341, 94, 74.1],
  "ia-na-pratica": [29.1], "vendas-na-pratica": [29.1], "lucro-e-caixa": [44.1] });
// Rotas especiais: a página 404 é servida pelo Worker em qualquer rota desconhecida (status 404);
// /conteudo-pronto é interceptada pelo Worker (DEC-04: tombstone 404, igual ao arquivo gerado);
// index.html é a cópia física do catálogo, servida em /index.html (a raiz / reescreve para /solucoes).
export const NOT_FOUND_PROBE = "/p03-rota-inexistente";
export const SPECIAL = Object.freeze({ index: { path: "/index.html", status: 200, canonical: "/solucoes" }, "404": { path: NOT_FOUND_PROBE, status: 404 },
  "conteudo-pronto": { path: "/conteudo-pronto", status: 404 } });
// Caminhos dinâmicos do Worker que não são arquivos (aceitos como destino de link interno).
const WORKER_PATHS = [/^\/comprar\/ZEV-[A-Z0-9-]+$/, /^\/assinar\/[a-z-]+$/, /^\/api\/[a-z0-9/_-]+$/, /^\/lista-de-espera$/];

const strip = (s) => s.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ");
export const decode = (s) => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
export const visibleText = (html) => decode(strip(html.split(/<body\b[^>]*>/i)[1] || html).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`, "i")); return m ? decode(m[1]) : null; };
const tags = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map((m) => m[0]);
const ids = (html) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const meta = (html, key, val) => tags(html, "meta").filter((t) => attr(t, key) === val).map((t) => attr(t, "content"));

export function parsePyTuple(src, name) {
  const m = src.match(new RegExp(`^${name} = \\(([\\s\\S]*?)^\\)`, "m"));
  if (!m) throw new Error(`${name} ausente no gerador`);
  return [...m[1].matchAll(/"([a-z0-9-]+)"/g)].map((x) => x[1]);
}
export function parseWorkerRoutes(src) {
  const m = src.match(/const htmlRoutes=new Set\(\[([^\]]*)\]\)/);
  if (!m) throw new Error("htmlRoutes ausente no Worker");
  return [...m[1].matchAll(/"([a-z0-9-]+)"/g)].map((x) => x[1]);
}
// Páginas cujo HTML o Worker reescreve conforme o interruptor de vendas, e apelidos servidos como elas
// (/index.html -> página solucoes, para a cópia física nunca mostrar "fechadas" com vendas abertas).
export function parseWorkerToggle(src) {
  const m = src.match(/const SALES_TOGGLE_PAGES=new Set\(\[([^\]]*)\]\)/);
  if (!m) throw new Error("SALES_TOGGLE_PAGES ausente no Worker");
  const toggle = [...m[1].matchAll(/"([a-z0-9-]+)"/g)].map((x) => x[1]);
  const aliases = {};
  for (const a of src.matchAll(/url\.pathname==="\/([a-z0-9-]+)\.html"\)\s*\{\s*url\.pathname="\/([a-z0-9-]+)\.html";\s*page="\2";/g)) aliases[a[1]] = a[2];
  return { togglePages: toggle, workerAliases: aliases };
}
export function parseSitemap(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
}

export function loadSite(root, dir = join(root, "sales-public")) {
  const routes = parsePyTuple(readFileSync(join(root, "scripts/build_sales_public.py"), "utf8"), "HTML_ROUTES");
  const workerRoutes = parseWorkerRoutes(readFileSync(join(root, "worker/sales-public-worker.mjs"), "utf8"));
  const files = readdirSync(dir).filter((f) => f.endsWith(".html")).sort();
  const pages = Object.fromEntries(files.map((f) => [f.slice(0, -5), readFileSync(join(dir, f), "utf8")]));
  const sitemap = parseSitemap(readFileSync(join(dir, "sitemap.xml"), "utf8"));
  const products = JSON.parse(readFileSync(join(root, "data/products.json"), "utf8")).products;
  const gen = readFileSync(join(root, "scripts/build_sales_public.py"), "utf8");
  const genPrices = Object.fromEntries([...gen.matchAll(/"([a-z-]+)": \{"sku": "[^"]+", "name": "[^"]+", "price": (\d+)/g)].map((m) => [m[1], +m[2]]));
  const wsrc = readFileSync(join(root, "worker/sales-public-worker.mjs"), "utf8");
  const wm = wsrc.match(/const PRICES=(\{[^;]*\});/);
  const workerPrices = wm ? Object.fromEntries(Object.values(JSON.parse(wm[1])).map(([n, p]) => [n, p])) : {};
  return { dir, routes, workerRoutes, files, pages, sitemap, products, genPrices, workerPrices, ...parseWorkerToggle(wsrc) };
}

// Caminho público de cada arquivo e status esperado.
export function urlFor(slug) { return SPECIAL[slug] || { path: "/" + slug, status: 200 }; }
export function inventory(site) {
  const expected = [...site.routes, "index", "404"].sort();
  const have = Object.keys(site.pages).sort();
  const problems = [];
  const missing = expected.filter((s) => !have.includes(s)), extra = have.filter((s) => !expected.includes(s));
  if (missing.length) problems.push({ code: "S01", page: "*", msg: `páginas previstas sem arquivo: ${missing.join(", ")}` });
  if (extra.length) problems.push({ code: "S01", page: "*", msg: `arquivos fora do inventário do gerador: ${extra.join(", ")}` });
  const w = [...site.workerRoutes].sort(), r = [...site.routes].sort();
  if (JSON.stringify(w) !== JSON.stringify(r)) problems.push({ code: "S02", page: "*", msg: `rotas do Worker != HTML_ROUTES do gerador (só Worker: ${w.filter((x) => !r.includes(x)).join(",") || "-"}; só gerador: ${r.filter((x) => !w.includes(x)).join(",") || "-"})` });
  if (new Set(site.routes).size !== site.routes.length) problems.push({ code: "S01", page: "*", msg: "HTML_ROUTES com rota duplicada" });
  return { expected, have, count: have.length, problems };
}

const isNoindex = (html) => meta(html, "name", "robots").some((c) => /noindex/i.test(c || ""));
const canonicals = (html) => tags(html, "link").filter((t) => attr(t, "rel") === "canonical").map((t) => attr(t, "href"));
export const FULL_LAYOUT_EXEMPT = new Set(["conteudo-pronto"]);  // tombstone DEC-04: página mínima, sem layout do site

export function checkPage(slug, html, site) {
  const out = [];
  const p = (code, msg) => out.push({ code, page: slug, msg });
  const htmlTag = tags(html, "html")[0] || "";
  if (attr(htmlTag, "lang") !== "pt-BR") p("S03", `lang do <html> = ${attr(htmlTag, "lang")}`);
  const titles = [...html.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => decode(m[1]).trim());
  if (titles.length !== 1 || !titles[0]) p("S04", `title: ${titles.length} elemento(s)`);
  const h1 = (html.match(/<h1\b/gi) || []).length;
  if (h1 !== 1) p("S05", `${h1} h1 (esperado 1)`);
  const mains = tags(html, "main");
  if (mains.length !== 1) p("S06", `${mains.length} <main> (esperado 1)`);
  if (!tags(html, "meta").some((t) => attr(t, "name") === "viewport" && /width=device-width/.test(attr(t, "content") || ""))) p("S07", "sem meta viewport width=device-width");
  if (!FULL_LAYOUT_EXEMPT.has(slug)) {
    const skip = html.match(/<body\b[^>]*>\s*<a class="skip-link" href="#([^"]+)"/);
    if (!skip) p("S08", "skip-link ausente ou não é o primeiro elemento do body");
    else if (!new RegExp(`<main\\b[^>]*\\sid="${skip[1]}"`).test(html)) p("S08", `skip-link aponta para #${skip[1]}, que não é o <main>`);
    if (!/<header\b/.test(html)) p("S09", "sem <header> (landmark banner)");
    const navs = tags(html, "nav");
    if (!navs.length) p("S09", "sem <nav>");
    if (navs.length > 1 && navs.some((n) => !attr(n, "aria-label") && !attr(n, "aria-labelledby"))) p("S09", "várias <nav> e alguma sem rótulo acessível");
  }
  // Links internos.
  const own = ids(html);
  for (const a of tags(html, "a")) {
    const href = attr(a, "href");
    if (href === null) continue;
    if (href === "" ) { p("S10", "link com href vazio"); continue; }
    let path = null, frag = null;
    if (href.startsWith("#")) { frag = href.slice(1); if (frag && !own.has(frag)) p("S10", `âncora #${frag} inexistente`); continue; }
    if (href.startsWith("/") && !href.startsWith("//")) [path, frag] = href.split("#");
    else if (href.startsWith(SALES_ORIGIN + "/") || href === SALES_ORIGIN) [path, frag] = (href.slice(SALES_ORIGIN.length) || "/").split("#");
    else continue;  // externo, mailto, tel
    path = path.split("?")[0];
    const r = resolvePath(path, site);
    if (!r.ok) p("S10", `link interno quebrado: ${href}`);
    else if (frag && r.slug && !ids(site.pages[r.slug] || "").has(frag)) p("S10", `âncora inexistente no destino: ${href}`);
  }
  // Canonical, descrição e Open Graph.
  const canon = canonicals(html);
  if (!isNoindex(html)) {
    if (canon.length !== 1) p("S11", `${canon.length} canonical (esperado 1)`);
    else {
      const want = slug === "index" ? `${SALES_ORIGIN}/solucoes` : `${SALES_ORIGIN}/${slug}`;
      // O3: exatamente o endereço servido (/slug, 200 sem redirect; /slug/ é outra URL, nunca a canônica).
      if (canon[0] !== want) p("S11", `canonical ${canon[0]} != ${want} (endereço servido)`);
      const og = meta(html, "property", "og:url");
      if (og.length && og[0] !== canon[0]) p("S11", `og:url ${og[0]} != canonical ${canon[0]}`);
    }
    if (meta(html, "name", "description").filter(Boolean).length !== 1) p("S12", "meta description ausente ou duplicada");
  } else if (canon.length > 1) p("S11", "várias canonical numa página noindex");
  out.push(...commercial(slug, html));
  out.push(...availability(slug, html, site));
  return out;
}

// Preço da tabela C citado no texto visível (R$ 97, R$ 97,00...; não casa R$ 97,50 nem R$ 1.970).
export const PRICE_CITE = new RegExp(`R\\$ ?(?:${[...new Set(Object.values(TABLE_C).map(([, v]) => v))].join("|")})(?:,00)?(?!\\d|[.,]\\d)`);
export const AVAILABILITY_NOTE_RE = /<p class="price-note">([^<]*)<\/p>/;
// O aviso neutro tem de dizer as duas coisas verdadeiras nos dois estados (e nada de "fechadas" afirmativo).
export const noteTextOk = (t) => /Confira a disponibilidade na página do produto/.test(t) && /as vendas podem estar temporariamente fechadas/.test(t);
export const togglePageOf = (slug, site) => (site.workerAliases || {})[slug] || slug;
export function availability(slug, html, site) {
  const out = [];
  const p = (code, msg) => out.push({ code, page: slug, msg });
  const toggled = (site.togglePages || []).includes(togglePageOf(slug, site));
  const priced = PRICE_CITE.test(visibleText(html)) || /class="catalog-price"|Preço de tabela:/.test(html);
  if (/\sdata-zev-closed\b/.test(html) && !toggled) p("S21", "aviso fixo de vendas fechadas numa página que o Worker não atualiza (ficaria falso com as vendas abertas)");
  if (priced && !toggled) {
    const m = html.match(AVAILABILITY_NOTE_RE);
    if (!m) p("S20", "preço da tabela C sem aviso de disponibilidade (.price-note)");
    else if (!noteTextOk(m[1])) p("S20", `aviso de disponibilidade com texto fora do padrão: ${m[1].slice(0, 80)}`);
  }
  if (priced && toggled && !/<p class="sales-notice" data-zev-closed>[^<]*vendas temporariamente fechadas/.test(html)) p("S20", "página do interruptor com preço e sem o aviso de vendas fechadas");
  return out;
}

export function resolvePath(path, site) {
  if (path === "/" || path === "") return { ok: true, slug: "solucoes" };
  const key = path.replace(/^\/|\/$/g, "");
  if (site.routes.includes(key)) return { ok: true, slug: key };
  if (WORKER_PATHS.some((re) => re.test(path))) return { ok: true, slug: null };
  const file = join(site.dir, decodeURIComponent(path));
  if (/\.[a-z0-9]{1,8}$/i.test(path) && existsSync(file)) return { ok: true, slug: path.endsWith(".html") ? key.slice(0, -5) : null };
  return { ok: false };
}

// Coerência comercial (12-B.1 e 12-B.2): preço de tabela, aviso de vendas fechadas, sem fabricação.
export function commercial(slug, html) {
  const out = [];
  const p = (code, msg) => out.push({ code, page: slug, msg });
  const text = visibleText(html);
  const names = Object.values(TABLE_C).map(([n]) => n);
  // S13: cada citação "<produto> ... R$ N" (primeiro valor depois do nome, sem outro produto nem
  // "economia/comissão/separad" no meio) precisa ser o preço da tabela C.
  for (const [ps, [name, price]] of Object.entries(TABLE_C)) {
    const allowed = new Set([price, ...(DERIVED[ps] || [])]);
    let i = -1;
    while ((i = text.indexOf(name, i + 1)) !== -1) {
      const tail = text.slice(i + name.length, i + name.length + 120);
      const m = tail.match(/R\$ ?(\d{1,3}(?:\.\d{3})*(?:,\d{2})?)/);
      if (!m) continue;
      const before = tail.slice(0, m.index);
      // Outro produto no meio, valor derivado declarado ou o nome citado como parte de um pacote
      // ("... e o Vendas na Prática completos, por R$ 157") não atribuem o valor a este produto.
      if (names.some((n) => before.includes(n)) || /economia|comiss|separad|desconto|complet|\bou\b|\./i.test(before)) continue;
      const v = +m[1].replace(/\./g, "").replace(",", ".");
      if (!allowed.has(v)) p("S13", `${name} citado com R$ ${m[1]} (tabela C: R$ ${price})`);
    }
  }
  if (TABLE_C[slug]) {
    const m = text.match(/Preço de tabela: R\$ (\d+)/);
    if (!m || +m[1] !== TABLE_C[slug][1]) p("S13", `preço de tabela da página ${m ? m[1] : "ausente"} != ${TABLE_C[slug][1]}`);
  }
  for (const m of html.matchAll(/<h3><a href="\/([a-z-]+)">[^<]*<\/a><\/h3>(?:(?!<\/article>)[\s\S])*?<p class="catalog-price">R\$ (\d+)</g)) {
    if (TABLE_C[m[1]] && +m[2] !== TABLE_C[m[1]][1]) p("S13", `catálogo: ${m[1]} R$ ${m[2]} != ${TABLE_C[m[1]][1]}`);
  }
  // S14: página com CTA de compra/espera ou bloco de preço precisa do aviso de vendas fechadas (build fechado).
  const hasCta = /data-zev-sku=|data-zev-sub=|class="catalog-price"|Preço de tabela:/.test(html);
  if (hasCta && !/<p class="sales-notice" data-zev-closed>[^<]*vendas temporariamente fechadas/.test(html)) p("S14", "CTA/preço sem o aviso de vendas fechadas");
  if (/href="\/comprar\//.test(html) || /pay\.hotmart\.com/.test(html)) p("S14", "link de compra ativo no build fechado");
  // S15: avaliação/depoimento fabricados (texto ou dado estruturado).
  if (/"@type"\s*:\s*"(?:Review|AggregateRating)"|"aggregateRating"|"review"\s*:/.test(html)) p("S15", "Review/AggregateRating no JSON-LD");
  if (/★|☆|\b\d+(?:[.,]\d)?\s*\/\s*5\b|\bestrelas\b|avaliações de clientes|clientes satisfeitos|depoimentos? de clientes|nota média/i.test(text)) p("S15", "avaliação/depoimento de cliente no texto");
  // <blockquote class="guide-model"> é modelo de mensagem com [campos], não fala de cliente.
  if (tags(html, "blockquote").some((t) => attr(t, "class") !== "guide-model")) p("S15", "<blockquote> (depoimento) sem origem verificável registrada");
  // S16: preço "de" fictício, riscado ou ancorado.
  if (/<(?:s|del|strike)\b/i.test(html) || /text-decoration:\s*line-through/i.test(html)) p("S16", "preço riscado (<s>/<del>)");
  if (/\bde R\$ ?\d[\d.,]*\s*(?:por|para)\s*(?:apenas\s*)?R\$/i.test(text) || /\b(?:antes|era|valor original)\s*:?\s*R\$/i.test(text)) p("S16", "preço \"de/por\" ou valor original fictício");
  // S17: escassez fictícia (12-B.1, item 3).
  if (/últimas? (?:vagas|unidades)|só hoje|oferta termina|restam \d+|apenas \d+ vagas/i.test(text)) p("S17", "escassez/contador fictício");
  return out;
}

export function siteChecks(site) {
  const out = [];
  const p = (code, page, msg) => out.push({ code, page, msg });
  // S04/S12: títulos e descrições únicos (index é a cópia declarada de solucoes).
  const seenT = new Map(), seenD = new Map();
  for (const [slug, html] of Object.entries(site.pages)) {
    if (slug === "index") continue;
    const t = (html.match(/<title>([^<]*)<\/title>/) || [])[1];
    if (t) { if (seenT.has(t)) p("S04", slug, `title repetido de ${seenT.get(t)}: "${decode(t)}"`); else seenT.set(t, slug); }
    if (!isNoindex(html)) {
      const d = meta(html, "name", "description")[0];
      if (d) { if (seenD.has(d)) p("S12", slug, `description repetida de ${seenD.get(d)}`); else seenD.set(d, slug); }
    }
  }
  if (site.pages.index && site.pages.solucoes && site.pages.index !== site.pages.solucoes) p("S01", "index", "index.html difere de solucoes.html (cópia física esperada)");
  // S18: sitemap <-> páginas indexáveis.
  const locs = new Set(site.sitemap);
  for (const loc of locs) {
    if (!loc.startsWith(SALES_ORIGIN + "/")) { p("S18", "sitemap", `loc fora do domínio de vendas: ${loc}`); continue; }
    const key = loc.slice(SALES_ORIGIN.length + 1).replace(/\/$/, "");
    const html = site.pages[key];
    if (!html || !site.routes.includes(key)) { p("S18", "sitemap", `loc sem página: ${loc}`); continue; }
    if (isNoindex(html)) p("S18", key, `noindex mas listada no sitemap`);
    else if (canonicals(html)[0] !== loc) p("S18", key, `canonical ${canonicals(html)[0]} != loc do sitemap ${loc}`);
  }
  if (site.sitemap.length !== locs.size) p("S18", "sitemap", "loc duplicado");
  for (const [slug, html] of Object.entries(site.pages)) {
    if (slug === "index" || slug === "404" || isNoindex(html)) continue;
    const c = canonicals(html)[0];
    if (!locs.has(c)) p("S18", slug, `indexável fora do sitemap (canonical ${c})`);
  }
  // S19: tabela C == data/products.json == gerador == Worker.
  for (const [slug, [name, price]] of Object.entries(TABLE_C)) {
    const prod = site.products.find((x) => x.slug === slug);
    if (!prod || prod.price !== price || prod.name !== name) p("S19", slug, `data/products.json diverge da tabela C (${prod && prod.price})`);
    if (site.genPrices[slug] !== price) p("S19", slug, `COMMERCE do gerador diverge da tabela C (${site.genPrices[slug]})`);
    if (site.workerPrices[name] !== price) p("S19", slug, `PRICES do Worker diverge da tabela C (${site.workerPrices[name]})`);
  }
  return out;
}

export function auditStatic(root, dir) {
  const site = loadSite(root, dir);
  const inv = inventory(site);
  const problems = [...inv.problems, ...siteChecks(site)];
  for (const [slug, html] of Object.entries(site.pages)) problems.push(...checkPage(slug, html, site));
  return { site, inventory: { count: inv.count, expected: inv.expected.length, routes: site.routes.length, sitemap: site.sitemap.length,
    pages: inv.have.map((s) => ({ slug: s, ...urlFor(s), indexable: !isNoindex(site.pages[s]), inSitemap: site.sitemap.includes(canonicals(site.pages[s])[0]) })) }, problems };
}
