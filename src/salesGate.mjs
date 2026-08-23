import { preSaleApproval } from './preSaleApproval.mjs';

export const SALES_GATE_KEYS = Object.freeze([
  'SALE_GLOBALLY_ENABLED',
  'PRE_SALE_GATES_APPROVED',
]);

export function salesGate(env=process.env) {
  const globalEnabled=String(env.SALE_GLOBALLY_ENABLED||'').toLowerCase()==='true';
  const preSaleApproved=String(env.PRE_SALE_GATES_APPROVED||'').toLowerCase()==='true';
  const manifest=preSaleApproval();
  const enabled=globalEnabled && preSaleApproved && manifest.approved;
  const blockers=[];
  if(!globalEnabled) blockers.push('global_sale_disabled');
  if(!preSaleApproved) blockers.push('pre_sale_gates_open');
  if(!manifest.approved) blockers.push(...manifest.blockers);
  return Object.freeze({
    enabled,
    global_enabled:globalEnabled,
    pre_sale_gates_approved:preSaleApproved,
    manifest_approved:manifest.approved,
    blockers:Object.freeze(blockers),
  });
}

export function channelEnabled(envKey,env=process.env) {
  return salesGate(env).enabled && String(env[envKey]||'').toLowerCase()==='true';
}
