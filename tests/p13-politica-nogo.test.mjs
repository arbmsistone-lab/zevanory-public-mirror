// P13 (Ordem 079-P13 / 076-P24): NO-GO na superfície pública + política única de compra.
// (a) modo fechado: zero href /comprar/ e zero schema.org/InStock no HTML estático publicado;
// (b) termos, reembolso e as cinco páginas de produto têm a MESMA regra de 7 dias e a divulgação
//     72 h / um download (texto único do Sol, exato, em termos e reembolso);
// (c) modo aberto (build de preview e restauração em tempo de execução pelo interruptor do
//     proprietário) devolve os CTAs originais e a Offer.
// Mutantes: página com /comprar/, página com InStock, texto "após o pagamento" — todos mortos.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, cpSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import worker, { openSalesHtml, resetPageSwitchCache } from "../worker/sales-public-worker.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const PUB = join(ROOT, "sales-public");
const P = JSON.parse(readFileSync(join(ROOT, "data/politica-unica.json"), "utf8"));
const PRODUCTS = P.policy_surfaces.products;
const LEGAL = P.policy_surfaces.legal;
const SKUS = { "ia-na-pratica": "ZEV-IA-011", "vendas-na-pratica": "ZEV-VEN-011", "lucro-e-caixa": "ZEV-LCX-011", "combo-ia-vendas": "ZEV-CMB-011", "negocio-completo": "ZEV-NGC-011" };
const CHECKOUT_HREF = /href\s*=\s*["']?[^"'\s>]*\/comprar\//i;
const read = (dir, slug) => readFileSync(join(dir, slug + ".html"), "utf8");
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
const audit = (dir, mode = "closed") => spawnSync("python3", [join(ROOT, "scripts/sales_policy.py"), "--audit", dir, "--mode", mode], { encoding: "utf8", env });
const ld = (html) => JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
const productOffer = (html) => (ld(html)["@graph"] || []).find((n) => n["@type"] === "Product")?.offers;
const buyAnchors = (html) => [...html.matchAll(/<a [^>]*href="\/comprar\/[^"]*"[^>]*>[^<]*<\/a>/g)].map((m) => m[0]);

test("(a) modo fechado: nenhum HTML publicado tem href /comprar/ nem schema.org/InStock", () => {
  const files = readdirSync(PUB).filter((f) => f.endsWith(".html"));
  assert.ok(files.length > 60, "superfície completa");
  for (const f of files) {
    const html = readFileSync(join(PUB, f), "utf8");
    assert.doesNotMatch(html, CHECKOUT_HREF, f);
    assert.doesNotMatch(html, /schema\.org\/InStock/i, f);
  }
  for (const slug of PRODUCTS) {
    const html = read(PUB, slug);
    assert.equal(productOffer(html), undefined, "sem Offer enquanto fechado: " + slug);
    assert.ok(html.includes(P.waitlist_label), "CTA lista de espera: " + slug);
    assert.ok(html.includes(P.closed_label), "rótulo vendas fechadas: " + slug);
    assert.match(html, /Preço de tabela: R\$ \d+/, "preço mantido como informação: " + slug);
  }
  assert.equal(audit(PUB).status, 0, "auditoria CLI do modo fechado");
});

test("(b) mesma regra de 7 dias e mesma divulgação 72 h / um download em todas as superfícies", () => {
  for (const slug of [...LEGAL, ...PRODUCTS]) {
    const html = read(PUB, slug);
    assert.ok(html.includes(P.rule_7d), "regra 7 dias: " + slug);
    assert.ok(html.includes(P.delivery_72h), "72 h / um download: " + slug);
    for (const bad of P.banned_policy_phrases) assert.ok(!html.includes(bad), `${slug}: '${bad}'`);
  }
  for (const slug of LEGAL) assert.ok(read(PUB, slug).includes(P.sol_text), "texto único exato: " + slug);
  assert.ok(read(PUB, "termos").includes(`id="${P.policy_anchor}"`), "âncora citada pelas páginas de produto");
  // A divulgação fica AO LADO da oferta: dentro do mesmo <aside> do CTA.
  for (const slug of PRODUCTS) {
    const aside = read(PUB, slug).match(/<aside class="offer-side"><div><span class="status-pill">[\s\S]*?<\/aside>/)[0];
    assert.ok(aside.includes(P.delivery_72h) && aside.includes(P.rule_7d), "resumo junto ao CTA: " + slug);
    assert.ok(aside.includes(`data-zev-sku="${SKUS[slug]}"`), "CTA no mesmo bloco: " + slug);
    assert.ok(aside.includes(`/termos#${P.policy_anchor}`), "link para o texto completo: " + slug);
  }
});

test("(c) modo aberto: build de preview e restauração em tempo de execução devolvem CTAs e Offer", () => {
  const out = mkdtempSync(join(tmpdir(), "p13-open-"));
  try {
    const r = spawnSync("python3", [join(ROOT, "scripts/build_sales_public.py")], { encoding: "utf8", env: { ...env, ZEVANORY_SALES_PUBLIC_MODE: "open", ZEVANORY_SALES_PUBLIC_OUT: out } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /ZEVANORY_SALES_MODE=open/);
    assert.equal(audit(out, "open").status, 0, "política única também no modo aberto");
    for (const slug of PRODUCTS) {
      const opened = read(out, slug), closed = read(PUB, slug);
      const anchors = buyAnchors(opened);
      assert.ok(anchors.length >= 3, "CTAs de compra restaurados: " + slug);
      assert.equal(anchors.length, (closed.match(/data-zev-sku=/g) || []).length, "um CTA aberto por CTA de espera: " + slug);
      assert.ok(anchors.every((a) => a.includes(`/comprar/${SKUS[slug]}`)), slug);
      assert.equal(productOffer(opened).availability, "https://schema.org/InStock", slug);
      assert.ok(!opened.includes("data-zev-") && !opened.includes(P.closed_label), "sem marcadores do modo fechado: " + slug);
      // Restauração em runtime (interruptor aberto) == build aberto.
      const runtime = openSalesHtml(closed, slug);
      assert.deepEqual(buyAnchors(runtime), anchors, "CTAs runtime == build aberto: " + slug);
      assert.deepEqual(productOffer(runtime), productOffer(opened), "Offer runtime == build aberto: " + slug);
      assert.ok(!runtime.includes("data-zev-") && !runtime.includes(P.closed_label), "runtime sem marcadores: " + slug);
    }
    const bad = spawnSync("python3", [join(ROOT, "scripts/build_sales_public.py")], { encoding: "utf8", env: { ...env, ZEVANORY_SALES_PUBLIC_MODE: "aberto", ZEVANORY_SALES_PUBLIC_OUT: out } });
    assert.notEqual(bad.status, 0, "modo desconhecido nunca abre");
  } finally { rmSync(out, { recursive: true, force: true }); }
});

function pageEnv(status) {
  return {
    ASSETS: { fetch: async (req) => new Response(readFileSync(join(PUB, new URL(req.url).pathname.slice(1)), "utf8"), { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }) },
    CORE: { fetch: async (u) => {
      const url = String(u?.url || u);
      if (url.endsWith("/api/sales/status")) { if (status === "throw") throw new Error("down"); return new Response(JSON.stringify({ open: status === "open" }), { status: status === 500 ? 500 : 200 }); }
      return new Response("{}", { status: 200 });
    } },
  };
}
const ctx = { waitUntil() {} };
const get = (path) => new Request("https://vendas.zevanory.api.br" + path, { headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36" } });

test("(c) Worker: CTAs só voltam com o interruptor do proprietário aberto (mesma /api/sales/status, fail-closed)", async () => {
  for (const [status, open] of [["open", true], ["closed", false], [500, false], ["throw", false]]) {
    for (const slug of ["ia-na-pratica", "negocio-completo"]) {
      resetPageSwitchCache();
      const body = await (await worker.fetch(get("/" + slug), pageEnv(status), ctx)).text();
      assert.equal(CHECKOUT_HREF.test(body), open, `${slug} status=${status}`);
      assert.equal(/schema\.org\/InStock/.test(body), open, `${slug} InStock status=${status}`);
      assert.equal(body.includes(P.waitlist_label), !open, `${slug} lista de espera status=${status}`);
      assert.ok(body.includes(P.delivery_72h), "72 h sempre ao lado da oferta");
    }
    resetPageSwitchCache();
    const cat = await (await worker.fetch(get("/solucoes"), pageEnv(status), ctx)).text();
    assert.equal(cat.includes(P.closed_label), !open, "catálogo status=" + status);
  }
});

test("release: build fixado em modo fechado e grep-gate de /comprar/ no workflow de publicação", () => {
  const wf = readFileSync(join(ROOT, ".github/workflows/zevanory-sales-public-release.yml"), "utf8");
  assert.match(wf, /ZEVANORY_SALES_PUBLIC_MODE: closed/);
  assert.ok((wf.match(/P13_NOGO_GREP_GATE=PASS/g) || []).length >= 2, "gate no verify e no deploy");
});

test("mutantes: /comprar/ remanescente, InStock remanescente e 'após o pagamento' são mortos", () => {
  const mutants = {
    "M1 produto mantém href /comprar/": (d) => mutate(d, "ia-na-pratica", (h) => h.replace(/href="https:\/\/wa\.me\/[^"]*" data-zev-sku="ZEV-IA-011"/, 'href="/comprar/ZEV-IA-011" data-zev-sku="ZEV-IA-011"')),
    "M1b href absoluto para /comprar/": (d) => mutate(d, "solucoes", (h) => h.replace("</main>", '<a href="https://vendas.zevanory.api.br/comprar/ZEV-NGC-011">x</a></main>')),
    "M2 produto mantém Offer InStock": (d) => mutate(d, "lucro-e-caixa", (h) => h.replace('"@type": "Product",', '"@type": "Product", "offers": {"@type": "Offer", "availability": "https://schema.org/InStock"},')),
    "M3 termos mantém 'após o pagamento'": (d) => mutate(d, "termos", (h) => h.replace("</main>", "<p>Você pode desistir da compra em até 7 dias após o pagamento.</p></main>")),
    "M3b produto troca a regra por 'após a compra'": (d) => mutate(d, "vendas-na-pratica", (h) => h.split(P.rule_7d).join("até 7 dias após a compra")),
    "M4 reembolso mantém 'em até 2 dias úteis'": (d) => mutate(d, "reembolso", (h) => h.replace("</main>", "<p>Reembolso em até 2 dias úteis.</p></main>")),
    "M5 produto sem 72 h ao lado da oferta": (d) => mutate(d, "combo-ia-vendas", (h) => h.split(P.delivery_72h).join("link pessoal")),
    "M6 texto único alterado em termos": (d) => mutate(d, "termos", (h) => h.replace(P.sol_text, P.sol_text.replace("receberá imediatamente a confirmação", "receberá a confirmação em 48 horas"))),
  };
  const report = [];
  for (const [name, apply] of Object.entries(mutants)) {
    const dir = mkdtempSync(join(tmpdir(), "p13-mut-"));
    try {
      cpSync(PUB, dir, { recursive: true, filter: (s) => !s.includes("/brand") && !s.includes("/assets") });
      apply(dir);
      const r = audit(dir);
      report.push(`${name}: ${r.status === 1 ? "KILLED" : "SURVIVED"} ${(r.stdout.match(/P13_FAIL [^\n]*/) || [""])[0]}`);
      assert.equal(r.status, 1, name + " sobreviveu: " + r.stdout);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  console.log(report.join("\n"));
});

function mutate(dir, slug, fn) {
  const f = join(dir, slug + ".html");
  const before = readFileSync(f, "utf8");
  const after = fn(before);
  assert.notEqual(after, before, "mutação não aplicada em " + slug);
  writeFileSync(f, after);
}
