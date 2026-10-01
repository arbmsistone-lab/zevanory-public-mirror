const retired=new Set(["/arbm-sist","/arbm-sist/","/arbm-sist.html","/zevanory-one","/zevanory-one/","/zevanory-one.html","/arbm-one","/arbm-one/","/arbm-one.html"]);
const htmlRoutes=new Set(["solucoes","arbm-contador-saloes","ia-na-pratica","vendas-na-pratica","lucro-e-caixa","combo-ia-vendas","negocio-completo","zevanory-cfo","termos","privacidade","reembolso","afiliados"]);
export default{async fetch(request,env){
  const url=new URL(request.url);
  if(retired.has(url.pathname)) return new Response("Produto retirado da superficie publica ZEVANORY.",{status:410,headers:{"content-type":"text/plain; charset=utf-8","cache-control":"no-store"}});
  if(url.pathname.startsWith("/api/")||url.pathname.startsWith("/admin")) return new Response("Not found",{status:404});
  if(url.pathname==="/"||url.pathname==="") url.pathname="/solucoes.html";
  else { const key=url.pathname.replace(/^\/|\/$/g,""); if(htmlRoutes.has(key)) url.pathname="/"+key+".html"; }
  const response=await env.ASSETS.fetch(new Request(url,request));
  const headers=new Headers(response.headers);
  headers.set("x-robots-tag","index,follow");
  headers.set("x-content-type-options","nosniff");
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}};