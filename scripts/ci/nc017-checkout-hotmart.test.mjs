import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {MP_PHASE1_CHECKOUT_ENABLED,isMpPhase1CheckoutEnabled} from "../../worker/nc015-sales-scope.mjs";
import sales,{HOTMART_TEXT,hotmartPage,HOTMART_CHECKOUT} from "../../worker/sales-public-worker.mjs";
import central from "../../worker/cloudflare-worker.compat.mjs";

const read=slug=>readFileSync(new URL("../../sales-public/"+slug+".html",import.meta.url),"utf8");
const ctx={waitUntil(){}};
const req=(path,method="GET")=>new Request("https://vendas.zevanory.api.br"+path,{method,headers:{"user-agent":"Mozilla/5.0 Chrome/137"}});
const env=(status)=>({MP_PHASE1_CHECKOUT_ENABLED:"true",CORE:{fetch:async input=>{
 const url=typeof input==="string"?input:input.url;
 assert.equal(url,"https://zevanory.api.br/api/sales/status","no own checkout bridge");
 return Response.json({open:status==="open"});
}},ASSETS:{fetch:async request=>new Response(read(new URL(request.url).pathname.replace(/^\//,"").replace(/\.html$/,"")),{status:200})}});

test("DEC05: code lock cannot be enabled by an env override or open owner switch",async()=>{
 assert.equal(MP_PHASE1_CHECKOUT_ENABLED,false);
 assert.equal(isMpPhase1CheckoutEnabled(),false);
 for(const mode of ["closed","open"]){
  const r=await sales.fetch(req("/comprar/ZEV-IA-011","POST"),env(mode),ctx);
  assert.equal(r.status,503,mode);
  assert.equal(r.headers.get("location"),null);
  assert.match(String(r.headers.get("cache-control")),/no-store/);
 }
 const paused=await sales.fetch(req("/comprar/ZEV-IA-011"),env("closed"),ctx);
 assert.equal(paused.status,200);
 assert.match(await paused.text(),/Vendas abrem em breve/);
});

test("DEC05: GET/HEAD of own buy route only reaches gated Hotmart variant",async()=>{
 for(const method of ["GET","HEAD"]){
  const r=await sales.fetch(req("/comprar/ZEV-IA-011",method),env("open"),ctx);
  assert.equal(r.status,302);
  assert.equal(r.headers.get("location"),"/hotmart/ia-na-pratica");
  assert.match(String(r.headers.get("cache-control")),/no-store/);
  assert.equal(r.headers.get("x-robots-tag"),"noindex, nofollow");
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
   // Optional legacy/new generator variants are allowed, but at least one
   // payment marker and the exact published overlay must be consumed.
   const matching=HOTMART_TEXT.filter(([source])=>html.includes(source));
   assert.ok(matching.length>=4,slug+" insufficient exact rewrite coverage");
   assert.ok(matching.some(([source])=>source.includes("Pagamento processado pelo Mercado Pago")),slug+" missing payment processor source");
   assert.ok(matching.some(([source])=>source.includes("Entrega por e-mail após a confirmação do pagamento (Pix ou cartão pelo Mercado Pago)") || source.includes("Pagamento por Pix à vista ou cartão na plataforma indicada")),slug+" missing current or legacy offer overlay source");
   const variant=hotmartPage(html,slug,"https://pay.hotmart.com/X123ABC");
   const visible=variant.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g,"");
   assert.ok(visible.includes('href="https://pay.hotmart.com/X123ABC"'),slug+" real Hotmart CTA");
   assert.doesNotMatch(visible,/Mercado Pago|pedir-reembolso|entrega\/reenviar/,slug);
   assert.throws(()=>hotmartPage(html.replace("</main>","<p>Mercado Pago</p></main>"),slug,"https://pay.hotmart.com/X123ABC"),/hotmart_copy_rewrite_incomplete/);
 }
});
