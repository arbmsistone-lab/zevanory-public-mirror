// Execute in a verified ZEVANORY production build. Never export credentials.
if (process.env.VERCEL_ENV !== 'production') throw new Error('production_build_required');
const emit = data => console.log('ZEVANORY_PROVIDER_AUDIT '+JSON.stringify({time:new Date().toISOString(),...data}));
async function get(path) {
  await new Promise(resolve=>setTimeout(resolve,550));
  const r=await fetch('https://api.resend.com'+path,{headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY},signal:AbortSignal.timeout(15000)});
  const b=await r.json();
  if(!r.ok){emit({path,http:r.status,error:b.name});return null;}
  return b;
}
const list=await get('/domains');
const domain=list?.data?.find(d=>d.name==='zevanory.api.br');
if(domain){
  const d=await get('/domains/'+domain.id);
  emit({domain:d?.name,id:d?.id,status:d?.status,capabilities:d?.capabilities,records:d?.records?.map(r=>({record:r.record,name:r.name,type:r.type,value:r.value,priority:r.priority,status:r.status}))});
}else emit({domain_found:false});
const hooks=await get('/webhooks');
const relevantHooks=hooks?.data?.filter(h=>h.endpoint==='https://zevanory.api.br/api/webhooks/resend')||[];
emit({webhooks:relevantHooks.map(h=>({id:h.id,endpoint:h.endpoint,status:h.status,events:h.events}))});
const emails=await get('/emails/receiving?limit=100');
const tests=emails?.data?.filter(m=>m.subject?.includes('ZEVANORY G5 INBOUND CERTIFICATION'))||[];
emit({received_test_emails:tests.map(m=>({id:m.id,created_at:m.created_at})),has_more:emails?.has_more});
for(const h of relevantHooks){
  const events=await get('/webhooks/'+h.id+'/events?limit=100');
  for(const event of events?.data?.filter(e=>e.type==='email.received').slice(0,10)||[]){
    const detail=await get('/webhooks/'+h.id+'/events/'+event.id);
    if(!tests.some(t=>t.id===detail?.payload?.data?.email_id))continue;
    const attempts=await get('/webhooks/'+h.id+'/events/'+event.id+'/attempts');
    emit({event_id:event.id,source_email_id:detail.payload.data.email_id,status:detail.status,attempts:attempts?.data?.map(a=>{
      let b={};try{b=JSON.parse(a.response);}catch{}
      return {id:a.id,http_status_code:a.http_status_code,sent_at:a.sent_at,accepted:b.accepted,forwarded:b.forwarded,error:typeof b.error==='string'&&/^[a-z_0-9]+$/.test(b.error)?b.error:undefined,forward_email_id:b.forward_email_id};
    })});
  }
}
const sent=await get('/emails?limit=100');
emit({sent_test_emails:sent?.data?.filter(m=>m.subject?.includes('ZEVANORY G5 INBOUND CERTIFICATION')).map(m=>({id:m.id,created_at:m.created_at,last_event:m.last_event})),has_more:sent?.has_more});
emit({inbound_enabled:process.env.EMAIL_INBOUND_ENABLED==='true',forward_to_expected:process.env.RESEND_FORWARD_TO==='zevanory@gmail.com',from_address_expected:/contato@zevanory\.api\.br/.test(process.env.RESEND_FROM_ADDRESS||'')});
try{
  const r=await fetch('https://zevanory.api.br/api/config?view=mercadolivre-audit',{headers:{Authorization:'Bearer '+process.env.OPERATOR_TOKEN},signal:AbortSignal.timeout(20000)});
  const b=await r.json();
  emit({mercadolivre:{http:r.status,...Object.fromEntries(Object.entries(b).filter(([k])=>['all_verified','identity_verified','notifications_verified','app_separation_verified','application_lookup_http','seller_id_match','application_id_match','notification_url_match','mercadopago_distinct_application'].includes(k)))}});
}catch{emit({mercadolivre:{error:'runtime_audit_unavailable'}});}
