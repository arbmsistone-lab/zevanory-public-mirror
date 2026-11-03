// NC-015 N1: outbox Resend consumer. Never enabled by changing an env value.
// Owner must explicitly approve a source-level activation and separate deploy.
export const KIT_RESEND_CONSUMER_ENABLED=false;
const KEY=/^kr:[a-f0-9]{64}:mail:v1$/;
const RECEIPT=/^[A-Za-z0-9_.:-]{8,180}$/;
const MAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PRIVATE_LINK=/^https:\/\/zevanory\.api\.br\/kit\/baixar\?t=v1\.[a-f0-9.]+$/;
export async function sendKitMailCandidate({
 stub,env,recipient,downloadLink,fetcher=fetch,enabled=false
}={}){
 if(!enabled)return {ok:false,code:"RESEND_DISABLED"};
 if(!MAIL.test(recipient)||!MAIL.test(String(env?.KIT_FROM_EMAIL||""))||
    !PRIVATE_LINK.test(downloadLink)||String(env?.RESEND_API_KEY||"").length<24||
    String(env?.INTERNAL_DO_SIGNING_KEY||"").length<24||!stub?.fetch)
  return {ok:false,code:"RESEND_CONFIGURATION_MISSING"};
 const claim=await stub.fetch("https://internal.kit.example/internal/email-claim",{
  method:"POST",headers:{"x-internal-do-key":env.INTERNAL_DO_SIGNING_KEY}});
 if(!claim.ok)return {ok:false,code:"MAIL_NOT_CLAIMABLE"};
 const data=await claim.json();
 if(!data.ok||!KEY.test(data.message_key))return {ok:false,code:"MAIL_NOT_CLAIMABLE"};
 // State is already "uncertain": an ambiguous network failure must not send again.
 let response;
 try{
  response=await fetcher("https://api.resend.com/emails",{
   method:"POST",headers:{
    "authorization":"Bearer "+env.RESEND_API_KEY,
    "content-type":"application/json","Idempotency-Key":data.message_key
   },
   body:JSON.stringify({
    from:env.KIT_FROM_EMAIL,to:[recipient],
    subject:"Seus arquivos ZEVANORY estão disponíveis",
    text:"Após a confirmação da liberação dos arquivos do seu pedido, use seu link individual: "+downloadLink
   }),
   redirect:"error",cache:"no-store"
  });
 }catch{return {ok:false,code:"MAIL_UNCERTAIN_NEEDS_RECONCILIATION"}}
 if(!response?.ok)return {ok:false,code:"MAIL_UNCERTAIN_NEEDS_RECONCILIATION"};
 let body;try{body=await response.json()}catch{return {ok:false,code:"MAIL_UNCERTAIN_NEEDS_RECONCILIATION"}}
 if(!RECEIPT.test(body?.id))return {ok:false,code:"MAIL_UNCERTAIN_NEEDS_RECONCILIATION"};
 const ack=await stub.fetch("https://internal.kit.example/internal/email-receipt",{
  method:"POST",headers:{"x-internal-do-key":env.INTERNAL_DO_SIGNING_KEY,"content-type":"application/json"},
  body:JSON.stringify({receipt:body.id})
 });
 if(!ack.ok)return {ok:false,code:"MAIL_UNCERTAIN_NEEDS_RECONCILIATION"};
 return {ok:true,code:"RESEND_ACCEPTED",receipt:body.id};
}
export function sendKitMailConfigured(args){
 return sendKitMailCandidate({...args,enabled:KIT_RESEND_CONSUMER_ENABLED});
}
