// NC-015 / DEC-04: launch scope is product guides and one-time kits only.
// It takes an audited code change plus a separate owner authorization to enable CP.
export const CP_SALES_ENABLED=false;
export function cpSalesEnabled(){return CP_SALES_ENABLED===true}
export function isCpPublicRoute(path){
 const clean=String(path||"").replace(/\/+$/,"")||"/";
 return clean==="/conteudo-pronto"||clean==="/conteudo-pronto.html"||
  clean==="/assinar/conteudo-pronto"||clean==="/hotmart/conteudo-pronto"||
  clean==="/conteudo-pronto/briefing"||clean==="/conteudo-pronto/pacote";
}
export function cpClosedResponse(){
 return new Response("Página indisponível",{status:404,headers:{
   "content-type":"text/plain; charset=utf-8","cache-control":"no-store, no-cache, must-revalidate",
   "x-robots-tag":"noindex, nofollow","x-content-type-options":"nosniff"
 }});
}
