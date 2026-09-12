import { createHmac, timingSafeEqual } from 'node:crypto';
import { Pool } from '@neondatabase/serverless';

const json=(res,status,body)=>{res.statusCode=status;res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');return res.end(JSON.stringify(body));};
const clean=(v,max=300)=>String(v??'').trim().slice(0,max);
const hex64=v=>/^[a-f0-9]{64}$/i.test(clean(v,80));

export function verifyNuvemshopWebhook(rawBody,signature,secret){
  const key=clean(secret,1000),sig=clean(signature,80);
  if(!key||!hex64(sig))return false;
  const expected=createHmac('sha256',key).update(Buffer.isBuffer(rawBody)?rawBody:Buffer.from(rawBody||'')).digest('hex');
  return timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(sig,'hex'));
}

export async function applyNuvemshopLifecycleEvent(sql,payload){
  const storeId=clean(payload?.store_id,80),event=clean(payload?.event,120);
  if(!/^\d+$/.test(storeId))throw new Error('nuvemshop_store_id_invalid');
  if(['app/uninstalled','app/suspended','app/store_redact'].includes(event)){
    if(!sql?.query)throw new Error('nuvemshop_sql_required');
    const rows=await sql.query("delete from provider_oauth_credentials where provider='nuvemshop' and account_id=$1 returning account_id",[storeId]);
    return {credential_revoked:Array.isArray(rows)&&rows.length>0};
  }
  return {credential_revoked:false};
}

export default async function handler(req,res){
  if(req.method!=='POST')return json(res,405,{error:'method_not_allowed',accepted:false});
  const raw=Buffer.isBuffer(req.rawBody)?req.rawBody:Buffer.from(req.rawBody||'');
  const signature=req.headers?.['x-linkedstore-hmac-sha256'];
  if(!process.env.NUVEMSHOP_CLIENT_SECRET)return json(res,503,{error:'nuvemshop_webhook_secret_missing',accepted:false});
  if(!verifyNuvemshopWebhook(raw,signature,process.env.NUVEMSHOP_CLIENT_SECRET))return json(res,401,{error:'nuvemshop_webhook_signature_invalid',accepted:false});
  const payload=req.parsedBody||{};const event=clean(payload.event,120);const storeId=clean(payload.store_id,80);
  if(!/^\d+$/.test(storeId)||!event)return json(res,400,{error:'nuvemshop_webhook_payload_invalid',accepted:false});
  let pool;
  try{
    let lifecycle={credential_revoked:false};
    if(['app/uninstalled','app/suspended','app/store_redact'].includes(event)){
      if(!process.env.DATABASE_URL)return json(res,503,{error:'database_required',accepted:false});
      pool=new Pool({connectionString:process.env.DATABASE_URL});const client=await pool.connect();
      try{lifecycle=await applyNuvemshopLifecycleEvent({query:(t,a)=>client.query(t,a).then(r=>r.rows)},payload);}finally{client.release();}
    }
    return json(res,200,{provider:'nuvemshop',accepted:true,event,store_id:storeId,commercial_enabled:false,...lifecycle});
  }catch{return json(res,503,{provider:'nuvemshop',accepted:false,error:'nuvemshop_webhook_processing_failed'});}finally{if(pool)await pool.end().catch(()=>{});}
}
