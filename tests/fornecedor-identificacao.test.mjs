// Decreto 7.962/2013, art. 2º, I e II: the site must show, in a visible place, the razão social and
// CNPJ, the physical and electronic address and the other data needed to locate and contact the
// supplier. Contract of this test: EVERY page of the sales site (sales-public/*.html, built by
// scripts/build_sales_public.py) and the three legal pages (/termos, /privacidade, /reembolso) carry
// exactly one "Identificação do fornecedor" block in the legal footer, with the five fields below
// equal to the single source (data/politica-unica.json, resumo_oferta.fornecedor) AND to the company's
// registration facts pinned here (a silent edit of the source also fails). The block also survives the
// Worker: the served /termos and the open-sales and Hotmart variants of the priced pages keep it.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readTextNormalized } from "./helpers/text.mjs";
import { SUPPLIER, ADDRESS_FULL } from "../worker/politica-unica.mjs";
import worker, { hotmartPage, openSalesHtml } from "../worker/sales-public-worker.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUB = join(ROOT, "sales-public");
const read = (f) => readTextNormalized(join(PUB, f));
const PAGES = readdirSync(PUB).filter((f) => f.endsWith(".html")).sort();
const LEGAL = ["termos.html", "privacidade.html", "reembolso.html"];
const PRICED = ["ia-na-pratica", "vendas-na-pratica", "lucro-e-caixa", "combo-ia-vendas", "negocio-completo"];
const REQUIRED = [...LEGAL, "index.html", "solucoes.html", "conteudo-pronto.html", "404.html", ...PRICED.map((s) => s + ".html")];

// Registration facts (contrato social / cartão CNPJ), pinned on purpose.
const FACTS = Object.freeze({
  razao_social: "A. RENAN ALVES MOREIRA BITU LTDA",
  nome_fantasia: "ZEVANORY",
  cnpj: "69.077.233/0001-99",
  endereco: "Rua Francisco de Freitas Neto, nº 96, Alto do Tenente, Várzea Alegre – CE, CEP 63540-000",
  email: "suporte@zevanory.api.br",
});
const LABELS = { razao_social: "Razão social", nome_fantasia: "Nome fantasia", cnpj: "CNPJ", endereco: "Endereço", email: "E-mail" };

function block(html, where) {
  const all = [...html.matchAll(/<section class="fl-block" aria-labelledby="fl-fornecedor" data-fornecedor="identificacao">([\s\S]*?)<\/section>/g)];
  assert.equal(all.length, 1, `${where}: exactly one "Identificação do fornecedor" block`);
  return { body: all[0][1], at: all[0].index };
}
function assertBlock(html, where) {
  const { body, at } = block(html, where);
  assert.match(body, /^<h2 class="fl-title" id="fl-fornecedor">Identificação do fornecedor<\/h2><ul>/, `${where}: heading`);
  const footer = html.lastIndexOf('<div class="container footer-legal">', at);
  assert.ok(footer >= 0 && !html.slice(footer, at).includes("</div>"), `${where}: block sits inside the legal footer`);
  assert.doesNotMatch(html.slice(footer, at + body.length), /\shidden\b|aria-hidden=|<template|<noscript/i, `${where}: block is not hidden`);
  const fields = [...body.matchAll(/<li data-fornecedor="([a-z_]+)"><strong>([^<]+)<\/strong> ([^<]*)(?:<a href="mailto:([^"]+)">([^<]+)<\/a>)?<\/li>/g)];
  assert.deepEqual(fields.map((m) => m[1]), Object.keys(FACTS), `${where}: the five fields, in order`);
  for (const [, key, label, text, mailto, mailText] of fields) {
    assert.equal(label, LABELS[key], `${where}: ${key} label`);
    if (key === "email") {
      assert.equal(text, "", `${where}: e-mail is only the link`);
      assert.equal(mailto, FACTS.email, `${where}: mailto`);
      assert.equal(mailText, FACTS.email, `${where}: e-mail text`);
    } else {
      assert.equal(mailto, undefined, `${where}: ${key} has no link`);
      assert.equal(text, FACTS[key], `${where}: ${key}`);
    }
  }
}

test("single source (politica-unica.json) == registration facts", () => {
  assert.equal(SUPPLIER.razao_social, FACTS.razao_social);
  assert.equal(SUPPLIER.nome_fantasia, FACTS.nome_fantasia);
  assert.equal(SUPPLIER.cnpj, FACTS.cnpj);
  assert.equal(ADDRESS_FULL, FACTS.endereco);
  assert.equal(SUPPLIER.email, FACTS.email);
});

test("every sales page and the three legal pages carry the supplier identification block", () => {
  for (const f of REQUIRED) assert.ok(PAGES.includes(f), `required page built: ${f}`);
  assert.ok(PAGES.length >= 70, `whole site scanned (${PAGES.length} pages)`);
  for (const f of PAGES) assertBlock(read(f), f);
});

test("stylesheets never hide the legal footer or its blocks", () => {
  for (const css of ["product.css", "legal.css"]) {
    const text = readTextNormalized(join(ROOT, css));
    for (const m of text.matchAll(/([^{}]*)\{([^}]*)\}/g)) {
      if (!/\.footer-legal|\.fl-block|#fl-fornecedor|data-fornecedor/.test(m[1])) continue;
      assert.doesNotMatch(m[2], /display\s*:\s*none|visibility\s*:\s*hidden|content-visibility\s*:\s*hidden|clip-path|font-size\s*:\s*0\b|opacity\s*:\s*0(?![.\d])/, `${css}: ${m[1].trim()}`);
    }
  }
});

test("served by the Worker: /termos, /privacidade, /reembolso and the catalogue keep the block", async () => {
  const env = { ASSETS: { fetch: async (req) => {
    const p = decodeURIComponent(new URL(req.url).pathname).slice(1), f = join(PUB, p);
    if (!p || !existsSync(f) || statSync(f).isDirectory()) return new Response("Not found", { status: 404 });
    return new Response(readFileSync(f), { status: 200, headers: { "content-type": p.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream" } });
  } } };
  for (const path of ["/termos", "/privacidade", "/reembolso", "/solucoes", "/"]) {
    const res = await worker.fetch(new Request("https://vendas.zevanory.api.br" + path, { headers: { "user-agent": "Mozilla/5.0" } }), env, { waitUntil() {} });
    assert.equal(res.status, 200, path);
    assertBlock(await res.text(), "served " + path);
  }
});

test("open-sales and Hotmart variants of the priced pages keep the block", () => {
  for (const slug of PRICED) {
    const html = read(slug + ".html");
    assertBlock(openSalesHtml(html, slug), slug + " (open)");
    assertBlock(hotmartPage(html, slug, "https://pay.hotmart.com/X1?off=a"), slug + " (hotmart)");
  }
  assertBlock(openSalesHtml(read("conteudo-pronto.html"), "conteudo-pronto"), "conteudo-pronto (open)");
});
