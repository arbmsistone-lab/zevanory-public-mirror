import { uploadYouTubeFromRemote } from './youtubeUpload.mjs';
import { publishTikTok, publishLinkedIn } from './socialPosting.mjs';
import { salesGate } from './salesGate.mjs';
import { loadMercadoLivreCredential, refreshMercadoLivreCredential } from './mercadoLivreOAuth.mjs';
import { loadTikTokCredential, refreshTikTokCredential } from './tiktokOAuth.mjs';
import { loadLinkedInCredential } from './linkedinOAuth.mjs';
import { loadNuvemshopCredential } from './nuvemshopOAuth.mjs';
import { loadMetaCredential } from './metaOAuth.mjs';
import { requestProviderJson, providerAcceptanceMissing } from './providerDelivery.mjs';
import { alternateAutomationReadiness } from './alternateChannelAutomation.mjs';
import { publishViaBuffer } from './bufferSocial.mjs';
import { defineChannelProvider, buildChannelProviderPool, buildUniversalChannelAdapter, externalChannelProviders } from './channelProviderRegistry.mjs';
import { buildBrevoEmailProvider, buildMailjetEmailProvider } from './emailProviders.mjs';
import { isActiveCommercialFront } from './activeCommercialScope.mjs';
const required=(value,code)=>{const v=String(value||'').trim();if(!v)throw new Error(code);return v;};
const ensureGlobalGates=(env,gateEvaluator=salesGate)=>{if(!gateEvaluator(env).enabled)throw new Error('commercial_gates_closed');};
const ensureHttps=(value,code)=>{const v=required(value,code);let u;try{u=new URL(v);}catch{throw new Error(code);}if(u.protocol!=='https:')throw new Error(code);return v;};
const requestJson=(fetchImpl,url,options,success=[200])=>requestProviderJson(fetchImpl,url,options,success,{timeoutMs:15000});
const contentWithLanding=(text,landing,max)=>{const base=String(text||'').trim(),url=String(landing||'').trim();let valid='';try{const u=new URL(url);if(u.protocol==='https:')valid=u.toString();}catch{}const joined=valid&&!base.includes(valid)?`${base}\n\n${valid}`:base;return joined.slice(0,max);};

