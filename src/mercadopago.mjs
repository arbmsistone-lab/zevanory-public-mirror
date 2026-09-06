import crypto from 'node:crypto';
import { PROJECT, isUuid } from './config.mjs';
import { externalReferenceForOrder, safePublicBaseUrl } from './order.mjs';
import { resolveCheckoutOffer } from './offerCatalog.mjs';

export const MERCADOPAGO_API_BASE='https://api.mercadopago.com';

const safeText=(value,min=1,max=160)=>{
  const text=String(value||'');
  return text.length>=min&&text.length<=max&&!/[\u0000-\u001f\u007f]/.test(text)?text:'';
};

export function buildMercadoPagoPreference(orderId,publicBaseUrl,offer=resolveCheckoutOffer(PROJECT.offerId)){
  const externalReference=externalReferenceForOrder(orderId);
  const base=safePublicBaseUrl(publicBaseUrl);
  if(!externalReference||!base||!isUuid(orderId)||!offer) return null;
  return Object.freeze({
    items:[{id:offer.id,title:`${offer.product} ${offer.version}`,description:'Produto digital ZEVANORY',quantity:1,currency_id:'BRL',unit_price:offer.price_brl}],
    back_urls:{success:`${base}/piloto?checkout=success`,pending:`${base}/piloto?checkout=pending`,failure:`${base}/piloto?checkout=failure`},
    auto_return:'approved',
    external_reference:externalReference,
    notification_url:`${base}/api/webhooks/mercadopago`,
    statement_descriptor:'ZEVANORY',
    metadata:{zevanory_order_id:String(orderId).toLowerCase(),offer_id:offer.id},
  });
}

function trustedCheckoutUrl(value){
  try{
    const url=new URL(String(value||''));
    const host=url.hostname.toLowerCase();
    const trusted=host==='mercadopago.com'||host.endsWith('.mercadopago.com')||host==='mercadopago.com.br'||host.endsWith('.mercadopago.com.br');
    return url.protocol==='https:'&&trusted?url.toString():'';
  }catch{return '';}
}
export function normalizeMercadoPagoPreference(value,externalReference,env='sandbox'){
  if(!value||typeof value!=='object') return null;
  const id=safeText(value.id,4,160);
  if(!id||String(value.external_reference||'')!==externalReference) return null;
  const preferred=String(env||'').toLowerCase()==='production'?value.init_point:value.sandbox_init_point||value.init_point;
  const link=trustedCheckoutUrl(preferred);
  if(!link) return null;
  return Object.freeze({id,link});
}

export function normalizeMercadoPagoWebhook(body,url=''){
  const type=String(body?.type||body?.topic||'').toLowerCase();
  const id=String(body?.data?.id||body?.id||'');
  if(type!=='payment'||!/^[0-9]{4,32}$/.test(id)) return null;
  const queryId=(()=>{try{return new URL(url,'https://zevanory.api.br').searchParams.get('data.id')||''}catch{return ''}})();
  if(queryId&&queryId!==id) return null;
  return Object.freeze({paymentId:id});
}

export function verifyMercadoPagoSignature({signature,requestId,dataId,secret,now=Date.now()}){
  const parts=Object.fromEntries(String(signature||'').split(',').map(x=>x.trim().split('=')).filter(x=>x.length===2));
  const ts=String(parts.ts||''); const v1=String(parts.v1||'');
  if(!/^\d{10,13}$/.test(ts)||!/^[a-f0-9]{64}$/i.test(v1)||!safeText(requestId,1,160)||!/^[0-9]{4,32}$/.test(String(dataId||''))||!secret) return false;
  const tsMs=ts.length===10?Number(ts)*1000:Number(ts);
  if(!Number.isFinite(tsMs)||Math.abs(now-tsMs)>10*60*1000) return false;
  const manifest=`id:${dataId};request-id:${requestId};ts:${ts};`;
  const expected=crypto.createHmac('sha256',String(secret)).update(manifest).digest('hex');
  const a=Buffer.from(expected); const b=Buffer.from(v1.toLowerCase());
  return a.length===b.length&&crypto.timingSafeEqual(a,b);
}

export function normalizeMercadoPagoFinancialEvent(payment,order){
  if(!payment||!order||String(payment.external_reference||'')!==String(order.external_reference||'')) return null;
  const amount=Math.round(Number(payment.transaction_amount)*100); const expected=Math.round(Number(order.amount)*100);
  if(!Number.isFinite(amount)||amount!==expected||expected<=0) return null;
  const status=String(payment.status||'').toLowerCase();
  if(status==='approved') return Object.freeze({normalized:'payment_confirmed',refundedTotal:null});
  const refunded=Math.round(Number(payment.transaction_amount_refunded||0)*100);
  if(status==='refunded'&&refunded===expected) return Object.freeze({normalized:'refund_confirmed',refundedTotal:refunded/100});
  if(status==='partially_refunded'&&refunded>0&&refunded<expected) return Object.freeze({normalized:'refund_confirmed',refundedTotal:refunded/100});
  return null;
}
