import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';

const policy=JSON.parse(fs.readFileSync('config/secret-lifecycle.json','utf8'));
const bindings=JSON.parse(fs.readFileSync('config/secret-binding-evidence.json','utf8'));

test('secret lifecycle classifies critical credential references without storing values',()=>{
  assert.equal(policy.rules.metadataOnly,true);
  assert.equal(policy.rules.neverStoreSecretMaterial,true);
  assert.equal(bindings.containsSecretMaterial,false);
  assert.equal(bindings.evidenceType,'deployment_binding_metadata');
  assert.ok(policy.credentials.length>=12);
  assert.doesNotMatch(JSON.stringify({policy,bindings}),/(?:sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]{20,}|PRIVATE KEY)/);
});

test('secret lifecycle audit passes for configured preview bindings with fresh metadata',()=>{
  const run=spawnSync(process.execPath,['scripts/secret-lifecycle-audit.mjs'],{
    encoding:'utf8',
    env:{...process.env,SECURITY_LIFECYCLE_NOW:'2026-09-18T23:15:00Z',DATABASE_URL:'metadata-only-test',CREATIVE_ASSET_SIGNING_KEY:'metadata-only-test'}
  });
  assert.equal(run.status,0,run.stderr||run.stdout);
  const result=JSON.parse(run.stdout);
  assert.equal(result.status,'PASS');
  assert.equal(result.failures.length,0);
  assert.ok(result.discovered.includes('DATABASE_URL'));
  assert.ok(result.discovered.includes('META_APP_SECRET'));
});

test('configured secret without binding evidence fails closed',()=>{
  const run=spawnSync(process.execPath,['scripts/secret-lifecycle-audit.mjs'],{
    encoding:'utf8',
    env:{...process.env,SECURITY_LIFECYCLE_NOW:'2026-09-18T23:15:00Z',WHATSAPP_ACCESS_TOKEN:'metadata-only-test'}
  });
  assert.notEqual(run.status,0);
  const result=JSON.parse(run.stdout);
  assert.ok(result.failures.includes('binding_evidence_missing:WHATSAPP_ACCESS_TOKEN'));
});
