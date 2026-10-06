const retired=new Set(["/arbm-sist","/arbm-sist/","/arbm-sist.html","/zevanory-one","/zevanory-one/","/zevanory-one.html","/arbm-one","/arbm-one/","/arbm-one.html"]);
const htmlRoutes=new Set(["solucoes","zevanory-sales","arbm-contador-saloes","ia-na-pratica","vendas-na-pratica","lucro-e-caixa","combo-ia-vendas","negocio-completo","zevanory-cfo","termos","privacidade","reembolso","afiliados"]);
const MP="https://www.mercadopago.com https://www.mercadopago.com.br";
const CSP=["default-src 'self'","base-uri 'none'",`form-action 'self' ${MP}`,"frame-ancestors 'none'","object-src 'none'",`script-src 'self' ${MP} https://sdk.mercadopago.com https://static.cloudflareinsights.com`,`frame-src ${MP} https://*.mercadopago.com https://*.mercadopago.com.br`,"style-src 'self'",`img-src 'self' data: ${MP}`,`connect-src 'self' https://api.mercadopago.com ${MP} https://*.mercadopago.com https://*.mercadopago.com.br https://cloudflareinsights.com`,"font-src 'self'"].join("; ");
function applySecurityHeaders(headers){
  headers.set("strict-transport-security","max-age=63072000; includeSubDomains; preload");
  headers.set("content-security-policy",CSP);
  headers.set("x-content-type-options","nosniff");
  headers.set("referrer-policy","strict-origin-when-cross-origin");
  headers.set("permissions-policy","camera=(), microphone=(), geolocation=()");
  headers.set("x-frame-options","DENY");
  return headers;
}
const FUNNEL_PAGES=new Set(["solucoes","ia-na-pratica","vendas-na-pratica","lucro-e-caixa","combo-ia-vendas","negocio-completo","material-gratuito"]);
function countView(request,env,ctx,page){
  // Aggregated, cookie-free view counting through the private service binding (never blocks the page).
  if(request.method!=="GET"||!env?.CORE||typeof env.CORE.fetch!=="function"||!ctx?.waitUntil||!FUNNEL_PAGES.has(page)) return;
  const body=JSON.stringify({page,ua:request.headers.get("user-agent")||"",ip:request.headers.get("cf-connecting-ip")||"",purpose:request.headers.get("sec-purpose")||request.headers.get("purpose")||""});
  ctx.waitUntil(env.CORE.fetch("https://funnel.internal/hit",{method:"POST",headers:{"content-type":"application/json"},body}).catch(()=>null));
}
const BUY_SKUS={"ZEV-IA-011":"ia-na-pratica","ZEV-VEN-011":"vendas-na-pratica","ZEV-LCX-011":"lucro-e-caixa","ZEV-CMB-011":"combo-ia-vendas","ZEV-NGC-011":"negocio-completo"};
const buyHits=new Map();
function buyLimited(ip){const now=Date.now();const e=buyHits.get(ip);if(!e||now-e.t>60000){buyHits.set(ip,{t:now,n:1});return false}e.n+=1;return e.n>10}
function infoPage(status,title,body){
  const page=`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><link rel="stylesheet" href="/product.css"></head><body><main class="wrap" style="max-width:640px;margin:48px auto;padding:0 16px"><h1>${title}</h1>${body}<p><a href="/solucoes">Ver todas as soluções</a></p></main></body></html>`;
  return new Response(page,{status,headers:applySecurityHeaders(new Headers({"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-robots-tag":"noindex"}))});
}
// Buy button target: /comprar/<SKU>. Creates the Mercado Pago checkout through the private
// service binding and redirects (303). While sales are closed it explains and offers WhatsApp.
async function handleBuy(request,env,sku){
  const slug=BUY_SKUS[sku];
  if(!slug) return infoPage(404,"Produto não encontrado","<p>Esse produto não existe ou foi retirado.</p>");
  if(request.method!=="GET"&&request.method!=="POST") return new Response("Method not allowed",{status:405,headers:applySecurityHeaders(new Headers())});
  if(!env?.CORE||typeof env.CORE.fetch!=="function") return infoPage(503,"Checkout indisponível","<p>Tente novamente em instantes ou fale com a gente no <a href=\"https://wa.me/5588992545413\">WhatsApp</a>.</p>");
  const ip=request.headers.get("cf-connecting-ip")||"unknown";
  if(buyLimited(ip)) return infoPage(429,"Muitas tentativas","<p>Aguarde um minuto e tente de novo.</p>");
  let open=false;
  try{const st=await env.CORE.fetch("https://zevanory.api.br/api/sales/status");open=(await st.json())?.open===true}catch{open=false}
  if(!open) return infoPage(200,"Vendas abrem em breve",`<p>Este produto ainda não está à venda. Quer ser avisado(a) ou tirar dúvidas agora?</p><p><a class="button primary" href="https://wa.me/5588992545413?text=${encodeURIComponent("Quero saber quando abre a venda do produto "+slug)}">Falar no WhatsApp</a></p>`);
  try{
    const res=await env.CORE.fetch("https://zevanory.api.br/api/checkout/mercadopago",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({request_id:crypto.randomUUID(),session_id:crypto.randomUUID(),offer_id:sku})});
    const data=await res.json().catch(()=>({}));
    const target=String(data?.checkout_url||"");
    if((res.status===201||res.status===200)&&/^https:\/\/(www\.)?mercadopago\.com(\.br)?\//.test(target)) return new Response(null,{status:303,headers:applySecurityHeaders(new Headers({location:target,"cache-control":"no-store"}))});
    console.error("buy_checkout_failed",res.status,String(data?.error||"").slice(0,80));
  }catch(e){console.error("buy_checkout_error",String(e&&e.message||e).slice(0,80))}
  return infoPage(503,"Não foi possível abrir o pagamento",`<p>Tente novamente em instantes. Se persistir, fale com a gente no <a href="https://wa.me/5588992545413">WhatsApp</a> ou em suporte@zevanory.api.br.</p>`);
}
export default{async fetch(request,env,ctx){
  const url=new URL(request.url);
  const buy=url.pathname.match(/^\/comprar\/([A-Z0-9-]{6,20})\/?$/i);
  if(buy) return handleBuy(request,env,buy[1].toUpperCase());
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
  let page="";
  if(url.pathname==="/"||url.pathname==="") { url.pathname="/solucoes.html"; page="solucoes"; }
  else { const key=url.pathname.replace(/^\/|\/$/g,""); if(htmlRoutes.has(key)) { url.pathname="/"+key+".html"; page=key; } }
  const response=await env.ASSETS.fetch(new Request(url,request));
  if(response.status===200&&page) countView(request,env,ctx,page);
  const headers=new Headers(response.headers);
  headers.set("x-robots-tag","index,follow");
  applySecurityHeaders(headers);
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}};