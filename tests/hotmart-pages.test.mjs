import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {hotmartPage,HOTMART_CHECKOUT} from "../worker/sales-public-worker.mjs";
const slugs=["ia-na-pratica","vendas-na-pratica","lucro-e-caixa","combo-ia-vendas","negocio-completo"];
test("hotmart variant: buy buttons go to Hotmart, no Mercado Pago or own-refund text, not indexed",()=>{
  for(const slug of slugs){
    const html=readFileSync(new URL("../sales-public/"+slug+".html",import.meta.url),"utf8");
    const out=hotmartPage(html,slug,"https://pay.hotmart.com/X123ABC");
    assert.doesNotMatch(out,/href="\/comprar\//,slug);
    assert.match(out,/href="https:\/\/pay\.hotmart\.com\/X123ABC"/);
    assert.doesNotMatch(out.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g,""),/Mercado Pago|pedir-reembolso|entrega\/reenviar/,slug);
    assert.match(out,/<meta name="robots" content="noindex,follow">/);
  }
  assert.deepEqual(Object.keys(HOTMART_CHECKOUT).sort(),slugs.slice().sort());
});
test("all five Hotmart checkout links are official pay.hotmart.com offers",()=>{
  for(const [slug,link] of Object.entries(HOTMART_CHECKOUT))
    assert.match(link,/^https:\/\/pay\.hotmart\.com\/[A-Za-z0-9]+\?off=[a-z0-9]+$/,slug);
});
