// ZEVANORY | Blog renderer (zevanory.api.br/blog, central Worker) — site audit C-03.
// Contract: the index and the articles wear the site identity (shared stylesheet, header with navigation,
// footer with legal identity and the official e-mail, skip link, one h1, light/dark tokens with AA contrast);
// the empty-KV state is honest (says nothing is published, noindex, no canonical) and agrees with the
// sitemap (the apex sitemap lists /blog and articles only when KV has articles); every same-origin
// reference in the rendered HTML resolves to something the central Worker really serves.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readTextNormalized } from "./helpers/text.mjs";
import { BLOG_CSS, BLOG_CSS_PATH, BLOG_LOGO_PATH, blogCssResponse } from "../worker/blog-layout.mjs";
import { renderBlogIndex, renderBlogArticle, appendBlogSitemap, BLOG_INDEX_KEY } from "../worker/multichannel-autonomy.mjs";
import { BRAND_SIZES } from "../worker/brand-kit.mjs";
import { SUPPORT_EMAIL, LEGAL_IDENTITY } from "../worker/politica-unica.mjs";

const kv = (entries = {}) => { const m = new Map(Object.entries(entries)); return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; };
const ARTICLES = [
  { slug: "rotina-de-caixa-2026-10-20", title: "Rotina de caixa em 10 minutos", description: "Um passo a passo simples.", publishedAt: "2026-10-20T12:00:00Z", url: "https://zevanory.api.br/blog/rotina-de-caixa-2026-10-20", day: "2026-10-20", product: "ZEV-LCX-011",
    body: "Separe entradas e saídas todo dia.\n\n## Como começar\n\nAnote o saldo inicial.", faq: [{ q: "Preciso de sistema?", a: "Não. Uma planilha resolve." }] },
  { slug: "atendimento-2026-10-21", title: "Responder clientes sem improviso", description: "Modelos revisados.", publishedAt: "2026-10-21T12:00:00Z", url: "https://zevanory.api.br/blog/atendimento-2026-10-21", day: "2026-10-21", product: "ZEV-IA-011", body: "Texto.", faq: [] },
];
const populated = () => {
  const e = { [BLOG_INDEX_KEY]: JSON.stringify({ articles: ARTICLES }) };
  for (const a of ARTICLES) e["zpc:blog:article:" + a.slug] = JSON.stringify(a);
  return { ZEVANORY_PRIVATE_ARTIFACTS: kv(e), PUBLIC_BASE_URL: "https://zevanory.api.br" };
};
const count = (html, re) => (html.match(re) || []).length;

function assertShell(html, label) {
  assert.match(html, /^<!doctype html><html lang="pt-BR">/, label);
  assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/, label);
  assert.equal(count(html, /<link rel="stylesheet" href="([^"]+)">/g), 1, label + ": exactly one stylesheet");
  assert.ok(html.includes(`<link rel="stylesheet" href="${BLOG_CSS_PATH}">`), label + ": shared blog stylesheet");
  assert.match(html, /<a class="skip-link" href="#conteudo">Ir para o conteúdo<\/a>/, label);
  assert.match(html, /<header class="site-header">.*<nav class="site-nav" aria-label="Navegação principal">.*<\/nav><\/div><\/header>/s, label);
  assert.match(html, /<main id="conteudo"/, label);
  assert.equal(count(html, /<h1[ >]/g), 1, label + ": one h1");
  assert.match(html, /<footer class="site-footer">/, label);
  assert.ok(html.includes(LEGAL_IDENTITY.replace(/&/g, "&amp;")), label + ": legal identity in the footer");
  assert.ok(html.includes(`mailto:${SUPPORT_EMAIL}`), label + ": official e-mail");
  assert.doesNotMatch(html, /contato@zevanory/, label + ": no legacy mailbox");
  assert.match(html, new RegExp(`<img src="${BLOG_LOGO_PATH}" alt="ZEVANORY"`), label + ": brand logo with alt");
  for (const img of html.match(/<img\b[^>]*>/g) || []) assert.match(img, /\balt="[^"]+"/, label + ": alt on " + img);
  assert.doesNotMatch(html, /FAIL_CLOSED|UNCONFIGURED|kill-switch|tenant|gates? oficia|ZEES-16|Novos artigos em preparação/i, label + ": no internal jargon / stale placeholder");
}

// Same-origin references must be served by the central Worker: the blog routes, the Worker-served stylesheet,
// the SHA-pinned brand exports (worker/cloudflare-worker.compat.mjs, BRAND_SIZES) and the logo the deploy
// overlays into public/brand (scripts/deploy/copy-brand-export.py copies it from sales-public/brand).
function assertRefsResolve(html, label, slugs = []) {
  const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
  for (const r of refs) {
    if (r.startsWith("#")) { assert.ok(html.includes(` id="${r.slice(1)}"`), label + ": anchor target " + r); continue; }
    if (/^(https?:|mailto:)/.test(r)) continue;
    assert.ok(r.startsWith("/"), label + ": relative ref must be root-relative " + r);
    if (r === "/blog" || slugs.includes(r)) continue;
    if (r === BLOG_CSS_PATH) continue;
    if (r.startsWith("/brand/export/")) { assert.ok(Object.hasOwn(BRAND_SIZES, r.slice("/brand/export/".length)), label + ": brand export " + r); continue; }
    if (r === BLOG_LOGO_PATH) { assert.ok(existsSync(new URL("../sales-public" + r, import.meta.url)), label + ": logo source " + r); continue; }
    assert.fail(label + ": unresolvable same-origin ref " + r);
  }
}

