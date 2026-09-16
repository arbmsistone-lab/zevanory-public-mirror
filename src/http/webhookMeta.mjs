import crypto from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { normalizeWhatsappStatusPayload,applyProviderConfirmation } from '../providerConfirmation.mjs';
import { preserveProviderConfirmations } from '../providerConfirmationFabric.mjs';
import { resolveMetaVerifyToken } from '../channelIdentityPreflight.mjs';
import { extractWhatsappInboundMessages, queueWhatsappConversation } from '../supportIntake.mjs';
import { understandWhatsappInbound } from '../whatsappMedia.mjs';

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
  const inbound=extractWhatsappInboundMessages(payload);
  if(inbound.length&&process.env.DATABASE_URL){const sql=neon(process.env.DATABASE_URL);let queued=0,support=0,commercial=0,media_review=0;for(const item of inbound){let enriched=item;try{enriched=await understandWhatsappInbound(item,{env:process.env});}catch{enriched={...item,understanding:item.text||item.caption||`Cliente enviou ${item.type}; midia requer revisao.`,understanding_mode:'media_review_required',understanding_confidence:0};}const text=String(enriched.understanding||enriched.text||'').trim();const r=await queueWhatsappConversation(sql,{contactRef:item.from,text,messageId:item.message_id,mediaType:item.type,mediaId:item.media_id,source:'meta_whatsapp'});if(r.queued){queued++;if(r.kind==='support')support++;else commercial++;}if(Number(enriched.understanding_confidence||0)<.99&&item.media_id)media_review++;}return json(res,200,{accepted:true,inbound_jobs_queued:queued,support_jobs_queued:support,commercial_jobs_queued:commercial,media_review_required:media_review});}
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
