// ZEVANORY | NC-1006-02: preço em fonte ÚNICA. data/products.json (reservado ao proprietário) é a tabela canônica dos
// 5 kits e do Conteúdo Pronto; este módulo (também reservado) só DERIVA dela. Módulos de e-mail, motor de aquisição,
// atendimento, criativos, blog e Shorts importam daqui em vez de repetir números. O gate
// tests/governanca/price-gate.mjs (check obrigatório product-pages / static-audit) reprova qualquer literal divergente.
import PRODUCTS from "../data/products.json" with { type: "json" };

const freeze = (o) => Object.freeze({ ...o });
export const OFFICIAL_PRODUCTS = Object.freeze(PRODUCTS.products.map(freeze));
export const SUBSCRIPTION = freeze(PRODUCTS.subscription);
export const GUARANTEE_DAYS = PRODUCTS.guaranteeDays;

const BY_SLUG = Object.freeze(Object.fromEntries([...OFFICIAL_PRODUCTS, SUBSCRIPTION].map((p) => [p.slug, p])));
const BY_SKU = Object.freeze(Object.fromEntries(OFFICIAL_PRODUCTS.map((p) => [p.sku, p])));

export function productBySlug(slug) {
  const p = BY_SLUG[slug];
  if (!p || !Number.isInteger(p.price)) throw new Error("product_price_unknown:" + slug);
  return p;
}
export function productBySku(sku) {
  const p = BY_SKU[sku];
  if (!p || !Number.isInteger(p.price)) throw new Error("product_price_unknown:" + sku);
  return p;
}
export const priceBySlug = (slug) => productBySlug(slug).price;
export const priceBySku = (sku) => productBySku(sku).price;
// { "ZEV-IA-011": 97, ... } — mapa SKU -> preço da tabela (só os 5 kits)
export const PRICE_BY_SKU = Object.freeze(Object.fromEntries(OFFICIAL_PRODUCTS.map((p) => [p.sku, p.price])));

// Composição dos pacotes; "separado" e "economia" são derivados da tabela, nunca literais.
export const BUNDLES = Object.freeze({
  "combo-ia-vendas": Object.freeze(["ia-na-pratica", "vendas-na-pratica"]),
  "negocio-completo": Object.freeze(["ia-na-pratica", "vendas-na-pratica", "lucro-e-caixa"]),
});
export const bundleSeparateTotal = (slug) => (BUNDLES[slug] || []).reduce((a, s) => a + priceBySlug(s), 0);
export const bundleSavings = (slug) => bundleSeparateTotal(slug) - priceBySlug(slug);
