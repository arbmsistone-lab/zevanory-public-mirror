import test from 'node:test';
import assert from 'node:assert/strict';
import { attachRequestContext } from '../src/observability.mjs';
import { liveProbe } from '../src/statusProbes.mjs';

function mock(method='GET', headers={}) {
  const out={};
  return { req:{method,headers}, res:{statusCode:200,body:'',setHeader(k,v){out[k.toLowerCase()]=v;},end(v=''){this.body=v;return this;},headers:out} };
}

test('request context preserves only safe request ids',()=>{
  const safe=mock('GET',{'x-request-id':'req-12345678'});
  const context=attachRequestContext(safe.req,safe.res,'/x');
  assert.equal(context.requestId,'req-12345678');
  const unsafe=mock('GET',{'x-request-id':'bad id'});
  const generated=attachRequestContext(unsafe.req,unsafe.res,'/x');
  assert.notEqual(generated.requestId,'bad id');
  assert.equal(unsafe.res.headers['x-request-id'],generated.requestId);
});

test('liveness endpoint is dependency independent and correlated',()=>{
  const {req,res}=mock('GET',{'x-request-id':'live-12345678'});
  liveProbe(req,res);
  const body=JSON.parse(res.body);
  assert.equal(res.statusCode,200);assert.equal(body.live,true);assert.equal(body.request_id,'live-12345678');assert.equal(res.headers['x-request-id'],'live-12345678');
});