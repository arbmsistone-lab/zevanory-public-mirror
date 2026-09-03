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
