import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/config.mjs';

const response=()=>({headers:{},statusCode:0,body:'',setHeader(k,v){this.headers[k]=v},end(v=''){this.body+=String(v);return this}});

test('closure status is aggregate, complete and secret-safe for active scope',async()=>{
  const req={method:'GET',url:'/api/config?view=closure_status',headers:{host:'zevanory.api.br'}};
  const res=response();
  await handler(req,res);
  assert.equal(res.statusCode,200);
  const body=JSON.parse(res.body);
  assert.equal(body.service,'ZEVANORY');
  assert.equal(Object.keys(body.channels).length,9);
  assert.equal(body.distribution.total_fronts,9);
  assert.equal(body.excluded_fronts.tiktok.state,'backlog_excluded');
  assert.equal(body.excluded_fronts.linkedin.state,'backlog_excluded');
  assert.equal(body.excluded_fronts.nuvemshop.state,'backlog_excluded');
  assert.equal(typeof body.brand_identity.ready,'boolean');
  assert.equal(typeof body.certification_pilot.enabled,'boolean');
  const raw=JSON.stringify(body).toLowerCase();
  for(const forbidden of ['access_token','client_secret','api_key','channel_id','profile_url','target_url'])assert.equal(raw.includes(forbidden),false);
});
