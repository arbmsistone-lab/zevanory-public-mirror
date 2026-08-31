import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReleaseMetadata, vercelRunnerConfig } from '../scripts/deploy-production.mjs';

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

test('production deploy uses Windows shell for npx command shims',()=>{
  assert.deepEqual(vercelRunnerConfig('win32'),{command:'npx',shell:true});
});

test('production deploy avoids shell on POSIX',()=>{
  assert.deepEqual(vercelRunnerConfig('linux'),{command:'npx',shell:false});
});
