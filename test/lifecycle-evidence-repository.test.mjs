import test from 'node:test';
import assert from 'node:assert/strict';
import { recordVerifiedLifecycleEvidence } from '../src/lifecycleEvidenceRepository.mjs';

test('verified lifecycle evidence requires trusted canonical source',async()=>{
  const db={query:async()=>[]};
  await assert.rejects(()=>recordVerifiedLifecycleEvidence(db,{dimension:'payment',source_class:'public_event',source:'web',idempotency_key:'proof:0001'}),/source_class_invalid/);
});

test('verified lifecycle evidence is hashed and idempotent',async()=>{
  const calls=[];
  const db={query:async(q,args)=>{calls.push({q,args});return [{evidence_id:args[0],dimension:args[1],source_class:args[7],verification_status:'verified',evidence_hash:args[8]}];}};
  const result=await recordVerifiedLifecycleEvidence(db,{dimension:'payment',source_class:'provider_webhook',source:'asaas',subject_ref:'order-1',idempotency_key:'payment:proof:0001',metadata:{provider:'asaas'}});
  assert.equal(result.inserted,true);
  assert.match(result.evidence_hash,/^[0-9a-f]{64}$/);
  assert.match(calls[0].q,/on conflict\(idempotency_key\) do nothing/i);
  assert.match(calls[0].q,/verification_status,evidence_hash,verified_at/i);
});