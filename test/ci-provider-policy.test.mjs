import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const policy=JSON.parse(fs.readFileSync('config/ci-provider-policy.json','utf8'));

test('canonical remote quality contract remains exact-SHA and fail-closed',()=>{
  const c=policy.canonical_quality_contract;
  assert.equal(policy.fail_closed,true);
  assert.equal(c.exact_sha_required,true);
  assert.equal(c.remote_checks_required,36);
  assert.equal(c.e2e_pass_required,30);
  assert.equal(c.runtime_control_plane_exact_sha_required,true);
  assert.equal(c.zea10_proven_required,10);
  assert.equal(c.commercial_gate_must_remain_fail_closed,true);
});

test('CircleCI quarantine records provider failure without claiming test failure',()=>{
  const c=policy.providers.circleci;
  assert.equal(c.status,'quarantined');
  assert.equal(c.tests_executed,false);
  assert.equal(c.task_error,'Error: Task information unavailable');
  assert.match(c.evidence_run_id,/^[0-9a-f-]{36}$/);
  assert.ok(c.reentry_gate.length>=4);
});

test('healthy provider evidence is explicit and cannot unlock commerce',()=>{
  const v=policy.providers.vercel;
  assert.equal(v.status,'healthy');
  assert.equal(v.checks,'36/36');
  assert.equal(v.e2e,'30/30');
  assert.equal(v.runtime_exact_sha,true);
  assert.equal(v.zea10,'10/10');
  assert.match(policy.promotion_rule,/cannot unlock commerce/i);
});
