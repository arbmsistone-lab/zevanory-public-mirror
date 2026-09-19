import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCloudflareReleaseMetadata, buildWranglerArgs, buildRuntimeConfig, verifyLiveRelease, verifyLiveControlPlane } from '../scripts/deploy-cloudflare-production.mjs';
const sha='a'.repeat(40),meta={sha,ref:'main'};

test('cloudflare production requires clean canonical main parity',()=>{
  assert.deepEqual(validateCloudflareReleaseMetadata({sha,ref:'main',status:'',canonicalSha:sha}),meta);
  assert.throws(()=>validateCloudflareReleaseMetadata({sha,ref:'main',status:' M x',canonicalSha:sha}),/clean_worktree/);
  assert.throws(()=>validateCloudflareReleaseMetadata({sha,ref:'main',status:'',canonicalSha:'b'.repeat(40)}),/parity/);
  assert.throws(()=>validateCloudflareReleaseMetadata({sha,ref:'feature',status:'',canonicalSha:sha}),/main_branch/);
});

test('cloudflare deploy carries strict immutable provenance',()=>{
  const args=buildWranglerArgs(meta);
  for(const value of ['wrangler','deploy','--strict',`--tag=${sha}`]) assert.equal(args.includes(value),true); assert.equal(args.includes('--keep-vars'),false);
  const cfg=JSON.parse(buildRuntimeConfig('{"vars":{"SALE_GLOBALLY_ENABLED":"false","PUBLIC_RELEASE_SHA":"stale"}}',meta));
  assert.equal(cfg.vars.ZEVANORY_RELEASE_SHA,sha); assert.equal(cfg.vars.ZEVANORY_RELEASE_REF,'main');
  assert.equal(cfg.vars.PUBLIC_RELEASE_SHA,undefined);
  assert.equal(cfg.vars.SALE_GLOBALLY_ENABLED,'false'); assert.equal(cfg.vars.ZEVANORY_DEPLOYMENT_ENV,'production'); assert.equal(cfg.vars.CERTIFICATION_PILOT_ENABLED,undefined); assert.equal(cfg.vars.CERTIFICATION_PILOT_MAX_ORDERS,undefined);
});

test('post deploy proof requires exact SHA and sales still locked',()=>{
  assert.equal(verifyLiveRelease({deployment:{commit_sha:sha,branch:'main'},sales_mode:'globally-blocked'},meta),true);
  assert.throws(()=>verifyLiveRelease({deployment:{commit_sha:'b'.repeat(40),branch:'main'},sales_mode:'globally-blocked'},meta),/sha_mismatch/);
  assert.throws(()=>verifyLiveRelease({deployment:{commit_sha:sha,branch:'main'},sales_mode:'enabled'},meta),/sales_must_remain_blocked/);
});


test('cloudflare deploy ignores unrelated untracked artifacts but not tracked dirtiness',async()=>{
  const source=await import('node:fs/promises').then(fs=>fs.readFile(new URL('../scripts/deploy-cloudflare-production.mjs',import.meta.url),'utf8'));
  assert.match(source,/status','--porcelain','--untracked-files=no/);
});

test('post deploy control plane requires exact SHA, 10/10 ZEA-10 and fail-closed commerce',()=>{
  const body={release:{deployment:{commit_sha:sha,branch:'main'}},proof_chain:{sha,branch:'main'},policy:{counts:{proven:10,partial:0,blocked:0}},global_state:'operational_commercial_blocked'};
  assert.equal(verifyLiveControlPlane(body,meta),true);
  assert.throws(()=>verifyLiveControlPlane({...body,policy:{counts:{proven:9,partial:1,blocked:0}}},meta),/zea10_not_proven/);
  assert.throws(()=>verifyLiveControlPlane({...body,release:{deployment:{commit_sha:'b'.repeat(40),branch:'main'}}},meta),/sha_mismatch/);
  assert.throws(()=>verifyLiveControlPlane({...body,global_state:'operational_commercial_enabled'},meta),/commercial_state_invalid/);
});
