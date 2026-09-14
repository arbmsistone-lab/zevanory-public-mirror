import { preSaleApproval } from './preSaleApproval.mjs';
import { salesLifecycleGate } from './salesLifecycleV2.mjs';
import { loadApprovedObservedLifecycleCertification } from './lifecycleCertificationProvenance.mjs';

export const SALES_GATE_KEYS = Object.freeze([
  'SALE_GLOBALLY_ENABLED',
  'PRE_SALE_GATES_APPROVED',
  'ABSOLUTE_RELEASE_APPROVED',
]);

export function salesGate(env=process.env,lifecycleCertification=null) {
  const globalEnabled=String(env.SALE_GLOBALLY_ENABLED||'').toLowerCase()==='true';
  const preSaleApproved=String(env.PRE_SALE_GATES_APPROVED||'').toLowerCase()==='true';
  const absoluteReleaseApproved=String(env.ABSOLUTE_RELEASE_APPROVED||'').toLowerCase()==='true';
  const manifest=preSaleApproval(env);
  const lifecycle=salesLifecycleGate(lifecycleCertification);
  const enabled=globalEnabled && preSaleApproved && absoluteReleaseApproved && manifest.approved && lifecycle.approved;
  const blockers=[];
  if(!globalEnabled) blockers.push('global_sale_disabled');
  if(!preSaleApproved) blockers.push('pre_sale_gates_open');
  if(!absoluteReleaseApproved) blockers.push('absolute_release_not_approved');
  if(!manifest.approved) blockers.push(...manifest.blockers);
  if(!lifecycle.approved) blockers.push(...lifecycle.blockers);
  return Object.freeze({
    enabled,
    global_enabled:globalEnabled,
    pre_sale_gates_approved:preSaleApproved,
    absolute_release_approved:absoluteReleaseApproved,
    manifest_approved:manifest.approved,
    lifecycle_approved:lifecycle.approved,
    lifecycle,
    blockers:Object.freeze([...new Set(blockers)]),
  });
}
export function channelEnabled(envKey,env=process.env) {
  return salesGate(env).enabled && String(env[envKey]||'').toLowerCase()==='true';
}

export async function salesGateFromObservedEvidence(sql,env=process.env,{deployedCommitSha}={}){
  const certification=await loadApprovedObservedLifecycleCertification(sql,{deployedCommitSha});
  return salesGate(env,certification);
}
