import test from 'node:test';
import assert from 'node:assert/strict';
import { ZEA10, buildZea10PolicySnapshot, buildControlPlaneSnapshot } from '../src/controlPlanePolicy.mjs';

const SHA='322f9ca25cf8e26fe2a9fd3acb66034a29484cce';

test('ZEA-10 exposes the canonical ten pillars only', () => {
  assert.equal(ZEA10.length, 10);
  assert.deepEqual(ZEA10.map(x=>x.id), Array.from({length:10},(_,i)=>`ZEA10-${String(i+1).padStart(2,'0')}`));
});

test('ZEA-10 never reports proven without a release SHA binding', () => {
  const snapshot=buildZea10PolicySnapshot({});
  assert.equal(snapshot.release_sha, null);
  assert.equal(snapshot.counts.proven, 0);
  assert.ok(snapshot.counts.partial + snapshot.counts.blocked === 10);
});

test('ZEA-10 binds all current internal assurance evidence to an exact SHA', () => {
  const snapshot=buildZea10PolicySnapshot({VERCEL_GIT_COMMIT_SHA:SHA});
  assert.equal(snapshot.release_sha, SHA);
  assert.equal(snapshot.pillars.length,10);
  assert.equal(snapshot.counts.proven + snapshot.counts.partial + snapshot.counts.blocked,10);
  assert.equal(snapshot.claim_scope,'internal_engineering_alignment_not_external_certification');
});

test('control plane remains commercially blocked when global sales gates are not enabled', () => {
  const snapshot=buildControlPlaneSnapshot({VERCEL_GIT_COMMIT_SHA:SHA});
  assert.equal(snapshot.global_state,'operational_commercial_blocked');
  assert.equal(snapshot.domains.revenue.state,'blocked');
  assert.equal(snapshot.proof_chain.sha,SHA);
});
