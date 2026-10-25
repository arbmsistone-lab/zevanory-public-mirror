import { CONTACT_HTML, CONTACT_LABEL, DELIVERY_72H, DELIVERY_TEXT, RESUMO_OFERTA, RULE_7D, RULE_LINE, contactHref, waitlistHref } from "./politica-unica.mjs";
// Contato humano nas páginas do Worker vem de contato_publico (e-mail enquanto o WhatsApp não opera).
const retired=new Set(["/arbm-sist","/arbm-sist/","/arbm-sist.html","/zevanory-one","/zevanory-one/","/zevanory-one.html","/arbm-one","/arbm-one/","/arbm-one.html"]);
const htmlRoutes=new Set(["material-gratuito","checklist-15-minutos","solucoes","quem-criou","zevanory-sales","arbm-contador-saloes","ia-na-pratica","vendas-na-pratica","lucro-e-caixa","combo-ia-vendas","negocio-completo","zevanory-cfo","termos","privacidade","reembolso","afiliados","conteudo-pronto","kit-afiliado","ia-por-ramo","ia-para-salao-de-beleza","ia-para-barbearia","ia-para-restaurante-e-lanchonete","ia-para-loja-de-roupas","ia-para-mercadinho","ia-para-oficina-mecanica","ia-para-clinica-e-consultorio","ia-para-academia","ia-para-pet-shop","ia-para-contabilidade","ia-para-imobiliaria","ia-para-deposito-de-bebidas","ferramentas","calculadora-preco-de-venda","calculadora-margem-de-lucro","calculadora-ponto-de-equilibrio","ia-para-padaria","ia-para-pizzaria","ia-para-hamburgueria","ia-para-acaiteria","ia-para-confeitaria","ia-para-farmacia","ia-para-otica","ia-para-papelaria","ia-para-materiais-de-construcao","ia-para-assistencia-tecnica-de-celular","ia-para-autoescola","ia-para-escola-de-idiomas","ia-para-clinica-odontologica","ia-para-psicologo","ia-para-nutricionista","ia-para-fisioterapia","ia-para-estetica","ia-para-manicure","ia-para-lava-jato","ia-para-eletricista-e-encanador","ia-para-fotografo","ia-para-arquitetura-e-design-de-interiores","ia-para-advocacia","ia-para-agencia-de-viagens","ia-para-floricultura","ia-para-marmitaria","ia-para-pousada","ia-para-distribuidora-de-gas-e-agua","calculadora-fluxo-de-caixa","calculadora-preco-hora-servico","calculadora-taxa-maquininha","calculadora-cmv","mensagem-para-cliente-que-sumiu","como-cobrar-cliente-pelo-whatsapp","como-mandar-orcamento-pelo-whatsapp"]);
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
const FUNNEL_PAGES=new Set(["conteudo-pronto","solucoes","ia-na-pratica","vendas-na-pratica","lucro-e-caixa","combo-ia-vendas","negocio-completo","material-gratuito","ferramentas","ia-por-ramo","afiliados","kit-afiliado"]);
export const isFunnelPage=page=>FUNNEL_PAGES.has(page)||/^(ia-para|calculadora)-[a-z-]{2,60}$/.test(page);
// Source attribution without cookies or personal data: the utm_source the link
// carried (our own channels always tag links) or, failing that, the referrer's
// platform. Only a short normalized label is counted, aggregated per day.
const SOURCE_HOSTS=[[/(^|\.)google\./,"google"],[/(^|\.)bing\.com$/,"bing"],[/(^|\.)(youtube\.com|youtu\.be)$/,"youtube"],[/(^|\.)(t\.me|telegram\.org)$/,"telegram"],[/(^|\.)bsky\.app$/,"bluesky"],[/(^|\.)instagram\.com$/,"instagram"],[/(^|\.)(facebook\.com|fb\.com|m\.facebook\.com)$/,"facebook"],[/(^|\.)tiktok\.com$/,"tiktok"],[/(^|\.)pinterest\./,"pinterest"],[/(^|\.)hotmart\.com$/,"hotmart"],[/^zevanory\.api\.br$/,"site"],[/^vendas\.zevanory\.api\.br$/,"interno"]];
export function attribution(request,url){
  const clean=(v,max)=>{const x=String(v||"").toLowerCase().trim();return new RegExp("^[a-z0-9_-]{1,"+max+"}$").test(x)?x:"";};
  let src=clean(url.searchParams.get("utm_source"),24);
  if(!src){let host="";try{host=new URL(request.headers.get("referer")||"").hostname}catch{}
    src=host?((SOURCE_HOSTS.find(([re])=>re.test(host))||[])[1]||"outro"):"direto";}
  return {src,camp:clean(url.searchParams.get("utm_campaign"),48)};
}
function utmQuery(url){
  const q=new URLSearchParams();for(const k of ["utm_source","utm_medium","utm_campaign"]){const v=url.searchParams.get(k);if(v&&/^[A-Za-z0-9_.-]{1,48}$/.test(v))q.set(k,v);}
  return q.toString();
}
// Keeps the visitor's source on the way to checkout (buy, Hotmart, subscribe, free material).
function carryUtm(response,url){
  const q=utmQuery(url);
  if(!q||typeof HTMLRewriter==="undefined")return response;
  return new HTMLRewriter().on('a[href^="/comprar/"],a[href^="/hotmart/"],a[href^="/assinar/"],a[href^="/material-gratuito"]',{element(el){const h=el.getAttribute("href")||"";if(!/utm_source=/.test(h))el.setAttribute("href",h+(h.includes("?")?"&":"?")+q);}}).transform(response);
}
function countView(request,env,ctx,page,metric="views"){
  // Aggregated, cookie-free view counting through the private service binding (never blocks the page).
  if(request.method!=="GET"||!env?.CORE||typeof env.CORE.fetch!=="function"||!ctx?.waitUntil||!isFunnelPage(page)) return;
  const url=new URL(request.url),{src,camp}=attribution(request,url);
  const body=JSON.stringify({page,metric,src,camp,asn:Number(request.cf?.asn)||0,al:request.headers.get("accept-language")?1:0,cty:String(request.cf?.country||"").slice(0,2),ua:request.headers.get("user-agent")||"",ip:request.headers.get("cf-connecting-ip")||"",purpose:request.headers.get("sec-purpose")||request.headers.get("purpose")||""});
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
// Same automation list as worker/funnel.mjs BOT_RE. "monitor" and "zevanory" were missing here: the
// live-buy smoke ("ZEVANORY-Monitor") passed this check and its POST created real orders (PR #789).
// Our own tools always identify themselves with "zevanory"; no real browser sends that.
// Mercado Pago back_urls land on /solucoes?pagamento=<estado>. The redirect is NOT payment proof:
// the text never claims confirmation or absence of charge; access depends only on the webhook.
const PAYMENT_RETURN={
  aprovado:["Recebemos o seu retorno do pagamento","<p>Assim que o Mercado Pago confirmar o pagamento, o acesso chega no e-mail informado na compra. Costuma levar poucos minutos.</p><p>Não chegou? Confira a caixa de spam ou promoções. Você também pode <a href=\"https://zevanory.api.br/entrega/reenviar\">pedir um novo link de acesso</a>.</p>"],
  pendente:["Acompanhe o seu pagamento","<p>Se você pagou com Pix ou boleto, a compensação pode levar algum tempo. Quando o Mercado Pago confirmar o pagamento, o acesso chega no e-mail informado na compra.</p><p>Se já pagou e nada chegou em 1 dia útil, <a href=\"https://zevanory.api.br/entrega/reenviar\">peça um novo link</a> ou fale com a gente: "+CONTACT_HTML+".</p>"],
  falhou:["Não conseguimos confirmar o seu pagamento","<p>Esta página não confirma o resultado do pagamento: ele pode ter sido recusado, cancelado ou até concluído. Confira o status no aplicativo ou no e-mail do Mercado Pago antes de tentar de novo, para não pagar duas vezes.</p><p>Se aparecer cobrança e o acesso não chegar no seu e-mail, <a href=\"https://zevanory.api.br/entrega/reenviar\">peça um novo link</a> ou fale com a gente: "+CONTACT_HTML+". Se não houve cobrança, você pode tentar de novo pela página do produto.</p>"]
};
export function paymentReturnPage(state){
  const entry=Object.prototype.hasOwnProperty.call(PAYMENT_RETURN,state)?PAYMENT_RETURN[state]:null;
  return entry?infoPage(200,entry[0],entry[1]):null;
}
export const BOT_UA=/bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|headless|lighthouse|monitor|uptime|pingdom|semrush|ahrefs|curl|wget|python|node-fetch|go-http|axios|okhttp|zevanory/i;
// Telegram's in-app browser on Android appends "Telegram-Android/<ver> (<device>)" to a normal mobile
// Chrome UA, so the word "telegram" blocked real people opening our Telegram links. The token is removed
// ONLY when the rest is a mobile browser UA; the result still goes through the full automation list
// (TelegramBot previews, headless, curl, python... stay blocked). A UA never proves a human: rate limits,
// honeypot and the datacenter-ASN filter remain the abuse controls.
const INAPP_TOKEN=/\s*\bTelegram-Android\/[\d.]+(?:\s*\([^)]*\))?/g;
const MOBILE_BROWSER=/^Mozilla\/5\.0 \((?:Linux; Android [^)]*|iPhone;[^)]*|iPad;[^)]*)\) AppleWebKit\/[\d.]+ \(KHTML, like Gecko\)/;
export function isAutomationUA(ua){
  const s=String(ua||"");
  if(!s)return true;
  return BOT_UA.test(MOBILE_BROWSER.test(s)?s.replace(INAPP_TOKEN,""):s);
}
const PRICES={"ZEV-IA-011":["IA na Prática",197],"ZEV-VEN-011":["Vendas na Prática",197],"ZEV-LCX-011":["Lucro & Caixa",247],"ZEV-CMB-011":["Combo IA + Vendas",297],"ZEV-NGC-011":["Negócio Completo",397]};
async function salesOpen(env){
  try{const st=await env.CORE.fetch("https://zevanory.api.br/api/sales/status");if(!st.ok)return false;return (await st.json())?.open===true}catch{return false}  // only an OK response with open===true opens; anything else is closed
}
// P13 (NO-GO): the static HTML is always built closed (waiting-list CTAs, no /comprar/ link, no
// schema.org Offer). Only when the owner switch is open (same /api/sales/status, fail-closed: KV
// sales:open:v1 + "LIBERAR VENDAS" + green preflight) the page is restored at request time.
const SALES_TOGGLE_PAGES=new Set(["ia-na-pratica","vendas-na-pratica","lucro-e-caixa","combo-ia-vendas","negocio-completo","solucoes","conteudo-pronto"]);
const SUBSCRIPTION_PATHS=Object.freeze({"conteudo-pronto":"/assinar/conteudo-pronto"});
const SALES_ORIGIN="https://vendas.zevanory.api.br";
export function openSalesHtml(html,slug){
  let out=String(html);
  out=out.replace(/<a ([^>]*?)href="[^"]*" data-zev-sku="(ZEV-[A-Z0-9-]+)" data-zev-open-text="([^"]*)">[^<]*<\/a>/g,(m,pre,sku,label)=>PRICES[sku]?`<a ${pre}href="/comprar/${sku}" rel="nofollow">${label}</a>`:m);
  out=out.replace(/<a ([^>]*?)href="[^"]*" data-zev-sub="([a-z-]+)" data-zev-open-text="([^"]*)">[^<]*<\/a>/g,(m,pre,sub,label)=>Object.prototype.hasOwnProperty.call(SUBSCRIPTION_PATHS,sub)?`<a ${pre}href="${SUBSCRIPTION_PATHS[sub]}">${label}</a>`:m);
  out=out.replace(/<(span|p)([^>]*?) data-zev-open-text="([^"]*)">[^<]*<\/\1>/g,"<$1$2>$3</$1>");
  out=out.replace(/<(p|span)\b[^>]*\sdata-zev-closed[^>]*>[^<]*<\/\1>/g,"");
  // Site audit S-04: the closed-sales sign-up block (form + e-mail waiting list) is a whole <section> with no
  // nested section; it disappears with the notice when the owner opens sales.
  out=out.replace(/<section\b[^>]*\sdata-zev-closed-block[^>]*>(?:(?!<section\b)[\s\S])*?<\/section>/g,"");
  const sku=Object.keys(BUY_SKUS).find(k=>BUY_SKUS[k]===slug);
  if(sku)out=out.replace(/(<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/,(m,a,body,c)=>{
    try{const d=JSON.parse(body);
      for(const n of d["@graph"]||[])if(n&&n["@type"]==="Product")n.offers={"@type":"Offer",price:PRICES[sku][1]+".00",priceCurrency:"BRL",availability:"https://schema.org/InStock",url:SALES_ORIGIN+"/"+slug,seller:{"@type":"Organization",name:"A. RENAN ALVES MOREIRA BITU LTDA"}};
      return a+JSON.stringify(d)+c;}catch{return m}});
  if(slug==="conteudo-pronto")out=out.replace(/(<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/,(m,a,body,c)=>{
    try{const d=JSON.parse(body);
      for(const n of d["@graph"]||[])if(n&&n["@type"]==="Service")n.offers={"@type":"Offer",price:"197.00",priceCurrency:"BRL",url:SALES_ORIGIN+"/conteudo-pronto"};
      return a+JSON.stringify(d)+c;}catch{return m}});
  return out;
}
// AVAL 084 (cache): no page-level switch cache. Every request of a switch-dependent page asks the
// owner switch again (/api/sales/status, itself capped < 60 s), so a close is reflected on the next
// request, and those pages are never stored by browsers or the edge (Cache-Control: no-store).
export function resetPageSwitchCache(){}  // kept for callers; there is no page-level cache any more
async function salesOpenForPages(env){return salesOpen(env)}
export const SWITCH_DEPENDENT_CACHE_CONTROL="no-store, no-transform";
export const isSwitchDependentPage=page=>SALES_TOGGLE_PAGES.has(page);
async function overLimit(env,ip){
  if(env?.BUY_LIMITER?.limit){try{const r=await env.BUY_LIMITER.limit({key:"buy:"+ip});return !r.success}catch{}}
  return buyLimited(ip);
}
async function handleBuy(request,env,sku,ctx){
  const slug=BUY_SKUS[sku];
  if(!slug) return infoPage(404,"Produto não encontrado","<p>Esse produto não existe ou foi retirado.</p>");
  if(request.method!=="GET"&&request.method!=="HEAD"&&request.method!=="POST") return new Response("Method not allowed",{status:405,headers:applySecurityHeaders(new Headers({allow:"GET, POST"}))});
  if(!env?.CORE||typeof env.CORE.fetch!=="function") return infoPage(503,"Checkout indisponível","<p>Tente novamente em instantes ou fale com a gente: "+CONTACT_HTML+".</p>");
  const [name,price]=PRICES[sku];
  const open=await salesOpen(env);
  if(!open) return infoPage(200,"Vendas abrem em breve",`<p>O ${name} ainda não está à venda. Quer tirar dúvidas agora?</p><p><a class="button primary" href="${contactHref("Olá! Tenho interesse no "+name+".").replace(/&/g,"&amp;")}">${CONTACT_LABEL}</a></p>`);
  if(request.method!=="POST"){
    countView(request,env,ctx,slug,"checkout_intent");
    return infoPage(200,`Comprar ${name}`,`<p><strong>${name}</strong> · R$ ${price},00 · pagamento único, Pix ou cartão.</p><p>Você será levado ao ambiente seguro do Mercado Pago. ${DELIVERY_TEXT} ${RULE_LINE}</p><form method="post" action="/comprar/${sku}"><button class="button primary" type="submit">Ir para o pagamento seguro</button></form><p class="small">Ao continuar você concorda com os <a href="/termos">Termos</a> e a <a href="/privacidade">Política de Privacidade</a>.</p>`);
  }
  const ua=request.headers.get("user-agent")||"";
  if(isAutomationUA(ua)) return infoPage(403,"Acesso não permitido","<p>Use um navegador para comprar.</p>");
  const ip=request.headers.get("cf-connecting-ip")||"unknown";
  if(await overLimit(env,ip)) return infoPage(429,"Muitas tentativas","<p>Aguarde um minuto e tente de novo.</p>");
  try{
    const res=await env.CORE.fetch("https://checkout.internal/api/checkout/mercadopago",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({request_id:crypto.randomUUID(),session_id:crypto.randomUUID(),offer_id:sku})});
    const data=await res.json().catch(()=>({}));
    const target=String(data?.checkout_url||"");
    if((res.status===201||res.status===200)&&/^https:\/\/(www\.)?mercadopago\.com(\.br)?\//.test(target)) return new Response(null,{status:303,headers:applySecurityHeaders(new Headers({location:target,"cache-control":"no-store"}))});
    console.error("buy_checkout_failed",res.status,String(data?.error||"").slice(0,80));
  }catch(e){console.error("buy_checkout_error",String(e&&e.message||e).slice(0,80))}
  return infoPage(503,"Não foi possível abrir o pagamento",`<p>Tente novamente em instantes. Se persistir, fale com a gente: ${CONTACT_HTML}.</p>`);
}

// Lead magnet form (POST, same origin): forwarded to the core Worker through the private binding.
// New free-material sign-up accepted by the core -> aggregate lead_submit counter by source. The source
// is the utm_source the form page carried (same-site referer only). Minimum data: user agent and ASN go
// only so the core can apply the same bot/datacenter filter as page views, and the core drops them for
// intent metrics (tests/attribution.test.mjs). No IP, country, e-mail or name is sent.
export function leadSource(request){
  try{const ref=new URL(request.headers.get("referer")||"");if(ref.hostname!==new URL(request.url).hostname)return "sem_tag";
    const v=String(ref.searchParams.get("utm_source")||"").toLowerCase();return /^[a-z0-9_-]{1,24}$/.test(v)?v:"sem_tag";}catch{return "sem_tag"}
}
export function leadHitBody(request){
  return {page:"material-gratuito",metric:"lead_submit",src:leadSource(request),ua:request.headers.get("user-agent")||"",asn:Number(request.cf?.asn)||0};
}
function countLead(request,env,ctx){
  if(!env?.CORE||typeof env.CORE.fetch!=="function"||!ctx?.waitUntil) return;
  ctx.waitUntil(env.CORE.fetch("https://funnel.internal/hit",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(leadHitBody(request))}).catch(()=>null));
}
async function handleLead(request,env,ctx){
  if(request.method!=="POST") return new Response(null,{status:303,headers:applySecurityHeaders(new Headers({location:"/material-gratuito"}))});
  const ua=request.headers.get("user-agent")||"";
  if(isAutomationUA(ua)) return infoPage(403,"Acesso não permitido","<p>Use um navegador.</p>");
  const ip=request.headers.get("cf-connecting-ip")||"unknown";
  if(await overLimit(env,"lead:"+ip)) return infoPage(429,"Muitas tentativas","<p>Aguarde um minuto e tente de novo.</p>");
  let form;try{form=await request.formData()}catch{form=new FormData()}
  if(String(form.get("website")||"")) return infoPage(200,"Quase lá!","<p>Confira seu e-mail.</p>");
  let page="";try{const ref=new URL(request.headers.get("referer")||"");if(ref.hostname===new URL(request.url).hostname)page=ref.pathname.slice(0,80)}catch{}
  const payload={email:String(form.get("email")||""),name:String(form.get("nome")||""),consent:String(form.get("consentimento")||"")==="sim",page};
  try{
    const res=await env.CORE.fetch("https://leads.internal/subscribe",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
    const data=await res.json().catch(()=>({}));
    // Only fixed, known messages are rendered (no upstream text in HTML).
    const KNOWN=["Quase lá! Enviamos um link de confirmação para o seu e-mail.","Enviamos o checklist para o seu e-mail.","Confira o e-mail.","Marque a autorização para receber o material.","Não conseguimos enviar agora. Tente de novo em instantes.","Não conseguimos registrar agora. Tente de novo em instantes."];
    const msg=KNOWN.find(k=>k===String(data?.message||""))||(res.ok?KNOWN[0]:"Tente novamente em instantes.");
    // Only a new (or re-requested, pending) sign-up counts; a resend to an already confirmed address does not.
    if(res.ok&&String(data?.message||"")===KNOWN[0]) countLead(request,env,ctx);
    // The checklist is a public (noindex) page, so gating it behind the e-mail confirmation only added two
    // steps between the visitor and what they asked for. It opens right away; the double opt-in still
    // guards every marketing e-mail.
    const body=res.ok?"<p>"+msg+"</p><p><a class=\"button primary\" href=\"/checklist-15-minutos\">Abrir o checklist agora</a></p><p>Confirme o e-mail para receber as dicas da sequência. Não chegou? Confira a caixa de spam ou promoções.</p>":"<p>"+msg+"</p><p><a class=\"button primary\" href=\"/material-gratuito\">Voltar</a></p>";
    return infoPage(res.ok?200:400,res.ok?"Quase lá!":"Não foi possível concluir",body);
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
  "ia-na-pratica":"https://pay.hotmart.com/F107979716H?off=g9knd34r",
  "vendas-na-pratica":"https://pay.hotmart.com/Y107979937I?off=8mg88sdd",
  "lucro-e-caixa":"https://pay.hotmart.com/L107979973K?off=ksb5di36",
  "combo-ia-vendas":"https://pay.hotmart.com/H107979990T?off=b3ytmah4",
  "negocio-completo":"https://pay.hotmart.com/U107980005X?off=weo47apk",
});
// Conteúdo Pronto subscription checkout on Hotmart (empty until the product exists).
export const SERVICE_CHECKOUT="https://pay.hotmart.com/X107980075B?off=4ydutio7";
const SERVICE_WA=contactHref("Olá! Quero assinar o Conteúdo Pronto.");
const HOTMART_TEXT=[
  // Design PR: the hero payment facts are a list (no "·" chain); each item has its Hotmart wording.
  ["Pagamento processado pelo Mercado Pago (Pix ou cartão)","Pagamento processado pela Hotmart (Pix, cartão ou boleto)"],
  [`Entrega por e-mail em ${DELIVERY_72H}`,"Acesso por e-mail após a confirmação do pagamento"],
  ["<strong>Pagamento</strong><span>processado pelo Mercado Pago","<strong>Pagamento</strong><span>processado pela Hotmart"],
  [`Entrega por e-mail após a confirmação do pagamento (Pix ou cartão pelo Mercado Pago), em ${DELIVERY_72H}.`,"Acesso após a confirmação do pagamento, pela Hotmart. Os dados de acesso chegam no seu e-mail."],
  [`Após a confirmação do pagamento (Pix ou cartão via Mercado Pago), você recebe por e-mail um ${DELIVERY_72H} do arquivo .zip com todo o material. A expiração do link não elimina o seu direito ao produto: peça outro sem custo em zevanory.api.br/entrega/reenviar.`,"Após a confirmação do pagamento, a Hotmart envia ao seu e-mail o acesso para baixar todo o material. Você também encontra o produto em Minhas compras, na sua conta Hotmart."],
  [`Você pode desistir em ${RULE_7D}, sem justificativa e com devolução integral: peça em zevanory.api.br/pedir-reembolso.`,`Você pode desistir em ${RULE_7D}, sem justificativa e com devolução integral: peça pela Hotmart, em Minhas compras.`],
  ["Pix ou cartão pelo Mercado Pago.","Pix, cartão ou boleto pela Hotmart."],
  ["Por e-mail após a confirmação do pagamento: válido por 72 horas e para um download.","Acesso por e-mail logo após a confirmação do pagamento."],
];
// Decreto 7.962 "Resumo da oferta": pagamento e entrega da variante Hotmart (data/politica-unica.json).
HOTMART_TEXT.push([RESUMO_OFERTA.produto_digital.pagamento,RESUMO_OFERTA.hotmart.pagamento],[RESUMO_OFERTA.produto_digital.entrega.replace("{delivery_72h}",DELIVERY_72H),RESUMO_OFERTA.hotmart.entrega]);
export function hotmartPage(html,slug,checkout){
  let out=openSalesHtml(html,slug);  // only served while sales are open (handleHotmart)
  for(const [from,to] of HOTMART_TEXT)out=out.split(from).join(to);
  out=out.replace(/href="\/comprar\/ZEV-[A-Z0-9-]+"/g,'href="'+checkout+'" rel="noopener"');
  // Avoid duplicate-content SEO: the canonical stays on the main page; this variant is not indexed.
  out=out.replace("<head>",'<head><meta name="robots" content="noindex,follow">');
  return out;
}
// Owner decision 14/10/2026: sales closed. The Hotmart purchase paths follow the SAME owner switch
// (/api/sales/status, fail-closed) as the own checkout. Informative pages stay up; existing
// subscribers are unaffected (Hotmart postbacks and deliveries do not pass through these routes).
const SALES_PAUSED_HTML=(name,slug)=>`<p>As vendas do ${name.replace(/&/g,"&amp;").replace(/</g,"&lt;")} estão pausadas no momento. Quem já comprou continua com acesso normalmente.</p><p><a class="button" href="/${slug}">Ver detalhes do produto</a></p><p><a class="button primary" href="${waitlistHref(name).replace(/&/g,"&amp;")}">Entrar na lista de espera</a></p>`;
export const HOTMART_NAMES=Object.freeze({"ia-na-pratica":"IA na Prática","vendas-na-pratica":"Vendas na Prática","lucro-e-caixa":"Lucro & Caixa","combo-ia-vendas":"Combo IA + Vendas","negocio-completo":"Negócio Completo","conteudo-pronto":"Conteúdo Pronto"});
async function handleHotmart(request,env,slug,ctx){
  if(!Object.prototype.hasOwnProperty.call(HOTMART_CHECKOUT,slug))return infoPage(404,"Produto não encontrado","<p>Esse produto não existe.</p>");
  if(!(await salesOpen(env)))return infoPage(200,"Vendas pausadas",SALES_PAUSED_HTML(HOTMART_NAMES[slug]||"produto",slug));
  const {src}=attribution(request,new URL(request.url));
  countView(request,env,ctx,slug,"hotmart_view");
  // Hotmart reports sales per "src", so the origin survives up to the actual sale.
  const checkout=HOTMART_CHECKOUT[slug]&&(HOTMART_CHECKOUT[slug]+"&src="+src);
  if(!Object.prototype.hasOwnProperty.call(HOTMART_CHECKOUT,slug))return infoPage(404,"Produto não encontrado","<p>Esse produto não existe.</p>");
  if(!/^https:\/\/pay\.hotmart\.com\/[A-Za-z0-9]+(\?[A-Za-z0-9=&_-]*)?$/.test(checkout||""))
    return new Response(null,{status:302,headers:applySecurityHeaders(new Headers({location:"/"+slug,"cache-control":"no-store"}))});
  const page=await env.ASSETS.fetch(new Request(new URL("/"+slug+".html",request.url),{method:"GET"}));
  if(page.status!==200)return page;
  const headers=applySecurityHeaders(new Headers({"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-robots-tag":"noindex, follow"}));  // never cache a purchase link past a switch change
  return new Response(hotmartPage(await page.text(),slug,checkout),{status:200,headers});
}

// Auditor Sol (AVAL 100): every response under /comprar/ (any SKU, method, status 2xx/3xx/4xx/5xx,
// open or closed sales) is kept out of search indexes by the response itself: X-Robots-Tag
// "noindex, nofollow", Cache-Control "no-store" and, in HTML, <meta name="robots" content="noindex,nofollow">.
// robots.txt does NOT disallow /comprar/ on purpose: a blocked URL is never fetched, so the crawler would
// never see the noindex (https://developers.google.com/search/docs/crawling-indexing/block-indexing).
export const RETIRED_CONTACT_SCRIPT="/whatsapp-contact.js";
export const RETIRED_CONTACT_BODY="/* retired: intentionally empty */\n";
// Transitional eviction (2026-10-24, evidence: docs/evidence/sales-ux/legacy-cache.md): the tombstone
// is only ever requested by an OLD cached page, so it also tells supporting browsers to drop this
// origin's HTTP cache (old HTML and the old script bytes). Scoped to this one response on purpose:
// on pages it would wipe the immutable assets on every navigation. Remove no earlier than 8 days
// (old script max-age 1 d + stale-while-revalidate 7 d) after this Worker is deployed; review 2026-12-01.
export const RETIRED_CONTACT_CLEAR_SITE_DATA='"cache"';
export const HASHED_ASSET=/^\/assets\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.[0-9a-f]{10}\.(?:css|js|woff2)$/;
export const IMMUTABLE_CACHE_CONTROL="public, max-age=31536000, immutable";
export const REVALIDATE_CACHE_CONTROL="no-cache";
// Pages: short max-age and must-revalidate (no stale-while-revalidate window), so HTML never
// outlives the hashed assets it points to by more than five minutes.
export const PAGE_CACHE_CONTROL="public, max-age=300, must-revalidate, no-transform";
export function assetCacheControl(pathname){
  if(HASHED_ASSET.test(pathname)) return IMMUTABLE_CACHE_CONTROL;
  if(/\.(css|m?js)$/i.test(pathname)) return REVALIDATE_CACHE_CONTROL;
  if(/\.(svg|png|webp|jpg|jpeg|ico|woff2?)$/i.test(pathname)) return "public, max-age=86400";
  return "";
}
export const COMPRAR_PATH=/^\/comprar(?:\/|$)/i;
// Percent-encoded aliases (/%63omprar/, /comp%72ar/, /co%6Dprar/ or /co%6dprar/): the pathname is decoded ONCE
// with the URL Standard percent-decode (bytes, then UTF-8 with replacement; never throws) before matching, so an
// alias of /comprar/<SKU> gets the same buy flow and the same noindex/nofollow/no-store as the literal path.
// Double-encoding policy: /%2563omprar/ is NOT equivalent to /comprar/ under URL rules (one decode gives
// /%63omprar/), so it is never routed to the buy flow; but if further decodes (at most 3 more) reach /comprar,
// it still answers a 404 with noindex/nofollow/no-store, because over-applying noindex to a non-page is harmless.
const URL_DECODER=new TextDecoder("utf-8");
export function percentDecodeOnce(input){
  const bytes=new TextEncoder().encode(String(input)),out=[];
  const hex=b=>(b>=48&&b<=57)||(b>=65&&b<=70)||(b>=97&&b<=102);
  for(let i=0;i<bytes.length;i++){
    if(bytes[i]===37&&i+2<bytes.length&&hex(bytes[i+1])&&hex(bytes[i+2])){out.push(parseInt(String.fromCharCode(bytes[i+1],bytes[i+2]),16));i+=2;}
    else out.push(bytes[i]);
  }
  return URL_DECODER.decode(new Uint8Array(out));
}
// -> {path, routable} when the request belongs to /comprar (literal, single-encoded or multi-encoded alias), else null.
export function comprarMatch(pathname){
  const once=percentDecodeOnce(pathname);
  if(COMPRAR_PATH.test(once)) return {path:once,routable:true};
  let p=once;
  for(let i=0;i<3;i++){const n=percentDecodeOnce(p);if(n===p)break;p=n;if(COMPRAR_PATH.test(p)) return {path:p,routable:false};}
  return null;
}
export const COMPRAR_ROBOTS="noindex, nofollow";
export const COMPRAR_META='<meta name="robots" content="noindex,nofollow">';
export async function noindexComprar(response){
  const headers=new Headers(response.headers);
  headers.set("x-robots-tag",COMPRAR_ROBOTS);
  headers.set("cache-control","no-store");
  applySecurityHeaders(headers);
  let body=response.body;
  if(body&&/^text\/html\b/i.test(headers.get("content-type")||"")){
    let html=await response.text();
    html=/<meta name="robots"[^>]*>/i.test(html)?html.replace(/<meta name="robots"[^>]*>/gi,COMPRAR_META):html.replace(/<head>/i,"<head>"+COMPRAR_META);
    headers.delete("content-length");
    body=html;
  }
  return new Response(body,{status:response.status,statusText:response.statusText,headers});
}
async function comprarRoute(request,env,ctx,match){
  try{
    const buy=match.routable&&match.path.match(/^\/comprar\/([A-Z0-9-]{6,20})\/?$/i);
    if(buy) return await handleBuy(request,env,buy[1].toUpperCase(),ctx);
    return infoPage(404,"Produto não encontrado","<p>Esse produto não existe ou foi retirado.</p>");
  }catch(e){
    console.error("buy_route_error",String(e&&e.message||e).slice(0,80));
    return infoPage(503,"Checkout indisponível","<p>Tente novamente em instantes.</p>");
  }
}

// Chat do site "Fale com a ZEVANORY" (worker/site-chat.mjs, no Worker central). Desligado por padrão:
// sem SITE_CHAT_ENABLED="true" neste Worker as rotas /api/chat* respondem 503 aqui mesmo (sem chamar o
// central) e nenhuma página recebe o widget. Ligado: o widget (CSS/JS próprios, sem script de terceiros,
// sem inline, compatível com a CSP) só é anexado às páginas abaixo e só abre por ação da pessoa.
export const SITE_CHAT_PAGES=Object.freeze(new Set(["solucoes","ia-na-pratica","vendas-na-pratica","lucro-e-caixa","combo-ia-vendas","negocio-completo","conteudo-pronto","termos","privacidade","reembolso"]));
export const siteChatEnabled=env=>String(env?.SITE_CHAT_ENABLED||"").toLowerCase()==="true";
export const shouldInjectSiteChat=(page,env)=>Boolean(page)&&SITE_CHAT_PAGES.has(page)&&siteChatEnabled(env);
export function injectSiteChatHtml(html){
  let out=String(html);
  if(out.includes('src="/site-chat.js"'))return out;
  out=out.replace("</head>",'<link rel="stylesheet" href="/site-chat.css"></head>');
  return out.replace("</body>",'<script src="/site-chat.js" defer></script></body>');
}
const CHAT_ROUTES=new Set(["/api/chat","/api/chat/session","/api/chat/handoff","/api/chat/status"]);
const CHAT_FALLBACK={contact_email:"suporte@zevanory.api.br",refund_form:"https://zevanory.api.br/pedir-reembolso",delivery_form:"https://zevanory.api.br/entrega/reenviar"};
export async function handleSiteChatProxy(request,env){
  const url=new URL(request.url);
  const headers=applySecurityHeaders(new Headers({"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-robots-tag":"noindex"}));
  const reply=(status,body)=>new Response(JSON.stringify(body),{status,headers});
  if(!siteChatEnabled(env)||!env?.CORE||typeof env.CORE.fetch!=="function")return reply(503,{error:"site_chat_disabled",fallback:CHAT_FALLBACK});
  const isStatus=url.pathname==="/api/chat/status";
  if(isStatus?request.method!=="GET":request.method!=="POST"){headers.set("allow",isStatus?"GET":"POST");return reply(405,{error:"method_not_allowed"});}
  if(isAutomationUA(request.headers.get("user-agent")||""))return reply(403,{error:"automation_not_allowed"});
  let body;
  if(!isStatus){
    // Mesma origem (o widget é servido daqui): bloqueia POST de outros sites.
    if(request.headers.get("origin")!==url.origin)return reply(403,{error:"origin_not_allowed"});
    if(!/^application\/json\b/i.test(request.headers.get("content-type")||""))return reply(415,{error:"json_required"});
    if(Number(request.headers.get("content-length")||0)>4096)return reply(413,{error:"too_large"});
    body=await request.text();
    if(body.length>4096)return reply(413,{error:"too_large"});
  }
  try{
    const res=await env.CORE.fetch("https://chat.internal"+url.pathname,{method:request.method,headers:{"content-type":"application/json","x-zev-client-ip":request.headers.get("cf-connecting-ip")||""},body});
    const text=await res.text();
    if(res.headers.get("retry-after"))headers.set("retry-after",res.headers.get("retry-after"));
    return new Response(text,{status:res.status,headers});
  }catch{return reply(503,{error:"site_chat_unavailable",fallback:CHAT_FALLBACK});}
}

export default{async fetch(request,env,ctx){
  const url=new URL(request.url);
  const comprar=comprarMatch(url.pathname);
  if(comprar) return noindexComprar(await comprarRoute(request,env,ctx,comprar));
  // IndexNow ownership proof for the sales host (same public key as the apex).
  if(url.pathname==="/4782b8291736ddb8fc6239a51c81d3004324faba12f20f625ddbf52ae0d8e922.txt"&&(request.method==="GET"||request.method==="HEAD"))
    return new Response(request.method==="HEAD"?null:"4782b8291736ddb8fc6239a51c81d3004324faba12f20f625ddbf52ae0d8e922",{status:200,headers:applySecurityHeaders(new Headers({"content-type":"text/plain; charset=utf-8","cache-control":"public, max-age=86400"}))});
  if(url.pathname==="/assinar/conteudo-pronto"){
    if(request.method!=="GET"&&request.method!=="HEAD")return new Response("Method not allowed",{status:405,headers:applySecurityHeaders(new Headers({allow:"GET, HEAD","cache-control":"no-store"}))});
    if(!(await salesOpen(env)))return infoPage(200,"Assinaturas pausadas",`<p>Novas assinaturas do Conteúdo Pronto estão pausadas no momento. Quem já é assinante continua recebendo normalmente.</p><p><a class="button" href="/conteudo-pronto">Ver detalhes do serviço</a></p><p><a class="button primary" href="${waitlistHref("Conteúdo Pronto").replace(/&/g,"&amp;")}">Entrar na lista de espera</a></p>`);
    countView(request,env,ctx,"conteudo-pronto","subscribe_click");
    const svc=SERVICE_CHECKOUT+"&src="+attribution(request,url).src;
    const target=/^https:\/\/pay\.hotmart\.com\/[A-Za-z0-9]+(\?[A-Za-z0-9=&_-]*)?$/.test(svc)?svc:SERVICE_WA;
    return new Response(null,{status:302,headers:applySecurityHeaders(new Headers({location:target,"cache-control":"no-store"}))});
  }
  const hm=url.pathname.match(/^\/hotmart\/([a-z-]{3,40})\/?$/);
  if(hm&&(request.method==="GET"||request.method==="HEAD")) return handleHotmart(request,env,hm[1],ctx);
  // Refund form lives on the core domain; the public router sends zevanory.api.br/reembolso* here.
  if(url.pathname==="/reembolso/solicitar"||url.pathname==="/reembolso/solicitar/") return new Response(null,{status:308,headers:applySecurityHeaders(new Headers({location:"https://zevanory.api.br/pedir-reembolso","cache-control":"no-store"}))});
  if(url.pathname==="/material-gratuito/inscrever") return handleLead(request,env,ctx);
  if(url.pathname==="/health"&&(request.method==="GET"||request.method==="HEAD")){
    return new Response(request.method==="HEAD"?null:JSON.stringify({
      ok:true,
      service:"zevanory-sales-public",
      release:String(env?.ZEVANORY_SALES_PUBLIC_RELEASE_SHA||"unversioned"),
      commercial_surface:"fail-closed"
    }),{status:200,headers:applySecurityHeaders(new Headers({"content-type":"application/json; charset=utf-8","cache-control":"no-store"}))});
  }
  // E2: the retired contact script (old, unhashed URL). Browsers that cached the old copy for a day
  // (plus a week of stale-while-revalidate) could still run it; this answer is an inert no-op that is
  // never stored, so a revalidation replaces the cached copy with nothing harmful.
  if(url.pathname===RETIRED_CONTACT_SCRIPT) return new Response(request.method==="HEAD"?null:RETIRED_CONTACT_BODY,{status:200,headers:applySecurityHeaders(new Headers({"content-type":"text/javascript; charset=utf-8","cache-control":"no-store","clear-site-data":RETIRED_CONTACT_CLEAR_SITE_DATA}))});
  if(retired.has(url.pathname)) return new Response("Produto retirado da superficie publica ZEVANORY.",{status:410,headers:applySecurityHeaders(new Headers({"content-type":"text/plain; charset=utf-8","cache-control":"no-store"}))});
  if(CHAT_ROUTES.has(url.pathname)) return handleSiteChatProxy(request,env);
  if(url.pathname.startsWith("/api/")||url.pathname.startsWith("/admin")) return new Response("Not found",{status:404,headers:applySecurityHeaders(new Headers())});
  if((url.pathname==="/solucoes"||url.pathname==="/solucoes/")&&(request.method==="GET"||request.method==="HEAD")&&url.searchParams.has("pagamento")){
    const back=paymentReturnPage(url.searchParams.get("pagamento"));
    if(back) return back;
  }
  let page="";
  if(url.pathname==="/"||url.pathname==="") { url.pathname="/solucoes.html"; page="solucoes"; }
  else { const key=url.pathname.replace(/^\/|\/$/g,""); if(htmlRoutes.has(key)) { url.pathname="/"+key+".html"; page=key; } }
  let response=await env.ASSETS.fetch(new Request(url,request));
  // Designed 404 for unknown PAGE paths (no file extension); asset 404s stay plain. Never cached.
  if(response.status===404&&!page&&(request.method==="GET"||request.method==="HEAD")&&!/\.[a-z0-9]{1,8}$/i.test(url.pathname)){
    const nf=await env.ASSETS.fetch(new Request(new URL("/404.html",request.url),{method:"GET"}));
    if(nf.status===200) return new Response(request.method==="HEAD"?null:nf.body,{status:404,headers:applySecurityHeaders(new Headers({"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-robots-tag":"noindex"}))});
  }
  if(response.status===200&&request.method==="GET"&&SALES_TOGGLE_PAGES.has(page)&&await salesOpenForPages(env))
    {const h=new Headers(response.headers);h.delete("content-length");response=new Response(openSalesHtml(await response.text(),page),{status:200,statusText:response.statusText,headers:h});}
  if(response.status===200&&request.method==="GET"&&shouldInjectSiteChat(page,env))
    {const h=new Headers(response.headers);h.delete("content-length");response=new Response(injectSiteChatHtml(await response.text()),{status:200,statusText:response.statusText,headers:h});}
  if(response.status===200&&page) countView(request,env,ctx,page);
  const headers=new Headers(response.headers);
  headers.set("x-robots-tag","index,follow");
  // E2 cache policy: content-hashed files under /assets/ never change -> immutable for a year;
  // unhashed CSS/JS must revalidate on every use (a stale script/stylesheet is how the retired
  // contact script kept running); unhashed images get a plain day; pages revalidate (below).
  if(response.status===200&&!page) {const cc=assetCacheControl(url.pathname);if(cc)headers.set("cache-control",cc);}
  // no-transform: the edge must not inject third-party scripts (Web Analytics beacon) into sales
  // pages — it was the only F5 performance offender and contradicts "no invasive tracking".
  // Pages whose HTML depends on the sales switch (open AND closed) are never cached: a cached open
  // page would keep showing buy CTAs after the owner closes sales.
  else if(page&&SALES_TOGGLE_PAGES.has(page)) headers.set("cache-control",SWITCH_DEPENDENT_CACHE_CONTROL);
  else if(response.status===200&&page) headers.set("cache-control",PAGE_CACHE_CONTROL);
  applySecurityHeaders(headers);
  const sku=Object.keys(BUY_SKUS).find(k=>BUY_SKUS[k]===page);
  if(response.status===200&&sku&&env?.CORE&&typeof HTMLRewriter!=="undefined"){
    const r=(await reviewSummary(env))[sku];
    if(r&&r.count>=3){
      const text=`★ ${String(r.average).replace(".",",")}/5 · ${r.count} avaliações de clientes`;
      const rewritten=carryUtm(new HTMLRewriter().on("main h1",{element(el){el.after(`<p class="review-summary">${text}</p>`,{html:true})}}).transform(new Response(response.body,{status:response.status,statusText:response.statusText,headers})),url);
      return page?compressPage(request,rewritten.body,{status:rewritten.status,statusText:rewritten.statusText,headers}):rewritten;
    }
  }
  if(response.status===200&&page){const carried=carryUtm(new Response(response.body,{status:response.status,statusText:response.statusText,headers}),new URL(request.url));return compressPage(request,carried.body,{status:carried.status,statusText:carried.statusText,headers});}
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}};