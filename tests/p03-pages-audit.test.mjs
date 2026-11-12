// P03 | Auditoria estática de todas as páginas de sales-public/ (scripts/audit/p03-pages-static.mjs).
// P1 roda na árvore real (72 páginas, zero achados); P2-P9 provam, com páginas mínimas em memória, que cada
// regra detecta o defeito que diz detectar e não acusa a página limpa. Marcadores [Pn.k] = asserções
// referenciadas por scripts/ci/mutants_p03_pages_allow.json.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readTextNormalized } from "./helpers/text.mjs";
import { join, normalize } from "node:path";
import { auditStatic, checkPage, siteChecks, inventory, commercial, availability, urlFor, visibleText, PRICE_CITE, SALES_ORIGIN } from "../scripts/audit/p03-pages-static.mjs";
import worker from "../worker/sales-public-worker.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const O = SALES_ORIGIN;
const page = ({ slug = "x", lang = "pt-BR", title = `T ${slug}`, desc = `d ${slug}`, canon = `${O}/${slug}`, head = "", body = "", skip = "#conteudo",
  header = '<header><nav aria-label="Principal"><a href="/x">x</a></nav></header>', h1 = "<h1>X</h1>", mainId = "conteudo", viewport = true } = {}) =>
  `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">${viewport ? '<meta name="viewport" content="width=device-width,initial-scale=1">' : ""}` +
  `${title === null ? "" : `<title>${title}</title>`}${desc === null ? "" : `<meta name="description" content="${desc}">`}` +
  `${canon === null ? "" : `<link rel="canonical" href="${canon}">`}${head}</head><body>${skip === null ? "" : `<a class="skip-link" href="${skip}">Ir para o conteúdo</a>`}` +
  `${header}<main id="${mainId}">${h1}${body}</main></body></html>`;
const site = (pages, extra = {}) => ({ dir: "/nao-existe", routes: Object.keys(pages).filter((s) => s !== "index" && s !== "404"),
  workerRoutes: Object.keys(pages).filter((s) => s !== "index" && s !== "404"), files: Object.keys(pages).map((s) => s + ".html"), pages,
  sitemap: Object.keys(pages).filter((s) => s !== "index" && s !== "404").map((s) => `${O}/${s}`),
  products: [["ia-na-pratica", "IA na Prática", 97], ["vendas-na-pratica", "Vendas na Prática", 97], ["lucro-e-caixa", "Lucro & Caixa", 147],
    ["combo-ia-vendas", "Combo IA + Vendas", 157], ["negocio-completo", "Negócio Completo", 247]].map(([slug, name, price]) => ({ slug, name, price })),
  genPrices: { "ia-na-pratica": 97, "vendas-na-pratica": 97, "lucro-e-caixa": 147, "combo-ia-vendas": 157, "negocio-completo": 247 },
  workerPrices: { "IA na Prática": 97, "Vendas na Prática": 97, "Lucro & Caixa": 147, "Combo IA + Vendas": 157, "Negócio Completo": 247 },
  togglePages: ["ia-na-pratica", "vendas-na-pratica", "lucro-e-caixa", "combo-ia-vendas", "negocio-completo", "solucoes", "conteudo-pronto"],
  workerAliases: { index: "solucoes" }, ...extra });
const codes = (list) => list.map((p) => p.code);
const one = (html, slug = "x", s = site({ x: html, y: page({ slug: "y" }) })) => codes(checkPage(slug, html, s));
const NOTICE = '<p class="sales-notice" data-zev-closed>Aviso: vendas temporariamente fechadas. Os preços são informativos.</p>';
const NOTE = '<p class="price-note">Valores de tabela, para referência. Confira a disponibilidade na página do produto; as vendas podem estar temporariamente fechadas.</p>';

