// NC-012 digital-products Hotmart ingestion (NOT Conteudo Pronto).
// Separate sales/activities ledger M3. Never writes the zpc:cp:* namespace.
import {recordHotmartSale} from "./sales-ledger.mjs";
import {emitActivity} from "./activity-ledger.mjs";
import {diarioSombra,eventoEntrega,eventoReembolso} from "./diario-sombra.mjs";
const ACTIVE=new Set(["PURCHASE_APPROVED","PURCHASE_COMPLETE"]);
const STOP=new Set(["PURCHASE_REFUNDED","PURCHASE_CHARGEBACK","PURCHASE_CANCELED","PURCHASE_PROTEST","SUBSCRIPTION_CANCELLATION"]);
const allowed=new Set([...ACTIVE,...STOP,"PURCHASE_EXPIRED","PURCHASE_DELAYED","PURCHASE_BILLET_PRINTED","PURCHASE_OUT_OF_SHOPPING_CART"]);
const json=(status,value)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function equal(a,b){
 const aa=new TextEncoder().encode(String(a)),bb=new TextEncoder().encode(String(b));
 if(!aa.length||aa.length!==bb.length)return false;
 let v=0;for(let i=0;i<aa.length;i++)v|=aa[i]^bb[i];return v===0;
}
export async function handleDigitalHotmartNc012(request,env){
 if(request.method!=="POST")return json(405,{ok:false,error:"method_not_allowed"});
 let cfg={};try{cfg=typeof env.CHANNEL_CREDENTIALS_JSON==="string"?JSON.parse(env.CHANNEL_CREDENTIALS_JSON):env.CHANNEL_CREDENTIALS_JSON||{}}catch{}
 const secret=String(env.HOTMART_HOTTOK||cfg.HOTMART_HOTTOK||"").trim();
 if(secret.length<16)return json(503,{ok:false,error:"hotmart_not_configured"});
 if(!equal(request.headers.get("x-hotmart-hottok")||"",secret))return json(401,{ok:false,error:"unauthorized"});
 let body;try{body=await request.json()}catch{return json(400,{ok:false,error:"invalid_json"})}
 const event=String(body?.event||"").toUpperCase(),data=body?.data||{},txn=String(data?.purchase?.transaction||"");
 if(!allowed.has(event)||!txn||txn.length>160||!/^[A-Za-z0-9._:-]+$/.test(txn))
  return json(422,{ok:false,error:"invalid_hotmart_event"});
 const productId=String(data?.product?.id||"");
 const cpIds=String(env.HOTMART_SERVICE_PRODUCT_IDS||cfg.HOTMART_SERVICE_PRODUCT_IDS||"8704905").split(",").map(x=>x.trim());
 if(cpIds.includes(productId)||String(data?.product?.name||"").trim()==="ZEVANORY Conteúdo Pronto")
  return json(403,{ok:false,error:"cp_event_misrouted"});
 const kv=env.ZEVANORY_PRIVATE_ARTIFACTS;
 if(!kv?.get||!kv?.put)return json(503,{ok:false,error:"sales_ledger_unavailable"});
 let result;try{result=await recordHotmartSale(kv,event,data)}catch{return json(503,{ok:false,error:"sales_ledger_commit_failed"})}
 // Idempotent activity marker in separate shared ledger. An identical webhook
 // may be replayed after an incomplete downstream read; never sends product email.
 if(ACTIVE.has(event))await emitActivity(env,{type:"delivery_sent",channel:"store",status:"hotmart_approved",ref:"hotmart:"+txn}).catch(()=>null);
 // P20 diário (sombra, docs/p20/diario-d1.md): best-effort, nunca bloqueia nem lança.
 if(ACTIVE.has(event))diarioSombra(env,null,()=>eventoEntrega({provider:"hotmart",transaction:txn,channel:"store",status:"hotmart_approved"}));
 if(STOP.has(event))diarioSombra(env,null,()=>eventoReembolso({provider:"hotmart",transaction:txn,stage:"hotmart_"+event.toLowerCase()}));
 if(STOP.has(event))await emitActivity(env,{type:"refund_requested",channel:"store",status:"hotmart_"+event.toLowerCase(),ref:"hotmart:"+txn}).catch(()=>null);
 return json(200,{ok:true,scope:"digital_product",duplicate:result?.reason==="duplicate"});
}
