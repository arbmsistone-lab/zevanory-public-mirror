const retired=new Set(["/arbm-sist","/arbm-sist/","/arbm-sist.html","/zevanory-one","/zevanory-one/","/zevanory-one.html","/arbm-one","/arbm-one/","/arbm-one.html"]);
const htmlRoutes=new Set(["solucoes","zevanory-sales","arbm-contador-saloes","ia-na-pratica","vendas-na-pratica","lucro-e-caixa","combo-ia-vendas","negocio-completo","zevanory-cfo","termos","privacidade","reembolso","afiliados"]);
const MP="https://www.mercadopago.com https://www.mercadopago.com.br";
const CSP=["default-src 'self'","base-uri 'none'",`form-action 'self' ${MP}`,"frame-ancestors 'none'","object-src 'none'",`script-src 'self' ${MP} https://sdk.mercadopago.com`,`frame-src ${MP} https://*.mercadopago.com https://*.mercadopago.com.br`,"style-src 'self'",`img-src 'self' data: ${MP}`,`connect-src 'self' https://api.mercadopago.com ${MP} https://*.mercadopago.com https://*.mercadopago.com.br`,"font-src 'self'"].join("; ");
function applySecurityHeaders(headers){
  headers.set("strict-transport-security","max-age=63072000; includeSubDomains; preload");
  headers.set("content-security-policy",CSP);
  headers.set("x-content-type-options","nosniff");
  headers.set("referrer-policy","strict-origin-when-cross-origin");
  headers.set("permissions-policy","camera=(), microphone=(), geolocation=()");
  headers.set("x-frame-options","DENY");
  return headers;
}
export default{async fetch(request,env){
  const url=new URL(request.url);
  if(url.pathname==="/health"&&(request.method==="GET"||request.method==="HEAD")){
    return new Response(request.method==="HEAD"?null:JSON.stringify({
      ok:true,
      service:"zevanory-sales-public",
      release:String(env?.ZEVANORY_SALES_PUBLIC_RELEASE_SHA||"unversioned"),
      commercial_surface:"fail-closed"
    }),{status:200,headers:applySecurityHeaders(new Headers({"content-type":"application/json; charset=utf-8","cache-control":"no-store"}))});
  }
  if(retired.has(url.pathname)) return new Response("Produto retirado da superficie publica ZEVANORY.",{status:410,headers:applySecurityHeaders(new Headers({"content-type":"text/plain; charset=utf-8","cache-control":"no-store"}))});
  if(url.pathname.startsWith("/api/")||url.pathname.startsWith("/admin")) return new Response("Not found",{status:404,headers:applySecurityHeaders(new Headers())});
  if(url.pathname==="/"||url.pathname==="") url.pathname="/solucoes.html";
  else { const key=url.pathname.replace(/^\/|\/$/g,""); if(htmlRoutes.has(key)) url.pathname="/"+key+".html"; }
  const response=await env.ASSETS.fetch(new Request(url,request));
  const headers=new Headers(response.headers);
  headers.set("x-robots-tag","index,follow");
  applySecurityHeaders(headers);
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}};