test("P1 árvore real: 72 páginas inventariadas e zero achados estáticos", () => {
  const r = auditStatic(ROOT);
  assert.equal(r.inventory.count, 72, "[P1.1] contagem de páginas HTML em sales-public");
  assert.equal(r.inventory.routes + 2, r.inventory.expected, "[P1.2] inventário = HTML_ROUTES + index + 404");
  assert.equal(r.inventory.expected, r.inventory.count, "[P1.2] inventário = arquivos");
  assert.deepEqual(r.problems, [], "[P1.3] achados estáticos na árvore real");
  const p404 = r.inventory.pages.find((p) => p.slug === "404"), pidx = r.inventory.pages.find((p) => p.slug === "index");
  assert.deepEqual([p404.status, pidx.path, r.inventory.pages.find((p) => p.slug === "conteudo-pronto").status], [404, "/index.html", 404], "[P1.4] rotas especiais");
});

test("P2 inventário exato: arquivo faltando, arquivo extra e Worker divergente", () => {
  const ok = site({ a: page({ slug: "a" }), index: page({ slug: "index" }), "404": page({ slug: "404" }) });
  assert.deepEqual(inventory(ok).problems, [], "[P2.0] inventário coerente");
  const missing = { ...ok, routes: [...ok.routes, "b"], workerRoutes: [...ok.workerRoutes, "b"] };
  assert.ok(codes(inventory(missing).problems).includes("S01"), "[P2.1] rota prevista sem arquivo");
  const extra = { ...ok, pages: { ...ok.pages, c: page({ slug: "c" }) } };
  assert.ok(codes(inventory(extra).problems).includes("S01"), "[P2.2] arquivo fora do inventário (a 72ª página não pode sumir do inventário)");
  const nf = { ...ok, pages: { a: ok.pages.a, index: ok.pages.index } };
  assert.ok(codes(inventory(nf).problems).includes("S01"), "[P2.2] 404.html ausente");
  assert.ok(codes(inventory({ ...ok, workerRoutes: ["a", "z"] }).problems).includes("S02"), "[P2.3] Worker com rota diferente do gerador");
});

test("P3 página limpa não gera achado (controle de falso positivo)", () => {
  const html = page({ body: '<p><a href="/y">y</a> <a href="#conteudo">topo</a> <a href="mailto:a@b.c">m</a> <a href="https://exemplo.com/z">e</a></p>' });
  assert.deepEqual(checkPage("x", html, site({ x: html, y: page({ slug: "y" }) })), [], "[P3.1] página limpa");
  assert.deepEqual(commercial("x", page({ body: "<p>Combo IA + Vendas: R$ 157 (separados custariam R$ 194). Economia de R$ 37.</p>" })), [], "[P3.2] valores derivados declarados");
});

test("P4 estrutura: lang, title, h1, main, viewport, skip-link e landmarks", () => {
  assert.ok(one(page({ lang: "en" })).includes("S03"), "[P4.1] lang diferente de pt-BR");
  assert.ok(one(page({ title: null })).includes("S04"), "[P4.2] sem title");
  assert.ok(one(page({ h1: "<h1>A</h1><h1>B</h1>" })).includes("S05"), "[P4.3] dois h1");
  assert.ok(one(page({ h1: "" })).includes("S05"), "[P4.4] sem h1");
  assert.ok(one(page({ body: "<main>2</main>" })).includes("S06"), "[P4.5] dois main");
  assert.ok(one(page({ viewport: false })).includes("S07"), "[P4.6] sem viewport");
  assert.ok(one(page({ skip: null })).includes("S08"), "[P4.7] sem skip-link");
  assert.ok(one(page({ skip: "#outro", body: '<p id="outro">o</p>' })).includes("S08"), "[P4.8] skip-link fora do main");
  assert.ok(one(page({ header: '<nav aria-label="N"><a href="/x">x</a></nav>' })).includes("S09"), "[P4.9] sem header");
  assert.ok(one(page({ body: '<nav><a href="/y">y</a></nav><nav><a href="/x">x</a></nav>' })).includes("S09"), "[P4.10] navs sem rótulo");
  const tomb = page({ slug: "conteudo-pronto", skip: null, header: "", canon: null, desc: null, head: '<meta name="robots" content="noindex,nofollow">' });
  assert.deepEqual(one(tomb, "conteudo-pronto", site({ "conteudo-pronto": tomb })), [], "[P4.11] tombstone DEC-04 isento só de skip-link/header");
});