export function buildOutboundAdapters({env=process.env,fetchImpl=globalThis.fetch,commercialGate=salesGate,channelProviders={}}={}){
  if(typeof fetchImpl!=='function')throw new Error('fetch_required');
  const metaBase=()=>`https://graph.facebook.com/${required(env.META_GRAPH_VERSION,'meta_graph_version_missing')}`;
  const directAdapters=Object.freeze({
    'channel:whatsapp':async(event)=>{
      ensureGlobalGates(env,commercialGate);if(env.WHATSAPP_SALES_ENABLED!=='true')throw new Error('whatsapp_sales_disabled');
      const token=required(env.WHATSAPP_ACCESS_TOKEN,'whatsapp_access_token_missing');
      const phoneId=required(env.WHATSAPP_PHONE_NUMBER_ID,'whatsapp_phone_number_id_missing');
      const to=required(event.payload?.contact_ref,'whatsapp_recipient_missing');
      const text=required(event.payload?.text,'whatsapp_text_missing');const media=String(event.payload?.media_url||'').trim();
      const message=media?{messaging_product:'whatsapp',recipient_type:'individual',to,type:'image',image:{link:ensureHttps(media,'whatsapp_media_url_invalid'),caption:text.slice(0,1024)}}:{messaging_product:'whatsapp',recipient_type:'individual',to,type:'text',text:{preview_url:false,body:text}};
      const body=await requestJson(fetchImpl,`${metaBase()}/${encodeURIComponent(phoneId)}/messages`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(message)},[200]);
      const messageId=String(body?.messages?.[0]?.id||'');if(!messageId)throw providerAcceptanceMissing('whatsapp_message_id_missing');
      return Object.freeze({provider:'meta_whatsapp',accepted:true,provider_message_id:messageId,confirmation:'webhook_required'});
    },
    'channel:email':async(event)=>{
      ensureGlobalGates(env,commercialGate);const token=required(env.RESEND_API_KEY,'resend_api_key_missing');
      const from=required(env.RESEND_FROM_ADDRESS,'resend_from_missing');const to=required(event.payload?.contact_ref,'email_recipient_missing');
      const text=required(event.payload?.text,'email_text_missing');const media=String(event.payload?.media_url||'').trim();const email={from,to:[to],subject:String(event.payload?.subject||'ZEVANORY').slice(0,240),text};if(media)email.attachments=[{path:ensureHttps(media,'email_media_url_invalid'),filename:'zevanory-creative.png'}];
      const body=await requestJson(fetchImpl,'https://api.resend.com/emails',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':String(event.idempotency_key||event.event_id)},body:JSON.stringify(email)},[200]);
      const id=String(body?.id||'');if(!id)throw providerAcceptanceMissing('resend_email_id_missing');
      return Object.freeze({provider:'resend',accepted:true,provider_message_id:id,confirmation:'webhook_required'});
    },
    'channel:facebook':async(event,{sql}={})=>{
      ensureGlobalGates(env,commercialGate);let token='',pageId='';if(sql?.query){try{const c=await loadMetaCredential(sql,env);token=c.access_token;pageId=c.page_id;}catch{}}if(!token||!pageId){token=String(env.META_ACCESS_TOKEN||'').trim();pageId=String(env.META_PAGE_ID||'').trim();}token=required(token,'meta_access_token_missing');
      const pageIdSafe=required(pageId,'meta_page_id_missing');const message=required(contentWithLanding(event.payload?.content,event.payload?.landing_url,60000),'facebook_content_missing',60000);const media=String(event.payload?.media_url||'').trim();
      const endpoint=media?`${metaBase()}/${encodeURIComponent(pageIdSafe)}/photos`:`${metaBase()}/${encodeURIComponent(pageIdSafe)}/feed`;const payload=media?{url:ensureHttps(media,'facebook_media_url_invalid'),caption:message,published:true}:{message};
      const body=await requestJson(fetchImpl,endpoint,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(payload)},[200]);
      const id=String(body?.id||body?.post_id||'');if(!id)throw providerAcceptanceMissing('facebook_post_id_missing');
      return Object.freeze({provider:'meta_facebook',accepted:true,provider_post_id:id,media_attached:Boolean(media),confirmation:'provider_lookup_or_webhook_required'});
    },
    'channel:instagram':async(event,{sql}={})=>{
      ensureGlobalGates(env,commercialGate);let token='',igId='';if(sql?.query){try{const c=await loadMetaCredential(sql,env);token=c.access_token;igId=c.instagram_id;}catch{}}if(!token||!igId){token=String(env.META_ACCESS_TOKEN||'').trim();igId=String(env.INSTAGRAM_BUSINESS_ACCOUNT_ID||'').trim();}token=required(token,'meta_access_token_missing');
      const igIdSafe=required(igId,'instagram_business_account_id_missing');
      const imageUrl=ensureHttps(event.payload?.media_url,'instagram_media_url_required');const caption=contentWithLanding(event.payload?.content,event.payload?.landing_url,2200);
      const container=await requestJson(fetchImpl,`${metaBase()}/${encodeURIComponent(igIdSafe)}/media`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({image_url:imageUrl,caption})},[200]);
      const creationId=String(container?.id||'');if(!creationId)throw providerAcceptanceMissing('instagram_container_id_missing');
      const published=await requestJson(fetchImpl,`${metaBase()}/${encodeURIComponent(igIdSafe)}/media_publish`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({creation_id:creationId})},[200]);
      const id=String(published?.id||'');if(!id)throw providerAcceptanceMissing('instagram_media_id_missing');
      return Object.freeze({provider:'meta_instagram',accepted:true,provider_media_id:id,container_id:creationId,confirmation:'provider_lookup_required'});
    },
    'channel:youtube':async(event,{sql}={})=>{
      ensureGlobalGates(env,commercialGate);
      return uploadYouTubeFromRemote({event,sql,env,fetchImpl});
    },
    'channel:tiktok':async(event,{sql}={})=>{
      ensureGlobalGates(env,commercialGate);
      if(!sql?.query)throw new Error('tiktok_sql_required');
      let credential=await loadTikTokCredential(sql,env);
      if(new Date(credential.expires_at).getTime()<=Date.now()+30*60*1000) credential=await refreshTikTokCredential(sql,credential,{env,fetchImpl});
      return publishTikTok({event,env,fetchImpl,accessToken:credential.access_token});
    },
    'channel:linkedin':async(event,{sql}={})=>{
      ensureGlobalGates(env,commercialGate);
      if(!sql?.query)throw new Error('linkedin_sql_required');
      const credential=await loadLinkedInCredential(sql,env);
      return publishLinkedIn({event,env,fetchImpl,accessToken:credential.access_token,authorUrn:credential.author_urn});
    },
    'channel:affiliate':async(event)=>{
      ensureGlobalGates(env,commercialGate);const provider=required(env.AFFILIATE_PROVIDER,'affiliate_provider_missing');
      if(provider==='zevanory-first-party'){
        const id=String(event.idempotency_key||event.event_id||'');if(!id)throw new Error('affiliate_event_id_missing');
        return Object.freeze({provider:'affiliate:zevanory-first-party',accepted:true,provider_message_id:id,confirmation:'first_party_ledger'});
      }
      const url=ensureHttps(env.AFFILIATE_WEBHOOK_URL,'affiliate_webhook_url_missing');const token=required(env.AFFILIATE_WEBHOOK_TOKEN,'affiliate_webhook_token_missing');
      const body=await requestJson(fetchImpl,url,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':String(event.idempotency_key||event.event_id)},body:JSON.stringify({provider,event_id:event.event_id,aggregate_id:event.aggregate_id,payload:event.payload||{}})},[200,201,202]);
      const id=String(body?.id||body?.tracking_id||body?.event_id||'');if(!id)throw providerAcceptanceMissing('affiliate_provider_id_missing');
      return Object.freeze({provider:`affiliate:${provider}`,accepted:true,provider_message_id:id,confirmation:'provider_lookup_or_webhook_required'});
    },
    'channel:nuvemshop':async(event,{sql}={})=>{
      ensureGlobalGates(env,commercialGate);
      if(!sql?.query)throw new Error('nuvemshop_sql_required');const credential=await loadNuvemshopCredential(sql,env);const token=credential.access_token;const storeId=credential.store_id;const appId=required(env.NUVEMSHOP_APP_ID,'nuvemshop_app_id_missing');
      const product=event.payload?.product;if(!product||typeof product!=='object'||Array.isArray(product))throw new Error('nuvemshop_product_missing');
      const body=await requestJson(fetchImpl,`https://api.nuvemshop.com.br/v1/${encodeURIComponent(storeId)}/products`,{method:'POST',headers:{authorization:`Bearer ${token}`,'user-agent':`ZEVANORY https://zevanory.api.br (${appId})`,'content-type':'application/json'},body:JSON.stringify(product)},[200,201]);
      const id=String(body?.id||'');if(!id)throw providerAcceptanceMissing('nuvemshop_product_id_missing');
      return Object.freeze({provider:'nuvemshop',accepted:true,provider_product_id:id,confirmation:'provider_api_and_webhook'});
    },
    'channel:mercado_livre':async(event,{sql}={})=>{
      ensureGlobalGates(env,commercialGate);if(!sql?.query)throw new Error('mercadolivre_sql_required');
      const item=event.payload?.item;if(!item||typeof item!=='object'||Array.isArray(item))throw new Error('mercadolivre_item_missing');
      let credential=await loadMercadoLivreCredential(sql,env);
      if(new Date(credential.expires_at).getTime()<=Date.now()+120000) credential=await refreshMercadoLivreCredential(sql,credential,{env,fetchImpl});
      const body=await requestJson(fetchImpl,'https://api.mercadolibre.com/items',{method:'POST',headers:{authorization:`Bearer ${credential.access_token}`,'content-type':'application/json'},body:JSON.stringify(item)},[200,201]);
      const id=String(body?.id||'');if(!id)throw providerAcceptanceMissing('mercadolivre_item_id_missing');
      return Object.freeze({provider:'mercado_livre',accepted:true,provider_item_id:id,seller_id:String(credential.account_id),confirmation:'provider_api_after_notification'});
    },
  });
  const universal={};
  for(const [destination,direct] of Object.entries(directAdapters)){
    const channel=destination.replace(/^channel:/,'');
    if(!isActiveCommercialFront(channel)){universal[destination]=async()=>{throw new Error('channel_excluded_from_active_scope');};continue;}
    const builtIn=[defineChannelProvider({id:`direct:${channel}`,channel,independenceDomain:`direct:${channel}`,execute:({event,context})=>direct(event,context)})];
    if(channel==='email') builtIn.push(buildBrevoEmailProvider({env,fetchImpl}),buildMailjetEmailProvider({env,fetchImpl}));
    if(['facebook','instagram','linkedin','tiktok','youtube'].includes(channel)) builtIn.push(defineChannelProvider({
      id:`buffer:${channel}`,channel,independenceDomain:'buffer.com',cost:0,
      ready:()=>alternateAutomationReadiness(channel,env).ready,
      execute:({event})=>publishViaBuffer({channel,event,env,fetchImpl}),
    }));
    const pool=buildChannelProviderPool(channel,{builtIn,external:externalChannelProviders(channel,channelProviders)});
    const routed=buildUniversalChannelAdapter(channel,pool);
    universal[destination]=async(event,context)=>{
      // Authorization applies to the operation, including every alternate provider.
      ensureGlobalGates(env,commercialGate);
      return routed(event,context);
    };
  }
  return Object.freeze(universal);
}
