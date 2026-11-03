// NC-015: isolated Hotmart kit event ingestion into its own DO.
// The non-CP digital-products financial ledger remains independently routed.
// Mounting is behind a SOURCE CODE constant, not an environment override.
import {resolveVerifiedKitPurchase} from "./kit-hotmart-identity.mjs";
export const KIT_ORDER_INGEST_ENABLED=false;
export function isKitProductNc015(data,env){
 const id=String(data?.product?.id??"");
 const allow=String(env?.HOTMART_KIT_PRODUCT_IDS||"").split(",").map(x=>x.trim());
 return /^[0-9]{6,12}$/.test(id)&&allow.includes(id);
}
export async function ingestVerifiedKitCandidate(request,env){
 try{
  const verified=await resolveVerifiedKitPurchase(request,env);
  if(String(env?.INTERNAL_DO_SIGNING_KEY||"").length<24)
   return Response.json({ok:false,error:"internal_do_signing_unavailable"},{status:503});
  const response=await verified.stub.fetch("https://internal.kit.example/internal/event",{
   method:"POST",headers:{"content-type":"application/json","x-internal-do-key":env.INTERNAL_DO_SIGNING_KEY},
   body:JSON.stringify({...verified.event,private_reference:verified.privateReference})
  });
  if(!response?.ok)return Response.json({ok:false,error:"kit_do_commit_not_confirmed"},{status:503});
  return Response.json({ok:true,code:"KIT_DO_COMMITTED"},{status:202});
 }catch(error){
  const status=error?.status===400||error?.status===401||error?.status===422?error.status:503;
  return Response.json({ok:false,error:status===503?"kit_do_unavailable":"kit_webhook_rejected"},{status});
 }
}
