import { createHash } from 'node:crypto';
import { Pool } from '@neondatabase/serverless';
import { safeBearerEqual } from './security.mjs';
import { consumeArtifactDownload, issueArtifactDownload, PRIVATE_ARTIFACT } from './artifactDelivery.mjs';

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
  const db=dbFor(env);let claimed;
  try{claimed=await consumeArtifactDownload(db,{token});}
  catch{return json(404,{error:'download_unavailable'});}
  finally{await db.pool.end().catch(()=>{});}
  if(!env.ZEVANORY_PRIVATE_ARTIFACTS)return json(503,{error:'artifact_storage_unavailable'});
  const bytes=await env.ZEVANORY_PRIVATE_ARTIFACTS.get(claimed.artifact_key,'arrayBuffer');
  if(!bytes)return json(503,{error:'artifact_missing'});
  const digest=createHash('sha256').update(Buffer.from(bytes)).digest('hex').toUpperCase();
  if(digest!==String(claimed.artifact_sha256).toUpperCase()||digest!==PRIVATE_ARTIFACT.sha256)return json(503,{error:'artifact_integrity_failed'});
  return new Response(bytes,{status:200,headers:{
    'content-type':PRIVATE_ARTIFACT.contentType,
    'content-disposition':`attachment; filename="${PRIVATE_ARTIFACT.filename}"`,
    'content-length':String(bytes.byteLength),
    'cache-control':'private, no-store, max-age=0',
    'x-content-type-options':'nosniff',
    'x-artifact-sha256':digest,
  }});
}
