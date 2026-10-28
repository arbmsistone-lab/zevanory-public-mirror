// ZEVANORY | Rotas jurídicas fora do site de vendas (Sol ORDEM 312, reauditoria rodada 12, MED-1). TRUST ANCHOR.
// As páginas jurídicas aprovadas (portão por bytes, snapshot aprovado) são servidas SÓ pelo Worker de vendas
// (vendas.zevanory.api.br). Qualquer outro host da ZEVANORY (apex pelo roteador público, edge./backup., workers.dev
// do central) responde às rotas jurídicas com 308 para a mesma rota em vendas, sem servir HTML próprio. Este módulo,
// o roteador público e a chamada no ponto de entrada do central são âncoras de confiança (check protegido).
export const LEGAL_ROUTE_NAMES = Object.freeze(["termos", "privacidade", "reembolso", "afiliados"]);
export const SALES_ORIGIN = "https://vendas.zevanory.api.br";
const LEGAL_PATH = /^\/(termos|privacidade|reembolso|afiliados)(?:\.html|\/index\.html)?\/*$/i;

export function legalRouteRedirect(request) {
  let url;
  try { url = new URL(request.url); } catch { return null; }
  const m = LEGAL_PATH.exec(url.pathname);
  if (!m) return null;
  return new Response(null, { status: 308, headers: { location: `${SALES_ORIGIN}/${m[1].toLowerCase()}${url.search}`, "cache-control": "no-store" } });
}
