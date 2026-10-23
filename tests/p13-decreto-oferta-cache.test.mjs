// AVAL 084 (Sol) sobre #878:
// 1) gate do modo fechado sem falso PASS: qualquer Offer paga em JSON-LD (InStock, PreOrder, PreSale,
//    LimitedAvailability ou sem availability), Offer em microdata e checkout externo derrubam a CLI;
//    Offer de preço 0 (calculadoras gratuitas) continua permitida;
// 2) cache: HTML que depende do interruptor de vendas sai com Cache-Control no-store nos dois modos e
//    um fechamento depois de aberto aparece já na requisição seguinte;
// 4) Decreto 7.962/2013, art. 2º: "Resumo da oferta" estruturado junto a cada oferta paga, com todos os
//    campos vindos de data/politica-unica.json (resumo_oferta) — verificado por estrutura (data-field).
import test from "node:test";
import assert from "node:assert/strict";
import { readTextNormalized } from "./helpers/text.mjs";
import { readFileSync, readdirSync, mkdtempSync, cpSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import worker, { openSalesHtml } from "../worker/sales-public-worker.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUB = join(ROOT, "sales-public");
const P = JSON.parse(readTextNormalized(join(ROOT, "data/politica-unica.json")));
const R = P.resumo_oferta;
const PRODUCTS = P.policy_surfaces.products;
const PRICES = { "ia-na-pratica": 197, "vendas-na-pratica": 197, "lucro-e-caixa": 247, "combo-ia-vendas": 297, "negocio-completo": 397 };
const PY = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" };
const audit = (dir) => spawnSync(PY, [join(ROOT, "scripts/sales_policy.py"), "--audit", dir, "--mode", "closed"], { encoding: "utf8", env });
const read = (slug) => readTextNormalized(join(PUB, slug + ".html"));
const PENDING = /PENDENTE|PREENCHER|A CONFIRMAR|PLACEHOLDER|XXX|\{|\}/i;

// Estrutura: <section class="offer-summary" data-offer-summary="slug"> ... <div data-field="k"><dt>..</dt><dd>..</dd></div>
function summaryFields(html, slug) {
  const start = html.indexOf(`<section class="offer-summary" data-offer-summary="${slug}"`);
  assert.ok(start >= 0, "Resumo da oferta ausente: " + slug);
  const end = html.indexOf("</section>", start);
  const block = html.slice(start, end);
  const fields = [...block.matchAll(/<div data-field="([a-z_]+)"><dt>([^<]+)<\/dt><dd>(.*?)<\/dd><\/div>/g)].map((m) => ({ key: m[1], label: m[2], value: m[3].replace(/<[^>]+>/g, "").trim() }));
  return { start, end, fields };
}
function checkSummary(html, slug, { open = false } = {}) {
  const { start, fields } = summaryFields(html, slug);
  assert.deepEqual(fields.map((f) => f.key), R.campos.map(([k]) => k), "todos os campos do art. 2º, na ordem: " + slug);
  assert.deepEqual(fields.map((f) => f.label), R.campos.map(([, l]) => l), "rótulos: " + slug);
  const v = Object.fromEntries(fields.map((f) => [f.key, f.value]));
  for (const [k, val] of Object.entries(v)) { assert.ok(val.length > 3, `${slug}: '${k}' vazio`); assert.doesNotMatch(val, PENDING, `${slug}: '${k}' pendente`); }
  const F = R.fornecedor;
  assert.ok(v.fornecedor.includes(F.razao_social) && v.fornecedor.includes(F.nome_fantasia), slug + ": identificação");
  assert.equal(v.cnpj, F.cnpj, slug + ": CNPJ");
  assert.match(F.cnpj, /^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/);
  assert.match(F.cep, /^\d{5}-\d{3}$/, "CEP preenchido");
  assert.equal(v.endereco_fisico, `${F.endereco_fisico}, CEP ${F.cep}`, slug + ": endereço físico");
  assert.ok(v.endereco_eletronico.includes(F.email), slug + ": endereço eletrônico");
  assert.equal(v.disponibilidade, open ? R.disponibilidade.open : R.disponibilidade.closed, slug + ": disponibilidade");
  assert.ok(v.arrependimento.includes(P.customer_wording.rule_7d), slug + ": arrependimento");
  return { v, start };
}

test("Decreto 7.962 art. 2º: cada oferta paga tem 'Resumo da oferta' estruturado e completo junto ao CTA", () => {
  for (const slug of PRODUCTS) {
    const html = read(slug);
    const { v, start } = checkSummary(html, slug);
    assert.ok(v.preco_total.startsWith(`R$ ${PRICES[slug]},00`), slug + ": preço total = preço da página");
    assert.ok(html.includes(`<span class="status-pill">R$ ${PRICES[slug]} · pagamento único</span>`), slug);
    assert.ok(v.entrega.includes(P.delivery_72h), slug + ": modo e prazo de entrega");
    // Posição ostensiva: dentro do mesmo <aside class="offer-side"> do CTA principal.
    const aside = html.slice(html.lastIndexOf('<aside class="offer-side"><div><span class="status-pill">', start), html.indexOf("</aside>", start));
    assert.ok(aside.includes("data-zev-sku=") && aside.includes(`data-offer-summary="${slug}"`), slug + ": junto ao CTA");
    // Modo aberto em runtime: mesma estrutura, disponibilidade aberta.
    checkSummary(openSalesHtml(html, slug), slug, { open: true });
  }
  const sub = read("conteudo-pronto");
  const { v, start } = checkSummary(sub, "conteudo-pronto");
  assert.ok(v.preco_total.startsWith("R$ 197,00 por mês"));
  assert.ok(start - sub.indexOf('data-zev-sub="conteudo-pronto"') < 2500, "assinatura: logo após o CTA principal");
  checkSummary(openSalesHtml(sub, "conteudo-pronto"), "conteudo-pronto", { open: true });
});

test("Decreto 7.962 mutantes: campo removido, CNPJ trocado, CEP pendente e disponibilidade ausente são mortos", () => {
  const html = read("ia-na-pratica");
  const muts = {
    "D1 sem CNPJ": (h) => h.replace(/<div data-field="cnpj">.*?<\/div>/, ""),
    "D2 CNPJ divergente": (h) => h.replace(`<dd>${R.fornecedor.cnpj}</dd>`, "<dd>00.000.000/0001-00</dd>"),
    "D3 CEP pendente": (h) => h.replace(`CEP ${R.fornecedor.cep}`, "CEP PENDENTE"),
    "D4 sem disponibilidade": (h) => h.replace(/<div data-field="disponibilidade">.*?<\/dd><\/div>/, ""),
    "D5 resumo fora do bloco da oferta (removido)": (h) => h.replace('data-offer-summary="ia-na-pratica"', 'data-offer-summary="outro"'),
  };
  for (const [name, fn] of Object.entries(muts)) {
    const m = fn(html);
    assert.notEqual(m, html, "mutação não aplicada: " + name);
    assert.throws(() => checkSummary(m, "ia-na-pratica"), undefined, name + " sobreviveu");
  }
});

test("gate do modo fechado (CLI): Offer paga em qualquer disponibilidade e checkout externo são rejeitados; preço 0 passa", () => {
  assert.equal(audit(PUB).status, 0, "build real fechado passa (calculadoras com Offer de preço 0)");
  const ld = (slug, offer) => (h) => h.replace('"@type": "Product",', `"@type": "Product", "offers": ${JSON.stringify(offer)},`);
  const mutants = {
    "G1 Offer PreOrder": ["ia-na-pratica", ld("ia-na-pratica", { "@type": "Offer", price: "197.00", priceCurrency: "BRL", availability: "https://schema.org/PreOrder" })],
    "G2 Offer PreSale": ["lucro-e-caixa", ld("lucro-e-caixa", { "@type": "Offer", price: "247.00", priceCurrency: "BRL", availability: "https://schema.org/PreSale" })],
    "G3 Offer paga sem availability": ["vendas-na-pratica", ld("vendas-na-pratica", { "@type": "Offer", price: "197.00", priceCurrency: "BRL" })],
    "G4 Offer LimitedAvailability": ["combo-ia-vendas", ld("combo-ia-vendas", { "@type": "Offer", price: 297, availability: "https://schema.org/LimitedAvailability" })],
    "G5 AggregateOffer lowPrice > 0": ["negocio-completo", ld("negocio-completo", { "@type": "AggregateOffer", lowPrice: "397", priceCurrency: "BRL" })],
    "G6 Offer sem preço": ["ia-na-pratica", ld("ia-na-pratica", { "@type": "Offer", priceCurrency: "BRL", availability: "https://schema.org/PreOrder" })],
    "G7 assinatura com Offer de 197 sem availability": ["conteudo-pronto", (h) => h.replace('"@type": "Service",', '"@type": "Service", "offers": {"@type": "Offer", "price": "197.00", "priceCurrency": "BRL"},')],
    "G8 calculadora vira oferta paga": ["calculadora-cmv", (h) => h.replace('"offers": {"@type": "Offer", "price": "0"', '"offers": {"@type": "Offer", "price": "19.90"')],
    "G9 link de checkout Mercado Pago externo": ["solucoes", (h) => h.replace("</main>", '<a href="https://mpago.la/2xYz">pagar</a></main>')],
    "G10 link go.hotmart.com": ["kit-afiliado", (h) => h.replace("</main>", '<a href="https://go.hotmart.com/X1">comprar</a></main>')],
    "G11 Offer em microdata": ["ferramentas", (h) => h.replace("</main>", '<div itemscope itemtype="https://schema.org/Offer"><span itemprop="price">97</span></div></main>')],
    // AVAL (Sol, 9a0f1eb): formas alternativas de @type e de marcação.
    "G12 @type em IRI completa (mutante do Sol)": ["ia-na-pratica", ld("ia-na-pratica", { "@type": "https://schema.org/Offer", price: "197.00", priceCurrency: "BRL", availability: "https://schema.org/PreOrder" })],
    "G13 @type em array": ["vendas-na-pratica", ld("vendas-na-pratica", { "@type": ["Offer", "https://schema.org/Thing"], price: "197.00", priceCurrency: "BRL" })],
    "G14 Offer solta no @graph (IRI)": ["lucro-e-caixa", (h) => h.replace('"@graph": [', '"@graph": [{"@type": "http://schema.org/Offer/", "price": "247.00", "priceCurrency": "BRL"}, ')],
    "G15 schema:Offer": ["combo-ia-vendas", ld("combo-ia-vendas", { "@type": "schema:Offer", price: "297.00" })],
    "G16 Offer em itemOffered aninhado": ["negocio-completo", (h) => h.replace('"@graph": [', '"@graph": [{"@type": "Demand", "itemOffered": {"@type": "Product", "name": "x", "offers": [{"@type": "https://schema.org/AggregateOffer", "lowPrice": "397"}]}}, ')],
    "G17 microdata com itemtype http e sem preço visível": ["solucoes", (h) => h.replace("</main>", '<div itemscope itemtype="http://schema.org/Offer"><meta itemprop="price" content="197"></div></main>')],
    "G18 microdata sem tipo em itemprop offers": ["ia-na-pratica", (h) => h.replace("</main>", '<div itemscope itemtype="https://schema.org/Product"><div itemprop="offers" itemscope><meta itemprop="price" content="197"></div></div></main>')],
    "G19 RDFa typeof=Offer com vocab": ["ferramentas", (h) => h.replace("</main>", '<div vocab="https://schema.org/" typeof="Offer"><span property="price">97</span></div></main>')],
    "G20 RDFa typeof=schema:Offer": ["kit-afiliado", (h) => h.replace("</main>", '<div prefix="schema: https://schema.org/" typeof="schema:Offer"><span property="schema:price">97</span></div></main>')],
    "G21 JSON-LD com charset no type": ["termos", (h) => h.replace("</main>", '<script type="application/ld+json; charset=utf-8">{"@context":"https://schema.org","@type":"https://schema.org/Offer","price":"9.90"}</script></main>')],
  };
  const report = [];
  for (const [name, [slug, fn]] of Object.entries(mutants)) {
    const dir = mkdtempSync(join(tmpdir(), "p13-gate-"));
    try {
      cpSync(PUB, dir, { recursive: true, filter: (s) => !/[\\/](brand|assets)([\\/]|$)/.test(s) });
      const f = join(dir, slug + ".html"), before = readTextNormalized(f), after = fn(before);
      assert.notEqual(after, before, "mutação não aplicada: " + name);
      writeFileSync(f, after);
      const r = audit(dir);
      report.push(`${name}: ${r.status === 1 ? "KILLED" : "SURVIVED"} ${(r.stdout.match(/P13_FAIL [^\n]*/) || [""])[0].slice(0, 120)}`);
      assert.equal(r.status, 1, name + " sobreviveu: " + r.stdout + r.stderr);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  console.log(report.join("\n"));
  // Preço 0 continua livre: as 7 calculadoras publicadas têm Offer de preço 0.
  assert.ok(readdirSync(PUB).filter((f) => f.startsWith("calculadora-") && readTextNormalized(join(PUB, f)).includes('"price": "0"')).length >= 7);
});

test("cache: páginas que dependem do interruptor saem com no-store nos dois modos e o fechamento vale na requisição seguinte", async () => {
  let state = "open";
  const pageEnv = {
    ASSETS: { fetch: async (req) => new Response(readFileSync(join(PUB, new URL(req.url).pathname.slice(1)), "utf8"), { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }) },
    CORE: { fetch: async (u) => String(u?.url || u).endsWith("/api/sales/status") ? new Response(JSON.stringify({ open: state === "open" }), { status: 200 }) : new Response("{}", { status: 200 }) },
  };
  const ctx = { waitUntil() {} };
  const get = (path) => worker.fetch(new Request("https://vendas.zevanory.api.br" + path, { headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36" } }), pageEnv, ctx);
  for (const path of ["/ia-na-pratica", "/negocio-completo", "/conteudo-pronto", "/solucoes", "/"]) {
    for (const s of ["open", "closed"]) {
      state = s;
      const res = await get(path);
      assert.equal(res.status, 200, path);
      const cc = String(res.headers.get("cache-control") || "");
      assert.match(cc, /\bno-store\b/, `${path} (${s}) sem no-store: ${cc}`);
      assert.doesNotMatch(cc, /\b(public|max-age=[1-9]|s-maxage|stale-while-revalidate)\b/, `${path} (${s}) armazenável: ${cc}`);
      await res.text();
    }
  }
  // Abre, depois fecha: a requisição imediatamente seguinte já vem fechada (sem cache de página).
  state = "open";
  assert.match(await (await get("/ia-na-pratica")).text(), /href="\/comprar\/ZEV-IA-011"/, "aberto mostra CTA");
  state = "closed";
  const after = await (await get("/ia-na-pratica")).text();
  assert.doesNotMatch(after, /href="\/comprar\//, "fechamento refletido na requisição seguinte");
  assert.ok(after.includes(P.waitlist_label));
  // Páginas que não dependem do interruptor mantêm o cache público curto.
  assert.match(String((await get("/calculadora-cmv")).headers.get("cache-control")), /public, max-age=300/);
});
