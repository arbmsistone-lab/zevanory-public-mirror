// Preço de catálogo para fixtures de teste: data/products.json é a única fonte (scripts/sync_canonical_prices.py).
// Um teste que monta pedido/pagamento "do IA na Prática" usa este valor, para uma mudança de preço não derrubar o teste.
import { readFileSync } from "node:fs";
const official = JSON.parse(readFileSync(new URL("../../data/products.json", import.meta.url), "utf8"));
export const PRICE_BY_SKU = Object.freeze(Object.fromEntries(official.products.map((p) => [p.sku, p.price])));
export const IA_PRICE = PRICE_BY_SKU["ZEV-IA-011"];
export const IA_PRICE_STR = IA_PRICE.toFixed(2);
