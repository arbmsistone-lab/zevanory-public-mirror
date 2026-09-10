import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ARBM_SIST_OFFER, ZEVANORY_PRODUCTS, resolveCheckoutOffer } from './offerCatalog.mjs';

const artifact=(offerId,version,filename,sha256)=>Object.freeze({
  offerId,
  key:offerId==='OFFER-0001'?`zevanory/arbm-sist/v${version}/${filename}`:`zevanory/v${version}/${filename}`,
  filename,
  sha256:String(sha256).toUpperCase(),
  contentType:'application/zip',
});

export const PRIVATE_ARTIFACTS=Object.freeze([
  artifact(ARBM_SIST_OFFER.id,ARBM_SIST_OFFER.version,ARBM_SIST_OFFER.artifact_name,ARBM_SIST_OFFER.artifact_sha256),
  ...ZEVANORY_PRODUCTS.filter(p=>p.sellable===true&&p.artifact_materialized===true).map(p=>artifact(p.sku,p.version,p.artifact_name,p.artifact_sha256)),
]);
export const PRIVATE_ARTIFACT=PRIVATE_ARTIFACTS.find(x=>x.offerId==='OFFER-0001');

export function privateArtifactForOffer(offerId){
  if(!String(offerId||'').trim()) return null;
  const offer=resolveCheckoutOffer(offerId);
  if(!offer) return null;
  return PRIVATE_ARTIFACTS.find(x=>x.offerId===offer.id)||null;
}

export function privateArtifactForClaim({artifact_key,artifact_sha256}={}){
  const key=String(artifact_key||''), sha=String(artifact_sha256||'').toUpperCase();
  return PRIVATE_ARTIFACTS.find(x=>x.key===key&&x.sha256===sha)||null;
}

const sha256=(value)=>createHash('sha256').update(String(value)).digest('hex');
const uuid=(value)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value||''));
export async function issueArtifactDownload(sql,{orderId,issuedBy='operator',ttlMinutes=30}={}){
  if(!sql?.query)throw new Error('artifact_sql_required');
  if(!uuid(orderId))throw new Error('artifact_order_id_invalid');
  const ttl=Math.min(60,Math.max(5,Number.parseInt(String(ttlMinutes),10)||30));
  const eligible=await sql.query(`select o.order_id,o.offer_id from orders o
    where o.order_id=$1 and o.status='paid'
      and exists(select 1 from financial_events f where f.order_id=o.order_id and f.normalized_event='payment_confirmed')
    limit 1`,[orderId]);
  if(eligible.length!==1)throw new Error('artifact_paid_reconciled_order_required');
  const selected=privateArtifactForOffer(eligible[0].offer_id);
  if(!selected)throw new Error('artifact_offer_not_registered');
  const token=randomBytes(32).toString('base64url');
  const rows=await sql.query(`insert into artifact_download_tokens
    (token_id,order_id,token_sha256,artifact_key,artifact_sha256,expires_at,issued_by)
    values($1,$2,$3,$4,$5,now()+($6::text||' minutes')::interval,$7)
    returning token_id,order_id,expires_at`,
    [randomUUID(),orderId,sha256(token),selected.key,selected.sha256,String(ttl),String(issuedBy).slice(0,120)]);
  if(rows.length!==1)throw new Error('artifact_token_persist_failed');
  return Object.freeze({...rows[0],token,artifact:selected});
}

export async function consumeArtifactDownload(sql,{token}={}){
  if(!sql?.query)throw new Error('artifact_sql_required');
  const raw=String(token||'').trim();
  if(raw.length<32||raw.length>128)throw new Error('artifact_token_invalid');
  const rows=await sql.query(`update artifact_download_tokens t set used_at=now()
    where t.token_sha256=$1 and t.used_at is null and t.expires_at>now()
      and exists(select 1 from orders o where o.order_id=t.order_id and o.status='paid'
        and exists(select 1 from financial_events f where f.order_id=o.order_id and f.normalized_event='payment_confirmed'))
    returning t.token_id,t.order_id,t.artifact_key,t.artifact_sha256,t.expires_at,t.used_at`,[sha256(raw)]);
  if(rows.length!==1)throw new Error('artifact_token_unavailable');
  if(!privateArtifactForClaim(rows[0]))throw new Error('artifact_claim_not_registered');
  return Object.freeze(rows[0]);
}

export function hashArtifactToken(token){return sha256(token);}
