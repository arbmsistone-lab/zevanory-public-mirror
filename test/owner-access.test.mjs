import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyOwnerCredential,setOwnerCredential,createOwnerSession,verifyOwnerSession,ownerCookie,readOwnerCookie} from '../src/ownerAccess.mjs';
const env={OWNER_DASHBOARD_SECRET:'A'.repeat(48)};
test('owner credential is fail-closed and constant contract',async()=>{
  assert.equal(await verifyOwnerCredential(env,'A'.repeat(48)),true);
  assert.equal(await verifyOwnerCredential(env,'B'.repeat(48)),false);
  assert.equal(await verifyOwnerCredential({},'A'.repeat(48)),false);
});
test('owner session is signed, unique and cookie hardened',async()=>{
  const a=await createOwnerSession(env),b=await createOwnerSession(env);
  assert.notEqual(a,b);assert.equal(await verifyOwnerSession(env,a),true);
  assert.equal(await verifyOwnerSession({OWNER_DASHBOARD_SECRET:'B'.repeat(48)},a),false);
  const cookie=ownerCookie(a);assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Strict/);
  const request=new Request('https://zevanory.api.br/central',{headers:{cookie}});
  assert.equal(readOwnerCookie(request),a);
});
test('owner credential v2 stores only keyed verifier and accepts 8 chars',async()=>{
  const store=new Map();
  const kv={get:async k=>store.get(k)??null,put:async(k,v)=>store.set(k,v)};
  await setOwnerCredential(env,kv,'Abcd1234');
  const raw=store.get('owner:credential:v1');
  assert.ok(raw);assert.equal(raw.includes('Abcd1234'),false);
  const parsed=JSON.parse(raw);assert.equal(parsed.v,2);assert.ok(parsed.salt);assert.ok(parsed.hash);
  assert.equal(await verifyOwnerCredential(env,'Abcd1234',kv),true);
  assert.equal(await verifyOwnerCredential(env,'Wrong123',kv),false);
});
