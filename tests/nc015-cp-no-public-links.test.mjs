// ZEVANORY | DEC-04 (phase 1): Conteúdo Pronto is hidden; /conteudo-pronto answers 404 noindex. No public
// page, sitemap, nav, CTA, cross-sell block, structured data or blog CTA may link to it, so the crawl gate
// never meets a broken internal ref. Only the tombstones themselves may carry the path. Termos and Reembolso
// keep a plain-text legal note (exclusion from current offers; rules for subscriptions contracted earlier),
// never a link.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDailyBlog, renderBlogArticle } from "../worker/multichannel-autonomy.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(root, rel), "utf8");
const TOMBSTONES = new Set(["conteudo-pronto/index.html", "sales-public/conteudo-pronto.html",
  "pages-mirror/conteudo-pronto.html", "pages-mirror/sales-public__conteudo-pronto.html"]);
// Plain-text legal mentions allowed (no link): see header.
const LEGAL_TEXT_OK = new Set(["termos/index.html", "reembolso/index.html", "sales-public/termos.html", "sales-public/reembolso.html"]);

// Any href/src/url/<loc>/JSON "url" that targets the CP page or its subscription/briefing routes.
const CP_REF = /(?:href|src|content)\s*=\s*["'][^"']*\/(?:assinar\/|hotmart\/)?conteudo-pronto(?:[/?#."']|$)|<loc>[^<]*\/conteudo-pronto[^<]*<\/loc>|"(?:url|@id|item)"\s*:\s*"[^"]*\/conteudo-pronto/i;
const CP_NAME = /Conte[uú]do Pronto/i;
export function cpProblems(rel, body) {
  const out = [];
  if (CP_REF.test(body)) out.push(rel + ": links to /conteudo-pronto");
  if (!LEGAL_TEXT_OK.has(rel) && CP_NAME.test(body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (s) => /ld\+json/i.test(s) ? s : ""))) out.push(rel + ": names Conteúdo Pronto");
  return out;
}

function publicFiles() {
  const files = ["index.html", "sitemap.xml", "robots.txt", "sales-overlay/llms.txt", "sales-overlay/robots.txt", "sales-overlay/approved.json"];
  for (const d of readdirSync(root)) {
    const p = join(d, "index.html");
    if (!d.startsWith(".") && existsSync(join(root, p)) && statSync(join(root, p)).isFile()) files.push(p);
  }
  for (const dir of ["sales-public", "pages-mirror"]) {
    for (const f of readdirSync(join(root, dir))) if (/\.(html|xml|txt)$/.test(f)) files.push(dir + "/" + f);
  }
  return files.filter((f) => existsSync(join(root, f)) && !TOMBSTONES.has(f));
}

test("DEC-04 no public source, generated sales page, Pages stub or sitemap links to or promotes Conteúdo Pronto", () => {
  const files = publicFiles();
  assert.ok(files.length > 200, "scanned " + files.length);
  for (const must of ["sitemap.xml", "sales-public/sitemap.xml", "kit-afiliado/index.html", "sales-public/kit-afiliado.html",
    "sales-public/ia-para-barbearia.html", "afiliados/index.html"]) assert.ok(files.includes(must), must);
  const problems = files.flatMap((f) => cpProblems(f, read(f)));
  assert.deepEqual(problems, []);
  for (const f of LEGAL_TEXT_OK) assert.doesNotMatch(read(f), /href="[^"]*conteudo-pronto/, f);
});

test("DEC-04 the 40 sector guides cross-sell a phase-1 product instead of the hidden subscription", () => {
  const guides = readdirSync(join(root, "sales-public")).filter((f) => /^ia-para-.+\.html$/.test(f));
  assert.equal(guides.length, 40);
  for (const f of guides) {
    const html = read("sales-public/" + f);
    const block = html.match(/<h2>Quer ir além\?<\/h2><\/div><ul class="outcome-list">([\s\S]*?)<\/ul>/);
    assert.ok(block, f + ": cross-sell block");
    const hrefs = [...block[1].matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(hrefs, ["/ia-na-pratica", "/vendas-na-pratica"], f);
    assert.match(block[1], /\(R\$ 97\)\.<\/li><li><a href="\/vendas-na-pratica">Vendas na Prática<\/a>:[^<]*\(R\$ 97\)\.<\/li>/, f);
  }
});

test("DEC-04 blog article CTAs never point at /conteudo-pronto", async () => {
  const m = new Map(), store = { get: async (k) => m.get(k) || null, put: async (k, v) => m.set(k, v) };
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: store, PUBLIC_BASE_URL: "https://zevanory.api.br" };
  const out = await ensureDailyBlog(env, new Date("2026-10-14T12:00:00Z"));
  for (const open of [false, true]) {
    const html = await renderBlogArticle(env, out.latest.slug, { salesOpen: open });
    assert.match(html, /vendas\.zevanory\.api\.br\/vendas-na-pratica\?/);
    assert.deepEqual(cpProblems("blog", html), []);
  }
});

test("DEC-04 detector kills planted CP link, sitemap entry, JSON-LD url and cross-sell mutants", () => {
  const base = read("sales-public/kit-afiliado.html");
  assert.deepEqual(cpProblems("sales-public/kit-afiliado.html", base), []);
  for (const [name, body] of [
    ["relative link", base.replace("</main>", '<a href="/conteudo-pronto">x</a></main>')],
    ["mirror link", base.replace("</main>", '<a href="/zevanory-public-mirror/conteudo-pronto">x</a></main>')],
    ["absolute link", base.replace("</main>", '<a href="https://vendas.zevanory.api.br/conteudo-pronto?utm_source=x">x</a></main>')],
    ["subscribe link", base.replace("</main>", '<a href="/assinar/conteudo-pronto">x</a></main>')],
    ["json-ld url", base.replace("</head>", '<script type="application/ld+json">{"url":"https://vendas.zevanory.api.br/conteudo-pronto"}</script></head>')],
    ["name only", base.replace("</main>", "<p>Conteúdo Pronto</p></main>")],
  ]) assert.notDeepEqual(cpProblems("sales-public/kit-afiliado.html", body), [], name);
  const sm = read("sales-public/sitemap.xml");
  assert.notDeepEqual(cpProblems("sales-public/sitemap.xml", sm.replace("</urlset>",
    "<url><loc>https://vendas.zevanory.api.br/conteudo-pronto</loc></url></urlset>")), [], "sitemap entry");
  assert.notDeepEqual(cpProblems("termos/index.html", read("termos/index.html").replace("</main>", '<a href="/conteudo-pronto">x</a></main>')), [], "legal link");
  // A blog slug that merely contains "conteudo" is not a CP link.
  assert.deepEqual(cpProblems("x", "<loc>https://zevanory.api.br/blog/conteudo-organico-com-evidencia</loc>"), []);
});
