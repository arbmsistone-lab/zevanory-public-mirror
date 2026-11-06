// Regressão P02-P04 pós-#878 (exact-cert ao vivo, portfolio-six-target-exact-cert.yml):
// com vendas fechadas o CTA da barra fixa móvel (.buy-bar) passou de "Comprar" para
// "Entrar na lista de espera". A regra antiga `.buy-bar .button{flex:0 0 auto}` impedia o botão de
// encolher/quebrar linha; com a fonte de fallback do runner Ubuntu (DejaVu Sans, sem Inter) o botão
// media ~264 px e terminava em x=404 numa viewport de 390 px -> "geometry/token failure ... bad:[A]"
// nos 5 alvos (mobile). Este teste fixa as regras de CSS que mantêm a barra dentro da tela.
import test from "node:test";
import assert from "node:assert/strict";
import { readTextNormalized } from "./helpers/text.mjs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TARGETS = ["ia-na-pratica", "vendas-na-pratica", "lucro-e-caixa", "combo-ia-vendas", "negocio-completo"];

// Regras (seletor -> declarações) dentro de cada bloco @media(max-width:760px), com casamento de chaves.
function mobileRules(css) {
  const rules = new Map();
  const re = /@media\s*\(\s*max-width\s*:\s*760px\s*\)\s*\{/g;
  let m;
  while ((m = re.exec(css))) {
    let depth = 1, i = re.lastIndex;
    while (depth && i < css.length) { if (css[i] === "{") depth++; else if (css[i] === "}") depth--; i++; }
    const body = css.slice(re.lastIndex, i - 1).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const r of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const decl = {};
      for (const d of r[2].split(";")) { const k = d.indexOf(":"); if (k > 0) decl[d.slice(0, k).trim()] = d.slice(k + 1).trim(); }
      for (const sel of r[1].split(",")) rules.set(sel.trim().replace(/\s*>\s*/g, ">").replace(/\s+/g, " "), { ...(rules.get(sel.trim()) || {}), ...decl });
    }
  }
  return rules;
}
const flexShrink = (d) => {
  if (d["flex-shrink"] !== undefined) return Number(d["flex-shrink"]);
  const f = (d.flex || "").trim();
  if (!f) return 1;            // padrão CSS
  if (f === "none") return 0;
  const parts = f.split(/\s+/);
  return parts.length >= 2 && /^[0-9.]+$/.test(parts[1]) ? Number(parts[1]) : 1;
};

for (const file of ["product.css", "sales-public/product.css"]) {
  test(`${file}: barra fixa móvel cabe em 390 px (CTA e texto encolhem e quebram linha, alvo de 44 px)`, () => {
    const rules = mobileRules(readTextNormalized(join(ROOT, file)));
    const btn = rules.get(".buy-bar .button"), txt = rules.get(".buy-bar>div");
    assert.ok(btn, "regra .buy-bar .button ausente no @media(max-width:760px)");
    assert.ok(flexShrink(btn) > 0, `.buy-bar .button não pode ter flex-shrink 0 (flex: ${btn.flex})`);
    assert.equal(btn["min-width"], "0", ".buy-bar .button precisa de min-width:0 para encolher abaixo do conteúdo");
    assert.notEqual(btn["white-space"], "nowrap", ".buy-bar .button não pode impedir a quebra de linha");
    assert.ok(btn["max-width"] && /%$/.test(btn["max-width"]) && parseFloat(btn["max-width"]) < 100, ".buy-bar .button precisa de max-width percentual < 100%");
    assert.ok(/anywhere|break-word/.test(btn["overflow-wrap"] || ""), ".buy-bar .button precisa de overflow-wrap");
    assert.equal(btn["min-height"], "44px", "alvo de toque de 44 px preservado");
    assert.ok(txt, "regra .buy-bar>div ausente");
    assert.equal(txt["min-width"], "0", ".buy-bar>div precisa de min-width:0");
    assert.ok(flexShrink(txt) > 0, ".buy-bar>div precisa poder encolher");
  });
}

test("sales-public/product.css é cópia exata de product.css e os 5 alvos fechados usam a barra com o CTA de lista de espera", () => {
  const root = readTextNormalized(join(ROOT, "product.css"));
  assert.equal(readTextNormalized(join(ROOT, "sales-public/product.css")), root, "build_sales_public.py copia product.css: as duas cópias não podem divergir");
  for (const slug of TARGETS) {
    const html = readTextNormalized(join(ROOT, "sales-public", slug + ".html"));
    const bar = html.match(/<div class="buy-bar"[^>]*>(<div>[\s\S]*?<\/div>)(<a class="button primary"[^>]*>([^<]*)<\/a>)<\/div>/);
    assert.ok(bar, slug + ": barra .buy-bar com <div> de texto (filho direto) + CTA");
    assert.equal(bar[3], "Entrar na lista de espera", slug + ": CTA fechado (vendas fechadas) inalterado");
    assert.ok(!/href="\/comprar\//.test(bar[2]), slug + ": sem link de checkout com vendas fechadas");
  }
});
