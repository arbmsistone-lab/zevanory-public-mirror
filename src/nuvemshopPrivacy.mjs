import { decryptCommercialSecret } from './commercialOAuthCrypto.mjs';

export const validNuvemshopMerchantEmail=value=>typeof value==='string'&&value.length<=254&&/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);

// Only the verified store owner's address is retained, encrypted, in the store record.
// Customer payloads remain transient. The report contains no customer identifiers or orders.
export async function sendNuvemshopPrivacyReport(sql,{storeId,requestId,deliveryKey,env=process.env,fetchImpl=globalThis.fetch}={}){
 if(!env.RESEND_API_KEY)throw new Error('nuvemshop_privacy_delivery_unconfigured');
 const rows=await sql.query('select merchant_email_enc from nuvemshop_connections where store_id=$1',[storeId]);
 if(rows.length!==1||!rows[0].merchant_email_enc)throw new Error('nuvemshop_privacy_recipient_unverified');
 const recipient=decryptCommercialSecret(rows[0].merchant_email_enc,env);
 if(!validNuvemshopMerchantEmail(recipient)||! /^[1-9][0-9]{0,19}$/.test(String(requestId||'')))throw new Error('nuvemshop_privacy_recipient_unverified');
 const report={provider:'nuvemshop',data_request_id:requestId,customer_payloads_stored:false,customer_data:[],orders:[],checkouts:[],draft_orders:[],commercial_enabled:false};
 const response=await fetchImpl('https://api.resend.com/emails',{method:'POST',redirect:'error',signal:AbortSignal.timeout(1500),headers:{authorization:'Bearer '+env.RESEND_API_KEY,'content-type':'application/json','Idempotency-Key':'nuvemshop-privacy/'+deliveryKey},body:JSON.stringify({from:'ZEVANORY <contato@zevanory.api.br>',to:[recipient],subject:'ZEVANORY — relatório de dados Nuvemshop',text:'Relatório solicitado pelo comerciante. A integração não mantém cadastros ou conteúdo de clientes/pedidos Nuvemshop. Apenas recibos HMAC mínimos de entrega e estado da própria integração são mantidos.\n\n'+JSON.stringify(report,null,2)})});
 const body=await response.json().catch(()=>null);
 if(!response.ok||typeof body?.id!=='string'||!body.id)throw new Error('nuvemshop_privacy_delivery_failed');
 return Object.freeze({merchant_report_sent:true});
}
