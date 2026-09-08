import asaasHandler from '../src/http/checkoutAsaas.mjs';
import mercadoPagoHandler from '../src/http/checkoutMercadoPago.mjs';
import { resolveCheckoutProviderRequest } from '../src/paymentProviders.mjs';

export const resolveCheckoutProvider=resolveCheckoutProviderRequest;

export default async function handler(req,res){
  const selected=resolveCheckoutProviderRequest(req);
  if(selected.ready&&selected.provider==='asaas') return asaasHandler(req,res);
  if(selected.ready&&selected.provider==='mercadopago') return mercadoPagoHandler(req,res);
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control','no-store');
  res.statusCode=503;
  return res.end(JSON.stringify({
    error:'payment_capacity_unavailable',
    preserved:true,
    provider:selected.provider||null,
    reason:selected.reason||'no_payment_provider_available',
  }));
}
