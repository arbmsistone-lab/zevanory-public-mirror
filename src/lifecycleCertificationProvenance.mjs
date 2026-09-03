import { createHash, randomUUID } from 'node:crypto';

const stable=(value)=>JSON.stringify(value,Object.keys(value||{}).sort());
const sha=(value)=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');

export function buildLifecycleCertificationArtifact({certification,evidenceHashes=[],deployedCommitSha,releaseId}={}){
  const hashes=[...new Set((evidenceHashes||[]).map(String).filter(x=>/^[0-9a-f]{64}$/.test(x)))].sort();
  const evidenceRootSha256=sha(hashes.join('\n'));
  const payload={
    release_id:String(releaseId||''),deployed_commit_sha:String(deployedCommitSha||''),
    lifecycle_version:String(certification?.version||''),required_score:Number(certification?.required_score)||10,
    total_dimensions:Number(certification?.total_dimensions)||0,proven_dimensions:Number(certification?.proven_dimensions)||0,
    certification_approved:certification?.approved===true,evidence_root_sha256:evidenceRootSha256,evidence_hashes:hashes,
  };
  return Object.freeze({...payload,artifact_sha256:sha(JSON.stringify(payload))});
}

export async function persistLifecycleCertificationArtifact(sql,artifact={}){
  if(artifact.certification_approved!==true||artifact.proven_dimensions!==39||artifact.total_dimensions!==39) throw new Error('lifecycle_39x10_required');
  if(!/^[0-9a-f]{40}$/.test(String(artifact.deployed_commit_sha||''))) throw new Error('deployed_commit_sha_invalid');
  const rows=await sql.query(`insert into lifecycle_certification_artifacts
    (artifact_id,artifact_sha256,evidence_root_sha256,lifecycle_version,deployed_commit_sha,required_score,total_dimensions,proven_dimensions,certification_approved,artifact_payload)
    values($1,$2,$3,$4,$5,$6,$7,$8,true,$9::jsonb) on conflict(artifact_sha256) do nothing returning artifact_id,status`,
    [randomUUID(),artifact.artifact_sha256,artifact.evidence_root_sha256,artifact.lifecycle_version,artifact.deployed_commit_sha,artifact.required_score,artifact.total_dimensions,artifact.proven_dimensions,JSON.stringify(artifact)]);
  return Object.freeze({inserted:rows.length===1,artifact_id:rows[0]?.artifact_id||null,status:rows[0]?.status||'pending'});
}

export async function approveLifecycleCertificationArtifact(sql,{artifactSha256,deployedCommitSha,approvedBy}={}){
  const hash=String(artifactSha256||'').toLowerCase();
  const commit=String(deployedCommitSha||'').toLowerCase(); const approver=String(approvedBy||'').trim();
  if(!/^[0-9a-f]{64}$/.test(hash)) throw new Error('artifact_sha256_invalid');
  if(!/^[0-9a-f]{40}$/.test(commit)) throw new Error('deployed_commit_sha_invalid');
  if(!approver) throw new Error('lifecycle_release_approver_required');
  const rows=await sql.query(`update lifecycle_certification_artifacts set status='approved',approved_at=now(),approved_by=$2 where artifact_sha256=$1 and deployed_commit_sha=$3 and certification_approved=true and required_score=10 and total_dimensions=39 and proven_dimensions=39 and status='pending' returning artifact_id,artifact_sha256,status,approved_at,approved_by`,[hash,approver,commit]);
  if(rows.length===1) return Object.freeze({...rows[0],approved:true});
  const existing=await sql.query(`select artifact_id,artifact_sha256,status,approved_at,approved_by,deployed_commit_sha,certification_approved,required_score,total_dimensions,proven_dimensions from lifecycle_certification_artifacts where artifact_sha256=$1 limit 1`,[hash]);
  const row=existing[0]; if(!row) throw new Error('lifecycle_certification_artifact_not_found');
  if(row.deployed_commit_sha!==commit) throw new Error('lifecycle_certification_commit_mismatch');
  if(row.status==='approved') return Object.freeze({...row,approved:true,idempotent:true});
  throw new Error(`lifecycle_certification_not_approvable:${row.status}`);
}
