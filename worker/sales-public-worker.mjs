const retired=new Set(["/arbm-sist","/arbm-sist/","/arbm-sist.html","/zevanory-one","/zevanory-one/","/zevanory-one.html","/arbm-one","/arbm-one/","/arbm-one.html"]);
const htmlRoutes=new Set(["material-gratuito","checklist-15-minutos","solucoes","quem-criou","zevanory-sales","arbm-contador-saloes","ia-na-pratica","vendas-na-pratica","lucro-e-caixa","combo-ia-vendas","negocio-completo","zevanory-cfo","termos","privacidade","reembolso","afiliados","conteudo-pronto"]);
const MP="https://www.mercadopago.com https://www.mercadopago.com.br";
// With no-transform the edge no longer compresses pages, so the Worker gzips HTML itself.
function compressPage(request, body, init){
  const accepts=String(request.headers.get("accept-encoding")||"");
  if(!body||!/\bgzip\b/i.test(accepts)||typeof CompressionStream==="undefined") return new Response(body,init);
  const headers=new Headers(init.headers);
  headers.set("content-encoding","gzip");
  headers.delete("content-length");
  headers.append("vary","accept-encoding");
  return new Response(body.pipeThrough(new CompressionStream("gzip")),{...init,headers,encodeBody:"manual"});
}
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
const FUNNEL_PAGES=new Set(["conteudo-pronto","solucoes","ia-na-pratica","vendas-na-pratica","lucro-e-caixa","combo-ia-vendas","negocio-completo","material-gratuito"]);
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
  const page=`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><link rel="stylesheet" href="/product.css"></head><body><main class="wrap"><h1>${title}</h1>${body}<p><a href="/solucoes">Ver todas as soluções</a></p></main></body></html>`;
  return new Response(page,{status,headers:applySecurityHeaders(new Headers({"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-robots-tag":"noindex"}))});
}
// Buy flow: GET /comprar/<SKU> shows a confirmation step (never creates anything, so link
// previews, crawlers and prefetch are harmless); the customer's POST creates the Mercado Pago
// checkout through the private service binding (checkout.internal) and redirects (303).
const BOT_UA=/bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|headless|lighthouse|curl|wget|python|node-fetch|go-http|axios|okhttp/i;
const PRICES={"ZEV-IA-011":["IA na Prática",197],"ZEV-VEN-011":["Vendas na Prática",197],"ZEV-LCX-011":["Lucro & Caixa",247],"ZEV-CMB-011":["Combo IA + Vendas",297],"ZEV-NGC-011":["Negócio Completo",397]};
async function salesOpen(env){
  try{const st=await env.CORE.fetch("https://zevanory.api.br/api/sales/status");return (await st.json())?.open===true}catch{return false}
}
async function overLimit(env,ip){
  if(env?.BUY_LIMITER?.limit){try{const r=await env.BUY_LIMITER.limit({key:"buy:"+ip});return !r.success}catch{}}
  return buyLimited(ip);
}
async function handleBuy(request,env,sku){
  const slug=BUY_SKUS[sku];
  if(!slug) return infoPage(404,"Produto não encontrado","<p>Esse produto não existe ou foi retirado.</p>");
  if(request.method!=="GET"&&request.method!=="HEAD"&&request.method!=="POST") return new Response("Method not allowed",{status:405,headers:applySecurityHeaders(new Headers({allow:"GET, POST"}))});
  if(!env?.CORE||typeof env.CORE.fetch!=="function") return infoPage(503,"Checkout indisponível","<p>Tente novamente em instantes ou fale com a gente no <a href=\"https://wa.me/5588992545413\">WhatsApp</a>.</p>");
  const [name,price]=PRICES[sku];
  const open=await salesOpen(env);
  if(!open) return infoPage(200,"Vendas abrem em breve",`<p>O ${name} ainda não está à venda. Quer tirar dúvidas agora?</p><p><a class="button primary" href="https://wa.me/5588992545413?text=${encodeURIComponent("Olá! Tenho interesse no "+name+".")}">Falar no WhatsApp</a></p>`);
  if(request.method!=="POST"){
    return infoPage(200,`Comprar ${name}`,`<p><strong>${name}</strong> · R$ ${price},00 · pagamento único, Pix ou cartão.</p><p>Você será levado ao ambiente seguro do Mercado Pago. Depois da aprovação, o link de download chega no seu e-mail (válido por 72 horas). Garantia de 7 dias.</p><form method="post" action="/comprar/${sku}"><button class="button primary" type="submit">Ir para o pagamento seguro</button></form><p class="small">Ao continuar você concorda com os <a href="/termos">Termos</a> e a <a href="/privacidade">Política de Privacidade</a>.</p>`);
  }
  const ua=request.headers.get("user-agent")||"";
  if(!ua||BOT_UA.test(ua)) return infoPage(403,"Acesso não permitido","<p>Use um navegador para comprar.</p>");
  const ip=request.headers.get("cf-connecting-ip")||"unknown";
  if(await overLimit(env,ip)) return infoPage(429,"Muitas tentativas","<p>Aguarde um minuto e tente de novo.</p>");
  try{
    const res=await env.CORE.fetch("https://checkout.internal/api/checkout/mercadopago",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({request_id:crypto.randomUUID(),session_id:crypto.randomUUID(),offer_id:sku})});
    const data=await res.json().catch(()=>({}));
    const target=String(data?.checkout_url||"");
    if((res.status===201||res.status===200)&&/^https:\/\/(www\.)?mercadopago\.com(\.br)?\//.test(target)) return new Response(null,{status:303,headers:applySecurityHeaders(new Headers({location:target,"cache-control":"no-store"}))});
    console.error("buy_checkout_failed",res.status,String(data?.error||"").slice(0,80));
  }catch(e){console.error("buy_checkout_error",String(e&&e.message||e).slice(0,80))}
  return infoPage(503,"Não foi possível abrir o pagamento",`<p>Tente novamente em instantes. Se persistir, fale com a gente no <a href="https://wa.me/5588992545413">WhatsApp</a> ou em suporte@zevanory.api.br.</p>`);
}

