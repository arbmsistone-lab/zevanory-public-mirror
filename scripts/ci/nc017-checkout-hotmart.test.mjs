import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {MP_PHASE1_CHECKOUT_ENABLED,isMpPhase1CheckoutEnabled} from "../../worker/nc015-sales-scope.mjs";
import sales,{HOTMART_TEXT,hotmartPage,HOTMART_CHECKOUT} from "../../worker/sales-public-worker.mjs";
import central from "../../worker/cloudflare-worker.compat.mjs";

const read=slug=>readFileSync(new URL("../../sales-public/"+slug+".html",import.meta.url),"utf8");
const ctx={waitUntil(){}};
const req=(path,method="GET")=>new Request("https://vendas.zevanory.api.br"+path,{method,headers:{"user-agent":"Mozilla/5.0 Chrome/137"}});
// D12 (19/11/2026): a rota /comprar -> /hotmart depende SÓ do interruptor Hotmart por produto (/api/sales/hotmart-status
// com a lista `products`), nunca do checkout próprio (/api/sales/status). `own` = checkout próprio; `hotmart` = corpo do
// hotmart-status (null = fechado). O fake recusa qualquer outra chamada (nenhuma ponte para o checkout próprio).
const HM_OPEN_IA={open:true,channel:"hotmart",products:["ia-na-pratica"]};
const env=(own,hotmart=null)=>({MP_PHASE1_CHECKOUT_ENABLED:"true",CORE:{fetch:async input=>{
 const url=typeof input==="string"?input:input.url;
 if(url==="https://zevanory.api.br/api/sales/hotmart-status")return Response.json(hotmart??{open:false,channel:"hotmart",products:[]});
 assert.equal(url,"https://zevanory.api.br/api/sales/status","no own checkout bridge");
 return Response.json({open:own==="open"});
}},ASSETS:{fetch:async request=>new Response(read(new URL(request.url).pathname.replace(/^\//,"").replace(/\.html$/,"")),{status:200})}});

test("DEC05: code lock cannot be enabled by an env override or open owner switch",async()=>{
 assert.equal(MP_PHASE1_CHECKOUT_ENABLED,false);
 assert.equal(isMpPhase1CheckoutEnabled(),false);
 for(const mode of ["closed","open"]){
  const r=await sales.fetch(req("/comprar/ZEV-IA-011","POST"),env(mode,mode==="open"?HM_OPEN_IA:null),ctx);
  assert.equal(r.status,503,mode);
  assert.equal(r.headers.get("location"),null);
  assert.match(String(r.headers.get("cache-control")),/no-store/);
 }
 const paused=await sales.fetch(req("/comprar/ZEV-IA-011"),env("closed"),ctx);
 assert.equal(paused.status,200);
 assert.match(await paused.text(),/Vendas abrem em breve/);
});

test("DEC05: GET/HEAD of own buy route only reaches gated Hotmart variant, per product (D12)",async()=>{
 for(const method of ["GET","HEAD"]){
  // Produto autorizado na lista do interruptor Hotmart: redireciona para a variante Hotmart.
  const r=await sales.fetch(req("/comprar/ZEV-IA-011",method),env("closed",HM_OPEN_IA),ctx);
  assert.equal(r.status,302,method+" autorizado");
  assert.equal(r.headers.get("location"),"/hotmart/ia-na-pratica");
  assert.match(String(r.headers.get("cache-control")),/no-store/);
  assert.equal(r.headers.get("x-robots-tag"),"noindex, nofollow");
  const closed=async(path,e,why)=>{const x=await sales.fetch(req(path,method),e,ctx);assert.equal(x.status,200,method+" "+why);assert.equal(x.headers.get("location"),null,method+" "+why);};
  // Produto fora da lista: não redireciona.
  await closed("/comprar/ZEV-VEN-011",env("closed",HM_OPEN_IA),"fora da lista");
  // Registro legado/incompleto (open sem `products`) ou lista vazia: fechado.
  await closed("/comprar/ZEV-IA-011",env("closed",{open:true,channel:"hotmart"}),"legado sem products");
  await closed("/comprar/ZEV-IA-011",env("closed",{open:true,channel:"hotmart",products:[]}),"lista vazia");
  // Checkout próprio aberto NÃO reabre a rota Hotmart.
  await closed("/comprar/ZEV-IA-011",env("open",null),"checkout próprio aberto, Hotmart fechado");
 }
});

test("DEC05: central internal and direct checkouts deny before touching provider",async()=>{
 for(const url of ["https://checkout.internal/api/checkout/mercadopago",
    "https://zevanory.api.br/api/checkout/mercadopago",
    "https://zevanory.api.br/api/checkout/stripe"]){
   const r=await central.fetch(new Request(url,{method:"POST",headers:{
    "content-type":"application/json","x-certification-pilot-token":"synthetic-pilot-token"
   },body:JSON.stringify({offer_id:"ZEV-IA-011",request_id:"a",session_id:"b"})}),
   {MP_PHASE1_CHECKOUT_ENABLED:"true",SALE_GLOBALLY_ENABLED:"true"},ctx);
   assert.equal(r.status,503,url);
   const body=await r.json();
   assert.equal(body.error,"phase1_hotmart_only");
 }
});

test("F-b: every Hotmart rewrite input exists and variant removes own checkout claims",()=>{
 const slugs=Object.keys(HOTMART_CHECKOUT);
 assert.equal(slugs.length,5);
 for(const slug of slugs){
   const html=read(slug);
   // Every pair must consume its source IN ORDER (as hotmartPage applies them): a pair whose
   // source no longer exists, or that an earlier generic pair already rewrote, silently stops
   // rewriting and is rejected here.
   let seq=html;
   HOTMART_TEXT.forEach(([source,target],i)=>{
     assert.ok(seq.includes(source),`${slug} pair ${i} source missing: ${source.slice(0,60)}`);
     seq=seq.split(source).join(target);
   });
   const variant=hotmartPage(html,slug,"https://pay.hotmart.com/X123ABC");
   const visible=variant.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g,"");
   assert.ok(visible.includes('href="https://pay.hotmart.com/X123ABC"'),slug+" real Hotmart CTA");
   assert.doesNotMatch(visible,/Mercado Pago|pedir-reembolso|entrega\/reenviar/,slug);
   assert.throws(()=>hotmartPage(html.replace("</main>","<p>Mercado Pago</p></main>"),slug,"https://pay.hotmart.com/X123ABC"),/hotmart_copy_rewrite_incomplete/);
 }
});
