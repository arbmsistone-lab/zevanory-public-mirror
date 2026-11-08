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
import { runGate, loadCanon, scanText, listFiles, BUNDLES, EXCECOES, pageProduct } from "./price-gate.mjs";
import * as PP from "../../worker/product-prices.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const GATE = join(ROOT, "tests/governanca/price-gate.mjs");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const canon = loadCanon(ROOT);

// Fixture: cópia mínima do repositório (tabela + arquivos dados) com uma troca de texto; roda o gate pela CLI.
function fixture(files, mutate = {}) {
  const dir = mkdtempSync(join(tmpdir(), "price-gate-"));
  for (const f of ["data/products.json", ...files]) {
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
  // valores derivados documentados: economia/soma do pacote e comissão de 50% do afiliado
  assert.equal(t("Combo IA + Vendas por R$ 157 (economia de R$ 37; separados R$ 194)").length, 0);
  assert.equal(t("Negócio Completo R$ 247 — economia de R$ 94 em relação à compra separada (R$ 341)").length, 0);
  assert.equal(t("IA na Prática · R$ 97 · comissão de 50% (R$ 48,50)").length, 0);
  assert.equal(t("IA na Prática · R$ 97 · comissão de 50% (R$ 50,00)").length, 1);
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
  assert.ok(EXCECOES.length >= 1 && EXCECOES.every((e) => e.arquivo && e.regra && e.produto && Number.isFinite(e.valor) && e.quantidade >= 1 && e.motivo.length > 20));
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
    assert.match(body, /grep -qx "# tests 8"/, `${wf}:${job} sem contagem exata`);
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
    "worker/product-prices.mjs", "data/products.json", "worker/sales-public-worker.mjs", "worker/sales-lock-content.mjs"]) {
    assert.ok(reservados.some((r) => r.test(c)), "não reservado: " + c);
    assert.ok(!rotina.some((r) => r.test(c)), "coberto por rotina_autonoma: " + c);
  }
  // arquivo comum com preço continua NÃO reservado: quem segura é este gate no check obrigatório
  assert.ok(!reservados.some((r) => r.test("worker/lead-magnet.mjs")));
});
