// Trava de vendas no CONTEÚDO publicado (Telegram/Bluesky do motor de aquisição, Shorts, adaptadores orgânicos).
// Enquanto a trava canônica (KV sales:open:v1 lida por worker/sales-control.mjs readSalesSwitch) não estiver
// aberta, nenhum texto publicado pode ter preço, link de checkout/assinatura ou chamada de compra.
// Reaproveita hasCheckoutCta (caminhos/hosts de checkout de data/politica-unica.json) e acrescenta /comprar sem
// barra final, preço em reais e as chamadas de compra explícitas.
import { hasCheckoutCta } from "./politica-unica.mjs";
import { readSalesSwitch } from "./sales-control.mjs";

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
