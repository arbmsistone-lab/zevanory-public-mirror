import { createHash } from 'node:crypto';
import { Pool } from '@neondatabase/serverless';
import { safeBearerEqual } from './security.mjs';
import { consumeArtifactDownload, issueArtifactDownload, privateArtifactForClaim } from './artifactDelivery.mjs';
import { preserveStorageOperation, storageOperation } from './storageFabric.mjs';

const json=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
const bearer=(request)=>String(request.headers.get('authorization')||'').replace(/^Bearer\s+/i,'');
const dbFor=(env)=>{
  if(!env.DATABASE_URL)throw new Error('database_url_required');
  const pool=new Pool({connectionString:env.DATABASE_URL});
  return {pool,query:async(text,args)=>{const client=await pool.connect();try{return (await client.query(text,args)).rows;}finally{client.release();}}};
};

export async function handleArtifactIssue(request,env){
  if(request.method!=='POST')return json(405,{error:'method_not_allowed'});
  if(!safeBearerEqual(String(env.FULFILLMENT_OPERATOR_TOKEN||''),bearer(request)))return json(401,{error:'operator_auth_required'});
  const text=await request.text();if(text.length>4096)return json(413,{error:'payload_too_large'});
  let body;try{body=JSON.parse(text||'{}')}catch{return json(400,{error:'invalid_json'});}
  const orderId=String(body.order_id||'').trim();if(!orderId)return json(400,{error:'order_id_required'});
  if(!env.DATABASE_URL){
    const operation=storageOperation({operationId:`fulfillment-issue:${orderId}`,operationType:'fulfillment.issue_intent',subjectRef:orderId,payload:{order_id:orderId,ttl_minutes:Number(body.ttl_minutes||0),requires_canonical_payment_reconciliation:true}});
    const preserved=await preserveStorageOperation(operation,{env,fetchImpl:globalThis.fetch,requiredCopies:1});
    return json(preserved.preserved?202:503,{issued:false,preserved:preserved.preserved,pending_validation:preserved.preserved,download_url:null,error:preserved.preserved?undefined:'fulfillment_storage_unavailable'});
  }
  const db=dbFor(env);
  try{
    const issued=await issueArtifactDownload(db,{orderId:body.order_id,issuedBy:'fulfillment-operator',ttlMinutes:body.ttl_minutes});
    const url=new URL('/private/artifacts/download',request.url);url.searchParams.set('token',issued.token);
    return json(201,{issued:true,order_id:issued.order_id,expires_at:issued.expires_at,download_url:url.toString(),single_use:true});
  }catch(error){return json(409,{issued:false,error:String(error?.message||'artifact_issue_failed')});}
  finally{await db.pool.end().catch(()=>{});}
}

export async function handleArtifactDownload(request,env){
  if(request.method!=='GET')return json(405,{error:'method_not_allowed'});
  const token=new URL(request.url).searchParams.get('token')||'';
  if(!env.DATABASE_URL)return json(503,{error:'download_validation_unavailable'});
  const db=dbFor(env);let claimed;
  try{claimed=await consumeArtifactDownload(db,{token});}
  catch{return json(404,{error:'download_unavailable'});}
  finally{await db.pool.end().catch(()=>{});}
  if(!env.ZEVANORY_PRIVATE_ARTIFACTS)return json(503,{error:'artifact_storage_unavailable'});
  const bytes=await env.ZEVANORY_PRIVATE_ARTIFACTS.get(claimed.artifact_key,'arrayBuffer');
  if(!bytes)return json(503,{error:'artifact_missing'});
  const registered=privateArtifactForClaim(claimed);
  if(!registered)return json(503,{error:'artifact_registry_mismatch'});
  const digest=createHash('sha256').update(Buffer.from(bytes)).digest('hex').toUpperCase();
  if(digest!==registered.sha256)return json(503,{error:'artifact_integrity_failed'});
  return new Response(bytes,{status:200,headers:{
    'content-type':registered.contentType,
    'content-disposition':`attachment; filename="${registered.filename}"`,
    'content-length':String(bytes.byteLength),
    'cache-control':'private, no-store, max-age=0',
    'x-content-type-options':'nosniff',
    'x-artifact-sha256':digest,
  }});
}
