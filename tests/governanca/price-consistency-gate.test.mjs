// ZEVANORY | NC-1006-02 (contra-auditoria GPT-6): gate de consistência de preços. RESERVADO ao proprietário
// (ops/owner-reserved-paths.json, classe marcos_irreversiveis, glob tests/governanca/**; fora de rotina_autonoma).
// Roda no check obrigatório "product-pages / static-audit" (product-pages-premerge.yml:audit e
// required-status-compat.yml:product-status), com contagem EXATA de testes. Um PR autônomo que mude um preço em
// arquivo NÃO reservado (ex.: worker/lead-magnet.mjs) deixa este gate vermelho; mudar o gate exige owner-approved.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { runGate, loadCanon, scanText, listFiles, BUNDLES, EXCECOES, pageProduct, moneyIn } from "./price-gate.mjs";
import * as PP from "../../worker/product-prices.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const GATE = join(ROOT, "tests/governanca/price-gate.mjs");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const canon = loadCanon(ROOT);

// Fixture: cópia mínima do repositório (tabela + arquivos dados) com uma troca de texto; roda o gate pela CLI.
function fixture(files, mutate = {}) {
  const dir = mkdtempSync(join(tmpdir(), "price-gate-"));
  for (const f of ["data/products.json", "data/affiliates.json", "ops/owner-reserved-paths.json", ...files]) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    copyFileSync(join(ROOT, f), join(dir, f));
  }
  for (const [f, [de, para]] of Object.entries(mutate)) {
    const src = readFileSync(join(dir, f), "utf8");
    assert.ok(src.includes(de), `fixture: trecho ausente em ${f}: ${de}`);
    writeFileSync(join(dir, f), src.replace(de, para));
  }
  const r = spawnSync(process.execPath, [GATE, "--root", dir, "--json"], { encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  return { rc: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr };
}

test("G01 tabela canônica: 5 kits + Conteúdo Pronto e economias derivadas (Combo 37 vs 194; Negócio Completo 94 vs 341)", () => {
  const d = JSON.parse(read("data/products.json"));
  assert.deepEqual(d.products.map((p) => [p.slug, p.sku, p.price]), [
    ["ia-na-pratica", "ZEV-IA-011", 97], ["vendas-na-pratica", "ZEV-VEN-011", 97], ["lucro-e-caixa", "ZEV-LCX-011", 147],
    ["combo-ia-vendas", "ZEV-CMB-011", 157], ["negocio-completo", "ZEV-NGC-011", 247]]);
  assert.deepEqual([d.subscription.slug, d.subscription.price, d.subscription.period], ["conteudo-pronto", 197, "mês"]);
  assert.equal(canon.bySlug["combo-ia-vendas"].separado, 194); assert.equal(canon.bySlug["combo-ia-vendas"].economia, 37);
  assert.equal(canon.bySlug["negocio-completo"].separado, 341); assert.equal(canon.bySlug["negocio-completo"].economia, 94);
  // o módulo de derivação usado pelos workers concorda com a tabela e com o gate
  assert.deepEqual(PP.BUNDLES, BUNDLES);
  assert.equal(PP.bundleSavings("combo-ia-vendas"), 37); assert.equal(PP.bundleSeparateTotal("negocio-completo"), 341);
  for (const p of d.products) { assert.equal(PP.priceBySku(p.sku), p.price); assert.equal(PP.priceBySlug(p.slug), p.price); }
  assert.equal(PP.priceBySlug("conteudo-pronto"), 197);
  assert.throws(() => PP.priceBySku("ZEV-XYZ-999"), /product_price_unknown/);
});

test("G02 o repositório atual passa e a varredura cobre as fontes de produção", () => {
  const r = runGate(ROOT);
  assert.equal(r.resultado, "PASS", JSON.stringify({ v: r.violacoes.slice(0, 5), e: r.excecoesQuebradas }, null, 1));
  const files = listFiles(ROOT);
  assert.ok(files.length > 500, "varredura suspeita: " + files.length);
  for (const must of ["worker/lead-magnet.mjs", "worker/acquisition-engine.mjs", "worker/support-knowledge.mjs", "worker/site-chat.mjs",
    "worker/multichannel-autonomy.mjs", "worker/creative-autonomy.mjs", "worker/sales-public-worker.mjs", "worker/sales-lock-content.mjs",
    "scripts/channels/youtube-daily-short.mjs", "scripts/channels/short-crosspost.mjs", "scripts/channels/render-youtube-short.mjs",
    "sales-public/ia-na-pratica.html", "sales-public/combo-ia-vendas.html", "sales-public/solucoes.html", "sales-public/index.html",
    "kit-afiliado/index.html", "data/politica-unica.json", "data/p24/promise-map.json", "data/site-chat-knowledge.json",
    "content/p09/checklist-v2/s2.md", "sales-overlay/llms.txt", "scripts/build_sales_public.py"].filter((f) => existsSync(join(ROOT, f))))
    assert.ok(files.includes(must), "fora da varredura: " + must);
  for (const f of files) assert.doesNotMatch(f, /^(tests|docs|evidence|\.github|scripts\/ci)\//, f);
  // toda exceção aponta para arquivo varrido (senão ela não seria conferida)
  for (const e of EXCECOES) assert.ok(files.includes(e.arquivo), "exceção de arquivo fora da varredura: " + e.arquivo);
});

test("G03 NEGATIVO: preço de kit trocado em worker/lead-magnet.mjs (arquivo NÃO reservado) reprova o gate", () => {
  const f = "worker/lead-magnet.mjs";
  assert.equal(fixture([f]).rc, 0, "fixture sem troca passa");
  // literal reintroduzido no objeto da oferta
  let r = fixture([f], { [f]: ['price: priceBySlug("ia-na-pratica")', "price: 99"] });
  assert.equal(r.rc, 1); assert.ok(r.out.violacoes.some((v) => v.regra === "CAMPO_DE_PRECO" && v.produto === "ia-na-pratica" && v.valor === 99));
  // preço de outro kit no objeto (147 é da tabela, mas não deste produto)
  r = fixture([f], { [f]: ['price: priceBySlug("vendas-na-pratica")', "price: 147"] });
  assert.equal(r.rc, 1); assert.ok(r.out.violacoes.some((v) => v.produto === "vendas-na-pratica" && v.valor === 147));
  // texto do e-mail com valor novo ao lado do nome do produto
  r = fixture([f], { [f]: ['por R$ ${priceBySlug("negocio-completo")}', "por R$ 199"] });
  assert.equal(r.rc, 1); assert.ok(r.out.violacoes.some((v) => v.regra === "VALOR_EM_REAIS" && v.produto === "negocio-completo" && v.valor === 199));
  r = fixture([f], { [f]: ['(separados custariam R$ ${bundleSeparateTotal("negocio-completo")})', "(separados custariam R$ 400)"] });
  assert.equal(r.rc, 1, "economia/soma inventada");
});

test("G04 NEGATIVO: o mesmo vale nos demais módulos, páginas e dados que citam preço", () => {
  const casos = [
    ["worker/support-knowledge.mjs", 'price_brl: priceBySlug("lucro-e-caixa")', "price_brl: 148"],
    ["worker/acquisition-engine.mjs", 'price:priceBySku("ZEV-CMB-011")', "price:167"],
    ["worker/creative-autonomy.mjs", 'price_brl:priceBySku("ZEV-NGC-011")', "price_brl:297"],
    ["worker/multichannel-autonomy.mjs", "export const BLOG_TABLE_C_PRICES=PRICE_BY_SKU;", 'export const BLOG_TABLE_C_PRICES={"ZEV-IA-011":87};'],
    ["scripts/channels/youtube-daily-short.mjs", "export const PRICES = PRICE_BY_SKU;", 'export const PRICES = Object.freeze({ "ZEV-IA-011": 197 });'],
    ["scripts/channels/render-youtube-short.mjs", 'body:"Organize tarefas repetitivas por R$ "+WELCOME_PRICE+",00. "', 'body:"Organize tarefas repetitivas por R$ 197,00. "'],
    ["worker/sales-public-worker.mjs", '"ZEV-IA-011":["IA na Prática",97]', '"ZEV-IA-011":["IA na Prática",107]'],
    ["worker/sales-lock-content.mjs", '"ZEV-LCX-011": Object.freeze({ slug: "lucro-e-caixa", name: "Lucro & Caixa", price: 147 })', '"ZEV-LCX-011": Object.freeze({ slug: "lucro-e-caixa", name: "Lucro & Caixa", price: 149 })'],
    ["sales-public/ia-na-pratica.html", "Comprar agora · R$ 97", "Comprar agora · R$ 98"],
    ["sales-public/solucoes.html", '<p class="catalog-price">R$ 247<', '<p class="catalog-price">R$ 257<'],
    ["sales-public/combo-ia-vendas.html", "Economia de R$ 37", "Economia de R$ 47"],
    ["data/p24/promise-map.json", "Economia de R$ 37", "Economia de R$ 40"],
    ["kit-afiliado/index.html", "R$ 48,50", "R$ 58,50"],
  ];
  for (const [f, de, para] of casos) {
    if (!existsSync(join(ROOT, f))) continue;
    assert.equal(fixture([f]).rc, 0, "base " + f);
    const r = fixture([f], { [f]: [de, para] });
    assert.equal(r.rc, 1, `troca não detectada em ${f}: ${para}`);
  }
});

test("G05 NEGATIVO: valor novo em R$ ao lado de nome/slug/SKU que não está na tabela reprova; valor sem produto não", () => {
  const t = (s, f = "worker/x.mjs") => scanText(f, s, canon);
  assert.equal(t('const s = "Negócio Completo por R$ 199,00";').length, 1);
  assert.equal(t('const s = "Lucro & Caixa — 150 reais";').length, 1);
  assert.equal(t('const s = "/hotmart/combo-ia-vendas: R$ 160";').length, 1);
  assert.equal(t('const s = "ZEV-VEN-011 R$ 99";').length, 1);
  assert.equal(t('{ slug: "ia-na-pratica", amount_cents: 9800 }').length, 1);
  assert.equal(t('{ slug: "ia-na-pratica", amount_cents: 9700 }').length, 0);
  assert.equal(t('{"conteudo-pronto": 187}').length, 1);
  assert.equal(t('{ brand: "ZEVANORY", body: "Organize por R$ 197,00.", price_brl: 197 }').length, 2, "criativo da marca com preço velho");
  // valores que não são preço de produto: exemplo de calculadora, custo zero, cédula de R$ 100
  assert.equal(t("Se você fatura R$ 40.000 e o CMV é R$ 13.000, a margem bruta é R$ 27.000.", "sales-public/calculadora-cmv.html").length, 0);
  assert.equal(t("// Cost: R$ 0. ZEVANORY").length, 0);
  // valores derivados documentados: economia/soma do pacote; comissão (taxa de data/affiliates.json) SÓ em página de afiliado reservada
  assert.equal(t("Combo IA + Vendas por R$ 157 (economia de R$ 37; separados R$ 194)").length, 0);
  assert.equal(t("Negócio Completo R$ 247 — economia de R$ 94 em relação à compra separada (R$ 341)").length, 0);
  assert.equal(t("<p>IA na Prática · R$ 97 · comissão de 50% (R$ 48,50)</p>", "sales-public/kit-afiliado.html").length, 0);
  assert.equal(t("<p>IA na Prática · R$ 97 · comissão de 50% (R$ 50,00)</p>", "sales-public/kit-afiliado.html").length, 1);
  assert.ok(t('const s = "IA na Prática · R$ 97 · comissão de 50% (R$ 48,50)";').some((v) => v.regra === "VALOR_EM_REAIS" && v.valor === 48.5), "comissão fora da página de afiliado");
  assert.equal(t("Combo IA + Vendas: economia de R$ 94").length, 1, "economia de outro pacote");
  // HTML: atributo de texto e página do produto contam como contexto
  assert.equal(pageProduct("sales-public/combo-ia-vendas.html", canon), "combo-ia-vendas");
  assert.equal(pageProduct("pages-mirror/zevanory-negocio-completo.html", canon), "negocio-completo");
  assert.equal(t('<a data-zev-sku="ZEV-IA-011" data-zev-open-text="Comprar agora · R$ 107">x</a>', "sales-public/x.html").length, 1);
  assert.equal(t("<p>Total R$ 167</p>", "sales-public/combo-ia-vendas.html").length, 1);
  assert.equal(t("Neg\\xF3cio Completo por R$ 299").length, 1, "escape \\xHH decodificado");
  assert.equal(t("Neg&oacute;cio Completo por R$&nbsp;299", "sales-public/x.html").length, 1, "entidade HTML decodificada");
});

test("G06 exceções documentadas são exatas: ocorrência a mais ou exceção que sumiu reprova", () => {
  assert.ok(EXCECOES.length >= 1 && EXCECOES.every((e) => e.arquivo && e.regra && e.produto && e.valor !== undefined && e.quantidade >= 1 && e.motivo.length > 20));
  const f = "worker/cloudflare-worker.recovered.mjs";
  assert.equal(fixture([f]).rc, 0);
  // mais uma ocorrência legada no mesmo arquivo
  let r = fixture([f], { [f]: ["table_price_brl: 197, pilot_price_brl: 147", "table_price_brl: 197, pilot_price_brl: 147, extra_price_brl: 197"] });
  assert.equal(r.rc, 1); assert.ok(r.out.excecoesQuebradas.length >= 1);
  // a exceção deixa de existir (alguém "corrige" o legado) também reprova: a lista não pode ficar velha
  r = fixture([f], { [f]: ["table_price_brl: 397, pilot_price_brl: 347", "table_price_brl: 247, pilot_price_brl: 247"] });
  assert.equal(r.rc, 1);
  // tabela ilegível = entrada inválida (rc 2), nunca PASS
  const dir = mkdtempSync(join(tmpdir(), "price-gate-"));
  mkdirSync(join(dir, "data")); writeFileSync(join(dir, "data/products.json"), "{quebrado");
  const x = spawnSync(process.execPath, [GATE, "--root", dir], { encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(x.status, 2);
});

test("G07 o gate roda nos emissores do check obrigatório e os módulos derivam da tabela canônica", () => {
  const cmd = "node --test tests/governanca/price-consistency-gate.test.mjs";
  for (const [wf, job] of [["product-pages-premerge.yml", "audit"], ["required-status-compat.yml", "product-status"]]) {
    const y = read(".github/workflows/" + wf);
    const start = y.indexOf(`\n  ${job}:\n`); assert.ok(start >= 0, wf + ":" + job);
    const rest = y.slice(start + 1); const next = rest.slice(1).search(/\n  [a-z][\w-]*:\n/);
    const body = next >= 0 ? rest.slice(0, next + 1) : rest;
    assert.ok(body.includes(cmd), `${wf}:${job} não roda o gate`);
    assert.match(body, /grep -qx "# tests 12"/, `${wf}:${job} sem contagem exata`);
    assert.match(body, /grep -qx "# fail 0"/); assert.match(body, /grep -qx "# skipped 0"/);
  }
  for (const f of ["worker/lead-magnet.mjs", "worker/acquisition-engine.mjs", "worker/support-knowledge.mjs", "worker/creative-autonomy.mjs",
    "worker/multichannel-autonomy.mjs", "scripts/channels/youtube-daily-short.mjs", "scripts/channels/render-youtube-short.mjs",
    "scripts/channels/youtube-preflight.mjs"]) assert.match(read(f), /product-prices\.mjs"/, f);
  assert.match(read("worker/product-prices.mjs"), /from "\.\.\/data\/products\.json" with \{ type: "json" \}/);
});

test("G08 o gate, o módulo de derivação e a tabela são reservados ao proprietário e ficam fora de rotina_autonoma", () => {
  const d = JSON.parse(read("ops/owner-reserved-paths.json"));
  const rx = (g) => { let o = "", i = 0; while (i < g.length) { if (g.startsWith("**/", i)) { o += "(?:.*/)?"; i += 3; } else if (g.startsWith("**", i)) { o += ".*"; i += 2; } else if (g[i] === "*") { o += "[^/]*"; i++; } else if (g[i] === "?") { o += "[^/]"; i++; } else { o += g[i].replace(/[.+^${}()|[\]\\]/g, "\\$&"); i++; } } return new RegExp("^" + o + "$", "s"); };
  const reservados = Object.values(d.classes).flatMap((c) => c.globs).map(rx);
  const rotina = d.rotina_autonoma.globs.map(rx);
  for (const c of ["tests/governanca/price-gate.mjs", "tests/governanca/price-consistency-gate.test.mjs", "tests/governanca/novo.mjs",
    "worker/product-prices.mjs", "data/products.json", "data/affiliates.json", "worker/affiliate-program.mjs", "worker/sales-public-worker.mjs", "worker/sales-lock-content.mjs"]) {
    assert.ok(reservados.some((r) => r.test(c)), "não reservado: " + c);
    assert.ok(!rotina.some((r) => r.test(c)), "coberto por rotina_autonoma: " + c);
  }
  // arquivo comum com preço continua NÃO reservado: quem segura é este gate no check obrigatório
  assert.ok(!reservados.some((r) => r.test("worker/lead-magnet.mjs")));
});

// NC-1008-01 (contra-auditoria do #1008): cada desvio achado pelo auditor vira fixture que TEM de reprovar.
const DESVIOS = [
  ["sales-public/ia-na-pratica.html", '<p class="receipt-total"><span>Total</span><span>R$ <b class="v">47</b></span></p>', "PAGINA_DE_PRODUTO"],
  ["sales-public/x.html", '<li>IA na Prática por R$ <b class="v">47</b></li>', "VALOR_EM_REAIS"],
  ["worker/x.mjs", 'const O = { ia: { name: "IA na Prática", price: priceBySlug("ia-na-pratica") - 50 } };', "ARITMETICA_DE_PRECO"],
  ["sales-public/ia-na-pratica.html", "<p>Preço: 47,00 à vista</p>", "PAGINA_DE_PRODUTO"],
  ["worker/x.mjs", 'const s = "IA na Prática: 47,00 à vista";', "VALOR_EM_REAIS"],
  ["worker/x.mjs", 'const s = "IA na Prática por quarenta e sete reais";', "VALOR_EM_REAIS"],
  ["worker/x.mjs", 'const s = "IA na Prática por BRL 47";', "VALOR_EM_REAIS"],
  ["worker/x.mjs", 'const s = "Por apenas R$ 47 você leva para casa hoje mesmo, sem demora, o material completo IA na Prática";', "VALOR_EM_REAIS"],
  ["worker/x.mjs", 'const k = { sku: "ZEV-IA-011", offer: { price: 47 } };', "CAMPO_DE_PRECO"],
  ["data/x.json", '{"items":[{"sku":"ZEV-IA-011","offer":{"price":"47"}}]}', "CAMPO_DE_PRECO"],
  ["worker/x.mjs", 'const m = { "ZEV-IA-011": "47" };', "MAPA_DE_PRECO"],
  ["worker/x.mjs", "const m = new Map([[sku, 47]]);", "LITERAL_DE_PRECO"],
  ["worker/x.mjs", 'const m = new Map([["ZEV-IA-011", 47]]);', "MAPA_DE_PRECO"],
  ["worker/x.mjs", "const OFFER = { label: \"oferta\", price: 47 };", "LITERAL_DE_PRECO"],
  ["sales-public/x.html", '<script type="application/ld+json">{"@type":"ItemList","itemListElement":[{"@type":"Product","name":"IA na Prática","offers":{"@type":"Offer","price":"47.00"}}]}</script>', "JSON_LD"],
  ["sales-public/ia-na-pratica.html", '<script type="application/ld+json">{"@type":"Product","offers":{"@type":"AggregateOffer","offers":[{"price":"47.00"}]}}</script>', "JSON_LD"],
  ["worker/x.mjs", "const t = `${o.name} (R$ ${o.price * 0.8})`;", "ARITMETICA_DE_PRECO"],
  ["worker/x.mjs", 'const p = priceBySku("ZEV-IA-011") * 0.8;', "ARITMETICA_DE_PRECO"],
  ["worker/x.mjs", "const p = PRICE_BY_SKU[sku] - 50;", "ARITMETICA_DE_PRECO"],
  ["worker/x.mjs", 'const s = "IA na Prática com 20% de desconto";', "DESCONTO"],
  ["worker/x.mjs", 'const s = "Use o cupom ZEV10 no Combo IA + Vendas";', "DESCONTO"],
  ["worker/x.mjs", 'const s = "Negócio Completo por cinquenta por cento a menos";', "DESCONTO"],
  ["sales-public/combo-ia-vendas.html", "<p>Black Friday: leve agora</p>", "DESCONTO"],
  // NC-1008-04: literal guardado em variável ou em expressão de template
  ["scripts/channels/render-youtube-short.mjs", "const WELCOME_PRICE = 197;", "LITERAL_DE_PRECO"],
  ["worker/x.mjs", "const s = `R$ ${297}`;", "LITERAL_DE_PRECO"],
  ["worker/x.mjs", 'const s = "R$ " + 297 + ",00";', "LITERAL_DE_PRECO"],
  ["worker/x.mjs", 'const s = "R$ " + (200 + 97);', "LITERAL_DE_PRECO"],
  ["worker/x.mjs", 'const P = 197;\nconst s = "Organize por R$ " + P + ",00";', "LITERAL_DE_PRECO"],
  ["worker/x.mjs", "const P = 197;\nconst s = `por R$ ${P},00`;", "LITERAL_DE_PRECO"],
  ["worker/x.mjs", "const P = 197;\nconst g = evaluate(c, { serverPrice: P });", "LITERAL_DE_PRECO"],
  ["worker/x.mjs", "let valorKit = 147;", "LITERAL_DE_PRECO"],
  ["worker/x.mjs", 'const ia = priceBySlug("ia-na-pratica");\nconst t = ia+100;', "ARITMETICA_DE_PRECO"],
  ["worker/x.mjs", "const k = PRICE_BY_SKU[sku];\nk *= 0.8;", "ARITMETICA_DE_PRECO"],
  ["worker/x.mjs", "let total = o.price;\ntotal = o.price;\no.price -= 50;", "ARITMETICA_DE_PRECO"],
];

test("G09 NEGATIVO: os desvios da contra-auditoria NC-1008-01 reprovam (HTML com tag no meio, sem R$, por extenso, BRL, longe, aninhado, Map, JSON-LD, aritmética, cupom)", () => {
  for (const [f, s, regra] of DESVIOS) {
    const v = scanText(f, s, canon);
    assert.ok(v.some((x) => x.regra === regra), `${regra} não detectado: ${f} ${s} -> ${JSON.stringify(v.map((x) => x.regra))}`);
  }
  assert.deepEqual(moneyIn("cento e quarenta e sete reais").map((m) => m.value), [147]);
  assert.deepEqual(moneyIn("mil e noventa e sete reais").map((m) => m.value), [1097]);
  // pela CLI, em cópias reais: página do produto e lead-magnet
  const pg = "sales-public/ia-na-pratica.html";
  let r = fixture([pg], { [pg]: ["<span>Total</span><span>R$ 97</span>", '<span>Total</span><span>R$ <b class="v">47</b></span>'] });
  assert.equal(r.rc, 1, "tag no meio do valor da página (Total)");
  r = fixture([pg], { [pg]: ['<span class="status-pill">R$ 97 · pagamento único</span>', '<span class="status-pill">R$ <b class="v">47</b> · pagamento único</span>'] });
  assert.equal(r.rc, 1, "tag no meio do valor da página (selo)");
  r = fixture(["worker/lead-magnet.mjs"], { "worker/lead-magnet.mjs": ['price: priceBySlug("ia-na-pratica")', 'price: priceBySlug("ia-na-pratica") - 50'] });
  assert.equal(r.rc, 1, "aritmética sobre o preço importado");
  assert.ok(r.out.violacoes.some((v) => v.regra === "ARITMETICA_DE_PRECO"));
  r = fixture(["worker/lead-magnet.mjs"], { "worker/lead-magnet.mjs": ['price: priceBySlug("ia-na-pratica")', "price: 0.8 * priceBySlug(\"ia-na-pratica\")"] });
  assert.equal(r.rc, 1, "aritmética à esquerda");
  // NC-1008-04: o cenário do auditor nos dois scripts reais do Short de boas-vindas
  for (const f of ["scripts/channels/render-youtube-short.mjs", "scripts/channels/youtube-preflight.mjs"]) {
    assert.equal(fixture([f]).rc, 0, "base " + f);
    r = fixture([f], { [f]: ['const WELCOME_PRICE = priceBySku("ZEV-IA-011");', "const WELCOME_PRICE = 197;"] });
    assert.equal(r.rc, 1, "WELCOME_PRICE literal passou em " + f);
    assert.ok(r.out.violacoes.some((v) => v.regra === "LITERAL_DE_PRECO" && v.valor === 197), f);
    r = fixture([f], { [f]: ['"Organize tarefas repetitivas por R$ "+WELCOME_PRICE+",00. "', '`Organize tarefas repetitivas por R$ ${197},00. `'] });
    assert.equal(r.rc, 1, "template com literal passou em " + f);
  }
  // fora dos desvios: valores legítimos continuam passando
  for (const [f, s] of [["worker/x.mjs", 'const s = "R$ " + priceBySlug("ia-na-pratica") + ",00";'], ["worker/x.mjs", "const s = `por R$ ${o.price},00`;"],
    ["worker/x.mjs", "const s = \"IA na Prática não tem desconto nem cupom.\";"], ["worker/x.mjs", 'const s = "Conteúdo Pronto: campanha mensal de promoção de vendas";'],
    ["sales-public/calculadora-cmv.html", "<p>A margem é de 32,5% sobre R$ 40.000.</p><p>Próximo passo: Lucro & Caixa</p>"]])
    assert.deepEqual(scanText(f, s, canon).map((x) => x.regra), [], s);
});

test("G10 runtime: os módulos de produção IMPORTADOS renderizam só os preços da tabela", async () => {
  const d = JSON.parse(read("data/products.json"));
  const price = Object.fromEntries(d.products.map((p) => [p.sku, p.price]));
  const bySlug = Object.fromEntries([...d.products, d.subscription].map((p) => [p.slug, p]));
  const prose = (label, text) => {
    const v = scanText("render/" + label + ".txt", String(text), canon);
    assert.deepEqual(v.map((x) => `${x.regra} ${x.produto}=${x.valor}`), [], label + ": " + String(text).slice(0, 160));
  };
  const { nurtureEmail } = await import("../../worker/lead-magnet.mjs");
  for (const [interest, slug] of [["ia", "ia-na-pratica"], ["vendas", "vendas-na-pratica"], ["caixa", "lucro-e-caixa"]]) {
    for (let step = 0; step < 5; step++) { const m = nurtureEmail(step, { interest, salesOpen: true, optOutUrl: "x" }); prose(`lead-${interest}-${step}`, m.subject + "\n" + m.text); }
    assert.ok(nurtureEmail(2, { interest, salesOpen: true, optOutUrl: "x" }).text.includes(`(R$ ${bySlug[slug].price},`), "oferta " + slug);
  }
  const { calendarEntry, generateNative } = await import("../../worker/acquisition-engine.mjs");
  const seen = new Set();
  for (let i = 0; i < 25; i++) {
    const e = calendarEntry(new Date(Date.UTC(2026, 10, 1 + i)).toISOString().slice(0, 10)); seen.add(e.product.sku);
    assert.equal(e.product.price, price[e.product.sku], "motor " + e.product.sku);
    for (const ch of ["blog", "telegram", "bluesky"]) {
      const g = generateNative(e, ch, { hotmartOpen: true }); const txt = JSON.stringify(g);
      prose(`acq-${ch}-${i}`, txt.replace(/\\n/g, "\n"));
      assert.ok(txt.includes("R$ " + price[e.product.sku]), `rascunho Hotmart sem o preço da tabela: ${e.product.sku}`);
    }
  }
  assert.equal(seen.size, 5);
  const { answerSupportQuestion, SUPPORT_PRODUCTS } = await import("../../worker/support-knowledge.mjs");
  for (const slug of Object.keys(SUPPORT_PRODUCTS)) {
    const a = answerSupportQuestion({ product: slug, question: "Quanto custa?", salesOpen: true }).answer;
    const brl = "R$ " + bySlug[slug].price + ",00";
    assert.ok(a.includes(brl), `atendimento ${slug}: ${a}`); prose("support-" + slug, a);
  }
  const yt = await import("../../scripts/channels/youtube-daily-short.mjs");
  const { captionFor } = await import("../../scripts/channels/short-crosspost.mjs");
  for (let i = 0; i < 15; i++) {
    const day = new Date(Date.UTC(2026, 10, 1 + i)).toISOString().slice(0, 10);
    for (const opt of [{ salesOpen: true }, { hotmartOpen: true }]) {
      const plan = yt.planShort(day, opt);
      if (!plan.entry?.product?.sku || plan.price == null) continue;
      assert.equal(plan.price, price[plan.entry.product.sku], `Short ${day} ${JSON.stringify(opt)}`);
      prose(`short-${day}`, [plan.title, plan.description, ...(plan.lines || []), plan.speech, JSON.stringify(plan.screen || ""), plan.spec?.body].join("\n"));
      for (const ch of ["tiktok", "instagram", "facebook", "telegram"]) { try { prose(`cap-${ch}-${day}`, captionFor(plan, ch, opt)); } catch { /* canal sem legenda */ } }
    }
  }
  // NC-1008-04: criativo de boas-vindas (builder exportado dos dois scripts) com o preço do IA na Prática da tabela
  for (const f of ["../../scripts/channels/render-youtube-short.mjs", "../../scripts/channels/youtube-preflight.mjs"]) {
    const { welcomeCreative } = await import(f);
    const c = welcomeCreative();
    assert.equal(c.price_brl, price["ZEV-IA-011"], f);
    assert.ok(c.body.includes(`R$ ${price["ZEV-IA-011"]},00`), f + ": " + c.body);
    for (const m of moneyIn(c.body)) assert.equal(m.value, price["ZEV-IA-011"], f);
    prose("welcome-" + f.split("/").pop(), JSON.stringify(c));
  }
  const { ZEV_CREATIVE_CATALOG } = await import("../../worker/creative-autonomy.mjs");
  for (const [sku, c] of Object.entries(ZEV_CREATIVE_CATALOG)) assert.equal(c.price_brl, price[sku], "criativo " + sku);
  const { BLOG_TABLE_C_PRICES } = await import("../../worker/multichannel-autonomy.mjs");
  assert.deepEqual({ ...BLOG_TABLE_C_PRICES }, price);
});

test("G11 comissão: taxa só na fonte reservada data/affiliates.json, lida pelo programa e pelo gate; valor derivado só nas páginas de afiliado", async () => {
  const af = JSON.parse(read("data/affiliates.json"));
  assert.equal(af.schema, "zevanory-affiliates/v1");
  assert.match(af.nota, /PENDENTE decisão do proprietário \(30% recomendado no F0\)/);
  assert.deepEqual([af.hotmart_commission_pct, af.own_program_commission_pct], [50, 30], "valores publicados hoje (nenhuma taxa decidida aqui)");
  const { AFFILIATE_COMMISSION_RATE } = await import("../../worker/affiliate-program.mjs");
  assert.equal(AFFILIATE_COMMISSION_RATE, af.own_program_commission_pct / 100);
  const src = read("worker/affiliate-program.mjs");
  assert.match(src, /from "\.\.\/data\/affiliates\.json" with \{ type: "json" \}/);
  // DML/relatório sem taxa literal; o ÚNICO literal permitido é o default do DDL (restore drill recusa DDL interpolado),
  // e ele tem de ser igual à taxa da fonte (tests/affiliate-program.test.mjs também confere)
  assert.doesNotMatch(src, /amount,0\.3000|amount\*0\.30|commission_rate:0\.30|comissão: 30%/, "taxa literal no programa");
  assert.deepEqual([...src.matchAll(/0\.30+\b/g)].map((m) => src.slice(0, m.index).endsWith("commission_rate numeric(5,4) not null default ")), [true]);
  assert.equal(Number(src.match(/commission_rate numeric\(5,4\) not null default ([0-9.]+)/)[1]), af.own_program_commission_pct / 100);
  assert.doesNotMatch(read("tests/governanca/price-gate.mjs"), /AFFILIATE_RATE\s*=|\*\s*0\.5\b/, "taxa literal no gate");
  for (const p of af.pages) assert.ok(existsSync(join(ROOT, p)), "página de afiliado inexistente: " + p);
  // página de afiliado: comissão derivada da taxa da fonte; outra taxa reprova
  const f = "sales-public/kit-afiliado.html";
  assert.equal(fixture([f]).rc, 0);
  assert.equal(fixture([f], { [f]: ["R$ 48,50", "R$ 38,80"] }).rc, 1, "comissão de 40% inventada");
  // trocar a taxa NA FONTE muda o que o gate aceita (prova de que ele lê a fonte)
  const dir = mkdtempSync(join(tmpdir(), "price-gate-"));
  for (const x of ["data/products.json", "ops/owner-reserved-paths.json", f]) { mkdirSync(dirname(join(dir, x)), { recursive: true }); copyFileSync(join(ROOT, x), join(dir, x)); }
  writeFileSync(join(dir, "data/affiliates.json"), JSON.stringify({ ...af, hotmart_commission_pct: 40 }));
  const x = spawnSync(process.execPath, [GATE, "--root", dir], { encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(x.status, 1, "com 40% na fonte, a página que diz 50% reprova");
});

// Plano do e-mail de abandono (PR-2; contra-auditoria do PR-1): worker/abandono-hotmart.mjs é RESERVADO (#1009), então o
// price-gate não aplica J2 nem a regra de desconto a ele. Esta regra estática cobre o módulo no check obrigatório: nenhum
// literal de preço, nome e preço só de productBySlug(slug) (data/products.json), nenhuma outra fonte de preço.
test("G12 lembrete de abandono: sem literal de preço e productBySlug obrigatório em worker/abandono-hotmart.mjs", () => {
  const code = read("worker/abandono-hotmart.mjs").replace(/\r\n/g, "\n").replace(/^\s*\/\/.*$/gm, "");
  assert.match(code, /import\s*\{\s*productBySlug\s*\}\s*from\s*"\.\/product-prices\.mjs"/, "importa productBySlug");
  assert.match(code, /export function abandonmentEmail\(slug[^)]*\)\s*\{\s*\n\s*const p = productBySlug\(slug\);/, "o texto deriva de productBySlug(slug)");
  assert.match(code, /R\$ \$\{p\.price\}/, "preço do texto = productBySlug(slug).price");
  assert.doesNotMatch(code, /R\$\s*\d|\bBRL\s*\d|\d+\s*reais\b|(?<![{\d])\d+,\d{2}(?![\d}])/i, "valor em reais literal");
  assert.doesNotMatch(code, /\b(?:price|preco|preço|valor|amount)\s*[:=]\s*-?\d/i, "campo de preço literal");
  assert.doesNotMatch(code, /\b(?:price|preco|valor)\s*[+\-*/%]\s*\d|\d\s*[+\-*/%]\s*\w*\.price\b/i, "aritmética de preço");
  assert.doesNotMatch(code, /HOTMART_KITS|PRICE_BY_SKU|priceBySku|priceBySlug|products\.json/, "outra fonte de preço");
  const official = new Set([...PP.OFFICIAL_PRODUCTS, PP.SUBSCRIPTION].map((p) => String(p.price)));
  const literals = [...code.matchAll(/(?<![\w.$])\d+(?![\w.])/g)].map((m) => m[0]).filter((n) => official.has(n));
  assert.deepEqual(literals, [], "número igual a um preço oficial no módulo");
  // prova de que a regra pega o mutante M34 (preço por literal): a mesma checagem sobre o texto mutado reprova
  const p0 = PP.productBySlug("ia-na-pratica").price;
  const mutated = code.replace("const p = productBySlug(slug);", `const p = { ...productBySlug(slug), price: ${p0} };`);
  assert.notEqual(mutated, code, "âncora do mutante presente");
  assert.match(mutated, /\b(?:price|preco|preço|valor|amount)\s*[:=]\s*-?\d/i, "a regra reprova o literal do mutante");
});
