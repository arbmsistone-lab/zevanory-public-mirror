import { createHash } from 'node:crypto';

export const TENANT_ROLES=Object.freeze({owner:['*'],admin:['read','write','commercial'],operator:['read','write'],analyst:['read'],billing:['read','billing']});
const clean=(v,max=160)=>String(v??'').trim().slice(0,max);
export function validTenantId(value){return /^[a-z0-9][a-z0-9_-]{2,63}$/i.test(clean(value,64));}
export function tenantScopedKey(tenantId,key){
  if(!validTenantId(tenantId))throw new Error('tenant_id_invalid');
  const raw=clean(key,500); if(!raw)throw new Error('tenant_key_required');
  return createHash('sha256').update(`${tenantId}|${raw}`).digest('hex');
}
export function authorizeTenantAction({tenant_id,actor_tenant_id,role='analyst',action='read'}={}){
  if(!validTenantId(tenant_id)||tenant_id!==actor_tenant_id)return Object.freeze({allowed:false,reason:'tenant_boundary_violation'});
  const grants=TENANT_ROLES[String(role)]||[]; const allowed=grants.includes('*')||grants.includes(String(action));
  return Object.freeze({allowed,reason:allowed?'tenant_role_allowed':'tenant_role_denied',tenant_id,role:String(role)});
}
export function tenantDataEnvelope(tenantId,payload={}){
  if(!validTenantId(tenantId))throw new Error('tenant_id_invalid');
  return Object.freeze({tenant_id:tenantId,payload:Object.freeze({...payload}),cross_tenant_access:false});
}
