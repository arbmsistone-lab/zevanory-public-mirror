import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root=new URL('../infra/free-ai-gateway/',import.meta.url);
const fn=readFileSync(new URL('supabase-edge-function.ts',root),'utf8');
const sql=readFileSync(new URL('migration.sql',root),'utf8');
const manifest=JSON.parse(readFileSync(new URL('manifest.json',root),'utf8'));

test('versioned FREE AI gateway keeps hard security and zero-spend controls',()=>{
  for(const marker of ['Ed25519','x-zevanory-signature','x-zevanory-body-sha256','zevanory_ai_gateway_nonces',"b?.zero_spend!==true","['mistral','lightning']","paid_fallback_used:false"]) assert.match(fn,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.doesNotMatch(fn,/sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{12,}/);
});

test('nonce migration remains private and service-role only',()=>{
  assert.match(sql,/enable row level security/i);
  assert.match(sql,/revoke all .* anon, authenticated/i);
  assert.match(sql,/grant insert, select, delete .* service_role/i);
});

test('manifest pins deployed FREE slot and public fingerprint',()=>{
  assert.equal(manifest.zero_spend_hard,true);
  assert.equal(manifest.commercial,false);
  assert.equal(manifest.deployed_slug,'arbm-ai-three-provider-probe-20260908');
  assert.deepEqual(manifest.allowed_ai_providers,['mistral','lightning']);
  assert.equal(manifest.deployed_edge_function_version,38);
});
