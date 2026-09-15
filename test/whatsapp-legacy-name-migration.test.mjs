import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/config.mjs';

function response(){return {statusCode:200,headers:{},body:'',setHeader(k,v){this.headers[k]=v;},end(v=''){this.body=String(v);}};}
const flags=['SALE_GLOBALLY_ENABLED','PRE_SALE_GATES_APPROVED','CHECKOUT_ENABLED','WHATSAPP_SALES_ENABLED','FINANCIAL_EVENTS_ENABLED'];

test('legacy WhatsApp name migration is fixed, gated and idempotent',async()=>{
  const oldFetch=global.fetch,oldEnv={}; for(const k of [...flags,'WHATSAPP_ACCESS_TOKEN','WHATSAPP_PHONE_NUMBER_ID','META_GRAPH_VERSION','DATABASE_URL']) oldEnv[k]=process.env[k];
  try{
    for(const k of flags) process.env[k]='false'; process.env.WHATSAPP_ACCESS_TOKEN='test-only'; process.env.WHATSAPP_PHONE_NUMBER_ID='123456'; process.env.META_GRAPH_VERSION='v26.0'; delete process.env.DATABASE_URL;
    const calls=[]; global.fetch=async(url,init={})=>{calls.push({url:String(url),method:init.method||'GET',body:init.body||null}); if(calls.length===1)return new Response(JSON.stringify({id:'123456',display_phone_number:'558892340423',verified_name:'Giro Local',name_status:'AVAILABLE_WITHOUT_REVIEW',quality_rating:'GREEN'}),{status:200}); if(calls.length===2)return new Response(JSON.stringify({success:true}),{status:200}); return new Response(JSON.stringify({id:'123456',display_phone_number:'558892340423',verified_name:'Giro Local',new_name_status:'PENDING',name_status:'AVAILABLE_WITHOUT_REVIEW',quality_rating:'GREEN'}),{status:200});};
    const res=response(); await handler({url:'/api/config?view=whatsapp_display_name_migrate_legacy',method:'POST',headers:{}},res); const body=JSON.parse(res.body);
    assert.equal(res.statusCode,200); assert.equal(body.ok,true); assert.equal(body.state,'submitted'); assert.equal(calls.length,3); assert.equal(calls[1].method,'POST'); assert.equal(JSON.parse(calls[1].body).new_display_name,'ZEVANORY');
  } finally {global.fetch=oldFetch; for(const [k,v] of Object.entries(oldEnv)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});
