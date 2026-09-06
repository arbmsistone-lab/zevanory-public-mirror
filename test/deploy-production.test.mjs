import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReleaseMetadata, verifyProductionRelease, vercelRunnerConfig } from '../scripts/deploy-production.mjs';

const sha='a'.repeat(40);

test('production deploy accepts only clean current origin/main',()=>{
  assert.deepEqual(validateReleaseMetadata({sha,ref:'main',status:'',remoteSha:sha}),{sha,ref:'main'});
});

test('production deploy rejects dirty worktree',()=>{
  assert.throws(()=>validateReleaseMetadata({sha,ref:'main',status:' M api/release.mjs',remoteSha:sha}),/clean_worktree/);
});

test('production deploy rejects non-main branch',()=>{
  assert.throws(()=>validateReleaseMetadata({sha,ref:'feature/test',status:'',remoteSha:sha}),/main_branch/);
});

test('production deploy rejects malformed SHA',()=>{
  assert.throws(()=>validateReleaseMetadata({sha:'bad',ref:'main',status:'',remoteSha:sha}),/sha_invalid/);
});

test('production deploy rejects stale local main',()=>{
  assert.throws(()=>validateReleaseMetadata({sha,ref:'main',status:'',remoteSha:'b'.repeat(40)}),/head_not_origin_main/);
});
test('production deploy rejects invalid remote main SHA',()=>{
  assert.throws(()=>validateReleaseMetadata({sha,ref:'main',status:'',remoteSha:'bad'}),/remote_main_sha_invalid/);
});

test('post-deploy verification requires exact public SHA',()=>{
  assert.equal(verifyProductionRelease({deployment:{commit_sha:sha}},sha),true);
  assert.throws(()=>verifyProductionRelease({deployment:{commit_sha:'b'.repeat(40)}},sha),/public_sha_mismatch/);
  assert.throws(()=>verifyProductionRelease({},sha),/public_sha_mismatch/);
});

test('production deploy uses Windows shell for npx command shims',()=>{
  assert.deepEqual(vercelRunnerConfig('win32'),{command:'npx',shell:true});
});

test('production deploy avoids shell on POSIX',()=>{
  assert.deepEqual(vercelRunnerConfig('linux'),{command:'npx',shell:false});
});
