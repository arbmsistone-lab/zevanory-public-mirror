import test from "node:test";
import assert from "node:assert/strict";
import {REQUIRED,isCheckoutRoute,allowCheckout,isProductionPilotBlocked,evaluateCheckout,requiresPilotDenial,verifyProductionToken} from "../worker/commercial-checkout-guard.mjs";
test("every one of 512 flag combinations fails closed except all true",()=>{
 let passing=0;
 for(let mask=0;mask<2**REQUIRED.length;mask++){
  const flags=Object.fromEntries(REQUIRED.map((f,i)=>[f,Boolean(mask&(1<<i))]));
  const allow=allowCheckout(flags);
  assert.equal(allow,mask===2**REQUIRED.length-1,"mask "+mask);
  if(allow)passing++;
 }
 assert.equal(passing,1);
});
test("all public and legacy checkout routes use shared matcher",()=>{
 for(const path of ["/api/checkout","/api/checkout/asaas","/api/checkout/mercadopago","/api/checkout/stripe","/checkout","/checkout/x","/comprar","/comprar/ZEV-IA-011","/api/payment/checkout","/api/payments/checkout"]){
   assert.equal(isCheckoutRoute(path),true,path);
 }
 for(const path of ["/api/webhooks/mercadopago","/api/status","/api/internal/certification/e2e/status","/api/reviews/summary"]){
   assert.equal(isCheckoutRoute(path),false,path);
 }
});
test("runtime preflight, owner KV, production mode and token must agree",async()=>{
 const at=Date.parse("2026-10-08T17:00:00Z");
 const cfg={SALE_GLOBALLY_ENABLED:"true",PRE_SALE_GATES_APPROVED:"true",ABSOLUTE_RELEASE_APPROVED:"true",CHECKOUT_ENABLED:"true",FINANCIAL_EVENTS_ENABLED:"true",MERCADOPAGO_ENV:"production",ZEVANORY_PRIVATE_ARTIFACTS:{get:async()=>JSON.stringify({ok:true,at:new Date(at-4000).toISOString()})}};
 const check=await evaluateCheckout(cfg,{enabled:true},{now:at,verify:async()=>true});
 assert.equal(check.allowed,true);
 assert.equal((await evaluateCheckout(cfg,{enabled:true},{now:at,verify:async()=>false})).allowed,false);
 assert.equal((await evaluateCheckout(cfg,{enabled:false},{now:at,verify:async()=>true})).allowed,false);
 assert.equal((await evaluateCheckout({...cfg,MERCADOPAGO_ENV:"sandbox"},{enabled:true},{now:at,verify:async()=>true})).allowed,false);
 assert.equal((await evaluateCheckout({...cfg,ZEVANORY_PRIVATE_ARTIFACTS:{get:async()=>JSON.stringify({ok:true,at:new Date(at-4*3600000).toISOString()})}},{enabled:true},{now:at,verify:async()=>true})).allowed,false);
});
test("production certification invite write is blocked by default",async()=>{
 assert.equal(isProductionPilotBlocked({MERCADOPAGO_ENV:"production"}),true);
 assert.equal(isProductionPilotBlocked({MERCADOPAGO_ENV:"production",CERTIFICATION_PILOT_PRODUCTION_ALLOWED:"false"}),true);
 assert.equal(isProductionPilotBlocked({MERCADOPAGO_ENV:"production",CERTIFICATION_PILOT_PRODUCTION_ALLOWED:"true"}),false);
 assert.equal(await requiresPilotDenial(new Request("https://zevanory.api.br/api/internal/certification/e2e/invite",{method:"POST"}),{MERCADOPAGO_ENV:"production"}),true);
 assert.equal(await requiresPilotDenial(new Request("https://zevanory.api.br/api/events/operator",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"certification_pilot_invite_create"})}),{MERCADOPAGO_ENV:"production"}),true);
});
test("unknown/unverified production token never passes",async()=>{
 assert.equal(await verifyProductionToken({MERCADOPAGO_ACCESS_TOKEN:"TEST-foo",MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16:"a".repeat(16)}),false);
 assert.equal(await verifyProductionToken({MERCADOPAGO_ACCESS_TOKEN:"APP_USR-"+"x".repeat(40),MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16:""}),false);
});
