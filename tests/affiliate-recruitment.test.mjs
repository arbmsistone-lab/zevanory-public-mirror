// ZEVANORY | #1014 (decisão Claude + GPT-6, 10/11, delegada pelo proprietário): botão "Pedir afiliação" por kit.
// Fonte única: data/affiliates.json -> hotmart_kits.<slug>.recruitment_url (link oficial de Recrutamento de Afiliados
// da Hotmart). Cada página do kit aponta cada kit para o SEU link; nenhum link de recrutamento é de checkout.
import test from "node:test";
import assert from "node:assert/strict";
import { readTextNormalized } from "./helpers/text.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readTextNormalized(join(ROOT, p));
const AF = JSON.parse(read("data/affiliates.json"));
const PRODUCTS = JSON.parse(read("data/products.json")).products;
const PAGES = ["kit-afiliado/index.html", "sales-public/kit-afiliado.html"];
const RECRUIT = /^https:\/\/affiliate\.hotmart\.com\/affiliate-recruiting\/view\/[0-9A-Z]+$/;
// IDs dos kits na Hotmart (os mesmos do webhook e do abandono: tests/abandono-hotmart.test.mjs)
const IDS = { "ia-na-pratica": 8704733, "vendas-na-pratica": 8704826, "lucro-e-caixa": 8704851, "combo-ia-vendas": 8704861, "negocio-completo": 8704871 };

test("R01 fonte única: um link oficial de recrutamento por kit, nunca checkout", () => {
  const kits = AF.hotmart_kits;
  assert.deepEqual(Object.keys(kits).sort(), PRODUCTS.map((p) => p.slug).sort(), "um registro por kit do catálogo");
  const urls = new Set();
  for (const [slug, k] of Object.entries(kits)) {
    assert.equal(k.hotmart_product_id, IDS[slug], "ID Hotmart de " + slug);
    assert.match(k.recruitment_url, RECRUIT, "formato do link de recrutamento de " + slug);
    assert.doesNotMatch(k.recruitment_url, /pay\.hotmart|go\.hotmart|checkout|[?&]off=/i, "link de checkout em " + slug);
    urls.add(k.recruitment_url);
  }
  assert.equal(urls.size, 5, "links repetidos entre kits");
});

