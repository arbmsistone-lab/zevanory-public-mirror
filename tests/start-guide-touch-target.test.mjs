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
test("receipt destinations: each everyday problem links to the product that solves it", () => {
  const html = readFileSync(new URL("../sales-public/solucoes.html", import.meta.url), "utf8");
  const block = html.slice(html.indexOf('<div class="receipt"'));
  const hrefs = [...block.slice(0, block.indexOf("</section>")).matchAll(/class="receipt-line" href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, ["/lucro-e-caixa", "/vendas-na-pratica", "/conteudo-pronto", "/ia-na-pratica", "/calculadora-preco-de-venda", "/combo-ia-vendas", "/negocio-completo"]);
});
