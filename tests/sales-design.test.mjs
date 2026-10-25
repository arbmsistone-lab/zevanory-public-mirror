// Design PR (sales site identity, 2026-10-24): contracts the design relies on.
//   (a) designed 404: unknown PAGE paths get /404.html with status 404, noindex and no-store; asset 404s
//       stay plain; the page is closed-mode safe (no checkout link) and carries the legal footer;
//   (b) a compact, factual trust block (company + CNPJ, payment processor, support + documented response
//       time, policy links) sits next to the price on every priced page; Hotmart variant names Hotmart;
//   (c) footer is structured (labelled blocks), not a "·" chain;
//   (d) digits use the unslashed Archivo figures (unicode-range face) in both stylesheets.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readTextNormalized } from "./helpers/text.mjs";
import worker, { hotmartPage } from "../worker/sales-public-worker.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUB = join(ROOT, "sales-public");
const read = (f) => readTextNormalized(join(PUB, f));
const env = { ASSETS: { fetch: async (req) => {
  const p = decodeURIComponent(new URL(req.url).pathname).slice(1), f = join(PUB, p);
  if (!p || !existsSync(f) || statSync(f).isDirectory()) return new Response("Not found", { status: 404 });
  return new Response(readFileSync(f), { status: 200, headers: { "content-type": p.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream" } });
} } };
const get = (path, method = "GET") => worker.fetch(new Request("https://vendas.zevanory.api.br" + path, { method, headers: { "user-agent": "Mozilla/5.0" } }), env, { waitUntil() {} });

test("(a) unknown page -> designed 404 (noindex, no-store); asset 404 stays plain", async () => {
  const res = await get("/pagina-que-nao-existe");
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.match(res.headers.get("x-robots-tag"), /noindex/);
  const body = await res.text();
  assert.match(body, /<h1>Esta página não existe\.<\/h1>/);
  assert.match(body, /<meta name="robots" content="noindex">/);
  assert.match(body, /href="mailto:suporte@zevanory\.api\.br"/);
  assert.doesNotMatch(body, /\/comprar\/|\/assinar\/|schema\.org\/InStock/);
  const asset = await get("/assets/nao-existe.0123456789.css");
  assert.equal(asset.status, 404);
  assert.equal(await asset.text(), "Not found");
});

const PRICED = ["ia-na-pratica", "vendas-na-pratica", "lucro-e-caixa", "combo-ia-vendas", "negocio-completo", "conteudo-pronto"];
test("(b) trust block next to the price on every priced page (and Hotmart wording in the Hotmart variant)", () => {
  for (const slug of PRICED) {
    const html = read(slug + ".html");
    const receipt = html.slice(html.indexOf('<div class="hero-panel receipt">'), html.indexOf("</ul></div>", html.indexOf('<ul class="trust-mini"')));
    assert.ok(receipt.includes('class="receipt-total"'), slug + ": price in the receipt");
    for (const need of ["Empresa brasileira", "A. RENAN ALVES MOREIRA BITU LTDA", "CNPJ 69.077.233/0001-99</span>", "Várzea Alegre (CE)", "resposta conclusiva em até 5 dias", 'href="/termos"', 'href="/privacidade"', 'href="/reembolso"'])
      assert.ok(receipt.includes(need), `${slug}: ${need}`);
    assert.ok(receipt.includes(slug === "conteudo-pronto" ? "processado pela Hotmart" : "processado pelo Mercado Pago"), slug + ": payment processor named as text");
  }
  for (const slug of PRICED.slice(0, 5)) {
    const out = hotmartPage(read(slug + ".html"), slug, "https://pay.hotmart.com/X1");
    assert.match(out, /<strong>Pagamento<\/strong><span>processado pela Hotmart/);
    assert.match(out, /Pagamento processado pela Hotmart \(Pix, cartão ou boleto\)/);
  }
});

test("(c) footer: labelled company / atendimento / regras / perfis blocks, no middle-dot chain", () => {
  for (const f of ["solucoes.html", "ia-na-pratica.html", "termos.html", "quem-criou.html"]) {
    const html = read(f);
    const footer = html.slice(html.indexOf('<div class="container footer-legal">'));
    for (const id of ["fl-empresa", "fl-contato", "fl-regras", "fl-perfis"]) assert.ok(footer.includes(`id="${id}"`), `${f}: ${id}`);
    assert.doesNotMatch(footer.slice(0, footer.indexOf("</div>")), / · /, f + ": no · chain in the footer");
  }
});

test("(d) unslashed figures: Archivo digits face (unicode-range U+0030-0039) in product.css and legal.css", () => {
  for (const f of ["product.css", "legal.css"]) {
    const css = readTextNormalized(join(ROOT, f));
    assert.match(css, /src:url\("assets\/fonts\/archivo-numerais\.woff2"\)[^}]*unicode-range:U\+0030-0039/, f);
  }
  assert.ok(existsSync(join(ROOT, "assets/fonts/archivo-numerais.woff2")));
});

// (e) Real previews (owner, in writing: "AUTORIZO PRÉVIAS REAIS DOS PRODUTOS NO SITE"; Sol 228): per product at
//     most three images; docs/evidence/sales-ux/previews-manifest.json has one entry per image with product,
//     zip + full SHA-256, path in zip, page/crop, redactions and the SHA-256 of the WebP and AVIF outputs.
//     This test recomputes every output hash from the committed files and checks the published markup.
test("(e) previews: manifest hashes recomputed, zip = production artifact, ≤ 3 per product, truthful labels, lazy, sized", async () => {
  const { createHash } = await import("node:crypto");
  const M = JSON.parse(readTextNormalized(join(ROOT, "docs/evidence/sales-ux/previews-manifest.json")));
  const sha = (p) => createHash("sha256").update(readFileSync(join(ROOT, p))).digest("hex");
  const recovered = readTextNormalized(join(ROOT, "worker/cloudflare-worker.recovered.mjs"));
  for (const [zip, h] of Object.entries(M.source_zips)) {
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.ok(recovered.includes(`artifact_name: "${zip}", artifact_sha256: "${h}"`), "zip SHA-256 = production catalog: " + zip);
  }
  for (const img of M.images) {
    for (const fmt of ["webp", "avif"]) assert.equal(sha(img[fmt].file), img[fmt].sha256, `${img.id}.${fmt}: committed file matches manifest`);
    assert.ok(img.products.length >= 1 && img.sources.length === img.products.length, img.id + ": one source per product");
    for (const src of img.sources) {
      assert.equal(M.source_zips[src.zip], src.zip_sha256, img.id + ": zip hash");
      assert.ok(src.path_in_zip && /^[0-9a-f]{64}$/.test(src.file_sha256), img.id + ": internal file + hash");
    }
    assert.ok(img.location.page || img.location.sheet, img.id + ": page or sheet");
    const redacted = img.redactions.length > 0;
    assert.equal(img.label, redacted ? "página real do material (trechos ocultos)" : img.label, img.id);
    assert.ok(redacted ? true : !/ocultos/.test(img.label), img.id + ": label must not claim redaction");
    assert.ok(img.why_safe.length > 40, img.id + ": justification");
  }
  const byId = Object.fromEntries(M.images.map((i) => [i.id, i]));
  for (const [slug, ids] of Object.entries(M.per_product)) {
    assert.ok(ids.length <= 3, slug + ": at most three images");
    const html = read(slug + ".html");
    if (!ids.length) { assert.ok(!html.includes('id="por-dentro"'), slug + ": no preview without a real file"); continue; }
    const start = html.indexOf('aria-labelledby="por-dentro"');
    const sec = html.slice(start, html.indexOf("</section>", start));
    assert.match(sec, /Páginas reais do material/);
    const figs = [...sec.matchAll(/<figure class="inside-item">([\s\S]*?)<\/figure>/g)].map((m) => m[1]);
    assert.equal(figs.length, ids.length, slug + ": one figure per authorised image");
    figs.forEach((fig, k) => {
      const i = byId[ids[k]];
      assert.match(fig, new RegExp(`<source type="image/avif" srcset="/assets/previews/${i.id}\\.[0-9a-f]{10}\\.avif">`));
      assert.match(fig, new RegExp(`<img src="/assets/previews/${i.id}\\.[0-9a-f]{10}\\.webp" width="${i.width}" height="${i.height}" loading="lazy" decoding="async" alt="[^"]{30,}">`));
      assert.ok(fig.includes(`<span class="inside-label">${i.label}</span>`), `${slug}/${i.id}: label shown`);
    });
    assert.doesNotMatch(sec, /href="[^"]*\.(pdf|docx|xlsx|zip|webp|avif)"/i, slug + ": nothing downloadable");
  }
  // Catalogue: the real cover (128 px on desktop), optionally with the approved inner page stacked behind it.
  const sol = read("solucoes.html");
  for (const slug of ["lucro-e-caixa", "vendas-na-pratica", "ia-na-pratica", "combo-ia-vendas", "negocio-completo"]) {
    const start = sol.indexOf(`id="p-${slug}"`);
    const card = sol.slice(start, sol.indexOf("</article>", start));
    const thumb = card.match(/<span class="cc-thumb( cc-stack)?">([\s\S]*?)<\/span><\/span>(?=<\/article>|$)/) || card.match(/<span class="cc-thumb( cc-stack)?">([\s\S]*)/);
    assert.ok(thumb, "catalogue thumbnail: " + slug);
    const used = [...card.matchAll(/src="\/assets\/previews\/([a-z0-9-]+)\.[0-9a-f]{10}\.webp"/g)].map((m) => m[1]);
    const allowed = M.per_product[slug];
    assert.ok(used.length >= 1 && used.length <= 2 && used.every((id) => allowed.includes(id)), `${slug}: thumbnail uses only its approved images (${used})`);
    assert.equal(used[used.length - 1], allowed[0], slug + ": the cover is in front");
    assert.match(card, /alt="[^"]+\(página real do material\)"/, slug + ": front cover alt + label");
    for (const tag of card.match(/<img [^>]*>/g)) { assert.match(tag, /width="\d+" height="\d+"/); assert.match(tag, /loading="lazy"/); }
    assert.doesNotMatch(card, /href="[^"]*\.(webp|avif|pdf)"/, slug + ": not downloadable");
  }
});

// (f) Both themes (prefers-color-scheme, no toggle): every published page declares "light dark" and loads a
//     stylesheet with dark rules; every text/background token pair meets WCAG AA (4.5:1 text, 3:1 UI/large)
//     in BOTH themes, for product.css and legal.css.
function tokens(css) {
  const grab = (block) => Object.fromEntries([...block.matchAll(/--([a-z-]+):(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2].toLowerCase()]));
  const rootEnd = css.indexOf("}", css.indexOf(":root{"));
  const light = grab(css.slice(css.indexOf(":root{"), rootEnd));
  const d = css.indexOf("@media (prefers-color-scheme:dark)");
  assert.ok(d > 0, "dark rules present");
  const dark = { ...light, ...grab(css.slice(d, css.indexOf("}", css.indexOf(":root{", d)))) };
  return { light, dark };
}
const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
test("(f) both themes: dark rules on every page, AA contrast for every token pair in light and dark", () => {
  const TEXT = [["tinta", "papel"], ["tinta", "cupom"], ["grafite", "papel"], ["grafite", "cupom"], ["azul-cedula", "papel"], ["azul-cedula", "cupom"],
    ["cupom", "azul-cedula"], ["sobre-amarelo", "amarelo-caixa"], ["balcao-texto", "balcao"], ["balcao-suave", "balcao"], ["azul-cedula", "azul-claro"],
    ["grafite", "cupom-elevado"], ["azul-cedula", "cupom-elevado"], ["cupom", "tinta"]];
  const UI = [["linha", "cupom"], ["linha", "papel"], ["amarelo-caixa", "balcao"], ["azul-cedula", "papel"], ["regua", "papel"], ["regua", "cupom"]];
  const bad = [];
  for (const f of ["product.css", "legal.css"]) {
    const css = readTextNormalized(join(ROOT, f));
    assert.match(css, /color-scheme:light dark/, f);
    for (const [theme, t] of Object.entries(tokens(css))) {
      for (const [list, min] of [[TEXT, 4.5], [UI, 3]]) for (const [fg, bg] of list) {
        if (!t[fg] || !t[bg]) { if (f === "product.css") bad.push(`${f} ${theme}: token ${t[fg] ? bg : fg} missing`); continue; }
        const r = ratio(t[fg], t[bg]);
        if (r < min) bad.push(`${f} ${theme}: ${fg} on ${bg} = ${r.toFixed(2)} < ${min}`);
      }
    }
  }
  assert.deepEqual(bad, []);
  const pages = readdirSync(PUB).filter((n) => n.endsWith(".html"));
  for (const n of pages) {
    const html = read(n);
    assert.match(html, /<meta name="color-scheme" content="light dark">/, n + ": declares both themes");
    const css = html.match(/<link rel="stylesheet" href="\/(assets\/(?:product|legal)\.[0-9a-f]{10}\.css)">/);
    assert.ok(css, n + ": loads the hashed design stylesheet");
    assert.match(readTextNormalized(join(PUB, css[1])), /@media \(prefers-color-scheme:dark\)/, n + ": stylesheet has dark rules");
  }
  // Print stays light in both stylesheets.
  for (const f of ["product.css", "legal.css"]) assert.match(readTextNormalized(join(ROOT, f)), /@media print\{[^]*?color-scheme:light;/, f + ": print forces light");
});