test("P5 links internos e âncoras", () => {
  assert.ok(one(page({ body: '<a href="/nao-existe">q</a>' })).includes("S10"), "[P5.1] rota interna inexistente");
  assert.ok(one(page({ body: '<a href="#sumiu">q</a>' })).includes("S10"), "[P5.2] âncora local inexistente");
  assert.ok(one(page({ body: '<a href="/y#sumiu">q</a>' })).includes("S10"), "[P5.3] âncora inexistente no destino");
  assert.deepEqual(one(page({ body: '<a href="/y#conteudo">ok</a><a href="/">raiz</a><a href="/assinar/conteudo-pronto">a</a>' })), [], "[P5.4] destinos válidos");
  assert.ok(one(page({ body: `<a href="${O}/nao-existe">q</a>` })).includes("S10"), "[P5.5] URL absoluta do domínio de vendas quebrada");
});

test("P6 canonical, og:url, descrição e unicidade", () => {
  assert.ok(one(page({ canon: `${O}/outra` })).includes("S11"), "[P6.1] canonical de outra página");
  assert.ok(one(page({ canon: null })).includes("S11"), "[P6.2] indexável sem canonical");
  assert.ok(one(page({ head: `<meta property="og:url" content="${O}/z">` })).includes("S11"), "[P6.3] og:url diferente da canonical");
  assert.ok(one(page({ desc: null })).includes("S12"), "[P6.4] sem description");
  assert.deepEqual(one(page({ canon: null, desc: null, head: '<meta name="robots" content="noindex">' })), [], "[P6.5] noindex sem canonical é aceito");
  const dupT = site({ a: page({ slug: "a", title: "Igual" }), b: page({ slug: "b", title: "Igual" }) });
  assert.ok(codes(siteChecks(dupT)).includes("S04"), "[P6.6] title repetido");
  const dupD = site({ a: page({ slug: "a", desc: "Igual" }), b: page({ slug: "b", desc: "Igual" }) });
  assert.ok(codes(siteChecks(dupD)).includes("S12"), "[P6.7] description repetida");
  assert.ok(one(page({ canon: `${O}/x/` })).includes("S11"), "[P6.8] canonical com barra final (/x/) != endereço servido /x");
});

test("P7 sitemap coerente com as páginas indexáveis", () => {
  const base = { a: page({ slug: "a" }), b: page({ slug: "b" }) };
  assert.deepEqual(siteChecks(site(base)), [], "[P7.0] sitemap coerente");
  assert.ok(codes(siteChecks(site(base, { sitemap: [`${O}/a`, `${O}/b`, `${O}/fantasma`] }))).includes("S18"), "[P7.1] loc sem página");
  const ni = { ...base, b: page({ slug: "b", head: '<meta name="robots" content="noindex">' }) };
  assert.ok(codes(siteChecks(site(ni, { sitemap: [`${O}/a`, `${O}/b`] }))).includes("S18"), "[P7.2] noindex no sitemap");
  assert.ok(codes(siteChecks(site(base, { sitemap: [`${O}/a`] }))).includes("S18"), "[P7.3] indexável fora do sitemap");
  const cb = { ...base, b: page({ slug: "b", canon: `${O}/b/` }) };
  assert.ok(codes(siteChecks(site(cb, { sitemap: [`${O}/a`, `${O}/b`] }))).includes("S18"), "[P7.4] canonical diferente do loc");
});

