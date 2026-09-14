import { probeMercadoPagoCredential } from '../financialAccountReadModel.mjs';
import { evaluateActivationReadiness } from '../activationReadiness.mjs';

function json(res,status,body){
  res.statusCode=status;
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control','no-store');
  res.setHeader('x-content-type-options','nosniff');
  return res.end(JSON.stringify(body));
}

export default async function handler(req,res){
  if(req.method!=='GET') return json(res,405,{error:'method_not_allowed'});
  const probe=await probeMercadoPagoCredential({env:process.env});
  const readiness=evaluateActivationReadiness(process.env);
  const body={
    service:'ZEVANORY',payment_provider:'mercadopago',
    environment:String(process.env.MERCADOPAGO_ENV||'').toLowerCase()||null,
    configured:probe.configured===true,authenticated:probe.authenticated===true,
    webhook_secret_configured:Boolean(String(process.env.MERCADOPAGO_WEBHOOK_SECRET||'').trim()),
    pre_sale_ready:readiness.ready===true,pre_sale_blockers:[...readiness.blockers],
    movement_enabled:false,observed_at:new Date().toISOString(),
  };
  return json(res,probe.authenticated?200:503,body);
}