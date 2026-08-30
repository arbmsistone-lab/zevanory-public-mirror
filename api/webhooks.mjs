import asaasHandler from '../src/http/webhookAsaas.mjs';
import mercadoPagoHandler from '../src/http/webhookMercadoPago.mjs';
import resendHandler from '../src/http/webhookResend.mjs';

const providerFrom=(req)=>{
  const direct=String(req.query?.provider||'').toLowerCase();
  if(direct) return direct;
  try{return String(new URL(req.url||'', 'https://zevanory.api.br').searchParams.get('provider')||'').toLowerCase();}catch{return '';}
};

export default async function handler(req,res){
  const provider=providerFrom(req);
  if(provider==='asaas') return asaasHandler(req,res);
  if(provider==='mercadopago') return mercadoPagoHandler(req,res);
  if(provider==='resend') return resendHandler(req,res);
  res.setHeader('content-type','application/json; charset=utf-8');
  res.statusCode=400;
  return res.end(JSON.stringify({error:'webhook_provider_invalid',accepted:false}));
}
