import { randomUUID } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { OPERATOR_EVENTS, OPERATOR_EVIDENCE_EVENTS, sanitizeText } from '../src/telemetry.mjs';
import { PROJECT, isUuid } from '../src/config.mjs';
import { safeBearerEqual } from '../src/security.mjs';
import { salesStageRank } from '../src/salesPipeline.mjs';
import { recordVerifiedLifecycleEvidence } from '../src/lifecycleEvidenceRepository.mjs';
import { buildLifecycleEvidenceSnapshot } from '../src/lifecycleEvidenceSnapshot.mjs';
import { persistLifecycleCertificationArtifact, approveLifecycleCertificationArtifact } from '../src/lifecycleCertificationProvenance.mjs';
import { RELEASE } from '../src/release.mjs';
import { createCertificationPilotInvite, revokeCertificationPilotInvite } from '../src/certificationPilot.mjs';
import { executeStorageMutation, storageOperation } from '../src/storageFabric.mjs';

const stageFor=Object.freeze({lead_qualified:'qualified',offer_sent:'offer_sent',checkout_started:'checkout_started'});
const dimensionFor=Object.freeze({lead_qualified:'qualification',offer_sent:'offer',checkout_started:'checkout',identity_verified:'identity',enrichment_verified:'enrichment',scoring_completed:'scoring',prioritization_completed:'prioritization',first_response_confirmed:'first_response',discovery_completed:'discovery',nurturing_touch_confirmed:'nurturing',objection_handled:'objection',negotiation_completed:'negotiation',abandonment_recovered:'abandonment_recovery',fulfillment_confirmed:'fulfillment'});

