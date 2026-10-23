// Multimodal coherence: the same product must carry the same name, code, price and guarantee
// on the site, in e-mails, videos, posts and the support agent. One official source.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { FUNNEL_PRODUCTS } from "../worker/funnel.mjs";
import { HOTMART_CHECKOUT, openSalesHtml } from "../worker/sales-public-worker.mjs";

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
  const worker = read("worker/sales-public-worker.mjs");
  const engine = read("worker/acquisition-engine.mjs");
  const support = read("worker/support-knowledge.mjs");
  const mail = read("worker/lead-magnet.mjs");
  for (const p of official.products) {
    assert.match(worker, new RegExp(`"${p.sku}":\\["${p.name.replace(/[+&]/g, (c) => "\\" + c)}",${p.price}\\]`), "sales worker " + p.slug);
    assert.match(engine, new RegExp(`sku:"${p.sku}",name:"${p.name.replace(/[+&]/g, (c) => "\\" + c)}",price:${p.price}`), "engine " + p.slug);
    assert.match(support, new RegExp(`"${p.slug}": \\{ name: "${p.name.replace(/[+&]/g, (c) => "\\" + c)}[^"]*", price_brl: ${p.price}`), "support " + p.slug);
  }
  for (const [name, price] of [...mail.matchAll(/name: "([^"]+)", price: (\d+)/g)].map((m) => [m[1], Number(m[2])])) {
    const p = official.products.find((x) => x.name === name);
    assert.ok(p, "e-mail product " + name); assert.equal(price, p.price, "e-mail price " + name);
  }
  for (const m of mail.matchAll(/R\$ (\d+)/g)) assert.ok([...official.products.map((p) => p.price), 641].includes(Number(m[1])), "e-mail mentions R$ " + m[1]);
});

test("published product pages show the official price everywhere (buttons, schema, buy bar)", () => {
  for (const p of official.products) {
    const file = new URL(`../sales-public/${p.slug}.html`, import.meta.url);
    if (!existsSync(file)) continue;
    const html = readFileSync(file, "utf8");
    const prices = [...html.matchAll(/R\$ ?(\d{3})(?![\d.,]*\s*(?:separad|em rela))/g)].map((m) => Number(m[1]));
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