// Lead magnet form (POST, same origin): forwarded to the core Worker through the private binding.
async function handleLead(request,env){
  if(request.method!=="POST") return new Response(null,{status:303,headers:applySecurityHeaders(new Headers({location:"/material-gratuito"}))});
  const ua=request.headers.get("user-agent")||"";
  if(!ua||BOT_UA.test(ua)) return infoPage(403,"Acesso não permitido","<p>Use um navegador.</p>");
  const ip=request.headers.get("cf-connecting-ip")||"unknown";
  if(await overLimit(env,"lead:"+ip)) return infoPage(429,"Muitas tentativas","<p>Aguarde um minuto e tente de novo.</p>");
  let form;try{form=await request.formData()}catch{form=new FormData()}
  if(String(form.get("website")||"")) return infoPage(200,"Quase lá!","<p>Confira seu e-mail.</p>");
  const payload={email:String(form.get("email")||""),name:String(form.get("nome")||""),consent:String(form.get("consentimento")||"")==="sim"};
  try{
    const res=await env.CORE.fetch("https://leads.internal/subscribe",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
    const data=await res.json().catch(()=>({}));
    const msg=String(data?.message||"Tente novamente em instantes.").replace(/[<>&]/g,"");
    return infoPage(res.ok?200:400,res.ok?"Quase lá!":"Não foi possível concluir",`<p>${msg}</p>${res.ok?"<p>Não chegou? Confira a caixa de spam ou promoções.</p>":"<p><a class=\"button primary\" href=\"/material-gratuito\">Voltar</a></p>"}`);
  }catch{return infoPage(503,"Não foi possível concluir","<p>Tente novamente em instantes.</p>")}
}

// Honest social proof: product pages show the real average rating once there are 3+ ratings.
let reviewCache={at:0,data:{}};
async function reviewSummary(env){
  if(Date.now()-reviewCache.at<600000) return reviewCache.data;
  try{const r=await env.CORE.fetch("https://zevanory.api.br/api/reviews/summary");const j=await r.json();reviewCache={at:Date.now(),data:(j&&j.products)||{}}}catch{reviewCache={at:Date.now(),data:{}}}
  return reviewCache.data;
}
// Hotmart affiliate channel: same official product page, but the buy buttons go to the
// Hotmart checkout (affiliate commission only exists there). Mercado Pago pages stay intact.
// Links are public checkout URLs (not secrets). Empty => redirect to the normal page.
export const HOTMART_CHECKOUT=Object.freeze({
  "ia-na-pratica":"",
  "vendas-na-pratica":"",
  "lucro-e-caixa":"",
  "combo-ia-vendas":"",
  "negocio-completo":"",
});
const HOTMART_TEXT=[
  ["Pagamento seguro pelo Mercado Pago (Pix ou cartão) · download logo após a confirmação · garantia de 7 dias.","Pagamento seguro pela Hotmart (Pix, cartão ou boleto) · acesso logo após a confirmação · garantia de 7 dias."],
  ["Download logo após a confirmação do pagamento (Pix ou cartão pelo Mercado Pago). Link pessoal enviado ao seu e-mail.","Acesso logo após a confirmação do pagamento, pela Hotmart. Os dados de acesso chegam no seu e-mail."],
  ["Logo após a confirmação do pagamento (Pix ou cartão via Mercado Pago), você recebe por e-mail um link pessoal para baixar o arquivo .zip com todo o material. Se o link se perder, peça outro em zevanory.api.br/entrega/reenviar.","Logo após a confirmação do pagamento, a Hotmart envia ao seu e-mail o acesso para baixar todo o material. Você também encontra o produto em Minhas compras, na sua conta Hotmart."],
  ["Você tem 7 dias de garantia: peça o reembolso integral em zevanory.api.br/pedir-reembolso, sem precisar explicar o motivo.","Você tem 7 dias de garantia: peça o reembolso integral pela Hotmart, em Minhas compras, sem precisar explicar o motivo."],
  ["Pix ou cartão pelo Mercado Pago.","Pix, cartão ou boleto pela Hotmart."],
  ["Link por e-mail logo após a confirmação do pagamento.","Acesso por e-mail logo após a confirmação do pagamento."],
];
export function hotmartPage(html,slug,checkout){
  let out=String(html);
  for(const [from,to] of HOTMART_TEXT)out=out.split(from).join(to);
  out=out.replace(/href="\/comprar\/ZEV-[A-Z0-9-]+"/g,'href="'+checkout+'" rel="noopener"');
  // Avoid duplicate-content SEO: the canonical stays on the main page; this variant is not indexed.
  out=out.replace("<head>",'<head><meta name="robots" content="noindex,follow">');
  return out;
}
async function handleHotmart(request,env,slug){
  const checkout=HOTMART_CHECKOUT[slug];
  if(!Object.prototype.hasOwnProperty.call(HOTMART_CHECKOUT,slug))return infoPage(404,"Produto não encontrado","<p>Esse produto não existe.</p>");
  if(!/^https:\/\/pay\.hotmart\.com\/[A-Za-z0-9]+(\?[A-Za-z0-9=&_-]*)?$/.test(checkout||""))
    return new Response(null,{status:302,headers:applySecurityHeaders(new Headers({location:"/"+slug,"cache-control":"no-store"}))});
  const page=await env.ASSETS.fetch(new Request(new URL("/"+slug+".html",request.url),{method:"GET"}));
  if(page.status!==200)return page;
  const headers=applySecurityHeaders(new Headers({"content-type":"text/html; charset=utf-8","cache-control":"public, max-age=300","x-robots-tag":"noindex, follow"}));
  return new Response(hotmartPage(await page.text(),slug,checkout),{status:200,headers});
}

export default{async fetch(request,env,ctx){
  const url=new URL(request.url);
  const hm=url.pathname.match(/^\/hotmart\/([a-z-]{3,40})\/?$/);
  if(hm&&(request.method==="GET"||request.method==="HEAD")) return handleHotmart(request,env,hm[1]);
  // Refund form lives on the core domain; the public router sends zevanory.api.br/reembolso* here.
  if(url.pathname==="/reembolso/solicitar"||url.pathname==="/reembolso/solicitar/") return new Response(null,{status:308,headers:applySecurityHeaders(new Headers({location:"https://zevanory.api.br/pedir-reembolso","cache-control":"no-store"}))});
  if(url.pathname==="/material-gratuito/inscrever") return handleLead(request,env);
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
  // Static assets (css/js/svg/images) are cached by browsers and the edge; pages revalidate.
  if(response.status===200&&!page&&/\.(css|js|svg|png|webp|jpg|jpeg|ico|woff2?)$/i.test(url.pathname)) headers.set("cache-control","public, max-age=86400, stale-while-revalidate=604800");
  // no-transform: the edge must not inject third-party scripts (Web Analytics beacon) into sales
  // pages — it was the only F5 performance offender and contradicts "no invasive tracking".
  else if(response.status===200&&page) headers.set("cache-control","public, max-age=300, stale-while-revalidate=3600, no-transform");
  applySecurityHeaders(headers);
  const sku=Object.keys(BUY_SKUS).find(k=>BUY_SKUS[k]===page);
  if(response.status===200&&sku&&env?.CORE&&typeof HTMLRewriter!=="undefined"){
    const r=(await reviewSummary(env))[sku];
    if(r&&r.count>=3){
      const text=`★ ${String(r.average).replace(".",",")}/5 · ${r.count} avaliações de clientes`;
      const rewritten=new HTMLRewriter().on("main h1",{element(el){el.after(`<p class="review-summary">${text}</p>`,{html:true})}}).transform(new Response(response.body,{status:response.status,statusText:response.statusText,headers}));
      return page?compressPage(request,rewritten.body,{status:rewritten.status,statusText:rewritten.statusText,headers}):rewritten;
    }
  }
  if(response.status===200&&page) return compressPage(request,response.body,{status:response.status,statusText:response.statusText,headers});
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}};