test("P8 coerência comercial: tabela C, aviso de vendas fechadas e nada fabricado", () => {
  const c = (body, slug = "x") => codes(commercial(slug, page({ body })));
  assert.ok(c("<p>IA na Prática (R$ 87)</p>").includes("S13"), "[P8.1] preço citado fora da tabela C");
  assert.ok(c(NOTICE + "<p>Preço de tabela: R$ 99</p>", "lucro-e-caixa").includes("S13"), "[P8.2] preço de tabela da página de produto");
  assert.ok(c(NOTICE + '<article class="catalog-card"><div class="cc-main"><h3><a href="/negocio-completo">N</a></h3></div><p class="catalog-price">R$ 297<span>x</span></p></article>').includes("S13"), "[P8.3] preço do catálogo");
  assert.deepEqual(c(NOTICE + "<p>Preço de tabela: R$ 157</p><p>Combo IA + Vendas · R$ 157 · comissão de 30% (R$ 47,10)</p>", "combo-ia-vendas"), [], "[P8.4] preço e derivados corretos");
  assert.ok(c('<a class="button" href="/x" data-zev-sku="ZEV-IA-011">Entrar na lista</a>').includes("S14"), "[P8.5] CTA sem aviso de vendas fechadas");
  assert.ok(c(NOTICE + '<a href="/comprar/ZEV-IA-011">Comprar</a>').includes("S14"), "[P8.6] link de compra no build fechado");
  assert.ok(codes(commercial("x", page({ head: '<script type="application/ld+json">{"@type":"Product","aggregateRating":{"ratingValue":5}}</script>' }))).includes("S15"), "[P8.7] AggregateRating");
  assert.ok(c("<p>★ 4,9/5 · 120 avaliações de clientes</p>").includes("S15"), "[P8.8] nota de avaliação no texto");
  assert.ok(c("<blockquote>Mudou minha vida — Maria</blockquote>").includes("S15"), "[P8.9] depoimento em blockquote");
  assert.deepEqual(c('<blockquote class="guide-model"><p>Oi, [nome]!</p></blockquote>'), [], "[P8.9] modelo de mensagem não é depoimento");
  assert.ok(c("<p><s>R$ 197</s> R$ 97</p>").includes("S16"), "[P8.10] preço riscado");
  assert.ok(c("<p>de R$ 197 por R$ 97</p>").includes("S16"), "[P8.11] preço de/por");
  assert.ok(c("<p>Últimas vagas: restam 3</p>").includes("S17"), "[P8.12] escassez fictícia");
  // O2: aviso que nunca mente (S20/S21), conforme a página seja ou não atualizada pelo interruptor do Worker.
  const a = (body, slug = "x") => codes(availability(slug, page({ slug, body }), site({})));
  assert.ok(a('<ul><li><a href="/ia-na-pratica">IA na Prática</a> (R$ 97).</li></ul>').includes("S20"), "[P8.13] preço citado fora do interruptor sem aviso de disponibilidade");
  assert.deepEqual(a('<ul><li><a href="/ia-na-pratica">IA na Prática</a> (R$ 97).</li></ul>' + NOTE), [], "[P8.13] com o aviso neutro");
  assert.deepEqual(a("<p>Exemplo: venda de R$ 97,50 e custo de R$ 1.970.</p>"), [], "[P8.13] valor que não é preço da tabela C");
  assert.ok(a(NOTICE + "<p>Lucro & Caixa (R$ 147)</p>").includes("S21"), "[P8.14] data-zev-closed fora das páginas do interruptor (ficaria falso com vendas abertas)");
  assert.deepEqual(a(NOTICE + "<p>Preço de tabela: R$ 97</p>", "ia-na-pratica"), [], "[P8.14] aviso de fechadas na página do interruptor");
  assert.ok(a(NOTICE + "<p>x</p>", "index").length === 0 && a(NOTICE + "<p>Preço de tabela: R$ 97</p>", "index").length === 0, "[P8.14] /index.html é servido como solucoes");
  assert.ok(a('<p>IA na Prática (R$ 97)</p><p class="price-note">Vendas fechadas.</p>').includes("S20"), "[P8.15] aviso de disponibilidade com texto fora do padrão");
  assert.ok(a("<p>Preço de tabela: R$ 97</p>", "ia-na-pratica").includes("S20"), "[P8.16] página do interruptor com preço e sem aviso de fechadas");
});

