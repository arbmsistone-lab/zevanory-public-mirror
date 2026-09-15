const reply=(res,status,body)=>{res.statusCode=status;res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');return res.end(JSON.stringify(body));};
export default async function handler(req,res){
  if(req.method!=='POST')return reply(res,405,{error:'method_not_allowed'});
  const kv=globalThis.__ZEVANORY_PRIVATE_KV__,lock='ops:wa-brand-migration:zevanory:v1';
  if(!kv?.get||!kv?.put)return reply(res,503,{error:'kv_unavailable'});
  if(await kv.get(lock))return reply(res,409,{error:'already_attempted'});
  await kv.put(lock,'started',{expirationTtl:3600});
  const token=String(process.env.WHATSAPP_ACCESS_TOKEN||''),id=String(process.env.WHATSAPP_PHONE_NUMBER_ID||''),version=String(process.env.META_GRAPH_VERSION||'v26.0');
  if(!token||!id)return reply(res,503,{error:'whatsapp_credentials_missing'});
  const r=await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(id)}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',display_name:'ZEVANORY'}),signal:AbortSignal.timeout(15000)});
  const b=await r.json().catch(()=>({}));
  await kv.put(lock,JSON.stringify({done:true,status:r.status}),{expirationTtl:3600});
  return reply(res,r.ok?200:502,{ok:r.ok,status:r.status,success:b?.success===true,error_code:b?.error?.code||null,error_subcode:b?.error?.error_subcode||null,error_type:b?.error?.type||null,error_message:String(b?.error?.message||'').slice(0,160)});
}
