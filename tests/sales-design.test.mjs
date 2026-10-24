// Design PR (sales site identity, 2026-10-24): contracts the design relies on.
//   (a) designed 404: unknown PAGE paths get /404.html with status 404, noindex and no-store; asset 404s
//       stay plain; the page is closed-mode safe (no checkout link) and carries the legal footer;
//   (b) a compact, factual trust block (company + CNPJ, payment processor, support + documented response
//       time, policy links) sits next to the price on every priced page; Hotmart variant names Hotmart;
//   (c) footer is structured (labelled blocks), not a "·" chain;
//   (d) digits use the unslashed Archivo figures (unicode-range face) in both stylesheets.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
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
