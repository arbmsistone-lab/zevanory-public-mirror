import crypto from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { normalizeResendDeliveryEvent,applyProviderConfirmation } from '../providerConfirmation.mjs';
import { preserveProviderConfirmations } from '../providerConfirmationFabric.mjs';

const API='https://api.resend.com';
const ALIASES=new Set(['contato','vendas','suporte','financeiro']);
const json=(res,status,body)=>{res.statusCode=status;return res.end(JSON.stringify(body));};
const headers=(req)=>({id:String(req.headers?.['svix-id']||''),timestamp:String(req.headers?.['svix-timestamp']||''),signature:String(req.headers?.['svix-signature']||'')});
const bodyText=(req)=>Buffer.isBuffer(req.rawBody)?req.rawBody.toString('utf8'):typeof req.rawBody==='string'?req.rawBody:Buffer.isBuffer(req.body)?req.body.toString('utf8'):typeof req.body==='string'?req.body:JSON.stringify(req.body||{});

export function verifyResendSignature({payload,id,timestamp,signature,secret,now=Date.now()}){
  if(!payload||!id||!timestamp||!signature||!secret?.startsWith('whsec_')) return false;
  const ts=Number(timestamp); if(!Number.isFinite(ts)||Math.abs(Math.floor(now/1000)-ts)>300) return false;
  let key; try{key=Buffer.from(secret.slice(6),'base64');}catch{return false;}
  const expected=crypto.createHmac('sha256',key).update(`${id}.${timestamp}.${payload}`,'utf8').digest('base64');
  return signature.split(' ').some(part=>{const [version,value]=part.split(',');if(version!=='v1'||!value)return false;try{return crypto.timingSafeEqual(Buffer.from(value),Buffer.from(expected));}catch{return false;}});
}

async function api(path,{method='GET',body,apiKey,fetchImpl=fetch,idempotencyKey}={}){
  const response=await fetchImpl(`${API}${path}`,{method,headers:{accept:'application/json','content-type':'application/json',authorization:`Bearer ${apiKey}`,'user-agent':'ZEVANORY/1.0',...(idempotencyKey?{'idempotency-key':idempotencyKey}:{})},body:body?JSON.stringify(body):undefined});
  const result=await response.json();if(!response.ok||result?.error||result?.name?.endsWith('_error'))throw new Error(`resend_api_${response.status}`);return result;
}
export default async function handler(req,res){
  res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
  if(req.method!=='POST') return json(res,405,{error:'method_not_allowed'});
  const raw=bodyText(req); const h=headers(req);
  if(!verifyResendSignature({payload:raw,...h,secret:process.env.RESEND_WEBHOOK_SECRET})) return json(res,401,{error:'webhook_auth_failed',accepted:false});
  let event; try{event=JSON.parse(raw);}catch{return json(res,400,{error:'invalid_json',accepted:false});}
  const delivery=normalizeResendDeliveryEvent(event);
  if(delivery){
    if(!process.env.DATABASE_URL){
      const recovery=await preserveProviderConfirmations([delivery]);
      return json(res,recovery.preserved?202:503,{accepted:recovery.preserved,preserved:recovery.preserved,reconciliation_pending:recovery.preserved,updated:false,status:delivery.status,error:recovery.preserved?undefined:'confirmation_storage_unavailable'});
    }
    try{const result=await applyProviderConfirmation(neon(process.env.DATABASE_URL),delivery);return json(res,200,{accepted:true,updated:result.updated,status:delivery.status});}
    catch{const recovery=await preserveProviderConfirmations([delivery]);return json(res,503,{error:'confirmation_reconciliation_unavailable',accepted:false,preserved:recovery.preserved,reconciliation_required:true});}
  }
  if(event?.type!=='email.received') return json(res,200,{accepted:true,ignored:true,reason:'event_not_supported'});
  if(process.env.EMAIL_INBOUND_ENABLED!=='true') return json(res,503,{error:'email_inbound_disabled',accepted:false});
  if(!process.env.RESEND_API_KEY||!process.env.RESEND_FORWARD_TO) return json(res,503,{error:'email_provider_unavailable',accepted:false});
  const emailId=String(event?.data?.email_id||''); if(!emailId)return json(res,400,{error:'email_id_missing',accepted:false});
  try{
    const email=await api(`/emails/receiving/${encodeURIComponent(emailId)}`,{apiKey:process.env.RESEND_API_KEY});
    const recipients=Array.isArray(email.to)?email.to:[]; const local=recipients.map(v=>String(v).trim().toLowerCase()).filter(v=>/^[^@]+@zevanory\.api\.br$/.test(v)).map(v=>v.split('@')[0]).find(v=>ALIASES.has(v));
    if(!local)return json(res,200,{accepted:true,ignored:true,reason:'recipient_not_allowed'});
    let attachments=[]; if(Array.isArray(email.attachments)&&email.attachments.length){
      const listed=await api(`/emails/receiving/${encodeURIComponent(emailId)}/attachments`,{apiKey:process.env.RESEND_API_KEY});
      attachments=(listed?.data||[]).filter(a=>a.download_url&&a.filename).map(a=>({path:a.download_url,filename:a.filename}));
    }
    const subject=`[${local.toUpperCase()}] ${String(email.subject||'(sem assunto)')}`;
    const forward={from:process.env.RESEND_FROM_ADDRESS||'ZEVANORY <contato@zevanory.api.br>',to:[process.env.RESEND_FORWARD_TO],subject,reply_to:String(email.from||''),text:email.text||undefined,html:email.html||undefined,attachments};
    const sent=await api('/emails',{method:'POST',body:forward,apiKey:process.env.RESEND_API_KEY,idempotencyKey:`inbound-${emailId}`});
    if(typeof sent?.id!=='string'||!sent.id.trim())throw new Error('resend_send_id_missing');
    return json(res,200,{accepted:true,forwarded:true,alias:local,source_email_id:emailId,forward_email_id:sent.id,delivery_proven:false});
  }catch{return json(res,503,{error:'email_forwarding_unavailable',accepted:false});}
}
