import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { invokeLegacy, withSearch } from '../netlify/lib/legacy-adapter.mjs';

test('Netlify adapter preserves exact raw body for signature verification', async () => {
  const secret='test-secret';
  const payload='{"event":"payment.updated","amount":123.45}';
  const signature=createHmac('sha256',secret).update(payload).digest('hex');
  const request=new Request('https://example.test/api/webhooks/meta',{method:'POST',headers:{'content-type':'application/json','x-signature':signature},body:payload});
  const response=await invokeLegacy((req,res)=>{
    assert.equal(req.rawBody.toString('utf8'),payload);
    assert.deepEqual(req.body,{event:'payment.updated',amount:123.45});
    assert.equal(req.headers['x-signature'],signature);
    res.statusCode=202; res.setHeader('content-type','application/json'); res.end(JSON.stringify({accepted:true}));
  },request);
  assert.equal(response.status,202);
  assert.deepEqual(await response.json(),{accepted:true});
});

test('Netlify adapter rewrites route query deterministically', async () => {
  const request=new Request('https://example.test/api/health?x=1');
  const response=await invokeLegacy((req,res)=>{
    assert.equal(req.method,'GET');
    assert.equal(req.query.x,'1');
    assert.equal(req.query.probe,'health');
    assert.equal(req.url,'/api/health?x=1&probe=health');
    res.statusCode=200; res.end('ok');
  },request,{rewriteUrl:u=>withSearch(u,'probe','health')});
  assert.equal(response.status,200);
  assert.equal(await response.text(),'ok');
});

test('Netlify adapter does not invent request data', async () => {
  const request=new Request('https://example.test/api/config');
  const response=await invokeLegacy((req,res)=>{
    assert.equal(req.body,undefined);
    assert.equal(req.rawBody.length,0);
    assert.deepEqual(req.query,{});
    res.statusCode=204; res.end();
  },request);
  assert.equal(response.status,204);
});