test("stylesheet path is pinned to the content (immutable cache) and served by the Worker", async () => {
  const h = createHash("sha256").update(BLOG_CSS).digest("hex").slice(0, 10);
  assert.equal(BLOG_CSS_PATH, `/blog-assets/blog.${h}.css`, "edit BLOG_CSS => update the hash in BLOG_CSS_PATH");
  const res = blogCssResponse(new Request("https://zevanory.api.br" + BLOG_CSS_PATH));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/css/);
  assert.match(res.headers.get("cache-control"), /immutable/);
  assert.equal(await res.text(), BLOG_CSS);
  assert.equal(await blogCssResponse(new Request("https://zevanory.api.br" + BLOG_CSS_PATH, { method: "HEAD" })).text(), "");
  assert.doesNotMatch(BLOG_CSS, /@import|url\(|@font-face/, "self-contained: apex CSP font-src/style-src 'self'");
  const src = readTextNormalized(new URL("../worker/cloudflare-worker.recovered.mjs", import.meta.url));
  const route = src.indexOf("url.pathname === BLOG_CSS_PATH");
  assert.ok(route > 0 && route < src.indexOf('url.pathname === "/blog" || url.pathname === "/blog/"'), "routed by the central Worker next to /blog");
  assert.ok(route < src.indexOf("const response2 = await env.ASSETS.fetch(assetRequest);"), "before the static assets fallthrough");
});

test("dark and light tokens keep AA contrast for every text pair the blog uses", () => {
  const block = (css) => Object.fromEntries([...css.matchAll(/--([a-z-]+):(#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]]));
  const light = block(BLOG_CSS.slice(0, BLOG_CSS.indexOf("@media (prefers-color-scheme:dark)")));
  const dark = { ...light, ...block(BLOG_CSS.slice(BLOG_CSS.indexOf("@media (prefers-color-scheme:dark)"), BLOG_CSS.indexOf("*,*::before"))) };
  const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const pairs = [["tinta", "papel"], ["tinta", "cupom"], ["grafite", "papel"], ["grafite", "cupom"], ["azul-cedula", "papel"], ["azul-cedula", "cupom"], ["balcao-texto", "balcao"], ["sobre-amarelo", "amarelo-caixa"]];
  for (const [name, t] of [["light", light], ["dark", dark]]) for (const [fg, bg] of pairs) {
    assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name}: ${fg} on ${bg} = ${ratio(t[fg], t[bg]).toFixed(2)}`);
  }
});

test("empty KV: honest empty state, noindex, no canonical, and the sitemap gets no blog entry", async () => {
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv(), PUBLIC_BASE_URL: "https://zevanory.api.br" };
  const html = await renderBlogIndex(env);
  assertShell(html, "index (empty)");
  assertRefsResolve(html, "index (empty)");
  assert.match(html, /Ainda não há artigos publicados\./);
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.doesNotMatch(html, /rel="canonical"/);
  assert.equal(count(html, /<article>/g), 0);
  assert.match(html, /<a href="\/blog" aria-current="page">Blog<\/a>/);
  const base = '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>';
  const xml = await appendBlogSitemap(env, base);
  assert.equal(xml, base, "nothing published => nothing about the blog in the sitemap");
  // Unreadable KV behaves like empty (never a 500, never a phantom article).
  const broken = await renderBlogIndex({ ZEVANORY_PRIVATE_ARTIFACTS: { get: async () => "{not json" } });
  assert.match(broken, /Ainda não há artigos publicados\./);
});

test("published articles: indexable index with canonical, the same set in the sitemap, newest first", async () => {
  const env = populated();
  const html = await renderBlogIndex(env);
  assertShell(html, "index");
  assertRefsResolve(html, "index", ARTICLES.map((a) => "/blog/" + a.slug));
  assert.doesNotMatch(html, /name="robots"/);
  assert.match(html, /<link rel="canonical" href="https:\/\/zevanory\.api\.br\/blog">/);
  assert.equal(count(html, /<article>/g), ARTICLES.length);
  assert.ok(html.indexOf("/blog/atendimento-2026-10-21") < html.indexOf("/blog/rotina-de-caixa-2026-10-20"));
  const xml = await appendBlogSitemap(env, "<urlset></urlset>");
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.deepEqual(locs, ["https://zevanory.api.br/blog", ...ARTICLES.map((a) => a.url)]);
  const listed = [...html.matchAll(/<h2><a href="\/blog\/([^"]+)">/g)].map((m) => "https://zevanory.api.br/blog/" + m[1]).sort();
  assert.deepEqual(listed, locs.slice(1).sort(), "index and sitemap list the same articles");
});

test("article page: shared shell, breadcrumb, closed-sales notice, CTA to the product page (never /comprar/ when closed)", async () => {
  const env = populated();
  const html = await renderBlogArticle(env, ARTICLES[0].slug, { salesOpen: false });
  assertShell(html, "article");
  assertRefsResolve(html, "article");
  assert.match(html, /<p class="breadcrumb"><a href="\/blog">Blog<\/a><\/p>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/zevanory\.api\.br\/blog\/rotina-de-caixa-2026-10-20">/);
  assert.match(html, /<h2>Como começar<\/h2>/);
  assert.match(html, /<h2>Perguntas frequentes<\/h2><h3>Preciso de sistema\?<\/h3>/);
  assert.match(html, /<p class="sales-closed">Preço informativo: vendas temporariamente fechadas\.<\/p>/);
  assert.doesNotMatch(html, /\/comprar\//);
  assert.match(html, /https:\/\/vendas\.zevanory\.api\.br\/lucro-e-caixa\?utm_source=blog/);
  assert.match(html, /"@type":"Article"/);
  assert.equal(await renderBlogArticle(env, "nao-existe"), null, "unknown slug stays a 404 upstream");
});
