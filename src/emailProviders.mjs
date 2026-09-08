import { defineChannelProvider } from './channelProviderRegistry.mjs';
import { requestProviderJson, providerAcceptanceMissing } from './providerDelivery.mjs';

const clean=(value,max=8000)=>String(value??'').trim().slice(0,max);
const requestJson=(fetchImpl,url,options,success)=>requestProviderJson(fetchImpl,url,options,success,{timeoutMs:15000});

export function buildBrevoEmailProvider({env=process.env,fetchImpl=globalThis.fetch}={}){
  const apiKey=clean(env.BREVO_API_KEY,4000);
  const fromEmail=clean(env.BREVO_FROM_ADDRESS,320);
  const fromName=clean(env.BREVO_FROM_NAME||'ZEVANORY',120);
  return defineChannelProvider({
    id:'brevo-email',channel:'email',independenceDomain:'brevo.com',cost:0,
    ready:()=>Boolean(apiKey&&fromEmail),
    execute:async({event})=>{
      if(!apiKey||!fromEmail)throw new Error('brevo_not_configured');
      const to=clean(event?.payload?.contact_ref,320);if(!to)throw new Error('email_recipient_missing');
      const text=clean(event?.payload?.text,5000);if(!text)throw new Error('email_text_missing');
      const subject=clean(event?.payload?.subject||'ZEVANORY',240);
      const body=await requestJson(fetchImpl,'https://api.brevo.com/v3/smtp/email',{method:'POST',headers:{'api-key':apiKey,'content-type':'application/json'},body:JSON.stringify({sender:{email:fromEmail,name:fromName},to:[{email:to}],subject,textContent:text,headers:{'X-Mailin-custom':`event_id:${clean(event?.event_id,200)}`}})},[201]);
      const id=clean(body?.messageId,300);if(!id)throw providerAcceptanceMissing('brevo_message_id_missing');
      return Object.freeze({provider:'brevo',accepted:true,provider_message_id:id,confirmation:'webhook_required'});
    },
  });
}
