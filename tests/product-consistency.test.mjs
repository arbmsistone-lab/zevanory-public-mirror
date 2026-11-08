// Multimodal coherence: the same product must carry the same name, code, price and guarantee
// on the site, in e-mails, videos, posts and the support agent. One official source.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { FUNNEL_PRODUCTS } from "../worker/funnel.mjs";
import { HOTMART_CHECKOUT, openSalesHtml } from "../worker/sales-public-worker.mjs";
import { SUPPORT_PRODUCTS } from "../worker/support-knowledge.mjs";
import { calendarEntry } from "../worker/acquisition-engine.mjs";
import { nurtureEmail } from "../worker/lead-magnet.mjs";

const official = JSON.parse(readFileSync(new URL("../data/products.json", import.meta.url)));
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

test("funnel, Hotmart and buy routes know every official product", () => {
  for (const p of official.products) {
    assert.equal(FUNNEL_PRODUCTS[p.slug]?.sku, p.sku, p.slug);
    assert.equal(FUNNEL_PRODUCTS[p.slug]?.name, p.name, p.slug);
    assert.match(String(HOTMART_CHECKOUT[p.slug] || ""), /^https:\/\/pay\.hotmart\.com\//, p.slug);
  }
});

test("site checkout prices, acquisition engine, support agent and e-mails agree with the official price", () => {
  // NC-1006-02: motor, atendimento e e-mails DERIVAM o preço de data/products.json (worker/product-prices.mjs);
  // aqui confere o valor efetivo (runtime), e o gate tests/governanca/price-gate.mjs reprova literal divergente.
  const worker = read("worker/sales-public-worker.mjs");
  for (const p of official.products) {
    assert.match(worker, new RegExp(`"${p.sku}":\\["${p.name.replace(/[+&]/g, (c) => "\\" + c)}",${p.price}\\]`), "sales worker " + p.slug);
    assert.equal(SUPPORT_PRODUCTS[p.slug]?.price_brl, p.price, "support " + p.slug);
  }
  assert.equal(SUPPORT_PRODUCTS[official.subscription.slug]?.price_brl, official.subscription.price, "support assinatura");
  const seen = new Map();
  for (let i = 0; i < 5; i++) { const e = calendarEntry(new Date(Date.UTC(2026, 10, 1 + i)).toISOString().slice(0, 10)); seen.set(e.product.sku, e.product); }
  for (const p of official.products) {
    assert.equal(seen.get(p.sku)?.name, p.name, "engine " + p.slug); assert.equal(seen.get(p.sku)?.price, p.price, "engine " + p.slug);
  }
  const byName = Object.fromEntries(official.products.map((p) => [p.name, p.price]));
  const ia = byName["IA na Prática"], ven = byName["Vendas na Prática"], lcx = byName["Lucro & Caixa"];
  const allowed = [...official.products.map((p) => p.price), ia + ven + lcx];
  for (const [interest, name] of [["ia", "IA na Prática"], ["vendas", "Vendas na Prática"], ["caixa", "Lucro & Caixa"]]) {
    assert.ok(nurtureEmail(2, { interest, salesOpen: true, optOutUrl: "x" }).text.includes(`${name} (R$ ${byName[name]},`), "e-mail " + name);
    for (let step = 0; step < 5; step++) {
      const m = nurtureEmail(step, { interest, salesOpen: true, optOutUrl: "x" });
      for (const r of (m.subject + " " + m.text).matchAll(/R\$ (\d+)/g)) assert.ok(allowed.includes(Number(r[1])), "e-mail mentions R$ " + r[1]);
    }
  }
  const last = nurtureEmail(4, { interest: "ia", salesOpen: true, optOutUrl: "x" }).text;
  assert.ok(last.includes(`por R$ ${byName["Negócio Completo"]} (separados custariam R$ ${ia + ven + lcx})`), "e-mail Negócio Completo");
});

test("published product pages show the official price everywhere (buttons, schema, buy bar)", () => {
  for (const p of official.products) {
    const file = new URL(`../sales-public/${p.slug}.html`, import.meta.url);
    if (!existsSync(file)) continue;
    const html = readFileSync(file, "utf8");
    const prices = [...html.matchAll(/R\$ ?(\d{2,3})(?![\d.,]*\s*(?:separad|em rela))/g)].map((m) => Number(m[1]));
    assert.ok(prices.includes(p.price), p.slug);
    // P13: the published static page is the closed (NO-GO) build; the price stays as information
    // and the buy link/Offer only come back through the owner switch (openSalesHtml at runtime).
    assert.match(html, new RegExp(`data-zev-sku="${p.sku}"`), "waiting-list CTA " + p.slug);
    assert.doesNotMatch(html, /"offers"/, "no Offer while closed " + p.slug);
    const open = openSalesHtml(html, p.slug);
    assert.match(open, new RegExp(`"price":"${p.price}\\.00"`), "schema when open " + p.slug);
    assert.match(open, new RegExp(`/comprar/${p.sku}`), "buy link when open " + p.slug);
    assert.match(html, /7 dias/, "guarantee " + p.slug);
  }
});
