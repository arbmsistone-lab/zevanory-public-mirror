import { uploadYouTubeFromRemote } from './youtubeUpload.mjs';
const jsonBody=async(response)=>{try{return await response.json();}catch{return {};}};
const required=(value,code)=>{const v=String(value||'').trim();if(!v)throw new Error(code);return v;};
const ensureGlobalGates=(env)=>{if(env.SALE_GLOBALLY_ENABLED!=='true'||env.PRE_SALE_GATES_APPROVED!=='true')throw new Error('commercial_gates_closed');};
const ensureHttps=(value,code)=>{const v=required(value,code);let u;try{u=new URL(v);}catch{throw new Error(code);}if(u.protocol!=='https:')throw new Error(code);return v;};
const requestJson=async(fetchImpl,url,options,success=[200])=>{const response=await fetchImpl(url,options);const body=await jsonBody(response);if(!success.includes(response.status)){const e=new Error(`provider_http_${response.status}`);e.status=response.status;e.body=body;throw e;}return body;};

export function buildOutboundAdapters({env=process.env,fetchImpl=globalThis.fetch}={}){
  if(typeof fetchImpl!=='function')throw new Error('fetch_required');
  const metaBase=()=>`https://graph.facebook.com/${required(env.META_GRAPH_VERSION,'meta_graph_version_missing')}`;
  return Object.freeze({
    'channel:whatsapp':async(event)=>{
      ensureGlobalGates(env);if(env.WHATSAPP_SALES_ENABLED!=='true')throw new Error('whatsapp_sales_disabled');
      const token=required(env.WHATSAPP_ACCESS_TOKEN,'whatsapp_access_token_missing');
      const phoneId=required(env.WHATSAPP_PHONE_NUMBER_ID,'whatsapp_phone_number_id_missing');
      const to=required(event.payload?.contact_ref,'whatsapp_recipient_missing');
      const text=required(event.payload?.text,'whatsapp_text_missing');
      const body=await requestJson(fetchImpl,`${metaBase()}/${encodeURIComponent(phoneId)}/messages`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',to,type:'text',text:{preview_url:false,body:text}})},[200]);
      const messageId=String(body?.messages?.[0]?.id||'');if(!messageId)throw new Error('whatsapp_message_id_missing');
      return Object.freeze({provider:'meta_whatsapp',accepted:true,provider_message_id:messageId,confirmation:'webhook_required'});
    },
    'channel:email':async(event)=>{
      ensureGlobalGates(env);const token=required(env.RESEND_API_KEY,'resend_api_key_missing');
      const from=required(env.RESEND_FROM_ADDRESS,'resend_from_missing');const to=required(event.payload?.contact_ref,'email_recipient_missing');
      const text=required(event.payload?.text,'email_text_missing');
      const body=await requestJson(fetchImpl,'https://api.resend.com/emails',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':String(event.idempotency_key||event.event_id)},body:JSON.stringify({from,to:[to],subject:String(event.payload?.subject||'ZEVANORY').slice(0,240),text})},[200]);
      const id=String(body?.id||'');if(!id)throw new Error('resend_email_id_missing');
      return Object.freeze({provider:'resend',accepted:true,provider_message_id:id,confirmation:'webhook_required'});
    },
    'channel:facebook':async(event)=>{
      ensureGlobalGates(env);const token=required(env.META_ACCESS_TOKEN,'meta_access_token_missing');
      const pageId=required(env.META_PAGE_ID,'meta_page_id_missing');const message=required(event.payload?.content,'facebook_content_missing');
      const body=await requestJson(fetchImpl,`${metaBase()}/${encodeURIComponent(pageId)}/feed`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({message})},[200]);
      const id=String(body?.id||'');if(!id)throw new Error('facebook_post_id_missing');
      return Object.freeze({provider:'meta_facebook',accepted:true,provider_post_id:id,confirmation:'provider_lookup_or_webhook_required'});
    },
    'channel:instagram':async(event)=>{
      ensureGlobalGates(env);const token=required(env.META_ACCESS_TOKEN,'meta_access_token_missing');
      const igId=required(env.INSTAGRAM_BUSINESS_ACCOUNT_ID,'instagram_business_account_id_missing');
      const imageUrl=ensureHttps(event.payload?.media_url,'instagram_media_url_required');const caption=String(event.payload?.content||'').slice(0,2200);
      const container=await requestJson(fetchImpl,`${metaBase()}/${encodeURIComponent(igId)}/media`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({image_url:imageUrl,caption})},[200]);
      const creationId=String(container?.id||'');if(!creationId)throw new Error('instagram_container_id_missing');
      const published=await requestJson(fetchImpl,`${metaBase()}/${encodeURIComponent(igId)}/media_publish`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({creation_id:creationId})},[200]);
      const id=String(published?.id||'');if(!id)throw new Error('instagram_media_id_missing');
      return Object.freeze({provider:'meta_instagram',accepted:true,provider_media_id:id,container_id:creationId,confirmation:'provider_lookup_required'});
    },
    'channel:youtube':async(event,{sql}={})=>{
      ensureGlobalGates(env);
      return uploadYouTubeFromRemote({event,sql,env,fetchImpl});
    },
  });
}
