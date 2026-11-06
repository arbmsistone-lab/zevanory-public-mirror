// NC-015 N1. Read-only Hotmart sales history. NEVER accepts a buyer-provided proof.
// Requires a server-side OAuth access token, supplied only after owner approval.
// Source: Hotmart Developers GET /payments/api/v1/sales/history?transaction=&product_id=.
const HISTORY="https://developers.hotmart.com/payments/api/v1/sales/history";
const TX=/^[A-Za-z0-9_.:-]{10,100}$/;
const PRODUCT=/^[0-9]{6,12}$/;
const ORDER=/^kr:[a-f0-9]{64}$/;
export class KitReadbackError extends Error {
 constructor(code,status=503){super(code);this.code=code;this.status=status}
}
export async function readHotmartOrderNc015({
 transaction,productId,approvedAtMs,orderOpaque,accessToken,fetcher=fetch,
 now=Date.now(),localRefundRequestOpen=false
}={}){
 if(!TX.test(transaction)||!PRODUCT.test(String(productId))||!ORDER.test(orderOpaque)||
    !Number.isSafeInteger(approvedAtMs)||!Number.isSafeInteger(now)||
    typeof accessToken!=="string"||accessToken.length<16||typeof fetcher!=="function")
  throw new KitReadbackError("readback_configuration_missing");
 const u=new URL(HISTORY);
 u.searchParams.set("transaction",transaction);
 u.searchParams.set("product_id",String(productId));
 u.searchParams.set("max_results","50");
 let response;
 try{
  response=await fetcher(u.toString(),{method:"GET",
   headers:{authorization:"Bearer "+accessToken,accept:"application/json"},
   redirect:"error",cache:"no-store"});
 }catch{throw new KitReadbackError("hotmart_readback_network_unavailable")}
 if(!response?.ok)throw new KitReadbackError("hotmart_readback_http_unavailable");
 let body;try{body=await response.json()}catch{throw new KitReadbackError("hotmart_readback_invalid_json")}
 if(!Array.isArray(body?.items)||body.page_info?.next_page_token)
  throw new KitReadbackError("hotmart_readback_ambiguous");
 const matching=body.items.filter(x=>x?.purchase?.transaction===transaction &&
   String(x?.product?.id)===String(productId));
 if(matching.length!==1)throw new KitReadbackError("hotmart_readback_ambiguous");
 const item=matching[0],purchase=item.purchase;
 if(purchase?.approved_date!==approvedAtMs)
  throw new KitReadbackError("hotmart_approval_timestamp_mismatch",403);
 if(purchase.status!=="APPROVED"||localRefundRequestOpen)
  throw new KitReadbackError("hotmart_purchase_not_eligible",403);
 // State of an independent refund request is additionally guarded by
 // KitReleaseLedger (held_refund_request). API APPROVED alone is insufficient.
 return Object.freeze({source:"hotmart_authoritative_readback",state:"APPROVED",
  order_opaque:orderOpaque,refund_request_open:false,checked_at_ms:now,
  approved_at_ms:approvedAtMs,product_id:String(productId)});
}
