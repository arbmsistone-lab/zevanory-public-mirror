import test from 'node:test';
import assert from 'node:assert/strict';
import { safeBearerEqual, validatePublicApiRequest } from '../src/security.mjs';

const env = { PUBLIC_BASE_URL: 'https://zevanory.api.br' };
const req = (headers={}) => ({ headers });

test('operator bearer comparison is fail closed and length hardened', () => {
  assert.equal(safeBearerEqual('short','short'), false);
  const token='operator-token-1234567890123456';
  assert.equal(safeBearerEqual(token,token), true);
  assert.equal(safeBearerEqual(token,token+'x'), false);
});

test('public event API enforces JSON and payload limit', () => {
  assert.deepEqual(validatePublicApiRequest(req({'content-type':'text/plain'}),env), {ok:false,status:415,error:'json_required'});
  assert.deepEqual(validatePublicApiRequest(req({'content-type':'application/json','content-length':'5000'}),env), {ok:false,status:413,error:'payload_too_large'});
});

test('public event API rejects foreign origins but permits same-origin or absent origin', () => {
  assert.equal(validatePublicApiRequest(req({'content-type':'application/json','origin':'https://evil.example'}),env).status,403);
  assert.equal(validatePublicApiRequest(req({'content-type':'application/json','origin':'https://zevanory.api.br'}),env).ok,true);
  assert.equal(validatePublicApiRequest(req({'content-type':'application/json'}),env).ok,true);
});