// Problemas de uma página do kit (lista vazia = ok). Usado no positivo (páginas reais) e nos negativos (mutantes).
function problemas(page, html) {
  const out = [];
  const sec = html.match(/<section class="container section" id="kits">([\s\S]*?)<\/section>/);
  if (!sec) return ["seção #kits ausente"];
  const pares = [...sec[1].matchAll(/<li>([\s\S]*?)<\/li>/g)].map(([, li]) => [
    (li.match(/<a href="[^"]*\/([a-z-]+)">Ver página<\/a>/) || [])[1],
    (li.match(/<a class="kit-recruit" href="([^"]+)"[^>]*>Pedir afiliação<\/a>/) || [])[1]]);
  if (pares.map(([s]) => s).join() !== Object.keys(AF.hotmart_kits).join()) out.push("ordem/slugs da lista");
  for (const [slug, href] of pares) if (!AF.hotmart_kits[slug] || href !== AF.hotmart_kits[slug].recruitment_url) out.push("link errado: " + slug);
  const todos = [...html.matchAll(/href="([^"]*affiliate-recruiting[^"]*)"/g)].map((m) => m[1]);
  if (todos.length !== 5) out.push("links de recrutamento != 5");
  for (const u of todos) if (!Object.values(AF.hotmart_kits).some((k) => k.recruitment_url === u)) out.push("link fora da fonte");
  if (/href="https:\/\/(?:pay|go)\.hotmart\.com/.test(html)) out.push("checkout na página");
  if (/app\.hotmart\.com\/market/.test(html)) out.push("Mercado de Afiliados");
  if (!/<a class="nav-cta" href="#kits">Pedir afiliação<\/a>/.test(html)) out.push("cabeçalho não leva a #kits");
  if (/href="mailto:[^"]*Afilia/i.test(html)) out.push("mailto de afiliação");
  if (!/Por enquanto, os produtos ficam fora do Mercado de Afiliados da Hotmart\./.test(html)) out.push("texto fora do Mercado");
  if (/20 vendas/.test(html)) out.push("meta de 20 vendas");
  if (!/suporte@zevanory\.api\.br/.test(html)) out.push("e-mail alternativo ausente");
  return out.map((x) => page + ": " + x);
}

test("R02 cada página do kit aponta cada kit para o SEU link; cabeçalho leva à seção dos kits; sem mailto de afiliação", () => {
  for (const page of PAGES) assert.deepEqual(problemas(page, read(page)), []);
  // NC-A (auditoria independente de 0b3baac): vigência dos 30% na Hotmart, sem citar a taxa antiga
  const VIG = "A comissão de 30% vale para vendas a partir de 13/11/2026; até essa data, a Hotmart ainda aplica a taxa anterior.";
  for (const page of [...PAGES, "afiliados/index.html", "sales-public/afiliados.html"]) {
    const html = read(page);
    assert.equal(html.split(VIG).length - 1, 1, page + ": frase de vigência");
    assert.doesNotMatch(html, /\b50\s*%|cinquenta por cento|\bmetade\b/i, page + ": taxa antiga citada");
  }
});

test("R03 NEGATIVO: troca entre kits, checkout, Mercado, mailto, cabeçalho e texto são detectados", () => {
  const page = PAGES[1], html = read(page);
  const ia = AF.hotmart_kits["ia-na-pratica"].recruitment_url, ven = AF.hotmart_kits["vendas-na-pratica"].recruitment_url;
  const mutantes = {
    "troca IA <-> Vendas": html.replace(`href="${ia}"`, 'href="__X__"').replace(`href="${ven}"`, `href="${ia}"`).replace('href="__X__"', `href="${ven}"`),
    "checkout no lugar do recrutamento": html.replace(`href="${ia}"`, 'href="https://pay.hotmart.com/F107979716H?off=g9knd34r"'),
    "link de recrutamento desconhecido": html.replace(ia, ia.replace(/.$/, "9")),
    "botão de um kit removido": html.replace(new RegExp(` · <a class="kit-recruit" href="${ia.replace(/[.?/]/g, "\\$&")}"[^>]*>Pedir afiliação</a>`), ""),
    "Mercado de Afiliados de volta": html.replace('href="#kits">Pedir afiliação', 'href="https://app.hotmart.com/market">Pedir afiliação'),
    "mailto de afiliação de volta": html.replace('<a class="button primary" href="#kits">', '<a class="button primary" href="mailto:suporte@zevanory.api.br?subject=Afilia%C3%A7%C3%A3o">'),
    "meta de 20 vendas citada": html.replace("Por enquanto, os produtos ficam fora do Mercado de Afiliados da Hotmart.", "Por enquanto, os produtos ficam fora do Mercado de Afiliados da Hotmart, até 20 vendas."),
  };
  for (const [nome, h] of Object.entries(mutantes)) {
    assert.notEqual(h, html, "mutante sem efeito: " + nome);
    assert.notDeepEqual(problemas(page, h), [], "mutante sobreviveu: " + nome);
  }
});

test("R04 P18 (NC-D): só /affiliate-recruiting/view/<id> em affiliate.hotmart.com é isento; outro caminho ou subdomínio é link de compra", async () => {
  const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { pathToFileURL } = await import("node:url");
  const ALLOW = JSON.parse(read("data/p18-commercial-allowlist.json"));
  assert.ok(!ALLOW.informational_hosts.some((h) => /affiliate\.hotmart\.com$/.test(h)), "affiliate.hotmart.com não pode ser isento por host inteiro");
  assert.deepEqual(ALLOW.informational_paths.map((x) => [x.host, x.path_prefix]), [["affiliate.hotmart.com", "/affiliate-recruiting/view/"]]);
  const ok = Object.values(AF.hotmart_kits).map((k) => k.recruitment_url);
  const id = ok[0].split("/").pop();
  const ruins = [
    "https://affiliate.hotmart.com/checkout/" + id,
    "https://affiliate.hotmart.com/affiliate-recruiting/" + id,
    "https://affiliate.hotmart.com/affiliate-recruiting/view/",
    "https://affiliate.hotmart.com/affiliate-recruiting/view/" + id + "/pay",
    "https://affiliate.hotmart.com/affiliate-recruiting/view/" + id + "?off=abc",
    "https://affiliate.hotmart.com/affiliate-recruiting/view/../../pay/" + id,
    "https://x.affiliate.hotmart.com/affiliate-recruiting/view/" + id,
    "https://affiliate.hotmart.com.evil.example/affiliate-recruiting/view/" + id,
    "https://affiliate.hotmart.com:8443/affiliate-recruiting/view/" + id,
    "http://affiliate.hotmart.com/affiliate-recruiting/view/" + id,
    "https://pay.hotmart.com/affiliate-recruiting/view/" + id,
  ];
  const page = (hrefs) => hrefs.map((h) => `<a href="${h}">x</a>`).join("");
  const comprasDe = (mod, h) => mod.extractPurchaseLinks(page([h]), ALLOW, { source: "t", slug: "kit-afiliado" });
  const avalia = (mod) => ({
    oks: ok.every((h) => comprasDe(mod, h).length === 0),
    // domínio fora de payment_host_suffixes (.evil.example) não é link de compra para o P18; os demais têm de ser
    ruins: ruins.filter((h) => !h.includes(".evil.example")).every((h) => comprasDe(mod, h).length > 0) && !mod.isInformationalPath(ruins[7], ALLOW),
  });
  const real = await import(pathToFileURL(join(ROOT, "scripts/b0/p18-commercial.mjs")).href);
  assert.deepEqual(avalia(real), { oks: true, ruins: true });
  for (const h of ok) assert.equal(real.isInformationalPath(h, ALLOW), true, h);
  // mutantes do código da isenção: cada um tem de mudar o veredito
  const src = read("scripts/b0/p18-commercial.mjs");
  const mutantes = {
    "isenção pelo host inteiro": ["host === x.host && u.pathname.startsWith(x.path_prefix)\n    && /^[A-Za-z0-9]+$/.test(u.pathname.slice(x.path_prefix.length))", "host === x.host"],
    "subdomínio aceito": ["host === x.host && u.pathname", "(host === x.host || host.endsWith(\".\" + x.host)) && u.pathname"],
    "qualquer sufixo após o prefixo": ["/^[A-Za-z0-9]+$/.test(u.pathname.slice(x.path_prefix.length))", "true"],
    "query/porta/http aceitos": ['if (u.protocol !== "https:" || u.port || u.username || u.password || u.search || u.hash) return false;', ""],
    "isenção desligada": ["|| isInformationalPath(h, allow)) continue;", ") continue;"],
  };
  const dir = mkdtempSync(join(tmpdir(), "p18-ncd-"));
  try {
    for (const [nome, [de, para]] of Object.entries(mutantes)) {
      assert.ok(src.includes(de), "âncora ausente: " + nome);
      const f = join(dir, nome.replace(/\W+/g, "_") + ".mjs");
      writeFileSync(f, src.replace(de, para));
      const mod = await import(pathToFileURL(f).href);
      assert.notDeepEqual(avalia(mod), { oks: true, ruins: true }, "mutante sobreviveu: " + nome);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
