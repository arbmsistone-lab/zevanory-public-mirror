import test from 'node:test';import assert from 'node:assert/strict';
import { resolveCpHotmartIngress,CpRoutingError } from '../worker/cp-do-identity.mjs';
const SECRET='HOTTOK_FOR_NC009_SYNTHETIC_TEST_1234';
const rkey='CP_DO_ROUTING_KEY_ONLY_TEST_0123456789ABCDEF';
function fixture({hottok=SECRET,product=8704905,sub='subscriber-test-a1111',txn='HP1234567890001',version='2.0.0',event='PURCHASE_APPROVED',buyer='buyer-a@test.invalid'}={}){
 const called=[];
 const env={HOTMART_HOTTOK:SECRET,HOTMART_SERVICE_PRODUCT_IDS:'8704905',CP_DO_ROUTING_KEY:rkey,CP_SUBSCRIBER_DO:{
  idFromName(name){called.push(name);return {toString:()=>name}},
  get(id){return {id:String(id)}}
 }};
 const body={version,event,data:{product:{id:product},subscription:{subscriber:{code:sub}},
  buyer:{email:buyer},purchase:{transaction:txn,approved_date:Date.UTC(2026,10,3,10,0)}}};
 const req=new Request('https://zevanory.api.br/api/webhooks/hotmart?sub=evil',{method:'POST',headers:{'x-hotmart-hottok':hottok,'content-type':'application/json'},body:JSON.stringify(body)});
 return {req,env,called};
}
async function rejected(o,code,status){await assert.rejects(resolveCpHotmartIngress(o.req,o.env),e=>e instanceof CpRoutingError&&e.code===code&&e.status===status);assert.equal(o.called.length,0)}
test('G01 Hotmart authentic POST determines stable DO identity',async()=>{
 const a=fixture(),b=fixture({buyer:'other@test.invalid',txn:'HP1234567890002'});
 const x=await resolveCpHotmartIngress(a.req,a.env),y=await resolveCpHotmartIngress(b.req,b.env);
 assert.equal(x.opaqueRoutingId,y.opaqueRoutingId);
 assert.equal(x.productId,'8704905');
 assert.match(a.called[0],/^cp-verified:[a-f0-9]{64}$/);
 assert.ok(!a.called[0].includes('subscriber-test'));
});
test('G01 wrong/empty Hottok fails before DO access',async()=>{await rejected(fixture({hottok:'wrong'}),'hotmart_not_authenticated',401);await rejected(fixture({hottok:''}),'hotmart_not_authenticated',401)});
test('G01 wrong product cannot resolve other subscriber',async()=>{await rejected(fixture({product:8704733}),'wrong_product',403)});
test('G01 unknown event/version/corrupted identity fails',async()=>{
 await rejected(fixture({event:'USER_PROFILE_CHANGED'}),'invalid_hotmart_event',422);
 await rejected(fixture({version:'1.0.0'}),'invalid_hotmart_event',422);
 await rejected(fixture({sub:'x'}),'subscriber_or_transaction_missing',422);
 await rejected(fixture({txn:'x'}),'subscriber_or_transaction_missing',422);
});
test('G01 tampered body subscriber after verified signature picks different DO, never URL param',async()=>{
 const a=fixture({sub:'subscriber-test-a1111'}),b=fixture({sub:'subscriber-test-b2222'});
 const x=await resolveCpHotmartIngress(a.req,a.env),y=await resolveCpHotmartIngress(b.req,b.env);
 assert.notEqual(x.opaqueRoutingId,y.opaqueRoutingId);
 // Authenticity depends on Hottok remaining confidential; this is not an end-to-end signature!
});
test('G01 absent DO binding/routing secret fails closed',async()=>{
 const a=fixture();delete a.env.CP_SUBSCRIBER_DO;await rejected(a,'trusted_ingress_or_binding_missing',503);
 const b=fixture();delete b.env.CP_DO_ROUTING_KEY;await rejected(b,'do_routing_key_missing',503);
});