export default async function handler(req,res){
  res.setHeader('content-type','application/json; charset=utf-8'); res.setHeader('cache-control','no-store'); res.setHeader('x-content-type-options','nosniff');
  if(req.method!=='POST'){res.statusCode=405;return res.end(JSON.stringify({error:'method_not_allowed'}));}
  const token=String(process.env.OPERATOR_TOKEN||''); const provided=String(req.headers?.authorization||'').replace(/^Bearer\s+/i,'');
  if(!safeBearerEqual(token,provided)){res.statusCode=401;return res.end(JSON.stringify({error:'operator_auth_required'}));}
  const body=req.body && typeof req.body==='object'?req.body:{};
  const name=sanitizeText(body.name,60);
  if(name==='certification_pilot_invite_create'){
    const approver=sanitizeText(process.env.CERTIFICATION_PILOT_APPROVER,120);
    if(!approver){res.statusCode=503;return res.end(JSON.stringify({error:'certification_pilot_approver_not_configured'}));}
    if(!process.env.DATABASE_URL){res.statusCode=503;return res.end(JSON.stringify({error:'operational_storage_unavailable'}));}
    try{const sql=neon(process.env.DATABASE_URL);const invite=await createCertificationPilotInvite(sql,{createdBy:approver,ttlHours:body.ttl_hours});res.statusCode=201;return res.end(JSON.stringify({created:true,invite_id:invite.invite_id,token:invite.token,expires_at:invite.expires_at,max_orders:invite.max_orders,commercial_unlock:false}));}catch(error){res.statusCode=409;return res.end(JSON.stringify({error:String(error?.message||'certification_pilot_invite_failed')}));}
  }
  if(name==='certification_pilot_invite_revoke'){
    const approver=sanitizeText(process.env.CERTIFICATION_PILOT_APPROVER,120);
    if(!approver){res.statusCode=503;return res.end(JSON.stringify({error:'certification_pilot_approver_not_configured'}));}
    if(!process.env.DATABASE_URL){res.statusCode=503;return res.end(JSON.stringify({error:'operational_storage_unavailable'}));}
    try{const sql=neon(process.env.DATABASE_URL);const result=await revokeCertificationPilotInvite(sql,{inviteId:String(body.invite_id||''),revokedBy:approver});res.statusCode=200;return res.end(JSON.stringify({...result,commercial_unlock:false}));}catch(error){res.statusCode=409;return res.end(JSON.stringify({error:String(error?.message||'certification_pilot_revoke_failed')}));}
  }  if(name==='lifecycle_certification_approve'){
    const approver=sanitizeText(process.env.LIFECYCLE_RELEASE_APPROVER,120);
    const deployedCommitSha=String(process.env.VERCEL_GIT_COMMIT_SHA||process.env.ZEVANORY_RELEASE_SHA||'').toLowerCase();
    const requestedHash=String(body.artifact_sha256||'').toLowerCase();
    if(!approver){res.statusCode=503;return res.end(JSON.stringify({error:'lifecycle_release_approver_not_configured'}));}
    if(!process.env.DATABASE_URL){res.statusCode=503;return res.end(JSON.stringify({error:'operational_storage_unavailable'}));}
    if(!/^[0-9a-f]{40}$/.test(deployedCommitSha)){res.statusCode=503;return res.end(JSON.stringify({error:'deployment_provenance_unavailable'}));}
    if(!/^[0-9a-f]{64}$/.test(requestedHash)){res.statusCode=400;return res.end(JSON.stringify({error:'invalid_artifact_sha256'}));}
    try{const sql=neon(process.env.DATABASE_URL); const snapshot=await buildLifecycleEvidenceSnapshot(sql,{deployedCommitSha,releaseId:RELEASE.id}); if(snapshot.artifact_eligible!==true){res.statusCode=409;return res.end(JSON.stringify({error:'lifecycle_39x10_required',proven_dimensions:snapshot.certification.proven_dimensions,total_dimensions:snapshot.certification.total_dimensions}));} if(snapshot.provenance.artifact_sha256!==requestedHash){res.statusCode=409;return res.end(JSON.stringify({error:'artifact_candidate_mismatch'}));} await persistLifecycleCertificationArtifact(sql,snapshot.provenance); const approval=await approveLifecycleCertificationArtifact(sql,{artifactSha256:requestedHash,deployedCommitSha,approvedBy:approver}); res.statusCode=200;return res.end(JSON.stringify({approved:approval.approved===true,artifact_sha256:requestedHash,deployed_commit_sha:deployedCommitSha,commercial_unlock:false}));}catch(error){res.statusCode=409;return res.end(JSON.stringify({error:String(error?.message||'lifecycle_certification_approval_failed')}));}
  }
  if(name==='media_spend_recorded'){
    const eventId=String(body.event_id||'').toLowerCase(),campaignId=sanitizeText(body.campaign_id,80),variantId=sanitizeText(body.variant_id,80),creativeId=sanitizeText(body.creative_id,80),channel=sanitizeText(body.channel,40),spend=Number(body.spend_brl);
    if(!isUuid(eventId)||!campaignId||!variantId||!creativeId||!channel||!Number.isFinite(spend)||spend<0){res.statusCode=400;return res.end(JSON.stringify({error:'invalid_media_spend_event'}));}
    if(!process.env.DATABASE_URL){res.statusCode=503;return res.end(JSON.stringify({error:'operational_storage_unavailable'}));}
    try{const sql=neon(process.env.DATABASE_URL);const rows=await sql.query(`insert into media_spend_events(spend_event_id,campaign_id,variant_id,creative_id,channel,spend_brl,occurred_at,source) values($1,$2,$3,$4,$5,$6,coalesce($7::timestamptz,now()),'operator') on conflict do nothing returning spend_event_id`,[eventId,campaignId,variantId,creativeId,channel,spend,body.occurred_at||null]);res.statusCode=202;return res.end(JSON.stringify({accepted:true,recorded:rows.length===1,commercial_unlock:false}));}catch(error){res.statusCode=503;return res.end(JSON.stringify({error:'media_spend_storage_unavailable',detail:String(error?.message||'').slice(0,120)}));}
  }
  const eventId=String(body.event_id||'').toLowerCase(); const sessionId=String(body.session_id||'').toLowerCase(); const channel=sanitizeText(body.channel,40);
  const stageEvent=OPERATOR_EVENTS.has(name); const evidenceOnly=OPERATOR_EVIDENCE_EVENTS.has(name);
  if((!stageEvent&&!evidenceOnly)||!isUuid(eventId)||!isUuid(sessionId)||!channel){res.statusCode=400;return res.end(JSON.stringify({error:'invalid_event'}));}
  const operation=storageOperation({operationId:`operator-event:${eventId}`,operationType:`operator.${name}`,subjectRef:sessionId,payload:{event_id:eventId,session_id:sessionId,channel,name}});
  const outcome=await executeStorageMutation({operation,mutate:async()=>{
    const sql=neon(process.env.DATABASE_URL); const stage=stageFor[name]||null;
    const existing=await sql.query('select stage from sales_leads where session_id=$1 limit 1',[sessionId]);
    const current=existing[0]?.stage||null;
    if(evidenceOnly&&current===null)return Object.freeze({status:404,error:'lead_not_found'});
    if(evidenceOnly&&name==='fulfillment_confirmed'){const paid=await sql.query("select o.order_id from orders o where o.session_id=$1 and o.status='paid' and exists(select 1 from financial_events f where f.order_id=o.order_id and f.normalized_event='payment_confirmed') order by o.created_at desc limit 1",[sessionId]);if(paid.length!==1)return Object.freeze({status:409,error:'paid_reconciled_order_required'});}
    if(evidenceOnly){const proof=await recordVerifiedLifecycleEvidence(sql,{dimension:dimensionFor[name],source_class:'operator_validation',source:'events-operator',subject_ref:sessionId,idempotency_key:`operator-evidence:${name}:${eventId}`,metadata:{event_name:name,channel}});return Object.freeze({status:202,accepted:true,evidence_recorded:proof.inserted===true,agent_job_queued:false});}
    if(current!==null&&salesStageRank(stage)<salesStageRank(current))return Object.freeze({status:409,error:'invalid_sales_transition'});
    const rows=await sql.query(`with inserted_event as (insert into telemetry_events(event_id,event_name,session_id,experiment_id,offer_id,channel,source) values($1,$2,$3,$4,$5,$6,'operator') on conflict(event_id) do nothing returning event_id), lead_upsert as (insert into sales_leads(lead_id,session_id,channel,stage,touchpoints,updated_at) select $7,$3,$6,$8,0,now() where exists(select 1 from inserted_event) on conflict(session_id) do update set stage=$8,channel=excluded.channel,updated_at=now() returning lead_id) insert into agent_jobs(job_id,job_type,status,priority,lead_id,idempotency_key,payload,available_at) select $9,'lead_review','queued',90,lead_id,$10,$11::jsonb,now() from lead_upsert on conflict(idempotency_key) do nothing returning job_id`,[eventId,name,sessionId,PROJECT.experimentId,PROJECT.offerId,channel,randomUUID(),stage,randomUUID(),`operator-event:${eventId}`,JSON.stringify({source:'operator_event',event_name:name})]);
    if(rows.length>0){try{await recordVerifiedLifecycleEvidence(sql,{dimension:dimensionFor[name],source_class:'operator_validation',source:'events-operator',subject_ref:sessionId,idempotency_key:`operator-evidence:${name}:${eventId}`,metadata:{event_name:name,channel}});}catch{}}
    return Object.freeze({status:202,accepted:true,agent_job_queued:rows.length>0});
  }});
  if(outcome.ok){res.statusCode=outcome.result.status||202;return res.end(JSON.stringify(outcome.result));}
  if(outcome.replayable){res.statusCode=202;return res.end(JSON.stringify({accepted:true,preserved:true,pending_validation:true,executed:false}));}
  res.statusCode=503;return res.end(JSON.stringify({error:'operator_event_reconciliation_required',preserved:outcome.preserved,reconciliation_required:outcome.reconciliation_required}));
}
