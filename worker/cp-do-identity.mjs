// NC-009 G01. Entry exclusively inside the trusted Hotmart webhook ingress.
// No public HTTP route or Cloudflare DO binding is provisioned by this module.
const REQUIRED = new Set(["PURCHASE_APPROVED","PURCHASE_COMPLETE","PURCHASE_REFUNDED","PURCHASE_CHARGEBACK","PURCHASE_PROTEST","PURCHASE_CANCELED"]);
export class CpRoutingError extends Error {
 constructor(code,status=400){super(code);this.code=code;this.status=status;}
}
const encoder=new TextEncoder();
const validPart=s=>typeof s==="string" && s.length>=5 && s.length<=160 && /^[a-zA-Z0-9._:-]+$/.test(s);
const digits=s=>typeof s==="string" && /^[0-9]+$/.test(s);
function safeEquals(a,b){
 if(!a||!b)return false;
 const aa=encoder.encode(a),bb=encoder.encode(b);
 if(aa.length!==bb.length)return false;
 let diff=0;for(let i=0;i<aa.length;i++)diff|=aa[i]^bb[i];
 return diff===0;
}
async function hmacHex(secret,message){
 const key=await crypto.subtle.importKey("raw",encoder.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const signature=await crypto.subtle.sign("HMAC",key,encoder.encode(message));
 return [...new Uint8Array(signature)].map(n=>n.toString(16).padStart(2,"0")).join("");
}
export async function resolveCpHotmartIngress(request,env){
 if(request?.method!=="POST" || !env || !env.CP_SUBSCRIBER_DO?.idFromName || !env.CP_SUBSCRIBER_DO?.get)
   throw new CpRoutingError("trusted_ingress_or_binding_missing",503);
 const hottok=String(env.HOTMART_HOTTOK||"");
 if(hottok.length<16 || !safeEquals(request.headers.get("x-hotmart-hottok")||"",hottok))
   throw new CpRoutingError("hotmart_not_authenticated",401);
 // Signature validated before body is interpreted. Do not accept buyer-defined DO IDs.
 let body;try{body=await request.json()}catch{throw new CpRoutingError("invalid_hotmart_json",400)}
 if(body?.version!=="2.0.0"||!REQUIRED.has(String(body?.event||"")))
   throw new CpRoutingError("invalid_hotmart_event",422);
 const id=String(body?.data?.product?.id||"");
 const configured=String(env.HOTMART_SERVICE_PRODUCT_IDS||"").split(",").map(x=>x.trim()).filter(Boolean);
 if(!digits(id)||!configured.includes(id))throw new CpRoutingError("wrong_product",403);
 const subscriptionCode=body?.data?.subscription?.subscriber?.code;
 const txn=body?.data?.purchase?.transaction;
 if(!validPart(subscriptionCode)||!validPart(txn))throw new CpRoutingError("subscriber_or_transaction_missing",422);
 // Identity only from Hottok-authenticated subscription owner; not buyer.email,
 // body.sub, URL, cookie or Authorization header. Never log or persist the original code.
 const routingKey=String(env.CP_DO_ROUTING_KEY||"");
 if(routingKey.length<32)throw new CpRoutingError("do_routing_key_missing",503);
 const opaque=await hmacHex(routingKey,"cp-do-routing/v1|"+id+"|"+subscriptionCode);
 const doId=env.CP_SUBSCRIBER_DO.idFromName("cp-verified:"+opaque);
 return {stub:env.CP_SUBSCRIBER_DO.get(doId),body,productId:id,opaqueRoutingId:opaque};
}
