// NC-009 N3. Kit DO routing is separate from Content Pronto subscription routing.
// Called ONLY from a Hotmart owner-authenticated webhook ingress (no public binding).
import { KitReleaseError } from "./kit-release-192h.mjs";
const kitEvents=new Set(["PURCHASE_APPROVED","PURCHASE_REFUNDED","PURCHASE_CHARGEBACK","PURCHASE_PROTEST","PURCHASE_CANCELED"]);
const enc=new TextEncoder();
const hex=x=>[...new Uint8Array(x)].map(y=>y.toString(16).padStart(2,"0")).join("");
const cteq=(a,b)=>{const x=enc.encode(String(a||"")),y=enc.encode(String(b||""));
 if(!x.length||x.length!==y.length)return false;let v=0;for(let i=0;i<x.length;i++)v|=x[i]^y[i];return v===0;};
export async function resolveVerifiedKitPurchase(request,env){
 if(request?.method!=="POST"||!env?.PURCHASE_RELEASE_DO?.idFromName||!env?.PURCHASE_RELEASE_DO?.get)
  throw new KitReleaseError("purchase_binding_unavailable",503);
 const token=String(env.HOTMART_HOTTOK||"");
 if(token.length<16||!cteq(token,request.headers.get("x-hotmart-hottok")))
  throw new KitReleaseError("unauthenticated_hotmart",401);
 let body;try{body=await request.json()}catch{throw new KitReleaseError("malformed_hotmart_json",400)}
 const data=body?.data||{},event=String(body?.event||""),productId=String(data?.product?.id||"");
 const allow=String(env.HOTMART_KIT_PRODUCT_IDS||"").split(",").map(x=>x.trim()).filter(Boolean);
 const transaction=String(data?.purchase?.transaction||"");
 if(body?.version!=="2.0.0"||!kitEvents.has(event)||!/^[0-9]+$/.test(productId)||!allow.includes(productId)||
   !/^[A-Za-z0-9_.:-]{10,100}$/.test(transaction))throw new KitReleaseError("invalid_kit_purchase",422);
 if(event==="PURCHASE_APPROVED" && !Number.isSafeInteger(data?.purchase?.approved_date))
  throw new KitReleaseError("approved_date_missing",422);
 const secret=String(env.PURCHASE_DO_ROUTING_KEY||"");
 if(secret.length<32)throw new KitReleaseError("kit_routing_key_missing",503);
 const key=await crypto.subtle.importKey("raw",enc.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const opaque=hex(await crypto.subtle.sign("HMAC",key,enc.encode("kit-release/v1|"+productId+"|"+transaction)));
 const id=env.PURCHASE_RELEASE_DO.idFromName("kit-verified:"+opaque);
 const actualId=String(id);
 if(!/^[a-f0-9]{64}$/.test(actualId))throw new KitReleaseError("kit_invalid_do_id",503);
 const eventKey="hotmart:"+event+":"+opaque.slice(0,40);
 return {stub:env.PURCHASE_RELEASE_DO.get(id),opaqueOrderId:"kr:"+actualId,
  event:{event_type:event,event_key:eventKey,approved_at_ms:data?.purchase?.approved_date??null},
  privateReference:{transaction,product_id:productId}, // internal DO only, NEVER log
  rawForAudit:{productId,event}}; // never expose transaction/buyer in logs
}
