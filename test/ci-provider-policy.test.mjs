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

test('canonical certifier policy never hardcodes mutable exact-SHA evidence',()=>{
  const v=policy.providers.vercel;
  assert.equal(v.static_status,'eligible');
  assert.equal(v.evidence_source,'build-generated public/control-plane-certification.json');
  assert.equal(v.sha_binding_source,'VERCEL_GIT_COMMIT_SHA');
  assert.equal(v.required_checks,36);
  assert.equal(v.required_e2e_passes,30);
  assert.equal(v.runtime_exact_sha_required,true);
  assert.equal(v.zea10_proven_required,10);
  assert.equal(Object.hasOwn(v,'evidence_sha'),false);
  assert.match(policy.promotion_rule,/cannot unlock commerce/i);
});
