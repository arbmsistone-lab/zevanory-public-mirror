import crypto from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { readJsonRequestBody, validatePublicApiRequest } from '../src/security.mjs';
import { consumeAdaptiveWebhookRate } from '../src/security/adaptiveRateLimit.mjs';
import { sanitizeText } from '../src/telemetry.mjs';

const emailRe=/^[A-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i;
const json=(res,status,body,headers={})=>{
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control','no-store');
  res.setHeader('x-content-type-options','nosniff');
  res.setHeader('referrer-policy','no-referrer');
  for(const [key,value] of Object.entries(headers))res.setHeader(key,value);
  res.statusCode=status;return res.end(JSON.stringify(body));
};
const requestIp=(req)=>String(req.headers?.['cf-connecting-ip']||req.headers?.['x-real-ip']||req.headers?.['x-forwarded-for']||'unknown').split(',')[0].trim().slice(0,96);
const normalizeEmail=(value)=>String(value||'').normalize('NFKC').trim().toLowerCase();

export default async function handler(req,res){
  if(req.method!=='POST') return json(res,405,{error:'method_not_allowed'},{allow:'POST'});
  const requestCheck=validatePublicApiRequest(req,process.env);
  if(!requestCheck.ok) return json(res,requestCheck.status,{error:requestCheck.error,commercial_unlock:false});
  const rate=consumeAdaptiveWebhookRate({key:`pilot-interest:${requestIp(req)}`,provider:'pilot-interest'});
  if(!rate.ok) return json(res,429,{error:'rate_limited',commercial_unlock:false},{'retry-after':String(rate.retryAfter)});
  res.setHeader('x-rate-limit-remaining',String(rate.remaining));
  const body=await readJsonRequestBody(req,4096).catch(()=>null);
  if(!body) return json(res,400,{error:'invalid_json',commercial_unlock:false});
  if(String(body.company_website||'').trim()) return json(res,202,{accepted:true,status:'waitlisted',commercial_unlock:false});
  const consent=body.consent===true; const privacy=body.privacy_accepted===true;
  if(!consent||!privacy) return json(res,400,{error:'consent_required',commercial_unlock:false});
  const email=normalizeEmail(body.email);
  if(email.length<5||email.length>254||!emailRe.test(email)) return json(res,400,{error:'email_invalid',commercial_unlock:false});
  const name=sanitizeText(String(body.name||'').normalize('NFKC'),120)||null;
  if(!process.env.DATABASE_URL) return json(res,503,{error:'storage_unavailable',commercial_unlock:false});
  const sql=neon(process.env.DATABASE_URL);
  try{
    const rows=await sql.query(`insert into certification_pilot_interest
      (interest_id,name,email,consent_version,consent_at,source,status,updated_at)
      values($1,$2,$3,'pilot-optin-v1',now(),'pilot_optin','waitlisted',now())
      on conflict(lower(email)) do update set
        name=coalesce(excluded.name,certification_pilot_interest.name),
        consent_version=excluded.consent_version,consent_at=now(),status='waitlisted',updated_at=now()
      returning interest_id,status`,[crypto.randomUUID(),name,email]);
    return json(res,202,{accepted:true,status:rows[0]?.status||'waitlisted',commercial_unlock:false});
  }catch{
    return json(res,503,{error:'pilot_interest_storage_unavailable',commercial_unlock:false});
  }
}