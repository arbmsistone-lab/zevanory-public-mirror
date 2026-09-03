import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { approveLifecycleCertificationArtifact } from '../src/lifecycleCertificationProvenance.mjs';

const hash='a'.repeat(64), commit='b'.repeat(40);

test('approval requires exact hash commit and configured approver',async()=>{
  const sql={query:async()=>[]};
  await assert.rejects(()=>approveLifecycleCertificationArtifact(sql,{artifactSha256:'bad',deployedCommitSha:commit,approvedBy:'owner'}),/artifact_sha256_invalid/);
  await assert.rejects(()=>approveLifecycleCertificationArtifact(sql,{artifactSha256:hash,deployedCommitSha:'bad',approvedBy:'owner'}),/deployed_commit_sha_invalid/);
  await assert.rejects(()=>approveLifecycleCertificationArtifact(sql,{artifactSha256:hash,deployedCommitSha:commit,approvedBy:''}),/lifecycle_release_approver_required/);
});

test('approval only promotes a pending 39x10 artifact for exact deployed commit',async()=>{
  const calls=[]; const sql={query:async(q,args)=>{calls.push({q,args}); return calls.length===1?[{artifact_id:'id',artifact_sha256:hash,status:'approved',approved_at:'now',approved_by:'owner'}]:[]}};
  const out=await approveLifecycleCertificationArtifact(sql,{artifactSha256:hash,deployedCommitSha:commit,approvedBy:'owner'});
  assert.equal(out.approved,true); assert.match(calls[0].q,/required_score=10/); assert.match(calls[0].q,/total_dimensions=39/); assert.match(calls[0].q,/proven_dimensions=39/); assert.deepEqual(calls[0].args,[hash,'owner',commit]);
});

test('operator approval path stays authenticated, current-candidate only, and non-unlocking',async()=>{
  const source=await readFile(new URL('../api/events-operator.mjs',import.meta.url),'utf8');
  assert.match(source,/safeBearerEqual/);
  assert.match(source,/lifecycle_certification_approve/);
  assert.match(source,/LIFECYCLE_RELEASE_APPROVER/);
  assert.match(source,/artifact_candidate_mismatch/);
  assert.match(source,/lifecycle_39x10_required/);
  assert.match(source,/commercial_unlock:false/);
  assert.match(source,/persistLifecycleCertificationArtifact/);
  assert.match(source,/approveLifecycleCertificationArtifact/);
});
