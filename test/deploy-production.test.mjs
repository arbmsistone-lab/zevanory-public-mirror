import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReleaseMetadata } from '../scripts/deploy-production.mjs';

test('production deploy accepts only clean main with immutable SHA',()=>{
  const sha='a'.repeat(40);
  assert.deepEqual(validateReleaseMetadata({sha,ref:'main',status:''}),{sha,ref:'main'});
});

test('production deploy rejects dirty worktree',()=>{
  assert.throws(()=>validateReleaseMetadata({sha:'a'.repeat(40),ref:'main',status:' M api/release.mjs'}),/clean_worktree/);
});

test('production deploy rejects non-main branch',()=>{
  assert.throws(()=>validateReleaseMetadata({sha:'a'.repeat(40),ref:'feature/test',status:''}),/main_branch/);
});

test('production deploy rejects malformed SHA',()=>{
  assert.throws(()=>validateReleaseMetadata({sha:'bad',ref:'main',status:''}),/sha_invalid/);
});
