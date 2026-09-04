import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';

const policy=JSON.parse(fs.readFileSync('config/secret-lifecycle.json','utf8'));

test('secret lifecycle classifies all critical credential references without storing values',()=>{
  assert.equal(policy.rules.metadataOnly,true);
  assert.equal(policy.rules.neverStoreSecretMaterial,true);
  assert.ok(policy.credentials.length>=12);
  assert.doesNotMatch(JSON.stringify(policy),/(?:sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]{20,}|PRIVATE KEY)/);
});

test('secret lifecycle audit is fail-closed and current',()=>{
  const run=spawnSync(process.execPath,['scripts/secret-lifecycle-audit.mjs'],{
    encoding:'utf8',env:{...process.env,SECURITY_LIFECYCLE_NOW:'2026-09-04T18:00:00Z'}
  });
  assert.equal(run.status,0,run.stderr||run.stdout);
  const result=JSON.parse(run.stdout);
  assert.equal(result.status,'PASS');
  assert.equal(result.failures.length,0);
  assert.ok(result.discovered.includes('DATABASE_URL'));
  assert.ok(result.discovered.includes('META_APP_SECRET'));
});
