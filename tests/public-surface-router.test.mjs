import test from "node:test";
import assert from "node:assert/strict";
import router from "../worker/public-surface-router.mjs";
const go=p=>router.fetch(new Request("https://zevanory.api.br"+p));
test("apex home goes to the public storefront, never to the owner panel",async()=>{
 const r=await go("/?utm_source=x");assert.equal(r.status,308);
 assert.equal(r.headers.get("location"),"https://vendas.zevanory.api.br/solucoes?utm_source=x");
 assert.doesNotMatch(r.headers.get("location"),/controle\./);
});
test("product paths keep converging on the sales host",async()=>{
 const r=await go("/ia-na-pratica");assert.equal(r.status,308);assert.equal(r.headers.get("location"),"https://vendas.zevanory.api.br/ia-na-pratica");
});
test("retired products stay 410",async()=>{assert.equal((await go("/arbm-one")).status,410);});
