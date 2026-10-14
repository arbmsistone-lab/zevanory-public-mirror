import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// #821 added inline links in "Por onde começar" with 20 px touch targets; the live apex gate
// (>= 44 x 44 px for every link/button in <main>) caught it. Keep the rule and the built copy.
const src = readFileSync(new URL("../product.css", import.meta.url), "utf8");
const built = readFileSync(new URL("../sales-public/product.css", import.meta.url), "utf8");
test("start-guide links keep a 44x44 px touch target", () => {
  const rule = /\.start-guide ol a\{([^}]*)\}/.exec(src);
  assert.ok(rule, "rule present");
  assert.match(rule[1], /min-height:44px/); assert.match(rule[1], /min-width:44px/); assert.match(rule[1], /display:inline-flex/);
});
test("the published sales stylesheet is the built copy of the source", () => assert.equal(built, src));
test("start-guide destinations unchanged", () => {
  const html = readFileSync(new URL("../sales-public/solucoes.html", import.meta.url), "utf8");
  const block = html.slice(html.indexOf('class="container start-guide"'));
  const hrefs = [...block.slice(0, block.indexOf("</section>")).matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, ["/material-gratuito", "/lucro-e-caixa", "/vendas-na-pratica", "/ia-na-pratica"]);
});
