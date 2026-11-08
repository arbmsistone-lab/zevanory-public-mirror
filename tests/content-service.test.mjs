import test from "node:test";
import assert from "node:assert/strict";
import * as CS from "../worker/content-service.mjs";
import {routeHotmartNc011,routeBriefingNc011,routePackageNc011} from "../worker/cp-nc011-routing.mjs";
class MapKV {
 data=new Map();
 async get(k){return this.data.get(k)||null}
 async put(k,v){if(k.startsWith("zpc:cp:"))throw Error("legacy_cp_writer_forbidden");this.data.set(k,String(v))}
 async delete(k){if(k.startsWith("zpc:cp:"))throw Error("legacy_cp_delete_forbidden");this.data.delete(k)}
 // NC-989-04: o postback recalcula o balde de vendas pela listagem do KV (API real do Workers KV).
 async list({prefix=""}={}){return {keys:[...this.data.keys()].filter(k=>k.startsWith(prefix)).sort().map(name=>({name})),list_complete:true}}
}
const token="hottok-test-1234567890abcdef";
function post(body,tok=token){
 return new Request("https://zevanory.api.br/api/webhooks/hotmart",{method:"POST",
  headers:{"content-type":"application/json","x-hotmart-hottok":tok},body:JSON.stringify(body)});
}
const digital=(event,txn)=>({event,data:{product:{id:8704733,name:"ZEVANORY IA na Prática"},purchase:{transaction:txn,status:"APPROVED",price:{value:97}}}});
test("NC012 authenticated digital-products Hotmart callback never writes zpc:cp:*",async()=>{
 const kv=new MapKV();
 const env={HOTMART_HOTTOK:token,HOTMART_SERVICE_PRODUCT_IDS:"8704905",ZEVANORY_PRIVATE_ARTIFACTS:kv};
 const r=await routeHotmartNc011(post(digital("PURCHASE_APPROVED","D001")),env);
 assert.equal(r.status,200);
 assert.equal((await r.json()).scope,"digital_product");
 assert.ok([...kv.data.keys()].some(k=>k.startsWith("zpc:sales:")));
 assert.equal([...kv.data.keys()].filter(k=>k.startsWith("zpc:cp:")).length,0);
 const repeated=await routeHotmartNc011(post(digital("PURCHASE_COMPLETE","D001")),env);
 assert.equal(repeated.status,200);
 assert.equal((await repeated.json()).duplicate,true);
});
test("NC012 Hottok missing, bad token and invalid digital event fail closed",async()=>{
 const env={HOTMART_HOTTOK:token,HOTMART_SERVICE_PRODUCT_IDS:"8704905",ZEVANORY_PRIVATE_ARTIFACTS:new MapKV()};
 assert.equal((await routeHotmartNc011(post(digital("PURCHASE_APPROVED","D001"),"wrong"),env)).status,401);
 assert.equal((await routeHotmartNc011(post(digital("PURCHASE_APPROVED","D001")),{...env,HOTMART_HOTTOK:""})).status,503);
 assert.equal((await routeHotmartNc011(post(digital("UNKNOWN","D001")),env)).status,422);
});
test("NC012 CP can never fall back to KV when DO binding absent",async()=>{
 const kv=new MapKV(),env={HOTMART_HOTTOK:token,HOTMART_SERVICE_PRODUCT_IDS:"8704905",ZEVANORY_PRIVATE_ARTIFACTS:kv};
 const body={version:"2.0.0",event:"PURCHASE_APPROVED",data:{product:{id:8704905,name:"ZEVANORY Conteúdo Pronto"},purchase:{transaction:"CP000000001",recurrence_number:1},subscription:{subscriber:{code:"sub000000001"}}}};
 const r=await routeHotmartNc011(post(body),env);
 assert.equal(r.status,503);
 assert.equal([...kv.data.keys()].filter(k=>k.startsWith("zpc:cp:")).length,0);
 assert.equal((await routeBriefingNc011(new Request("https://zevanory.api.br/conteudo-pronto/briefing?t=invalid"),env)).status,404);
 assert.equal(routePackageNc011().status,503);
});
test("NC012 obsolete CP entrypoints are deleted but generation validators remain",()=>{
 assert.equal(typeof CS.handleHotmartWebhook,"undefined");
 assert.equal(typeof CS.handleBriefing,"undefined");
 assert.equal(CS.SERVICE_PRODUCT_NAME,"ZEVANORY Conteúdo Pronto");
 assert.equal(CS.PACKAGE_LINK_DAYS,120);
 assert.equal(CS.validateRoteiros([{objetivo_id:"not-a-real-objective"}]),null);
 const posts=[{tema:"fraude",legenda:"Lucro 100% garantido! ".repeat(20),cta:"Compre",hashtags:["#x"],imagem:"texto"}];
 assert.equal(CS.validatePosts(posts,1),null);
});
