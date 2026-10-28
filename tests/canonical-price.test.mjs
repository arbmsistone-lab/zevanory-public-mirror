// Preço canônico (P24 T3 / Sol ORDEM 301 item 4): data/products.json é a única definição de preço. Este teste
// prova, por produto, que preço da página == preço do resumo da oferta == JSON-LD == preço cobrado no checkout
// próprio (unit_price da preferência) == atendimento/chat == materiais de divulgação. Vale para QUALQUER valor em
// data/products.json: mudar o preço é mudar um arquivo, rodar scripts/sync_canonical_prices.py e o build.
import test from "node:test";
import assert from "node:assert/strict";
import { readTextNormalized } from "./helpers/text.mjs";
import { requireTool } from "./helpers/toolchain.mjs";
import { spawnSync } from "node:child_process";
import vm from "node:vm";
import { openSalesHtml } from "../worker/sales-public-worker.mjs";

const read = (p) => readTextNormalized(new URL("../" + p, import.meta.url));
const official = JSON.parse(read("data/products.json"));
const P = Object.fromEntries(official.products.map((p) => [p.slug, p]));
const SUB = Number(official.subscription.price);
const sep = (slugs) => slugs.reduce((t, s) => t + P[s].price, 0);
const BUNDLES = { "combo-ia-vendas": ["ia-na-pratica", "vendas-na-pratica"], "negocio-completo": ["ia-na-pratica", "vendas-na-pratica", "lucro-e-caixa"] };
const prices = (html) => [...html.matchAll(/R\$ ?(\d+)/g)].map((m) => Number(m[1]));

// Checkout próprio: avalia o catálogo e o resolvedor reais do Worker (texto do bundle) numa VM, com o produto
// marcado como vendável só dentro do teste (em produção sellable=false enquanto as vendas estão fechadas).
function checkoutPrice(sku) {
  const src = read("worker/cloudflare-worker.recovered.mjs");
  const cat = src.match(/ZEVANORY_PRODUCTS = (Object\.freeze\(\[[\s\S]*?\]\));/)[1];
  const fn = (name) => src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))[0];
  const ctx = { PROJECT: { offerId: sku }, ARBM_SIST_OFFER: { id: "ARBM-SIST" }, process: { env: {} } };
  vm.runInNewContext(`const ZEVANORY_PRODUCTS = ${cat}.map((p) => ({ ...p, sellable: true }));\n${fn("getZevanoryProduct")}\n${fn("resolveCheckoutOffer")}\n${fn("publicOffer")}\nthis.out = resolveCheckoutOffer(${JSON.stringify(sku)}); this.pub = publicOffer();`, ctx);
  return Object.assign({}, ctx.out, { public_price_brl: ctx.pub.price_brl });
}

test("sincronizador: nenhuma superfície tem preço diferente de data/products.json", () => {
  requireTool("python3");
  const r = spawnSync("python3", ["scripts/sync_canonical_prices.py", "--check"], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PRECO_CANONICO=OK/);
});

