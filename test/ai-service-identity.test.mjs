import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { aiServicePublicIdentity, signAiGatewayRequest, AI_GATEWAY_PATH } from '../src/aiServiceIdentity.mjs';

test('service identity derives stable public key without exposing secret',()=>{
  const a=aiServicePublicIdentity('unit-secret-a'),b=aiServicePublicIdentity('unit-secret-a'),c=aiServicePublicIdentity('unit-secret-b');
  assert.deepEqual(a,b);assert.notEqual(a.fingerprint,c.fingerprint);
  assert.equal(a.algorithm,'Ed25519');assert.ok(!JSON.stringify(a).includes('unit-secret-a'));
});

test('gateway signature verifies against derived public key and exact body',()=>{
  const secret='unit-secret-a',timestamp=1700000000,nonce='fixed-nonce-123456';
  const signed=signAiGatewayRequest({secret,body:{input:'safe research only'},timestamp,nonce});
  const id=aiServicePublicIdentity(secret);
  const canonical=`v1\n${timestamp}\n${nonce}\n${signed.headers['x-zevanory-body-sha256']}\n${AI_GATEWAY_PATH}`;
  const publicKey=createPublicKey({key:Buffer.from(id.public_key_spki,'base64url'),format:'der',type:'spki'});
  assert.equal(verify(null,Buffer.from(canonical),publicKey,Buffer.from(signed.headers['x-zevanory-signature'],'base64url')),true);
});
