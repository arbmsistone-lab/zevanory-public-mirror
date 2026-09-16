import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/config.mjs';

function response(){return {statusCode:200,headers:{},body:'',setHeader(k,v){this.headers[k]=v;},end(v=''){this.body=String(v);}};}

for(const view of ['whatsapp_display_name_migrate_legacy','whatsapp_display_name_update']){
  test(`${view} mutation endpoint is not exposed in steady state`,async()=>{
    const res=response();
    await handler({url:`/api/config?view=${view}`,method:'POST',headers:{}},res);
    assert.equal(res.statusCode,405);
    assert.deepEqual(JSON.parse(res.body),{error:'method_not_allowed'});
  });
}
