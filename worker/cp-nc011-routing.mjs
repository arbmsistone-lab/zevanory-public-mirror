// NC-011: effective Conteudo Pronto router (candidate only, no deploy).
// CP events never fall back to legacy KV. Non-CP digital products keep their own
// existing Hotmart path until an independent digital-products cutover.
import { isServiceProduct, validateCampaign, CAMPANHA_CAMPOS, CP_BRIEFING_FIELDS } from "./content-service.mjs";
import {handleDigitalHotmartNc012} from "./cp-nc012-digital-hotmart.mjs";
import {KIT_ORDER_INGEST_ENABLED,isKitProductNc015,ingestVerifiedKitCandidate} from "./kit-nc015-ingress.mjs";
import { handleCpDoWebhookCandidate, inspectCpFormTokenCandidate, submitCpFormCandidate, enqueueCpFormWorkCandidate } from "./cp-g03-g04-candidate.mjs";

const json=(status,body)=>Response.json(body,{status,headers:{"cache-control":"no-store"}});
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function page(title,body,status=200){
 return new Response('<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>'+esc(title)+' | ZEVANORY</title><style>body{background:#0a1121;color:#f0f5ff;font:16px system-ui;margin:0;padding:1rem}main{max-width:740px;margin:auto}label{display:block;margin:14px 0 5px}input,textarea{display:block;background:#15243a;border:1px solid #627998;border-radius:7px;color:#fff;padding:10px;width:100%;max-width:100%;box-sizing:border-box}button{padding:12px;background:#c8e0ff;color:#07121e;border:0;border-radius:7px;font-weight:bold;margin:18px 0}</style></head><body><main>'+body+'</main></body></html>',{status,headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","referrer-policy":"no-referrer","x-frame-options":"DENY"}});
}
function configuredIds(env){
 let json={};try{json=typeof env.CHANNEL_CREDENTIALS_JSON==="string"?JSON.parse(env.CHANNEL_CREDENTIALS_JSON):env.CHANNEL_CREDENTIALS_JSON||{}}catch{}
 return String(env.HOTMART_SERVICE_PRODUCT_IDS||json.HOTMART_SERVICE_PRODUCT_IDS||"8704905");
}
export async function routeHotmartNc011(request,env,ctx){
 if(request.method!=="POST")return json(405,{ok:false,error:"method_not_allowed"});
 let body;try{body=await request.clone().json()}catch{return json(400,{ok:false,error:"invalid_json"})}
 const ids=configuredIds(env);
 if(isServiceProduct(body?.data,ids)){
  // The only CP path is authenticated Hottok -> HMAC-routed SQLite DO.
  // Missing binding, invalid cycle and failed commit all reject (never return a false 200).
  return handleCpDoWebhookCandidate(request,{...env,HOTMART_SERVICE_PRODUCT_IDS:ids});
 }
 // CP product ID/name are never classified by buyer claims alone after the
 // strict allowlist; unknown digital products continue to their existing route.
 // DEC-04: existing guides/kits digital ledger is processed once. The DO
 // extension stays disabled in source until a separate owner release.
 if(KIT_ORDER_INGEST_ENABLED&&isKitProductNc015(body?.data,env)){
  const digital=await handleDigitalHotmartNc012(request.clone(),env);
  if(!digital.ok)return digital;
  const recorded=await ingestVerifiedKitCandidate(request,env);
  return recorded.ok?digital:recorded;
 }
 return handleDigitalHotmartNc012(request,env);
}
export async function routeBriefingNc011(request,env){
 if(!["GET","POST"].includes(request.method))return page("Método inválido","<h1>Método inválido</h1>",405);
 const url=new URL(request.url),token=url.searchParams.get("t")||"";
 const verify=request.method==="GET"?await inspectCpFormTokenCandidate({token,env}):null;
 if(request.method==="GET"&&!verify.ok)return page("Link indisponível","<h1>Link inválido, expirado ou ainda não liberado.</h1><p>Entre em contato com suporte@zevanory.api.br.</p>",verify.status===503?503:404);
 if(request.method==="GET"){
  const fields=[
   ...CAMPANHA_CAMPOS.map(f=>'<label for="'+esc(f.id)+'">'+esc(f.rotulo)+'</label><input id="'+esc(f.id)+'" name="'+esc(f.id)+'" maxlength="'+Number(f.max||100)+'" '+(f.tipo==="date"?'type="date"':'type="text"')+' required>'),
   ...CP_BRIEFING_FIELDS.map(([id,label,max,required])=>'<label for="'+esc(id)+'">'+esc(label)+(required?"":" (opcional)")+'</label>'+(max>120?'<textarea id="'+esc(id)+'" name="'+esc(id)+'" maxlength="'+max+'" '+(required?"required":"")+'></textarea>':'<input type="text" id="'+esc(id)+'" name="'+esc(id)+'" maxlength="'+max+'" '+(required?"required":"")+'>'))
  ];
  return page("Campanha do mês",'<h1>Conteúdo Pronto · campanha do mês '+Number(verify.cycle)+'</h1><p>Preencha os dados abaixo. O envio fica retido no registro transacional até o serviço de entrega ser homologado.</p><form method="post" action="?t='+encodeURIComponent(token)+'">'+fields.join("")+'<button type="submit">Registrar campanha</button></form>');
 }
 if(String(request.headers.get("content-type")||"").split(";")[0].trim()!=="application/x-www-form-urlencoded")
  return page("Formato inválido","<h1>Formato inválido.</h1>",415);
 let text;try{text=await request.text()}catch{return page("Erro","<h1>Não foi possível ler o formulário.</h1>",400)}
 if(text.length>16000)return page("Excesso de dados","<h1>Formulário muito longo.</h1>",413);
 const params=new URLSearchParams(text),fields={};
 for(const f of CAMPANHA_CAMPOS){
  if(params.getAll(f.id).length!==1)return page("Campo inválido","<h1>Campo ausente ou repetido.</h1>",400);
  fields[f.id]=params.get(f.id);
 }
 const camp=validateCampaign(fields,{now:Date.now()});
 if(!camp.ok)return page("Campanha incompleta","<h1>"+esc(camp.error)+"</h1>",422);
 const briefing={};
 for(const [id,label,max,required] of CP_BRIEFING_FIELDS){
  if(params.getAll(id).length>1)return page("Campo repetido","<h1>Campo repetido.</h1>",400);
  const value=String(params.get(id)||"").replace(/\s+/g," ").trim();
  if(value.length>max||(required&&value.length<2))return page("Briefing incompleto","<h1>Informe: "+esc(label)+"</h1>",422);
  briefing[id]=value;
 }
 const result=await submitCpFormCandidate({token,form:{briefing,campanha:camp.campanha},env});
 if(result.status!==202)return page("Não registrado","<h1>Não foi possível registrar a campanha.</h1><p>Nenhuma entrega foi prometida.</p>",result.status);
 const queued=await enqueueCpFormWorkCandidate({token,env});
 if(queued.status!==202)return page("Pendente","<h1>Registro aguardando fila de processamento.</h1><p>O formulário foi recebido, mas a geração ainda não está confirmada. Nenhum pacote ou e-mail foi enviado.</p>",503);
 return page("Registrado","<h1>Campanha registrada na fila transacional.</h1><p>Nenhum pacote ou e-mail será enviado até a homologação do consumidor DO e da outbox Resend.</p>",202);
}
export function routePackageNc011(){
 return page("Entrega indisponível","<h1>Pacote indisponível até homologação do novo sistema.</h1><p>Contate suporte@zevanory.api.br.</p>",503);
}
export function routeOperatorNc011(){
 return json(503,{ok:false,error:"cp_do_operator_not_connected",notice:"legacy_kv_operator_disabled"});
}
