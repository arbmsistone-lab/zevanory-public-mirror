import {musicCurationDigest} from "./music-curation-report.mjs";
// Acquisition V1: independent channel outcomes, evidence-first and zero cold outreach.
// Cron ingress remains the existing Cloudflare hourly schedule; this module selects peak slots.
import { ensureDailyBlog, publishTelegram, channelChecklist, resolveChannelCredentials, localContentDay } from "./multichannel-autonomy.mjs";
import { publishBluesky, blueskyReady, blueskyPostText, graphemeCount } from "./bluesky-publisher.mjs";
import { emitActivity } from "./activity-ledger.mjs";
import { creativeAutopublishPaused } from "./creative-autonomy.mjs";
import { CLOSED_LABEL } from "./politica-unica.mjs";
import { priceBySku } from "./product-prices.mjs";
import { contentSalesOpen, salesLockViolations, hotmartKitsOpen, hotmartKit, hotmartLockViolations } from "./sales-lock-content.mjs";
export const ACQUISITION_STATE_PREFIX="zpc:acquisition:daily:";
export const ACQUISITION_CALENDAR_KEY="zpc:acquisition:calendar:v1";
const DAY=86400000;
const PRODUCTS=Object.freeze([
 {sku:"ZEV-IA-011",name:"IA na Prática",price:priceBySku("ZEV-IA-011")},
 {sku:"ZEV-VEN-011",name:"Vendas na Prática",price:priceBySku("ZEV-VEN-011")},
 {sku:"ZEV-LCX-011",name:"Lucro & Caixa",price:priceBySku("ZEV-LCX-011")},
 {sku:"ZEV-CMB-011",name:"Combo IA + Vendas",price:priceBySku("ZEV-CMB-011")},
 {sku:"ZEV-NGC-011",name:"Negócio Completo",price:priceBySku("ZEV-NGC-011")}
]);
const NICHES=Object.freeze(["salão","loja","prestador de serviço","delivery","autônomo"]);
const ANGLES=Object.freeze(["dor","tutorial","caso de uso","objeção","comparação"]);
const TIMEZONE="America/Sao_Paulo";
const PEAK_HOURS=Object.freeze({blog:9,telegram:12,bluesky:19});
const safeJson=async(kv,key,fallback)=>{try{return JSON.parse(String(await kv?.get?.(key)||"null"))??fallback;}catch{return fallback;}};
// Ausência real é legítima; falha/JSON/estrutura inválida nunca alimenta gate ou idempotência.
const obj=v=>v!==null&&typeof v==="object"&&!Array.isArray(v);
export async function readAcquisitionKv(kv,key,valid){
 try{const raw=await kv.get(key);if(raw===null)return {ok:true,value:null};
 const value=JSON.parse(String(raw));return valid(value)?{ok:true,value}:{ok:false};}catch{return {ok:false};}
}
const receiptShape=v=>obj(v)&&["pending","erro","publicado"].includes(v.status);
const stateShape=v=>obj(v)&&Array.isArray(v.outcomes)&&v.outcomes.every(o=>obj(o)&&typeof o.channel==="string"&&typeof o.status==="string");
const historyShape=v=>Array.isArray(v)&&v.every(p=>obj(p)&&typeof p.text==="string"&&typeof p.day==="string");
const dayOrdinal=day=>Math.floor(Date.parse(day+"T00:00:00Z")/DAY);
const localHour=now=>Number(new Intl.DateTimeFormat("en-GB",{timeZone:TIMEZONE,hour:"2-digit",hourCycle:"h23"}).format(now));
const localDay=now=>new Intl.DateTimeFormat("en-CA",{timeZone:TIMEZONE,year:"numeric",month:"2-digit",day:"2-digit"}).format(now);
export function calendarEntry(day){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw new Error("calendar_day_invalid");
 const n=dayOrdinal(day)-dayOrdinal("2026-10-10"); if(!Number.isInteger(n))throw new Error("calendar_day_invalid");
 const product=PRODUCTS[((n%5)+5)%5],niche=NICHES[((Math.floor(n/5)%5)+5)%5],angle=ANGLES[((n*3+Math.floor(n/5))%5+5)%5];
 const subject=niche+" · "+product.name+" · "+angle;
 return {day,product,niche,angle,subject,theme_id:[product.sku,niche,angle].join(":"),
  publish_at:{blog:"09:00",telegram:"12:00",bluesky:"19:00"},timezone:TIMEZONE};
}
export function planCalendar(now=new Date(),days=30){
 if(!Number.isInteger(days)||days<1||days>30)throw new Error("calendar_range_invalid");
 const first=localDay(now),epoch=Date.parse(first+"T00:00:00Z");
 return Array.from({length:days},(_,i)=>calendarEntry(new Date(epoch+i*DAY).toISOString().slice(0,10)));
}
// Trava de vendas (fail-closed): só com salesOpen === true o link vai ao checkout /comprar/<SKU>; fechada
// (padrão) vai à página do produto, a mesma convenção do blog e do Short (CLOSED_LABEL no texto).
export const PRODUCT_PAGES=Object.freeze({"ZEV-IA-011":"ia-na-pratica","ZEV-VEN-011":"vendas-na-pratica","ZEV-LCX-011":"lucro-e-caixa","ZEV-CMB-011":"combo-ia-vendas","ZEV-NGC-011":"negocio-completo"});
// Modo Hotmart (interruptor completo fechado, sales:hotmart:v1 aberto): o link vai ao caminho de compra do kit pela
// Hotmart no site de vendas (/hotmart/<slug>), nunca ao checkout próprio /comprar/.
export function productLink(entry,channel,{salesOpen=false,hotmartOpen=false}={}){
 if(!["blog","telegram","bluesky"].includes(channel))throw new Error("channel_not_enabled");
 const page=PRODUCT_PAGES[entry?.product?.sku];
 if(!page)throw new Error("product_page_unknown");
 const hm=salesOpen!==true&&hotmartOpen===true&&hotmartKit(entry.product.sku)!=null;
 const u=new URL("https://vendas.zevanory.api.br/"+(hm?"hotmart/"+page:(salesOpen===true?"comprar/"+entry.product.sku:page)));
 u.searchParams.set("utm_source",channel);u.searchParams.set("utm_medium","organic");u.searchParams.set("utm_campaign","conteudo_"+entry.day.replaceAll("-",""));
 return u.toString();
}
// Variação de texto (Plano Mestre F1). O template fixo por ângulo repetia o mesmo texto a cada ciclo de 25 dias
// do calendário, e o gate de similaridade (>= 0,5 contra os 30 últimos posts) passou a reprovar todo post do
// Bluesky a partir de 06/11 sem gravar nada no KV. Agora cada dia combina, de forma determinística pela data:
// uma dica concreta de um banco de 37 (primo: não se repete em 30 dias), um gancho entre 4 por ângulo (troca a
// cada ciclo de 25 dias) e uma chamada entre 7 (produto e chamada só voltam a coincidir após 35 dias). Sem LLM, sem
// dependência nova. Nenhuma frase promete resultado; o gate de compliance e a trava de vendas continuam iguais.
const CALENDAR_EPOCH="2026-10-10";
export const DAILY_TIPS=Object.freeze([
 "Separe as 3 perguntas mais comuns e deixe uma resposta base para cada.",
 "Reserve 15 minutos na sexta para revisar a agenda da semana seguinte.",
 "Anote toda saída do caixa no mesmo dia, mesmo as pequenas.",
 "Peça à IA um rascunho de resposta e revise antes de enviar.",
 "Crie uma etiqueta para orçamentos ainda sem retorno.",
 "Confira os 5 itens que mais saem antes de abrir as portas.",
 "Escreva em uma folha o roteiro do atendimento mais repetido.",
 "Responda primeiro quem espera há mais tempo, não quem chamou por último.",
 "Mantenha uma tabela curta de valores revisada toda segunda.",
 "Guarde cada comprovante de pagamento em uma pasta por mês.",
 "Defina um horário fixo para responder mensagens e avise os clientes.",
 "Teste um modelo de mensagem por uma semana antes de trocar.",
 "Compare entradas e saídas no fim de cada semana.",
 "Use dados fictícios ao testar a IA: nada de nome ou telefone real.",
 "Monte uma saudação curta com endereço e horário de funcionamento.",
 "Marque um lembrete para retomar contato com quem sumiu há um mês.",
 "Dinheiro do negócio e dinheiro de casa: mantenha separados.",
 "Peça permissão antes de enviar novidades a alguém.",
 "Revise com calma todo texto gerado por IA que cite valores ou prazos.",
 "Registre de onde veio cada cliente novo: indicação, rede social ou passagem.",
 "Calcule o custo de cada serviço antes de conceder desconto.",
 "Deixe pronta uma resposta educada para pedidos de desconto.",
 "Organize fotos dos trabalhos em um álbum fácil de enviar.",
 "Confirme o horário na véspera com uma mensagem simples.",
 "Escolha um único indicador para acompanhar neste mês, como pedidos por dia.",
 "Liste as tarefas que só você sabe fazer e descreva como fazê-las.",
 "Combine por escrito prazo e forma de pagamento antes de começar.",
 "Faça um resumo do dia em três linhas antes de fechar.",
 "Gere com a IA três versões de um aviso e escolha a mais clara.",
 "Uma vez por mês, corte os gastos fixos que você não usa.",
 "Explique num roteiro curto como funciona a entrega.",
 "Agrupe tarefas parecidas, como cobranças, num mesmo horário.",
 "Salve as respostas que funcionaram bem num documento compartilhado.",
 "Envie a mensagem para o seu próprio celular antes de mandar aos clientes.",
 "Quando um cliente reclama, siga um passo a passo combinado.",
 "Acompanhe as contas a receber numa lista com data de vencimento.",
 "Pergunte a dois clientes por semana o que poderia melhorar."
]);
// Variantes vizinhas (mesmo produto, nicho e ângulo 25 dias depois) mudam a preposição e a posição do nicho,
// para que nem as junções de palavras em volta do nicho se repitam.
export const ANGLE_HOOKS=Object.freeze({
 "dor":["Gargalo comum para {n}","Na rotina de {n}, um ajuste simples","Para {n}: mensagens que se repetem","Dia corrido de {n}? Comece aqui"],
 "tutorial":["Mini tutorial para {n}","Rotina de {n}: ajuste de 15 min","Para {n}: um passo para hoje","Dia a dia de {n}: teste hoje"],
 "caso de uso":["Exemplo de uso para {n}","No dia a dia de {n}, um caso","Para {n}: um caso simples","Rotina de {n}: um exemplo"],
 "objeção":["Sem tempo? Começo leve para {n}","Sem sistema novo: rotina de {n}","Para {n}: comece pequeno","Parece difícil? Rotina de {n}, aos poucos"],
 "comparação":["Manual ou assistido? Para {n}","Rotina de {n}: o que comparar","Para {n}: dois jeitos de organizar","Antes de trocar o método de {n}, compare"]
});
export const CTAS=Object.freeze(["Veja o guia","Saiba mais","Leia o guia","Confira","Detalhes no link","Mais no link","Conheça o guia"]);
const mod=(a,b)=>((a%b)+b)%b;
export function textVariant(day){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(String(day)))throw new Error("calendar_day_invalid");
 const n=dayOrdinal(day)-dayOrdinal(CALENDAR_EPOCH);
 return {tip:mod(n,DAILY_TIPS.length),hook:mod(Math.floor(n/25),4),cta:mod(n,CTAS.length)};
}
export function generateNative(entry,channel,{salesOpen=false,hotmartOpen=false}={}){
 const open=salesOpen===true;
 // Modo Hotmart: o kit leva o preço da tabela (R$ <preço>) no lugar do aviso de vendas fechadas.
 const kit=!open&&hotmartOpen===true?hotmartKit(entry?.product?.sku):null;
 const variant=textVariant(entry.day);
 const hook=ANGLE_HOOKS[entry.angle][variant.hook].replaceAll("{n}",entry.niche);
 const tip=DAILY_TIPS[variant.tip];
 // Fechada: o aviso vem logo após o nome do produto, antes de qualquer corte de tamanho (Bluesky).
 const prefix=entry.product.name+(kit?" (R$ "+kit.price+")":(open?"":" ("+CLOSED_LABEL+")"));
 const value=prefix+": "+tip;
 const cta=CTAS[variant.cta];
 const link=productLink(entry,channel,{salesOpen:open,hotmartOpen:kit!=null});
 if(channel==="telegram")return {channel,hook,value,cta,link,text:hook+"\n\n"+value+"\n\n"+cta+": "+link+"\n#ZEVANORY #Negocios"};
 if(channel==="bluesky"){
  // Limite de 300 grafemas: só a dica é encurtada, por palavra inteira e com reticências; nome, aviso e preço ficam.
  const words=tip.split(" ");
  for(let k=words.length;k>=0;k--){
   const v=k===0?prefix:prefix+": "+words.slice(0,k).join(" ")+(k<words.length?"…":"");
   const generated=blueskyPostText({hook,value:v,cta,productUrl:link,day:entry.day});
   if(k===0||generated.text.includes(hook+"\n"+v+"\n"+cta+"\n"))return {channel,hook,value:v,cta,link:generated.link,text:generated.text};
  }
 }
 if(channel==="blog")return {channel,hook,value,cta,link,text:hook+". "+value+" "+cta+": "+link};
 throw new Error("channel_not_enabled");
}
export function textSimilarity(a,b){
 const tokens=s=>String(s||"").toLocaleLowerCase("pt-BR").match(/[\p{L}\p{N}]+/gu)||[];
 const grams=s=>{const t=tokens(s);return new Set(t.slice(0,-2).map((_,i)=>t.slice(i,i+3).join(" ")));};
 const x=grams(a),y=grams(b);return [...x].filter(k=>y.has(k)).length/(new Set([...x,...y]).size||1);
}
export function validateDraft({draft,entry,priorPosts=[],linkHttpStatus=200,salesOpen=false,hotmartOpen=false}={}){
 const reasons=[],open=salesOpen===true;
 const kit=!open&&hotmartOpen===true?hotmartKit(entry?.product?.sku):null;
 const forbidden=/\b(?:lucro garantido|renda garantida|faturamento garantido|ganhe dinheiro|resultado garantido|depoimento real|cliente comprovou)\b/i;
 if(forbidden.test(draft?.text||""))reasons.push("claims");
 if(!draft?.text||!draft.text.includes(entry?.product?.name))reasons.push("product_identity");
 const link=productLink(entry,draft?.channel,{salesOpen:open,hotmartOpen:kit!=null});
 if(draft.link!==link||!draft.text.includes(link))reasons.push("utm_or_sku");
 // Vendas fechadas (ou trava ilegível): sem preço, sem /comprar, sem Hotmart/checkout, sem chamada de compra,
 // e o texto avisa que as vendas estão fechadas.
 // Modo Hotmart: só o preço exato e o caminho /hotmart/<slug> DESTE kit passam; o preço é obrigatório.
 if(kit){
  for(const v of hotmartLockViolations(String(draft?.text||"")+"\n"+String(draft?.link||""),kit.sku))reasons.push("hotmart_"+v);
  if(!String(draft?.text||"").includes("R$ "+kit.price))reasons.push("hotmart_price_missing");
 }else if(!open){
  for(const v of salesLockViolations(String(draft?.text||"")+"\n"+String(draft?.link||"")))reasons.push("sales_closed_"+v);
  if(!String(draft?.text||"").includes(CLOSED_LABEL))reasons.push("sales_closed_label_missing");
 }
 if(linkHttpStatus!==200)reasons.push("product_http_not_200");
 if(draft.channel==="bluesky"&&graphemeCount(draft.text)>300)reasons.push("channel_graphemes");
 if(draft.channel==="telegram"&&draft.text.length>4096)reasons.push("channel_length");
 if(priorPosts.slice(-30).some(p=>textSimilarity(draft.text,p.text)>=0.5))reasons.push("similarity");
 // Deterministic rubric: complete native format, true product, valid CTA, length and unique subject.
 const quality=100-[draft.hook?0:20,draft.value?0:20,draft.cta?0:20,draft.text?.includes(entry?.niche)?0:15].reduce((a,b)=>a+b,0);
 if(quality<85)reasons.push("quality");
 return {ok:reasons.length===0,compliance:reasons.includes("claims")?0:100,score:quality,similarity_max:Math.max(0,...priorPosts.slice(-30).map(p=>textSimilarity(draft.text,p.text))),reasons};
}
// The product URL is served by the separate sales Worker (vendas.zevanory.api.br,
// Custom Domain on the same account). A subrequest from this core Worker to it is
// not a reliable probe: it loops back through the sales Worker's CORE service
// binding and returned non-200 in production for every SKU (KV outcome
// "product_http_not_200") while browsers received 200. That made the gate block
// every Bluesky and engine-Telegram post. The link is therefore verified against
// the published catalog (the same SKUs the sales Worker routes, enforced by test);
// availability is proven externally by the read-only live-evidence workflow.
export const CATALOG_SKUS=Object.freeze(PRODUCTS.map(p=>p.sku));
export async function verifyProductLink(url){
 let u;try{u=new URL(url);}catch{return 0;}
 if(u.protocol!=="https:"||u.hostname!=="vendas.zevanory.api.br"||u.username||u.password||u.port)return 0;
 const m=/^\/comprar\/(ZEV-[A-Z0-9-]+)$/.exec(u.pathname);
 if(m)return CATALOG_SKUS.includes(m[1])?200:0;
 const h=/^\/hotmart\/([a-z-]+)$/.exec(u.pathname);
 if(h)return Object.values(PRODUCT_PAGES).includes(h[1])?200:0;
 return Object.values(PRODUCT_PAGES).includes(u.pathname.slice(1))?200:0;
}
const MAX_DAILY_ATTEMPTS=3;
// Definitive provider rejections happen before anything is published; they may be
// retried on a later tick. Ambiguous failures (timeouts, 5xx) stay terminal for
// Telegram, which has no idempotency key. Bluesky reuses a deterministic record
// key and adopts an existing record, so it can safely retry either way.
const definitiveFailure=message=>/^(bluesky_http_4\d\d|bluesky_session_invalid|bluesky_receipt_mismatch|telegram_http_4\d\d|provider_http_4\d\d|bluesky_product_link_invalid|bluesky_link_too_long|bluesky_grapheme_limit|telegram_credentials_missing|brand_[a-z0-9_]+)$/.test(String(message||""))&&!/_(408|429)$/.test(String(message||""));
async function publishChannel({channel,entry,env,now,kv,fetchImpl,past=[],salesOpen=false,hotmartOpen=false}){
 const key=ACQUISITION_STATE_PREFIX+entry.day+":"+channel;
 const read=await readAcquisitionKv(kv,key,receiptShape);
 if(!read.ok)return {channel,day:entry.day,status:"erro",code:"receipt_unreadable"};
 const prior=read.value;
 const attempts=Number(prior?.attempts||(prior?1:0));
 if(prior){
  const retryable=prior.status!=="publicado"&&attempts<MAX_DAILY_ATTEMPTS&&(channel==="bluesky"||(prior.status==="erro"&&prior.definitive===true));
  if(!retryable)return prior; // published, or ambiguous Telegram pending: never blindly repost
 }
 // Preserve legacy Telegram publish-once marker during cutover. Never produce two posts in a day.
 if(channel==="telegram"&&!prior){
  const legacyRead=await readAcquisitionKv(kv,"zpc:multichannel:evidence:telegram:daily:"+entry.day,obj);
  if(!legacyRead.ok)return {channel,day:entry.day,status:"erro",code:"legacy_receipt_unreadable"};
  const previous=legacyRead.value;
  if(previous){
   const adopted=previous.provider_post_id&&previous.url
    ?{channel,day:entry.day,status:"publicado",provider_post_id:String(previous.provider_post_id),url:previous.url,at:previous.publishedAt||null,product:null,provenance:"legacy"}
    :{channel,day:entry.day,status:"pending",code:"legacy_telegram_unverified",needs_reconciliation:true};
   await kv.put(key,JSON.stringify(adopted),{expirationTtl:45*86400});
   return adopted;
  }
 }
 const open=salesOpen===true;
 const draft=generateNative(entry,channel,{salesOpen:open,hotmartOpen:hotmartOpen===true});
 const linkHttpStatus=await verifyProductLink(draft.link);
 const gate=validateDraft({draft,entry,priorPosts:past,linkHttpStatus,salesOpen:open,hotmartOpen:hotmartOpen===true});
 if(!gate.ok){return {channel,day:entry.day,status:"erro",code:gate.reasons.join(","),gate};}
 const reservation={channel,day:entry.day,status:"pending",startedAt:now.toISOString(),theme_id:entry.theme_id,attempts:attempts+1};
 await kv.put(key,JSON.stringify(reservation),{expirationTtl:45*86400});
 try{
  const receipt=channel==="telegram"
   ?await publishTelegram({env,payload:{content:draft.text,media_url:"https://zevanory.api.br/brand/export/post-01.png"},fetchImpl})
   :await publishBluesky({env,title:draft.hook,hook:draft.hook,value:draft.value,cta:draft.cta,productUrl:draft.link,day:entry.day,topic:entry.product.sku,fetchImpl});
  if(!receipt?.url||!receipt?.provider_post_id)throw new Error("provider_receipt_missing");
  const outcome={channel,day:entry.day,status:"publicado",provider_post_id:receipt.provider_post_id,url:receipt.url,product:entry.product.sku,utm:draft.link,text:draft.text,at:now.toISOString(),attempts:attempts+1,gate};
  await kv.put(key,JSON.stringify(outcome),{expirationTtl:45*86400});
  // An independent, masked activity record; a failed outbox must not repost to the provider.
  await emitActivity(env,{type:"post_published",channel,status:"published",ref:channel+":"+entry.day+":"+entry.theme_id,link:receipt.url},{now:now.getTime()}).catch(()=>null);
  return outcome;
 }catch(error){
  const message=String(error?.message||"");
  const definitive=definitiveFailure(message);
  const code=/^bluesky_http_401$/.test(message)?"credential_expired":(/^[a-z0-9_]{3,60}$/.test(message)?message:"provider_unverified");
  // Telegram ambiguous failures keep "pending" (terminal, manual reconciliation).
  const failed={...reservation,status:definitive||channel==="bluesky"?"erro":"pending",code,definitive,needs_reconciliation:!definitive,failedAt:now.toISOString()};
  await kv.put(key,JSON.stringify(failed),{expirationTtl:45*86400}).catch(()=>null);
  return failed;
 }
}
// Status de falha do Bluesky (Plano Mestre F1). Uma reprovação do gate não grava a chave por canal
// (zpc:acquisition:daily:<dia>:bluesky), então de 06/11 em diante a falha não aparecia no painel nem gerava alerta.
// Reprovação do gate ou falha de publicação grava UMA chave do dia, com TTL. Se já existe um status válido para o
// dia, ele não é regravado, mesmo que o motivo ou a similaridade mudem (NC-F1-A1-01; cota de KV): no máximo 1
// gravação por dia em execuções sequenciais. A leitura seguida de escrita no KV NÃO protege contra execuções
// concorrentes (o KV não tem escrita condicional); o cron do motor é sequencial. Sucesso não grava nada.
export const BLUESKY_STATUS_PREFIX="bluesky:status:";
export const BLUESKY_STATUS_TTL=14*86400;
export const blueskyStatusKey=day=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(String(day)))throw new Error("calendar_day_invalid");return BLUESKY_STATUS_PREFIX+String(day).replaceAll("-","");};
export async function recordBlueskyFailure(kv,day,now,{motivo,similaridade=null}={}){
 const key=blueskyStatusKey(day);
 const sim=typeof similaridade==="number"&&Number.isFinite(similaridade)?Math.round(similaridade*1000)/1000:null;
 const status={ok:false,motivo:/^[a-z0-9_,]{1,120}$/.test(String(motivo||""))?String(motivo):"desconhecido",similaridade:sim,day};
 const read=await readAcquisitionKv(kv,key,v=>obj(v)&&v.ok===false&&v.day===day&&typeof v.motivo==="string");
 if(!read.ok)return {written:false,key,code:"status_unreadable"};
 const prior=read.value;
 if(prior?.ok===false&&prior.day===day)return {written:false,key};
 try{await kv.put(key,JSON.stringify({...status,at:now.toISOString()}),{expirationTtl:BLUESKY_STATUS_TTL});}catch{return {written:false,key};}
 return {written:true,key};
}
// Recuperação só depois de ler integralmente os 30 dias locais (hoje e 29 anteriores).
// Ausência real é legítima; um único recibo ilegível impede qualquer escrita do histórico.
export async function rebuildChannelHistory(kv,day,channel){
 const recovered=[];
 for(let i=29;i>=0;i--){
  const d=new Date(Date.parse(day+"T12:00:00Z")-i*DAY).toISOString().slice(0,10);
  const read=await readAcquisitionKv(kv,ACQUISITION_STATE_PREFIX+d+":"+channel,v=>receiptShape(v)&&(v.day===undefined||v.day===d)&&(v.status!=="publicado"||typeof v.text==="string"));
  if(!read.ok)return {ok:false};
  if(read.value?.status==="publicado")recovered.push({day:d,text:read.value.text,product:read.value.product??null});
 }
 return {ok:true,history:recovered};
}
// Decisão F0 nº 7 do proprietário (10/11/2026): o Telegram de divulgação fica DESLIGADO. Sem flag, variável de
// ambiente ou chave de KV que o religue: religar exige mudar este código (PR com decisão do dono). O código de
// publicação no Telegram continua aqui, só não é chamado pelo motor. Nada é gravado no KV pelo canal desligado.
export const OWNER_DISABLED_CHANNELS=Object.freeze(["telegram"]);
export const CHANNEL_DISABLED_CODE="canal_desligado_decisao_proprietario";
export async function runAcquisitionEngine(env={},now=new Date(),fetchImpl=fetch){
 env=resolveChannelCredentials(env);
 const kv=env.ZEVANORY_PRIVATE_ARTIFACTS;
 if(!kv?.get||!kv?.put)return {ok:false,code:"kv_unavailable"};
 const day=localContentDay(now),entry=calendarEntry(day),hour=localHour(now),channels=channelChecklist(env);
 const active=channel=>channels.find(x=>x.id===channel)?.configured===true;
 let pause;try{pause=await kv.get("zpc:creative-autonomy:paused:v1");}catch{return {ok:false,code:"pause_unreadable",outcomes:[]};}
 if(pause!==null&&pause!=="0"&&pause!=="1")return {ok:false,code:"pause_unreadable",outcomes:[]};
 const paused=pause==="1";
 // Trava canônica de vendas (KV sales:open:v1 via readSalesSwitch), lida uma vez por execução; erro = fechada.
 const salesOpen=await contentSalesOpen(env);
 // Modo Hotmart (sales:hotmart:v1 via readHotmartSwitch; erro = fechado): só vale com o interruptor completo fechado.
 // A pausa criativa acima continua valendo antes de qualquer publicação.
 const hotmartOpen=!salesOpen&&await hotmartKitsOpen(env);
 const outcomes=[];
 if(hour>=PEAK_HOURS.blog){
  try{
   const blog=await ensureDailyBlog(env,now,fetchImpl);
   outcomes.push({channel:"blog",status:blog.latest?"publicado":blog.draft?"rascunho":"erro",url:blog.latest?.url||null,at:blog.latest?.publishedAt||null,day,code:blog.latest?null:blog.reason||"blog_unavailable"});
   if(blog.latest)await emitActivity(env,{type:"post_published",channel:"blog",status:"published",ref:"blog:"+day+":"+blog.latest.slug,link:blog.latest.url},{now:now.getTime()}).catch(()=>null);
  }catch{outcomes.push({channel:"blog",status:"erro",code:"blog_generation_failed",day});}
 }
 for(const channel of ["telegram","bluesky"]){
  if(hour<PEAK_HOURS[channel])continue;
  if(OWNER_DISABLED_CHANNELS.includes(channel)){outcomes.push({channel,status:"desligado",code:CHANNEL_DISABLED_CODE,day});continue;}
  if(paused){outcomes.push({channel,status:"pausado",code:"creative_autopublish_paused",day});continue;}
  if(!active(channel)){
   outcomes.push({channel,status:"aguardando credencial",day});
   continue;
  }
  try{
   let historyRead=await readAcquisitionKv(kv,"zpc:acquisition:history:"+channel,historyShape);
   let historyRebuilt=false;
   if(!historyRead.ok){
    const rebuilt=await rebuildChannelHistory(kv,day,channel);
    if(rebuilt.ok){
     await kv.put("zpc:acquisition:history:"+channel,JSON.stringify(rebuilt.history),{expirationTtl:45*86400});
     historyRead={ok:true,value:rebuilt.history};historyRebuilt=true;
     if(channel==="bluesky")await recordBlueskyFailure(kv,day,now,{motivo:"history_rebuilt"});
    }
   }
   if(!historyRead.ok){
    outcomes.push({channel,status:"erro",code:"history_unreadable",day});
    if(channel==="bluesky")await recordBlueskyFailure(kv,day,now,{motivo:"history_unreadable"});
    continue;
   }
   const archive=historyRead.value??[];
   const result=await publishChannel({channel,entry,env,now,kv,fetchImpl,past:archive,salesOpen,hotmartOpen});
   if(historyRebuilt)result.history_rebuilt=true;
   outcomes.push(result);
   if(channel==="bluesky"&&result.status==="erro")await recordBlueskyFailure(kv,day,now,{motivo:result.code,similaridade:result.gate?.similarity_max});
   if(result.status==="publicado"&&!archive.some(p=>p.day===day)){
    await kv.put("zpc:acquisition:history:"+channel,JSON.stringify([...archive,{day,text:result.text,product:result.product}].slice(-30)),{expirationTtl:45*86400});
   }
  }catch{
   outcomes.push({channel,status:"erro",code:"engine_exception",day});
   if(channel==="bluesky")await recordBlueskyFailure(kv,day,now,{motivo:"engine_exception"}).catch(()=>null);
  }
 }
 // KV write budget (account-wide 1,000/day): the calendar changes once a day, not every run.
 const days=planCalendar(now);
 const calendarRead=await readAcquisitionKv(kv,ACQUISITION_CALENDAR_KEY,v=>obj(v)&&Array.isArray(v.days));
 const priorCal=calendarRead.value;
 if(calendarRead.ok&&(!priorCal||JSON.stringify(priorCal.days)!==JSON.stringify(days)))await kv.put(ACQUISITION_CALENDAR_KEY,JSON.stringify({updatedAt:now.toISOString(),days,timezone:TIMEZONE}),{expirationTtl:86400*2});
 const state={day,generatedAt:now.toISOString(),product:entry.product.sku,niche:entry.niche,angle:entry.angle,outcomes};
 const stateRead=await readAcquisitionKv(kv,ACQUISITION_STATE_PREFIX+day,stateShape);
 const priorState=stateRead.value;
 if(stateRead.ok&&(!priorState||JSON.stringify(priorState.outcomes)!==JSON.stringify(outcomes)||priorState.product!==state.product))await kv.put(ACQUISITION_STATE_PREFIX+day,JSON.stringify(state),{expirationTtl:45*86400});
 const ownerDigest=await runOwnerDailyDigest(env,now,fetchImpl);
 return {ok:true,...state,ownerDigest};
}
// 20:00 Sao Paulo owner digest: only real receipts, no invented funnel counts.
export async function runOwnerDailyDigest(env={},now=new Date(),fetchImpl=fetch){
 const kv=env.ZEVANORY_PRIVATE_ARTIFACTS,day=localDay(now),hour=localHour(now),key="zpc:acquisition:owner-digest:"+day;
 if(hour<20)return {status:"agendado",day};
 if(!kv?.get||!kv?.put)return {status:"erro",code:"kv_unavailable"};
 const markerRead=await readAcquisitionKv(kv,key,receiptShape);
 if(!markerRead.ok)return {status:"erro",code:"digest_marker_unreadable"};
 const existing=markerRead.value;if(existing)return existing;
 if(!env.RESEND_API_KEY||!env.OWNER_ALERT_EMAIL)return {status:"aguardando credencial",missing:["RESEND_API_KEY","OWNER_ALERT_EMAIL"].filter(x=>!env[x])};
 const sourceRead=await readAcquisitionKv(kv,ACQUISITION_STATE_PREFIX+day,stateShape);
 if(!sourceRead.ok)return {status:"erro",code:"digest_source_unreadable"};
 const state=sourceRead.value;
 const actual=(state?.outcomes||[]).filter(x=>x.status==="publicado"&&x.url);
 const lines=actual.map(x=>"• "+x.channel+": "+x.url);
 const subject="ZEVANORY | Resumo de divulgação "+day;
 const content=["Publicações confirmadas:",...(lines.length?lines:["Sem publicações comprovadas."]),"","Leads: sem dados","Checkouts: sem dados","Vendas: sem dados","Alertas: sem dados",await musicCurationDigest(kv),"","Agenda de amanhã: "+(calendarEntry(new Date(Date.parse(day+"T00:00:00Z")+DAY).toISOString().slice(0,10)).subject),"","Painel: https://controle.zevanory.api.br"].join("\n");
 await kv.put(key,JSON.stringify({status:"pending",day,at:now.toISOString()}),{expirationTtl:7*86400});
 try{
  const response=await fetchImpl("https://api.resend.com/emails",{method:"POST",headers:{"authorization":"Bearer "+String(env.RESEND_API_KEY),"content-type":"application/json"},body:JSON.stringify({from:String(env.RESEND_FROM_ADDRESS||"ZEVANORY <contato@zevanory.api.br>"),to:[String(env.OWNER_ALERT_EMAIL)],subject,text:content}),signal:AbortSignal.timeout(10000)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||!data?.id)throw new Error("owner_digest_provider_unverified");
  const receipt={status:"publicado",day,at:now.toISOString(),provider_post_id:String(data.id),channels:actual.map(x=>x.channel)};
  await emitActivity(env,{type:"email_sent",channel:"owner",status:"sent",ref:"owner-digest:"+day},{now:now.getTime()}).catch(()=>null);
  await kv.put(key,JSON.stringify(receipt),{expirationTtl:45*86400});
  return receipt;
 }catch{return {status:"erro",code:"owner_digest_unverified",needs_reconciliation:true};}
}

export async function acquisitionSnapshot(env={},now=new Date()){
 env=resolveChannelCredentials(env);
 const kv=env.ZEVANORY_PRIVATE_ARTIFACTS,day=localDay(now);
 const [today,calendar,blog,legacy]=await Promise.all([
  safeJson(kv,ACQUISITION_STATE_PREFIX+day,null),
  safeJson(kv,ACQUISITION_CALENDAR_KEY,null),
  safeJson(kv,"zpc:blog:index:v1",{articles:[]}),
  safeJson(kv,"zpc:multichannel:state:v1",{evidence:[]})
 ]);
 const channels=["blog","telegram","bluesky","pinterest","youtube","instagram","facebook","whatsapp","email"];
 const credentialList=channelChecklist(env);
 const fallback=[];
 const article=(blog.articles||[]).filter(x=>x.url&&x.publishedAt&&localDay(new Date(x.publishedAt))===day).sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt))[0];
 if(article)fallback.push({channel:"blog",status:"publicado",url:article.url,at:article.publishedAt});
 const telegram=(legacy.evidence||[]).filter(x=>x.channel==="telegram"&&x.url&&x.provider_post_id&&x.publishedAt&&localDay(new Date(x.publishedAt))===day).sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt))[0];
 if(telegram)fallback.push({channel:"telegram",status:"publicado",url:telegram.url,at:telegram.publishedAt});
 const proof=channels.map(channel=>{
  const configured=credentialList.find(x=>x.id===channel);
  const row=today?.outcomes?.find(x=>x.channel===channel)||fallback.find(x=>x.channel===channel)||null;
  const missing=Boolean(configured)&&!configured.configured;
  const awaitingApproval=missing&&configured.external_verification_pending===true;
  return {channel,configured:configured?.configured===true,
   status:row?.status||(awaitingApproval?"aguardando aprovação":missing?"aguardando credencial":"sem dados"),
   link:row?.url||null,at:row?.at||null,error:row?.code||null,
   next_post:calendarEntry(day).publish_at[channel]||null,
   posts_7d:null,clicks_7d:null,checkouts_7d:null};
 });
 return {schema:"zevanory.acquisition.v1",day,timezone:TIMEZONE,generatedAt:now.toISOString(),today:proof,calendar:calendar?.days||[],
   metrics:{visits:null,leads:null,checkouts:null,sales:null},
   timeline:proof.filter(x=>x.status==="publicado").map(x=>({at:x.at||null,channel:x.channel,type:"post_published",status:x.status,link:x.link}))};
}
