import { createHash, randomUUID } from 'node:crypto';
import { SALES_LIFECYCLE_CANONICAL_V2 } from './salesLifecycleV2.mjs';

const DIMENSIONS=new Set(SALES_LIFECYCLE_CANONICAL_V2);
const TRUSTED_SOURCE_CLASSES=new Set(['canonical_database','provider_webhook','operator_validation']);
const clean=(value,max=240)=>String(value??'').trim().slice(0,max);
const stable=(value)=>{
  if(Array.isArray(value)) return value.map(stable);
  if(value&&typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]));
  return value;
};
const digest=(value)=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

export async function recordVerifiedLifecycleEvidence(sql,input={}){
  const dimension=clean(input.dimension,80);
  const sourceClass=clean(input.source_class,40);
  const source=clean(input.source,120);
  const subjectRef=clean(input.subject_ref,240)||null;
  const key=clean(input.idempotency_key,240);
  if(!DIMENSIONS.has(dimension)) throw new Error('lifecycle_evidence_dimension_invalid');
  if(!TRUSTED_SOURCE_CLASSES.has(sourceClass)) throw new Error('lifecycle_evidence_source_class_invalid');
  if(!source) throw new Error('lifecycle_evidence_source_required');
  if(key.length<8) throw new Error('lifecycle_evidence_idempotency_key_invalid');  const metadata=stable(input.metadata&&typeof input.metadata==='object'?input.metadata:{});
  const occurredAt=input.occurred_at||null;
  const evidenceHash=digest({dimension,source_class:sourceClass,source,subject_ref:subjectRef,idempotency_key:key,metadata,occurred_at:occurredAt});
  const evidenceId=clean(input.evidence_id,36)||randomUUID();
  const rows=await sql.query(`insert into lifecycle_evidence_events
    (evidence_id,dimension,proof_kind,source,subject_ref,idempotency_key,metadata,occurred_at,source_class,verification_status,evidence_hash,verified_at)
    values($1,$2,'observed_production',$3,$4,$5,$6::jsonb,coalesce($7::timestamptz,now()),$8,'verified',$9,now())
    on conflict(idempotency_key) do nothing
    returning evidence_id,dimension,source_class,verification_status,evidence_hash,occurred_at`,
    [evidenceId,dimension,source,subjectRef,key,JSON.stringify(metadata),occurredAt,sourceClass,evidenceHash]);
  return Object.freeze({inserted:rows.length===1,evidence:rows[0]||null,evidence_id:evidenceId,evidence_hash:evidenceHash});
}

export const LIFECYCLE_EVIDENCE_TRUST=Object.freeze({
  source_classes:Object.freeze([...TRUSTED_SOURCE_CLASSES]),
  proof_kind:'observed_production',
  verification_status:'verified',
  hash_algorithm:'sha256',
});