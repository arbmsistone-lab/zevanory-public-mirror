// Trava de vendas no CONTEÚDO publicado (Telegram/Bluesky do motor de aquisição, Shorts, adaptadores orgânicos).
// Enquanto a trava canônica (KV sales:open:v1 lida por worker/sales-control.mjs readSalesSwitch) não estiver
// aberta, nenhum texto publicado pode ter preço, link de checkout/assinatura ou chamada de compra.
// Reaproveita hasCheckoutCta (caminhos/hosts de checkout de data/politica-unica.json) e acrescenta /comprar sem
// barra final, preço em reais e as chamadas de compra explícitas.
import { hasCheckoutCta } from "./politica-unica.mjs";
import { readSalesSwitch, readHotmartSwitch } from "./sales-control.mjs";

const PRICE_RE = /R\$\s*\d/i;
const COMPRAR_RE = /\/comprar(?![\p{L}\p{N}-])/u;
// Fronteiras Unicode: \b do JS não trata "á"/"ã" como letra.
const PURCHASE_CTA_RE = /(?<![\p{L}\p{N}])(?:(?:compre|comprar|compra)\s+(?:já|ja|agora|aqui|hoje)|garanta\s+(?:já|ja|o\s+seu|a\s+sua|seu|sua)|finalize\s+(?:a\s+|sua\s+)?compra|botão\s+de\s+compra|botao\s+de\s+compra)(?![\p{L}\p{N}])/iu;

export function salesLockViolations(text) {
  const s = String(text ?? "");
  const out = [];
  if (PRICE_RE.test(s)) out.push("price");
  if (hasCheckoutCta(s) || COMPRAR_RE.test(s)) out.push("checkout_link");
  if (PURCHASE_CTA_RE.test(s)) out.push("purchase_cta");
  return out;
}

// Campos de texto que um evento publish_content leva à rede (adaptadores de saída).
const PAYLOAD_TEXT_FIELDS = Object.freeze(["content", "title", "description", "caption", "text", "message", "hook", "body", "cta", "link", "url", "media_url"]);
export function payloadSalesLockViolations(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const out = new Set(salesLockViolations(PAYLOAD_TEXT_FIELDS.map((k) => (p[k] == null ? "" : String(p[k]))).join("\n")));
  if (p.price_brl != null && p.price_brl !== "") out.add("price");
  return [...out];
}

// Fail-closed: exceção, KV ausente ou registro incompleto => fechado.
export async function contentSalesOpen(env) {
  try { return (await readSalesSwitch(env))?.enabled === true; } catch { return false; }
}

// Modo Hotmart (roteiro v5.0, Nível 1, reabertura de 08/11): o canal próprio sales:hotmart:v1 (readHotmartSwitch)
// abre SÓ os 5 kits, comprados pela Hotmart. O interruptor completo sales:open:v1 continua fechado: checkout próprio,
// recuperação de carrinho e a assinatura Conteúdo Pronto seguem fechados. Tabela única dos kits (SKU, página e preço
// iguais aos do site de vendas, worker/sales-public-worker.mjs PRICES/BUY_SKUS).
export const HOTMART_KITS = Object.freeze({
  "ZEV-IA-011": Object.freeze({ slug: "ia-na-pratica", name: "IA na Prática", price: 97 }),
  "ZEV-VEN-011": Object.freeze({ slug: "vendas-na-pratica", name: "Vendas na Prática", price: 97 }),
  "ZEV-LCX-011": Object.freeze({ slug: "lucro-e-caixa", name: "Lucro & Caixa", price: 147 }),
  "ZEV-CMB-011": Object.freeze({ slug: "combo-ia-vendas", name: "Combo IA + Vendas", price: 157 }),
  "ZEV-NGC-011": Object.freeze({ slug: "negocio-completo", name: "Negócio Completo", price: 247 }),
});
export const HOTMART_KIT_SLUGS = Object.freeze(Object.values(HOTMART_KITS).map((k) => k.slug));
// SKU ou slug de um dos 5 kits -> {sku, slug, name, price}; qualquer outra coisa (Conteúdo Pronto incluído) -> null.
export function hotmartKit(skuOrSlug) {
  const key = String(skuOrSlug ?? "");
  if (Object.prototype.hasOwnProperty.call(HOTMART_KITS, key)) return { sku: key, ...HOTMART_KITS[key] };
  const sku = Object.keys(HOTMART_KITS).find((k) => HOTMART_KITS[k].slug === key);
  return sku ? { sku, ...HOTMART_KITS[sku] } : null;
}
// Caminho de compra pela Hotmart no site de vendas (o site redireciona ao checkout da Hotmart com o src da origem).
export const hotmartPurchasePath = (skuOrSlug) => { const k = hotmartKit(skuOrSlug); return k ? "/hotmart/" + k.slug : null; };
// Fail-closed: exceção, KV ausente, canal diferente ou registro incompleto => fechado.
export async function hotmartKitsOpen(env) {
  try { return (await readHotmartSwitch(env))?.open === true; } catch { return false; }
}
// Compra aberta para um produto: interruptor completo aberto OU (modo Hotmart aberto E o produto é um dos 5 kits).
export async function purchaseOpenFor(env, skuOrSlug) {
  if (await contentSalesOpen(env)) return true;
  if (!hotmartKit(skuOrSlug)) return false;
  return hotmartKitsOpen(env);
}
// Leitura única por execução para os publicadores: {full, hotmart}. hotmart só vale com o completo fechado.
export async function readPurchaseMode(env) {
  const full = await contentSalesOpen(env);
  return { full, hotmart: !full && (await hotmartKitsOpen(env)) };
}

// Filtro de conteúdo no modo Hotmart: o texto de UM kit pode levar o seu preço exato ("R$ <preço>", com ou sem ",00")
// e o seu caminho de compra https://vendas.zevanory.api.br/hotmart/<slug> (com ou sem query). Tudo o mais continua
// barrado como com vendas fechadas: outro preço, /comprar, /assinar, pay.hotmart, outro kit, chamada de compra.
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function hotmartLockViolations(text, skuOrSlug) {
  const kit = hotmartKit(skuOrSlug);
  if (!kit) return salesLockViolations(text);
  const link = new RegExp("https://vendas\\.zevanory\\.api\\.br/hotmart/" + escRe(kit.slug) + "(?![\\p{L}\\p{N}/-])(?:\\?[A-Za-z0-9=&_%.-]*)?", "gu");
  const price = new RegExp("R\\$\\s*" + kit.price + "(?:,00)?(?![\\d.,]*\\d)", "g");
  return salesLockViolations(String(text ?? "").replace(link, " ").replace(price, " "));
}