test("por produto: página == resumo da oferta == JSON-LD == checkout (unit_price) == atendimento == divulgação", () => {
  const preference = read("worker/cloudflare-worker.recovered.mjs");
  assert.match(preference, /quantity: 1, currency_id: "BRL", unit_price: offer\.price_brl \}/, "a preferência cobra offer.price_brl");
  const support = read("worker/support-knowledge.mjs"), engine = read("worker/acquisition-engine.mjs"), creative = read("worker/creative-autonomy.mjs");
  const salesWorker = read("worker/sales-public-worker.mjs"), overlay = read("sales-overlay/approved.json"), llms = read("sales-overlay/llms.txt");
  for (const p of official.products) {
    const html = read(`sales-public/${p.slug}.html`);
    const allowed = new Set([p.price, ...(BUNDLES[p.slug] ? [sep(BUNDLES[p.slug]), sep(BUNDLES[p.slug]) - p.price] : [])]);
    const shown = prices(html);
    assert.ok(shown.includes(p.price), `[pagina] ${p.slug} mostra R$ ${p.price}`);
    assert.deepEqual(shown.filter((v) => !allowed.has(v)), [], `[pagina] ${p.slug}: nenhum outro valor`);
    assert.match(html, new RegExp(`R\\$ ${p.price} · pagamento único`), `[resumo] ${p.slug}`);
    assert.match(html, new RegExp(`R\\$ ${p.price},00, pagamento único`), `[resumo-oferta] ${p.slug}`);
    const open = openSalesHtml(html, p.slug);
    const ld = [...open.matchAll(/"price":"(\d+)\.00"/g)].map((m) => Number(m[1]));
    assert.ok(ld.length >= 1 && ld.every((v) => v === p.price), `[json-ld] ${p.slug}: ${ld}`);
    assert.match(open, new RegExp(`Comprar agora · R\\$ ${p.price}`), `[botao-aberto] ${p.slug}`);
    const offer = checkoutPrice(p.sku);
    assert.equal(offer.price_brl, p.price, `[checkout] ${p.sku}: cobrado == página`);
    assert.equal(offer.public_price_brl, p.price, `[public-offer] ${p.sku}: rota pública de status == página`);
    assert.match(salesWorker, new RegExp(`"${p.sku}":\\["[^"]+",${p.price}\\]`), `[comprar] ${p.sku}`);
    assert.match(support, new RegExp(`"${p.slug}": \\{ name: "[^"]+", price_brl: ${p.price}\\b`), `[chat] ${p.slug}`);
    assert.match(engine, new RegExp(`sku:"${p.sku}",name:"[^"]+",price:${p.price}\\b`), `[divulgacao] ${p.slug}`);
    assert.match(creative, new RegExp(`slug:"${p.slug}",name:"[^"]+",price_brl:${p.price}\\b`), `[criativos] ${p.slug}`);
    assert.match(overlay, new RegExp(`"${p.slug}": "(?:[^"\\\\]|\\\\.)*?Preço de tabela: R\\$ ${p.price}\\b`), `[overlay] ${p.slug}`);
    assert.match(llms, new RegExp(`/${p.slug}\\)[^\\n]*R\\$ ${p.price}\\b`), `[llms] ${p.slug}`);
  }
});

test("assinatura Conteúdo Pronto: página == JSON-LD == chat == contrato", () => {
  const html = read("sales-public/conteudo-pronto.html");
  assert.deepEqual([...new Set(prices(html))], [SUB], "[cp-pagina] só o preço da assinatura");
  const open = openSalesHtml(html, "conteudo-pronto");
  assert.match(open, new RegExp(`"price":"${SUB}\\.00"`), "[cp-json-ld]");
  assert.match(read("worker/support-knowledge.mjs"), new RegExp(`Conteúdo Pronto \\(assinatura mensal\\)", price_brl: ${SUB}\\b`), "[cp-chat]");
  assert.match(read("data/politica-unica.json"), new RegExp(`"preco_total": "R\\$ ${SUB},00 por mês`), "[cp-contrato]");
});

// Auditoria #954 HIGH-1: nenhum arquivo versionado tem preço próprio. Com preços-sentinela em data/products.json,
// o sincronizador e o build precisam tirar TODO preço real do repositório (exceções justificadas no script).
test("varredura: trocar o preço em data/products.json troca todas as superfícies (nenhum preço literal sobra)", () => {
  requireTool("python3");
  const cwd = new URL("..", import.meta.url);
  const r = spawnSync("python3", ["-B", "scripts/price_surface_scan.py"], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, "[varredura] " + r.stdout.slice(-3000) + r.stderr.slice(-1000));
  assert.match(r.stdout, /PRICE_SCAN=OK ocorrencias=0/);
  const self = spawnSync("python3", ["-B", "scripts/price_surface_scan.py", "--selftest"], { cwd, encoding: "utf8" });
  assert.equal(self.status, 0, "[varredura-autoteste] " + self.stdout + self.stderr);
  assert.match(self.stdout, /PRICE_SCAN_SELFTEST=OK/);
});
