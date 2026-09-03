import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildLifecycleCertificationArtifact } from '../src/lifecycleCertificationProvenance.mjs';

const certification={version:'sales-lifecycle-v2',required_score:10,total_dimensions:39,proven_dimensions:39,approved:true};
const commit='c'.repeat(40);
const hashes=['a'.repeat(64),'b'.repeat(64)];
const facts={page_views:10,paid_orders:3,profitable_paid_orders:2,verified_evidence:{identity:4,fulfillment:2},lifecycle_counts:{activated:2,onboarded:3}};
const artifact=(evidenceFacts=facts,evidenceHashes=hashes)=>buildLifecycleCertificationArtifact({certification,evidenceHashes,evidenceFacts,deployedCommitSha:commit,releaseId:'R'});

test('fact root is deterministic under recursive object key and event hash reorder',()=>{
  const reordered={verified_evidence:{fulfillment:2,identity:4},profitable_paid_orders:2,lifecycle_counts:{onboarded:3,activated:2},paid_orders:3,page_views:10};
  const a=artifact(),b=artifact(reordered,[...hashes].reverse());
  assert.equal(a.evidence_facts_sha256,b.evidence_facts_sha256);
  assert.equal(a.event_evidence_root_sha256,b.event_evidence_root_sha256);
  assert.equal(a.evidence_root_sha256,b.evidence_root_sha256);
  assert.equal(a.artifact_sha256,b.artifact_sha256);
});
test('changing aggregate facts changes fact root combined root and artifact',()=>{
  const base=artifact();
  for(const changed of [
    {...facts,page_views:11},
    {...facts,paid_orders:4},
    {...facts,profitable_paid_orders:3},
    {...facts,lifecycle_counts:{...facts.lifecycle_counts,onboarded:4}},
  ]){
    const next=artifact(changed);
    assert.notEqual(next.evidence_facts_sha256,base.evidence_facts_sha256);
    assert.notEqual(next.evidence_root_sha256,base.evidence_root_sha256);
    assert.notEqual(next.artifact_sha256,base.artifact_sha256);
  }
});

test('changing direct event evidence changes event root combined root and artifact',()=>{
  const base=artifact();
  const next=artifact(facts,['a'.repeat(64),'d'.repeat(64)]);
  assert.notEqual(next.event_evidence_root_sha256,base.event_evidence_root_sha256);
  assert.notEqual(next.evidence_root_sha256,base.evidence_root_sha256);
  assert.notEqual(next.artifact_sha256,base.artifact_sha256);
});
test('artifact carries aggregate-only facts and explicit evidence roots',()=>{
  const out=artifact();
  assert.equal(out.evidence_hash_count,2);
  assert.deepEqual(out.evidence_facts,facts);
  assert.match(out.event_evidence_root_sha256,/^[0-9a-f]{64}$/);
  assert.match(out.evidence_facts_sha256,/^[0-9a-f]{64}$/);
  const serialized=JSON.stringify(out.evidence_facts);
  for(const forbidden of ['contact_ref','email','phone','name','address','token']) assert.equal(serialized.includes(forbidden),false);
});

test('snapshot binds the observed certification facts into provenance',()=>{
  const source=fs.readFileSync('src/lifecycleEvidenceSnapshot.mjs','utf8');
  assert.match(source,/evidenceFacts:observed/);
  assert.match(source,/const observed=\{/);
});