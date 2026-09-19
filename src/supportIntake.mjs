import { randomUUID } from 'node:crypto';

const clean=(v,max=5000)=>String(v??'').normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
const supportRx=/\b(erro|falha|bug|problema|ajuda|suporte|nao funciona|n\u00e3o funciona|travou|lento|configur|instal|integra|webhook|login|acesso|permiss|atualiza|deploy|backup|restore|restaur)\b/i;

export function inferSupportProduct(text=''){
  const value=clean(text,5000);
  if(/\bzevanory[\s-]*one\b/i.test(value)||/\barbm[\s-]*one\b/i.test(value))return 'ARBM-ONE';
  if(/\barbm[\s-]*sist\b/i.test(value))return 'ARBM-SIST';
  if(/\barbm[\s-]*contador(?:[\s-]*(?:para[\s-]*)?sal[o?]es)?\b/i.test(value))return 'ARBM-CONTADOR-SALOES';
  if(/\bia na pr[a\u00e1]tica\b/i.test(value))return 'ZEV-IA-011';
  if(/\bvendas na pr[a\u00e1]tica\b/i.test(value))return 'ZEV-VEN-011';
  if(/\blucro e caixa\b/i.test(value))return 'ZEV-LCX-011';
  if(/\b(combo ia|ia e vendas)\b/i.test(value))return 'ZEV-CMB-011';
  if(/\bneg[o\u00f3]cio completo\b/i.test(value))return 'ZEV-NGC-011';
  return '';
}

export function looksLikeProductSupport(text=''){return supportRx.test(clean(text,5000));}

export async function queueProductSupport(sql,{channel,contactRef,text,subject='',productCode='',productVersion='',module='',errorCode='',source='inbound'}={}){
  const message=clean(text,5000),contact=clean(contactRef,500),ch=clean(channel,40).toLowerCase();
  if(!message||!contact||!['whatsapp','email'].includes(ch))return Object.freeze({queued:false,reason:'support_intake_invalid'});
  if(!looksLikeProductSupport(`${subject} ${message}`))return Object.freeze({queued:false,reason:'not_support_intent'});
  const product=clean(productCode||inferSupportProduct(`${subject} ${message}`),120);
  let lead=(await sql.query('select lead_id,session_id from sales_leads where channel=$1 and contact_ref=$2 order by updated_at desc limit 1',[ch,contact]))[0];
  if(!lead){const leadId=randomUUID(),sessionId=randomUUID();await sql.query("insert into sales_leads(lead_id,session_id,channel,stage,contact_ref,touchpoints,updated_at) values($1,$2,$3,'contacted',$4,0,now())",[leadId,sessionId,ch,contact]);lead={lead_id:leadId,session_id:sessionId};}
  const jobId=randomUUID(),caseId=randomUUID(),key=`support:${ch}:${contact}:${Buffer.from(message).toString('base64url').slice(0,96)}`;
  const payload={case_id:caseId,product_code:product,product_version:clean(productVersion,80),module:clean(module,120),symptom:message,error_code:clean(errorCode,200),question:message,channel:ch,source,inbound_message:message};
  const rows=await sql.query("insert into agent_jobs(job_id,job_type,status,priority,lead_id,idempotency_key,payload,available_at) values($1,'product_support','queued',100,$2,$3,$4::jsonb,now()) on conflict(idempotency_key) do nothing returning job_id",[jobId,lead.lead_id,key,JSON.stringify(payload)]);
  await sql.query("insert into agent_memory(memory_id,scope_type,scope_ref,memory_key,memory_value,confidence) values($1,'lead',$2,'last_inbound_message',$3::jsonb,1) on conflict(scope_type,scope_ref,memory_key) do update set memory_value=excluded.memory_value,confidence=1,updated_at=now()",[randomUUID(),String(lead.lead_id),JSON.stringify({text:message,source,kind:'support'})]);
  if(product&&rows.length){await sql.query("insert into product_support_cases(case_id,lead_id,product_code,product_version,module,symptom,error_code,status) values($1,$2,$3,$4,$5,$6,$7,'open') on conflict(case_id) do nothing",[caseId,lead.lead_id,product,clean(productVersion,80)||null,clean(module,120)||null,message,clean(errorCode,200)||null]);}
  return Object.freeze({queued:rows.length===1,job_id:rows[0]?.job_id||null,case_id:caseId,product_code:product||null,lead_id:lead.lead_id,kind:'support'});
}

