import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReleaseMetadata, verifyDeploymentInspection, verifyPromotedDeployment, extractDeploymentUrl, vercelRunnerConfig, buildDeployArgs, buildInspectArgs, buildApiArgs, buildPromoteArgs } from '../scripts/deploy-production.mjs';

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

test('isolated deployment verification requires READY and exact authenticated SHA',()=>{
  assert.equal(verifyDeploymentInspection({readyState:'READY',meta:{gitCommitSha:sha}},sha),true);
  assert.equal(verifyDeploymentInspection({readyState:'READY',meta:{githubCommitSha:sha}},sha),true);
  assert.throws(()=>verifyDeploymentInspection({readyState:'BUILDING',meta:{gitCommitSha:sha}},sha),/deploy_not_ready/);
  assert.throws(()=>verifyDeploymentInspection({readyState:'READY',meta:{gitCommitSha:'b'.repeat(40)}},sha),/inspection_sha_mismatch/);
});

test('promotion verification requires same READY deployment id',()=>{
  const body={id:'dpl_ok',readyState:'READY'};
  assert.equal(verifyPromotedDeployment(body,'dpl_ok'),true);
  assert.throws(()=>verifyPromotedDeployment(body,'dpl_other'),/promoted_id_mismatch/);
  assert.throws(()=>verifyPromotedDeployment({id:'dpl_ok',readyState:'BUILDING'},'dpl_ok'),/promoted_not_ready/);
});

test('deployment URL extraction fails closed',()=>{
  assert.equal(extractDeploymentUrl('Production https://sample-abc.vercel.app'),'https://sample-abc.vercel.app');
  assert.throws(()=>extractDeploymentUrl('no deployment here'),/deploy_url_missing/);
});

test('production deploy uses Windows shell for npx command shims',()=>{
  assert.deepEqual(vercelRunnerConfig('win32'),{command:'npx',shell:true});
});

test('production deploy avoids shell on POSIX',()=>{
  assert.deepEqual(vercelRunnerConfig('linux'),{command:'npx',shell:false});
});


test('production deploy is isolated, archived and carries provenance',()=>{
  const args=buildDeployArgs({sha,ref:'main'});
  assert.equal(args[0],'vercel');
  assert.equal(args[1],'deploy');
  assert.equal(args.includes('--skip-domain'),true);
  assert.equal(args.includes('--archive=tgz'),true);
  assert.equal(args.includes('--no-wait'),true);
  assert.equal(args.includes('ZEVANORY_RELEASE_SHA='+sha),true);
  assert.equal(args.includes('ZEVANORY_RELEASE_REF=main'),true);
});

test('production deploy verifies via authenticated API before explicit promotion',()=>{
  assert.deepEqual(buildInspectArgs('https://sample.vercel.app'),['vercel','inspect','https://sample.vercel.app','--scope','arbmsistone-labs-projects','--wait','--timeout','3m','--json']);
  assert.deepEqual(buildApiArgs('dpl_sample'),['vercel','api','/v13/deployments/dpl_sample','--scope','arbmsistone-labs-projects']);
  assert.deepEqual(buildPromoteArgs('https://sample.vercel.app'),['vercel','promote','https://sample.vercel.app','--scope','arbmsistone-labs-projects','--yes']);
});
