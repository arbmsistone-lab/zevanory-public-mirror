import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildLifecycleCertificationArtifact,persistLifecycleCertificationArtifact } from '../src/lifecycleCertificationProvenance.mjs';

test('certification artifact is deterministic and bound to evidence root',()=>{
  const certification={version:'v',required_score:10,total_dimensions:39,proven_dimensions:39,approved:true};
  const input={certification,evidenceHashes:['a'.repeat(64),'b'.repeat(64)],deployedCommitSha:'c'.repeat(40),releaseId:'R'};
  const a=buildLifecycleCertificationArtifact(input),b=buildLifecycleCertificationArtifact({...input,evidenceHashes:[...input.evidenceHashes].reverse()});
  assert.equal(a.artifact_sha256,b.artifact_sha256);assert.match(a.evidence_root_sha256,/^[0-9a-f]{64}$/);
});

test('artifact persistence refuses anything below 39x10',async()=>{
  const db={query:async()=>[]};
  await assert.rejects(()=>persistLifecycleCertificationArtifact(db,{certification_approved:false,total_dimensions:39,proven_dimensions:38}),/39x10/);
});

test('migration makes payload immutable and approval explicit',()=>{
  const sql=fs.readFileSync('db/migrations/015_lifecycle_certification_provenance.sql','utf8');
  assert.match(sql,/artifact_sha256/);assert.match(sql,/evidence_root_sha256/);assert.match(sql,/artifact_immutable/);
  assert.match(sql,/status IN \('pending','approved','rejected'\)/);assert.match(sql,/015_lifecycle_certification_provenance/);
});

test('trusted evidence repository writes the real migration column',()=>{
  const source=fs.readFileSync('src/lifecycleEvidenceRepository.mjs','utf8');
  assert.match(source,/evidence_sha256/);assert.doesNotMatch(source,/evidence_hash[,)]/);
});

import { loadApprovedObservedLifecycleCertification } from '../src/lifecycleCertificationProvenance.mjs';
test('approved observed lifecycle resolver is commit-bound and fail-closed',async()=>{
  const commit='a'.repeat(40);
  const sql={query:async(q,args)=> q.includes("status='approved'")&&args?.[0]===commit?[{artifact_sha256:'b'.repeat(64),deployed_commit_sha:commit,required_score:10,total_dimensions:39,proven_dimensions:39,status:'approved'}]:[]};
  const cert=await loadApprovedObservedLifecycleCertification(sql,{deployedCommitSha:commit});
  assert.equal(cert.certification_track,'observed_production'); assert.equal(cert.release_approved,true);
  assert.equal(await loadApprovedObservedLifecycleCertification(sql,{deployedCommitSha:'bad'}),null);
});
