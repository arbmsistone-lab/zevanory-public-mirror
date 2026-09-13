import crypto from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { normalizeWhatsappStatusPayload,applyProviderConfirmation } from '../providerConfirmation.mjs';
import { preserveProviderConfirmations } from '../providerConfirmationFabric.mjs';
import { resolveMetaVerifyToken } from '../channelIdentityPreflight.mjs';
import { extractWhatsappSupportMessages, queueProductSupport } from '../supportIntake.mjs';

const json=(res,status,body)=>{res.statusCode=status;return res.end(JSON.stringify(body));};
const rawText=(req)=>Buffer.isBuffer(req.rawBody)?req.rawBody.toString('utf8'):String(req.rawBody||'');

export function verifyMetaSignature({payload,signature,appSecret}={}){
  const supplied=String(signature||'');const secret=String(appSecret||'');
  if(!payload||!secret||!supplied.startsWith('sha256='))return false;
  const expected='sha256='+crypto.createHmac('sha256',secret).update(payload,'utf8').digest('hex');
  try{return crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(expected));}catch{return false;}
}

export default async function handler(req,res){
  res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
  if(req.method==='GET'){
    const mode=String(req.query?.['hub.mode']||''),token=String(req.query?.['hub.verify_token']||''),challenge=String(req.query?.['hub.challenge']||'');
    if(mode==='subscribe'&&token&&token===resolveMetaVerifyToken(process.env)){res.statusCode=200;return res.end(challenge);}
    return json(res,403,{error:'webhook_verification_failed'});
  }
  if(req.method!=='POST')return json(res,405,{error:'method_not_allowed'});
  const raw=rawText(req);if(!verifyMetaSignature({payload:raw,signature:req.headers?.['x-hub-signature-256'],appSecret:process.env.META_APP_SECRET}))return json(res,401,{error:'webhook_auth_failed',accepted:false});
  let payload;try{payload=raw?JSON.parse(raw):{};}catch{return json(res,400,{error:'invalid_json',accepted:false});}
  const inbound=extractWhatsappSupportMessages(payload);
  if(inbound.length&&process.env.DATABASE_URL){const sql=neon(process.env.DATABASE_URL);let queued=0;for(const item of inbound){const r=await queueProductSupport(sql,{channel:'whatsapp',contactRef:item.from,text:item.text,source:'meta_whatsapp'});if(r.queued)queued++;}if(queued)return json(res,200,{accepted:true,support_jobs_queued:queued});}
  const confirmations=normalizeWhatsappStatusPayload(payload);if(!confirmations.length)return json(res,200,{accepted:true,ignored:true,reason:'status_not_supported'});
  if(!process.env.DATABASE_URL){
    const recovery=await preserveProviderConfirmations(confirmations);
    return json(res,recovery.preserved?202:503,{accepted:recovery.preserved,preserved:recovery.preserved,reconciliation_pending:recovery.preserved,confirmations:confirmations.length,updated:0,error:recovery.preserved?undefined:'confirmation_storage_unavailable'});
  }
  try{
    const sql=neon(process.env.DATABASE_URL);let updated=0;
    for(const item of confirmations){const result=await applyProviderConfirmation(sql,item);if(result.updated)updated+=1;}
    return json(res,200,{accepted:true,confirmations:confirmations.length,updated});
  }catch{
    const recovery=await preserveProviderConfirmations(confirmations);
    return json(res,503,{error:'confirmation_reconciliation_unavailable',accepted:false,preserved:recovery.preserved,reconciliation_required:true});
  }
}