export async function queueWhatsappConversation(sql,{contactRef,text,messageId='',mediaType='text',mediaId='',source='meta_whatsapp'}={}){
  const contact=clean(contactRef,500),message=clean(text,5000),id=clean(messageId,240),type=clean(mediaType,40).toLowerCase();
  if(!contact||!message)return Object.freeze({queued:false,reason:'whatsapp_conversation_invalid'});
  if(looksLikeProductSupport(message))return queueProductSupport(sql,{channel:'whatsapp',contactRef:contact,text:message,source});
  let lead=(await sql.query("select lead_id,session_id,stage from sales_leads where channel='whatsapp' and contact_ref=$1 order by updated_at desc limit 1",[contact]))[0];
  if(!lead){const leadId=randomUUID(),sessionId=randomUUID();await sql.query("insert into sales_leads(lead_id,session_id,channel,stage,contact_ref,touchpoints,updated_at) values($1,$2,'whatsapp','contacted',$3,1,now())",[leadId,sessionId,contact]);lead={lead_id:leadId,session_id:sessionId,stage:'contacted'};}else{await sql.query("update sales_leads set stage=case when stage='new' then 'contacted' else stage end,touchpoints=touchpoints+1,last_contact_at=now(),updated_at=now() where lead_id=$1",[lead.lead_id]);}
  const key=`whatsapp-inbound:${id||Buffer.from(`${contact}:${message}`).toString('base64url').slice(0,120)}`;
  const payload={source,channel:'whatsapp',inbound_message:message,message_id:id||null,media_type:type,media_id:clean(mediaId,240)||null,consent_allowed:true};
  const rows=await sql.query("insert into agent_jobs(job_id,job_type,status,priority,lead_id,idempotency_key,payload,available_at) values($1,'lead_review','queued',95,$2,$3,$4::jsonb,now()) on conflict(idempotency_key) do nothing returning job_id",[randomUUID(),lead.lead_id,key,JSON.stringify(payload)]);
  await sql.query("insert into agent_memory(memory_id,scope_type,scope_ref,memory_key,memory_value,confidence) values($1,'lead',$2,'last_inbound_message',$3::jsonb,1) on conflict(scope_type,scope_ref,memory_key) do update set memory_value=excluded.memory_value,confidence=1,updated_at=now()",[randomUUID(),String(lead.lead_id),JSON.stringify({text:message,message_id:id||null,media_type:type,source})]);
  return Object.freeze({queued:rows.length===1,job_id:rows[0]?.job_id||null,lead_id:lead.lead_id,kind:'commercial'});
}

export function extractWhatsappInboundMessages(payload={}){
  const out=[];
  for(const entry of Array.isArray(payload.entry)?payload.entry:[])for(const change of Array.isArray(entry?.changes)?entry.changes:[]){
    const value=change?.value||{};
    for(const message of Array.isArray(value.messages)?value.messages:[]){
      const type=String(message?.type||'text').toLowerCase();
      const media=message?.[type]||{};
      const text=String(message?.text?.body||message?.button?.text||message?.interactive?.button_reply?.title||message?.interactive?.list_reply?.title||media?.caption||'').trim();
      const from=String(message?.from||'').trim();
      const mediaId=String(media?.id||'').trim();
      if(from&&(text||mediaId))out.push(Object.freeze({from,type,text,caption:String(media?.caption||'').trim(),media_id:mediaId,mime_type:String(media?.mime_type||'').trim(),filename:String(media?.filename||'').trim(),message_id:String(message?.id||'')}));
    }
  }
  return Object.freeze(out);
}
