// ZEVANORY | Rotas jurídicas fora do site de vendas (Sol ORDEM 312, reauditoria rodada 12, MED-1). TRUST ANCHOR.
// As páginas jurídicas aprovadas (portão por bytes, snapshot aprovado) são servidas SÓ pelo Worker de vendas
// (vendas.zevanory.api.br). Qualquer outro host da ZEVANORY (apex pelo roteador público, edge./backup., workers.dev
// do central) responde às rotas jurídicas com 308 para a mesma rota em vendas, sem servir HTML próprio. Este módulo,
// o roteador público e a chamada no ponto de entrada do central são âncoras de confiança (check protegido).
export const LEGAL_ROUTE_NAMES = Object.freeze(["termos", "privacidade", "reembolso", "afiliados"]);
export const SALES_ORIGIN = "https://vendas.zevanory.api.br";
const LEGAL_PATH = /^\/(termos|privacidade|reembolso|afiliados)(?:\.html|\/index\.html)?\/*$/i;

// Rodada 13 (LOW-1): o caminho é canonicalizado antes do teste, para variantes como //termos, /t%65rmos, /termos%2F e
// /termos;x também irem para vendas. Percent-encoding é decodificado UMA vez; percent duplo (%25), sequência inválida,
// caractere de controle ou barra invertida no resultado não casam (o pedido segue o caminho normal, sem redirecionar).
// O destino é sempre SALES_ORIGIN + o nome fixo da rota (nunca vem do pedido além da query): sem open redirect.
export function canonicalLegalPath(pathname) {
  const raw = String(pathname || "");
  if (/%25/.test(raw)) return null;
  let p;
  try { p = decodeURIComponent(raw); } catch { return null; }
  if (/[\u0000-\u001f\u007f\\%]/.test(p)) return null;
  p = p.split("/").map((seg) => seg.split(";")[0]).join("/");
  return p.replace(/\/{2,}/g, "/");
}

export function legalRouteRedirect(request) {
  let url;
  try { url = new URL(request.url); } catch { return null; }
  const path = canonicalLegalPath(url.pathname);
  const m = path === null ? null : LEGAL_PATH.exec(path);
  if (!m) return null;
  return new Response(null, { status: 308, headers: { location: `${SALES_ORIGIN}/${m[1].toLowerCase()}${url.search}`, "cache-control": "no-store" } });
}