test("P9 tabela C igual em data/products.json, no gerador e no Worker", () => {
  const s = site({ a: page({ slug: "a" }) });
  assert.deepEqual(codes(siteChecks(s)), [], "[P9.0] fontes coerentes");
  assert.ok(codes(siteChecks({ ...s, products: s.products.map((p) => p.slug === "lucro-e-caixa" ? { ...p, price: 197 } : p) })).includes("S19"), "[P9.1] products.json divergente");
  assert.ok(codes(siteChecks({ ...s, genPrices: { ...s.genPrices, "negocio-completo": 297 } })).includes("S19"), "[P9.2] gerador divergente");
  assert.ok(codes(siteChecks({ ...s, workerPrices: { ...s.workerPrices, "IA na Prática": 67 } })).includes("S19"), "[P9.3] Worker divergente");
});

// P10 (O2, prova): o estado do aviso nunca diverge do estado de vendas. As 72 páginas passam pelo Worker real
// (worker/sales-public-worker.mjs) com o interruptor FECHADO e ABERTO (CORE simulado em /api/sales/status).
// Fechado: toda página com preço da tabela C diz "vendas temporariamente fechadas" (interruptor) ou traz o
// aviso neutro. Aberto: nenhuma resposta afirma vendas fechadas, o aviso neutro continua (verdadeiro) e as
// páginas de produto têm o link de compra.
const DIR = join(ROOT, "sales-public");
const ASSETS = { async fetch(req) {
  const file = normalize(join(DIR, decodeURIComponent(new URL(req.url).pathname)));
  if (!file.startsWith(DIR)) return new Response("x", { status: 404 });
  try { return new Response(readTextNormalized(file), { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }); } catch { return new Response("x", { status: 404 }); }
} };
const serve = async (path, open) => {
  const env = { ASSETS, CORE: { fetch: async () => new Response(JSON.stringify({ open }), { status: 200, headers: { "content-type": "application/json" } }) } };
  const r = await worker.fetch(new Request("https://vendas.zevanory.api.br" + path, { headers: { "user-agent": "Mozilla/5.0" } }), env, { waitUntil() {} });
  return { status: r.status, html: await r.text() };
};
test("P10 aviso de vendas coerente com o interruptor em todas as páginas servidas (fechado e aberto)", async () => {
  const st = auditStatic(ROOT);
  let priced = 0, notes = 0;
  for (const { slug } of st.inventory.pages) {
    const u = urlFor(slug);
    const closed = await serve(u.path, false), open = await serve(u.path, true);
    assert.equal(closed.status, u.status, `[P10.0] ${slug} status fechado`);
    assert.equal(open.status, u.status, `[P10.0] ${slug} status aberto`);
    const hasPrice = PRICE_CITE.test(visibleText(closed.html));
    if (hasPrice) {
      priced++;
      const ok = /data-zev-closed>[^<]*vendas temporariamente fechadas/.test(closed.html) || /<p class="price-note">[^<]*as vendas podem estar temporariamente fechadas/.test(closed.html);
      assert.ok(ok, `[P10.1] ${slug}: preço sem aviso com vendas fechadas`);
    }
    assert.doesNotMatch(open.html, /data-zev-closed|vendas temporariamente fechadas/, `[P10.2] ${slug}: afirma vendas fechadas com o interruptor aberto`);
    if (/class="price-note"/.test(closed.html)) { notes++; assert.match(open.html, /<p class="price-note">/, `[P10.3] ${slug}: aviso neutro some com vendas abertas`); }
    if (["ia-na-pratica", "vendas-na-pratica", "lucro-e-caixa", "combo-ia-vendas", "negocio-completo"].includes(slug)) assert.match(open.html, /href="\/comprar\/ZEV-/, `[P10.4] ${slug}: sem link de compra com vendas abertas`);
    assert.doesNotMatch(closed.html, /href="\/comprar\//, `[P10.4] ${slug}: link de compra com vendas fechadas`);
  }
  assert.deepEqual([priced, notes], [57, 50], "[P10.5] 57 páginas com preço (5 produtos + solucoes + index + 50 com aviso neutro)");
});
