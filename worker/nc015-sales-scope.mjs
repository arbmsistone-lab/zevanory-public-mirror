// NC-015 / DEC-04: launch scope is product guides and one-time kits only.
// It takes an audited code change plus a separate owner authorization to enable CP.
export const CP_SALES_ENABLED=false;
// DEC-05: Mercado Pago own-checkout is not a phase-one sales channel.
// Immutable runtime flag. An environment variable and the global sales switch cannot enable it.
// Historical paid-order support/refunds are intentionally outside this NEW checkout gate.
export const MP_PHASE1_CHECKOUT_ENABLED=false;
export const isMpPhase1CheckoutEnabled=()=>MP_PHASE1_CHECKOUT_ENABLED===true;
export function cpSalesEnabled(){return CP_SALES_ENABLED===true}
export function isCpPublicRoute(path){
 const clean=String(path||"").replace(/\/+$/,"")||"/";
 return clean==="/conteudo-pronto"||clean==="/conteudo-pronto.html"||clean==="/conteudo-pronto/index.html"||
  clean==="/assinar/conteudo-pronto"||clean==="/hotmart/conteudo-pronto"||
  clean==="/conteudo-pronto/briefing"||clean==="/conteudo-pronto/pacote";
}
export function cpClosedResponse(){
 // DEC-04: this is an actual public HTML page response, not an unlabelled text/plain 404.
 // The Worker intercepts this route before Static Assets; accessibility must live here.
 const html='<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Página indisponível | ZEVANORY</title></head><body><main><h1>Página indisponível</h1><p>Suporte: <a href="mailto:suporte@zevanory.api.br">suporte@zevanory.api.br</a></p></main></body></html>';
 return new Response(html,{status:404,headers:{
   "content-type":"text/html; charset=utf-8","cache-control":"no-store, no-cache, must-revalidate",
   "x-robots-tag":"noindex, nofollow","x-content-type-options":"nosniff"
 }});
}
