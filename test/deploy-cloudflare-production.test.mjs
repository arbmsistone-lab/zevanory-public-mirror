import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCloudflareReleaseMetadata, buildWranglerArgs, buildRuntimeConfig, verifyLiveRelease } from '../scripts/deploy-cloudflare-production.mjs';
const sha='a'.repeat(40),meta={sha,ref:'main'};

test('cloudflare production requires clean GitHub GitLab HEAD parity',()=>{
  assert.deepEqual(validateCloudflareReleaseMetadata({sha,ref:'main',status:'',githubSha:sha,gitlabSha:sha}),meta);
  assert.throws(()=>validateCloudflareReleaseMetadata({sha,ref:'main',status:' M x',githubSha:sha,gitlabSha:sha}),/clean_worktree/);
  assert.throws(()=>validateCloudflareReleaseMetadata({sha,ref:'main',status:'',githubSha:'b'.repeat(40),gitlabSha:sha}),/parity/);
  assert.throws(()=>validateCloudflareReleaseMetadata({sha,ref:'feature',status:'',githubSha:sha,gitlabSha:sha}),/main_branch/);
});

test('cloudflare deploy carries strict immutable provenance',()=>{
  const args=buildWranglerArgs(meta);
  for(const value of ['wrangler','deploy','--strict',`--tag=${sha}`]) assert.equal(args.includes(value),true); assert.equal(args.includes('--keep-vars'),false);
  const cfg=JSON.parse(buildRuntimeConfig('{"vars":{"SALE_GLOBALLY_ENABLED":"false"}}',meta));
  assert.equal(cfg.vars.ZEVANORY_RELEASE_SHA,sha); assert.equal(cfg.vars.ZEVANORY_RELEASE_REF,'main');
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
