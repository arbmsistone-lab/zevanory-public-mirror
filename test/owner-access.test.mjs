import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyOwnerCredential,createOwnerSession,verifyOwnerSession,ownerCookie,readOwnerCookie} from '../src/ownerAccess.mjs';
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