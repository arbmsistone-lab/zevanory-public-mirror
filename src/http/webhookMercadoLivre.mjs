const json=(res,status,body)=>{res.statusCode=status;return res.end(JSON.stringify(body));};
const clean=(v,max=200)=>String(v??'').trim().slice(0,max);
const numeric=(v)=>/^\d+$/.test(clean(v,40));

export function validateMercadoLivreNotification(payload,env=process.env){
  const expectedApp=clean(env.MERCADOLIVRE_APP_ID,40);
  const expectedSeller=clean(env.MERCADOLIVRE_SELLER_ID,40);
  if(!numeric(expectedApp)||!numeric(expectedSeller)) return {ok:false,status:503,error:'mercadolivre_identity_unconfigured'};
  if(!payload||typeof payload!=='object'||Array.isArray(payload)) return {ok:false,status:400,error:'invalid_payload'};
  const appId=clean(payload.application_id,40),userId=clean(payload.user_id,40),topic=clean(payload.topic,80),resource=clean(payload.resource,500);
  if(appId!==expectedApp||userId!==expectedSeller) return {ok:false,status:401,error:'mercadolivre_identity_mismatch'};
  if(!topic||!resource.startsWith('/')||resource.startsWith('//')) return {ok:false,status:400,error:'mercadolivre_notification_invalid'};
  return {ok:true,topic,resource,application_id:appId,user_id:userId};
}

export default async function handler(req,res){
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control','no-store');
  res.setHeader('x-content-type-options','nosniff');
  if(req.method!=='POST') return json(res,405,{error:'method_not_allowed',accepted:false});
  const result=validateMercadoLivreNotification(req.parsedBody,process.env);
  if(!result.ok) return json(res,result.status,{error:result.error,accepted:false});
  return json(res,200,{accepted:true,provider:'mercado_livre',topic:result.topic});
}
