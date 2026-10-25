import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// #821 added inline links in "Por onde começar" with 20 px touch targets; the live apex gate
// (>= 44 x 44 px for every link/button in <main>) caught it. Design PR (2026-10-24): "Por onde
// começar" became the hero receipt ("Problemas do balcão"), one problem per line linking to the
// product that solves it. Same guarantees: 44 px targets in the CSS, built copy = source, and the
// destinations pinned (now the receipt's, in order).
const src = readFileSync(new URL("../product.css", import.meta.url), "utf8");
const built = readFileSync(new URL("../sales-public/product.css", import.meta.url), "utf8");
test("receipt lines (formerly start-guide links) keep a 44 px touch target", () => {
  const rule = /\.receipt-line\{([^}]*)\}/.exec(src);
  assert.ok(rule, "rule present");
  assert.match(rule[1], /min-height:48px/); assert.match(rule[1], /display:flex/);
  const leader = /\.receipt-line \.leader\{([^}]*)\}/.exec(src);
  assert.ok(leader && /min-width:24px/.test(leader[1]), "dotted leader never collapses");
});
test("the published sales stylesheet is the built copy of the source", () => assert.equal(built, src));
test("receipt destinations: each everyday problem jumps to the card of the product that solves it", () => {
  // Signature interaction (design PR, second review): a receipt line is an in-page link to the matching
  // catalogue card, which :target highlights ("Seu problema: ...") and whose title links to the product.
  const html = readFileSync(new URL("../sales-public/solucoes.html", import.meta.url), "utf8");
  const block = html.slice(html.indexOf('<div class="receipt"'));
  const hrefs = [...block.slice(0, block.indexOf("</section>")).matchAll(/class="receipt-line" href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, ["#p-lucro-e-caixa", "#p-vendas-na-pratica", "#p-conteudo-pronto", "#p-ia-na-pratica", "#p-ferramentas", "#p-combo-ia-vendas", "#p-negocio-completo"]);
  for (const h of hrefs) {
    const slug = h.slice(3);
    const card = html.match(new RegExp(`<article class="catalog-card[^"]*" id="p-${slug}" tabindex="-1"><div class="cc-main"><p class="cc-match">Seu problema: [^<]+</p><h3><a href="/${slug}">`));
    assert.ok(card, "card target with problem label and product link: " + slug);
  }
  assert.match(src, /\.catalog-card:target\{[^}]*outline:3px solid/, "the chosen card is visibly marked");
  assert.match(src, /\.catalog-card:target \.cc-match\{display:block\}/);
});
