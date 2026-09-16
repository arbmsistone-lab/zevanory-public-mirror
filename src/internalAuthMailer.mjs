const JSON_HEADERS=Object.freeze({'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
const PRODUCT='arbm-contador-saloes';
const RESET_ORIGIN='https://arbm-mei-api.zevanory.workers.dev';
const EMAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const response=(status,body)=>new Response(JSON.stringify(body),{status,headers:JSON_HEADERS});
function validResetUrl(value){
  try{
    const url=new URL(String(value||''));
    return url.origin===RESET_ORIGIN&&url.pathname==='/'&&url.searchParams.has('reset_token')&&url.searchParams.get('reset_token').length>=32;
  }catch{return false;}
}
export async function handleInternalAuthMailer(request,env){
  const url=new URL(request.url);
  if(url.hostname!=='zevanory.internal'||url.pathname!=='/internal/auth/password-reset')return response(404,{error:'not_found'});
  if(request.method!=='POST')return response(405,{error:'method_not_allowed'});
  let body;try{body=await request.json();}catch{return response(400,{error:'invalid_json'});}
  const product=String(body?.product||''),email=String(body?.email||'').trim().toLowerCase(),resetUrl=String(body?.resetUrl||'');
  if(product!==PRODUCT||email.length>254||!EMAIL_RE.test(email)||!validResetUrl(resetUrl))return response(400,{error:'invalid_request'});
  const apiKey=String(env.RESEND_API_KEY||'');if(!apiKey)return response(503,{error:'mailer_unavailable'});
  const from=String(env.RESEND_FROM_ADDRESS||'Zevanory <suporte@zevanory.api.br>');
  const subject='Redefina sua senha do ARBM Contador';
  const text=`Recebemos uma solicitação para redefinir sua senha. Use este link em até 15 minutos: ${resetUrl}\n\nSe não foi você, ignore esta mensagem.`;
  const sent=await fetch('https://api.resend.com/emails',{method:'POST',headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json'},body:JSON.stringify({from,to:[email],subject,text})});
  const provider=await sent.json().catch(()=>null);if(!sent.ok||!provider?.id)return response(502,{error:'provider_rejected'});
  return response(202,{accepted:true,provider:'resend'});
}
