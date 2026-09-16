import test from 'node:test';
import assert from 'node:assert/strict';
import { aiVaultStatus, deriveAiVaultIngestToken, loadAiVaultSecret, storeAiVaultSecret } from '../src/aiSecretVault.mjs';

const memoryKv=()=>{
  const m=new Map();
  return {put:async(k,v)=>m.set(k,v),get:async(k)=>m.get(k)??null,raw:m};
};

test('AI vault encrypts provider secrets and never stores plaintext',async()=>{
  const kv=memoryKv(),master='x'.repeat(48),secret='gsk_example_secret_123456789';
  const saved=await storeAiVaultSecret('groq',secret,{kv,master});
  assert.equal(saved.encrypted,true);
  const raw=kv.raw.get('ai-vault:groq');
  assert.ok(raw&&!raw.includes(secret));
  assert.equal(await loadAiVaultSecret('groq',{kv,master}),secret);
});

test('AI vault status exposes names only and derived token is deterministic',async()=>{
  const kv=memoryKv(),master='y'.repeat(48);
  await storeAiVaultSecret('openrouter','sk-or-example-secret-123456789',{kv,master});
  const status=await aiVaultStatus({kv});
  assert.deepEqual(status.providers,['openrouter']);
  assert.equal(status.encrypted,true);
  assert.equal(await deriveAiVaultIngestToken(master),await deriveAiVaultIngestToken(master));
});

test('AI vault HTTP module resolves its canonical implementation',async()=>{const mod=await import('../src/http/aiVault.mjs');assert.equal(typeof mod.default,'function');});
