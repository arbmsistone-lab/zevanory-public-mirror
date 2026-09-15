import { safeBearerEqual } from '../security.mjs';

const json=(res,status,body)=>{res.statusCode=status;res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.end(JSON.stringify(body));};

export default async function handler(req,res){
  if(req.method!=='POST')return json(res,405,{error:'method_not_allowed'});
  const expected=String(process.env.WHATSAPP_BRAND_MIGRATION_TOKEN||'');
  const provided=String(req.headers?.authorization||'').replace(/^Bearer\s+/i,'');
  if(!expected||!safeBearerEqual(expected,provided))return json(res,401,{error:'maintenance_auth_required'});
  const token=String(process.env.WHATSAPP_ACCESS_TOKEN||'');
  const phoneId=String(process.env.WHATSAPP_PHONE_NUMBER_ID||'');
  const version=String(process.env.META_GRAPH_VERSION||'v26.0');
  if(!token||!phoneId)return json(res,503,{error:'whatsapp_provider_not_configured'});
  const url=`https://graph.facebook.com/${encodeURIComponent(version)}/${encodeURIComponent(phoneId)}`;
  try{
    const response=await fetch(url,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',new_display_name:'ZEVANORY'}),signal:AbortSignal.timeout(10000)});
    const body=await response.json().catch(()=>({}));
    const safe={ok:response.ok,status:response.status,success:body?.success===true,error_code:body?.error?.code||null,error_subcode:body?.error?.error_subcode||null,error_type:body?.error?.type||null,error_message:String(body?.error?.message||'').slice(0,180)||null};
    return json(res,response.ok?200:502,safe);
  }catch(error){return json(res,503,{ok:false,error:'provider_unavailable',detail:String(error?.message||'').slice(0,120)});}
}
