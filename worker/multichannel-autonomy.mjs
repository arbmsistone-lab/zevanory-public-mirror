import { CREATIVE_AUTONOMY_FEED_KEY, creativeAutopublishPaused, evaluateCreativeWithRewrites } from "./creative-autonomy.mjs";

export const CHANNEL_STATE_KEY="zpc:multichannel:state:v1";
export const BLOG_INDEX_KEY="zpc:blog:index:v1";
export const CHANNEL_PROOF_PREFIX="zpc:multichannel:proof:";
const DAY=86400;
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const clean=(v,n=4000)=>String(v??"").trim().slice(0,n);
const truth=v=>[true,"true","1","live","approved"].includes(typeof v==="string"?v.toLowerCase():v);
const baseUrl=env=>clean(env.PUBLIC_BASE_URL||"https://zevanory.api.br",500).replace(/\/$/,"");
const CHANNEL_SECRET_NAMES=Object.freeze(["TELEGRAM_BOT_TOKEN","TELEGRAM_CHANNEL_ID","YOUTUBE_CLIENT_ID","YOUTUBE_CLIENT_SECRET","YOUTUBE_REFRESH_TOKEN","PINTEREST_ACCESS_TOKEN","PINTEREST_BOARD_ID"]);
export const INDEXNOW_PUBLIC_KEY="4782b8291736ddb8fc6239a51c81d3004324faba12f20f625ddbf52ae0d8e922";

export function resolveChannelCredentials(env={}){
 let bundle={};
 try{const raw=env.CHANNEL_CREDENTIALS_JSON;if(raw&&typeof raw==="object")bundle=raw;else if(clean(raw))bundle=JSON.parse(String(raw));}catch{}
 const resolved={...env};
 for(const name of CHANNEL_SECRET_NAMES)if(clean(bundle?.[name]))resolved[name]=bundle[name];
 return resolved;
}

export const CHANNELS=Object.freeze([
 {id:"telegram",label:"Telegram",docs:"https://core.telegram.org/bots/tutorial",secrets:["TELEGRAM_BOT_TOKEN","TELEGRAM_CHANNEL_ID"],activation:"credential"},
 {id:"pinterest",label:"Pinterest",docs:"https://developers.pinterest.com/apps/",secrets:["PINTEREST_ACCESS_TOKEN","PINTEREST_BOARD_ID"],scopes:["pins:write","boards:write"],activation:"credential"},
 {id:"blog",label:"Blog / SEO",docs:"https://www.indexnow.org/documentation",secrets:[],activation:"automatic"},
 {id:"youtube",label:"YouTube Shorts",docs:"https://developers.google.com/youtube/v3/guides/uploading_a_video",secrets:["YOUTUBE_CLIENT_ID","YOUTUBE_CLIENT_SECRET","YOUTUBE_REFRESH_TOKEN"],activation:"credential"},
 {id:"google_search",label:"Google Search Console + Blog",docs:"https://search.google.com/search-console/sitemaps",secrets:[],activation:"automatic"},
 {id:"instagram",label:"Instagram",docs:"https://developers.facebook.com/docs/instagram-platform/content-publishing/",secrets:["META_ACCESS_TOKEN","INSTAGRAM_BUSINESS_ACCOUNT_ID"],activation:"live",flag:"META_APP_LIVE"},
 {id:"facebook",label:"Facebook",docs:"https://developers.facebook.com/docs/pages-api/posts/",secrets:["META_ACCESS_TOKEN","META_PAGE_ID"],activation:"live",flag:"META_APP_LIVE"},
 {id:"tiktok",label:"TikTok",docs:"https://developers.tiktok.com/doc/content-posting-api-get-started/",secrets:["TIKTOK_CLIENT_KEY","TIKTOK_CLIENT_SECRET"],activation:"audit",flag:"TIKTOK_AUDIT_APPROVED"},
 {id:"newsletter",label:"Newsletter",docs:"https://resend.com/docs/dashboard/emails/introduction",secrets:["RESEND_API_KEY"],activation:"double_opt_in"}
]);

export function channelChecklist(env={}){
 env=resolveChannelCredentials(env);
 return CHANNELS.map(channel=>{const missing=channel.secrets.filter(name=>!clean(env[name]));const externallyApproved=!channel.flag||truth(env[channel.flag]);const configured=missing.length===0&&externallyApproved;return Object.freeze({...channel,configured,mode:configured?"active":channel.activation==="live"||channel.activation==="audit"?"dry_run":"pending",missing:Object.freeze(missing),external_verification_pending:missing.length===0&&!externallyApproved});});
}

async function requestJson(fetchImpl,url,options,accepted=[200,201]){const response=await fetchImpl(url,{...options,signal:AbortSignal.timeout(15000)});const body=await response.json().catch(()=>({}));if(!accepted.includes(response.status))throw new Error(`provider_http_${response.status}`);return body;}

export const TELEGRAM_CAPTION_MAX=1024;
export function telegramCaption(text=""){const value=String(text||"");if(value.length<=TELEGRAM_CAPTION_MAX)return value;const cut=value.slice(0,TELEGRAM_CAPTION_MAX-1),space=cut.lastIndexOf(" ");return (space>TELEGRAM_CAPTION_MAX-200?cut.slice(0,space):cut).trimEnd()+"…";}
export async function publishTelegram({env={},payload={},fetchImpl=fetch}={}){const token=clean(env.TELEGRAM_BOT_TOKEN),chat=clean(env.TELEGRAM_CHANNEL_ID,200),text=clean(payload.content||payload.text,3900),media=clean(payload.media_url);if(!token||!chat)throw new Error("telegram_credentials_missing");const send=(method,body)=>requestJson(fetchImpl,`https://api.telegram.org/bot${token}/${method}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});let out;if(media){/* Bot API: photo captions are capped at 1024 chars (longer => HTTP 400). Keep the full text by falling back to a message with the image link when the photo is refused. */try{out=await send("sendPhoto",{chat_id:chat,photo:media,caption:telegramCaption(text)});}catch(error){if(!/_400$/.test(String(error?.message||"")))throw error;out=await send("sendMessage",{chat_id:chat,text:clean(`${text}\n\n${media}`,4096)});}}else out=await send("sendMessage",{chat_id:chat,text});if(out?.ok!==true||!out?.result?.message_id)throw new Error("telegram_acceptance_missing");const username=chat.startsWith("@")?chat.slice(1):String(out.result?.chat?.username||"");return {provider:"telegram",provider_post_id:String(out.result.message_id),url:/^[A-Za-z0-9_]{5,32}$/.test(username)?`https://t.me/${username}/${out.result.message_id}`:null};}

export async function publishPinterest({env={},payload={},fetchImpl=fetch}={}){const token=clean(env.PINTEREST_ACCESS_TOKEN),board=clean(env.PINTEREST_BOARD_ID,200),link=clean(payload.landing_url),media=clean(payload.media_url);if(!token||!board)throw new Error("pinterest_credentials_missing");const out=await requestJson(fetchImpl,"https://api.pinterest.com/v5/pins",{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({board_id:board,title:clean(payload.title,100),description:clean(payload.content,500),link,media_source:{source_type:"image_url",url:media}})});if(!out?.id)throw new Error("pinterest_acceptance_missing");return {provider:"pinterest",provider_post_id:String(out.id),url:`https://www.pinterest.com/pin/${out.id}/`};}

const topics=Object.freeze([
["ia-pratica-pequenos-negocios","IA prática para pequenos negócios","Como organizar tarefas repetitivas com IA sem perder controle"],
["automacao-atendimento-clareza","Automação de atendimento com clareza","Um roteiro seguro para responder melhor e medir resultados"],
["conteudo-organico-com-evidencia","Conteúdo orgânico com evidência","Como transformar dúvidas reais em conteúdo útil e mensurável"],
["vendas-lojas-fortaleza","Vendas para lojas de Fortaleza: rotina de atendimento","Guia digital para lojistas: registro de pedidos, reposição e seguimento ético sem listas frias","Para uma loja de Fortaleza, anote a pergunta do cliente, ofereça a informação solicitada e registre o próximo passo escolhido por ele. Não há necessidade de compras de listas nem disparos de mensagens."],
["caixa-comercio-juazeiro-do-norte","Caixa para pequenos comércios de Juazeiro do Norte","Uma rotina simples para acompanhar entradas, margem e saídas sem prometer resultados","Um pequeno comércio de Juazeiro do Norte pode separar diariamente entradas, custos de reposição e valores a receber. Use o material para organizar controles internos, sem tratar este guia digital como atendimento local presencial."],
["atendimento-servicos-varzea-alegre","Atendimento em serviços de Várzea Alegre","Como documentar dúvidas, orçamento e devolutiva em negócios de serviços","Para prestadores de serviços em Várzea Alegre, registre data, tipo de solicitação e consentimento para retorno. Responda apenas quem procurou o negócio ou autorizou o contato; revise os modelos antes de usar."]
]);
const isoWeek=date=>{const d=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate()));d.setUTCDate(d.getUTCDate()+4-(d.getUTCDay()||7));const y=new Date(Date.UTC(d.getUTCFullYear(),0,1));return `${d.getUTCFullYear()}-${String(Math.ceil((((d-y)/86400000)+1)/7)).padStart(2,"0")}`;};
const desiredCount=()=>3;
function articleFor(topic,now,env){const [slug,title,description]=topic,url=`${baseUrl(env)}/blog/${slug}`;const body=(topic[3] ? topic[3]+" " : "Escolha uma tarefa repetitiva, defina um resultado mensurável e mantenha revisão humana simples. ")+"A ZEVANORY oferece um guia digital para processos práticos, sem promessas de ganho financeiro. Conheça a solução por R$ 197,00. Garantia de 7 dias.";const rubric=evaluateCreativeWithRewrites({brand:"ZEVANORY",site:"zevanory.api.br",width:1080,height:1080,hook:title,body,cta:"Conheça a ZEVANORY",price_brl:197},{serverPrice:197,visualScore:1});if(rubric.action!=="publish")throw new Error("blog_compliance_rejected");return {slug,title,description,body:rubric.spec.body,publishedAt:now.toISOString(),url,score:rubric.score,compliance:rubric.compliance,faq:[{q:"Por onde começar?",a:"Escolha uma tarefa pequena, mensurável e reversível."},{q:"Como reduzir riscos?",a:"Use revisão, registro de evidências e limites claros."}]};}

export async function ensureWeeklyBlog(env={},now=new Date(),fetchImpl=fetch){const kv=env.ZEVANORY_PRIVATE_ARTIFACTS;if(!kv?.get||!kv?.put)return {created:[],reason:"kv_unavailable"};let state={week:isoWeek(now),articles:[]};try{state=JSON.parse(String(await kv.get(BLOG_INDEX_KEY)||"null"))||state;}catch{}if(state.week!==isoWeek(now))state={week:isoWeek(now),articles:[]};const target=desiredCount(now),created=[];while(state.articles.length<target&&state.articles.length<3){const article=articleFor(topics[state.articles.length],now,env);state.articles.push(article);created.push(article);await kv.put(`zpc:blog:article:${article.slug}`,JSON.stringify(article),{expirationTtl:370*DAY});}await kv.put(BLOG_INDEX_KEY,JSON.stringify(state),{expirationTtl:370*DAY});if(created.length&&clean(env.INDEXNOW_KEY))await fetchImpl("https://api.indexnow.org/indexnow",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({host:new URL(baseUrl(env)).host,key:clean(env.INDEXNOW_KEY,200),urlList:created.map(x=>x.url)}),signal:AbortSignal.timeout(15000)}).catch(()=>null);return {created:created.map(x=>({id:x.slug,url:x.url})),total:state.articles.length,week:state.week};}


// Daily local calendar: Fortaleza has UTC-03 throughout 2026. No timers, no paid scheduler.
export const localContentDay = now => new Date(now.getTime() - 3 * 3600_000).toISOString().slice(0,10);
export const BLOG_DAILY_KEY_PREFIX = "zpc:blog:daily:";

// One new article per local day. KV marker is written only after the article and
// rolling index are persisted; retrying the hourly cron never publishes twice.
export async function ensureDailyBlog(env={}, now=new Date(), fetchImpl=fetch) {
  const kv=env.ZEVANORY_PRIVATE_ARTIFACTS, day=localContentDay(now), key=BLOG_DAILY_KEY_PREFIX+day;
  if(!kv?.get||!kv?.put)return {created:[],latest:null,reason:"kv_unavailable"};
  let marker=null;try{marker=JSON.parse(String(await kv.get(key)||"null"));}catch{}
  if(marker?.slug){
    let existing=null;try{existing=JSON.parse(String(await kv.get("zpc:blog:article:"+marker.slug)||"null"));}catch{}
    if(existing)return {created:[],latest:existing,day,reason:"already_published"};
  }
  const ordinal=Math.floor((Date.parse(day+"T00:00:00Z")/86400000));
  const article=articleFor(topics[ordinal % topics.length],now,env);
  article.slug=article.slug+"-"+day;
  article.url=baseUrl(env)+"/blog/"+article.slug;
  article.description=article.description+". Aplicação prática em pequenos negócios, com revisão humana e sem promessas de faturamento.";
  article.body += "\n\nAção do dia "+day+": registre uma dúvida real de um cliente, identifique o próximo passo e acompanhe o resultado, sem usar listas compradas ou mensagens não solicitadas.";
  let index={articles:[]};try{index=JSON.parse(String(await kv.get(BLOG_INDEX_KEY)||"null"))||index;}catch{}
  index={schema:"zevanory.blog-daily/v1",updatedAt:now.toISOString(),articles:[...(index.articles||[]).filter(x=>x.slug!==article.slug),article].slice(-45)};
  await kv.put("zpc:blog:article:"+article.slug,JSON.stringify(article),{expirationTtl:370*DAY});
  await kv.put(BLOG_INDEX_KEY,JSON.stringify(index),{expirationTtl:370*DAY});
  await kv.put(key,JSON.stringify({slug:article.slug,publishedAt:article.publishedAt}),{expirationTtl:370*DAY});
  if(clean(env.INDEXNOW_KEY))await fetchImpl("https://api.indexnow.org/indexnow",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({host:new URL(baseUrl(env)).host,key:clean(env.INDEXNOW_KEY,200),urlList:[article.url]}),signal:AbortSignal.timeout(15000)}).catch(()=>null);
  return {created:[{id:article.slug,url:article.url}],latest:article,total:index.articles.length,day};
}

export async function recordChannelProof(env={},proof={}){const id=clean(proof.channel,40);if(!["telegram","youtube"].includes(id)||!clean(proof.provider_post_id,200))throw new Error("channel_proof_invalid");const row={channel:id,provider_post_id:clean(proof.provider_post_id,200),url:clean(proof.url,1000)||null,publishedAt:clean(proof.publishedAt,80)||new Date().toISOString()};await env.ZEVANORY_PRIVATE_ARTIFACTS?.put?.(`${CHANNEL_PROOF_PREFIX}${id}`,JSON.stringify(row),{expirationTtl:370*DAY});return row;}

export async function runMultichannelAutonomy(env={},now=new Date(),fetchImpl=fetch){
  env=resolveChannelCredentials(env);
  const blog=await ensureDailyBlog(env,now,fetchImpl),channels=channelChecklist(env),kv=env.ZEVANORY_PRIVATE_ARTIFACTS,evidence=[];
  const day=localContentDay(now),telegram=channels.find(x=>x.id==="telegram");
  const quotaKey="zpc:multichannel:quota:telegram:"+day;
  const postKey="zpc:multichannel:evidence:telegram:daily:"+day;
  const paused=await creativeAutopublishPaused(env);
  if(blog.latest&&telegram?.configured&&!paused&&kv?.get&&kv?.put){
    const prior=await kv.get(postKey),used=Number(await kv.get(quotaKey)||0);
    if(!prior&&used<1){
      // Write pending before invoking Telegram. Ambiguous network failures stop
      // automatic retries rather than risk duplicate unsolicited posts.
      await kv.put(postKey,JSON.stringify({status:"pending",day,startedAt:now.toISOString()}),{expirationTtl:7*DAY});
      const campaign="conteudo_"+day.replace(/-/g,"");
      const utm="?utm_source=telegram&utm_medium=organic&utm_campaign="+campaign;
      const payload={content:blog.latest.title+"\n\n"+blog.latest.description+
        "\n\nLeia o guia: "+blog.latest.url+utm+
        "\nConheça a solução: https://vendas.zevanory.api.br/comprar/ZEV-IA-011"+utm};
      try{
        const result=await publishTelegram({env,payload,fetchImpl});
        const row={channel:"telegram",creative_id:"daily:"+day,provider_post_id:result.provider_post_id,url:result.url,publishedAt:now.toISOString()};
        await kv.put(postKey,JSON.stringify(row),{expirationTtl:370*DAY});
        await recordChannelProof(env,row);
        await kv.put(quotaKey,"1",{expirationTtl:2*DAY});
        evidence.push(row);
      }catch(error){
        // Keep pending marker for manual reconciliation: a timeout may have posted.
        evidence.push({channel:"telegram",status:"unverified_manual_reconciliation",day,error:String(error?.message||"provider_failed").slice(0,90)});
      }
    }
  }
  // Pinterest retains the existing approved F1 score/compliance path; no new DM.
  let feed=[];try{feed=JSON.parse(String(await kv?.get?.(CREATIVE_AUTONOMY_FEED_KEY)||"[]"));}catch{}
  const creative=(Array.isArray(feed)?feed:[]).find(x=>x?.status==="approved_for_autopublish"&&Number(x?.compliance)===100&&Number(x?.score)>=85);
  if(creative&&!paused&&channels.find(x=>x.id==="pinterest")?.configured&&creative.asset_url&&kv?.get&&kv?.put){
    const key="zpc:multichannel:evidence:pinterest:"+creative.creative_id;
    if(!await kv.get(key)){
      try{
        const result=await publishPinterest({env,payload:{...creative,media_url:creative.asset_url},fetchImpl});
        const row={channel:"pinterest",creative_id:creative.creative_id,provider_post_id:result.provider_post_id,url:result.url,publishedAt:now.toISOString()};
        await kv.put(key,JSON.stringify(row),{expirationTtl:370*DAY});evidence.push(row);
      }catch(error){evidence.push({channel:"pinterest",error:String(error?.message||"provider_failed").slice(0,90)});}
    }
  }
  // The public evidence endpoint reads CHANNEL_STATE_KEY. Keep successful
  // Telegram receipts visible after subsequent cron ticks instead of
  // overwriting them with an empty array on the next hour.
  const recentDays=[day,localContentDay(new Date(now.getTime()-DAY*1000))];
  const seen=new Set(evidence.filter(x=>x.provider_post_id).map(x=>String(x.provider_post_id)));
  for(const proofDay of recentDays){
    let proof=null;
    try{proof=JSON.parse(String(await kv?.get?.("zpc:multichannel:evidence:telegram:daily:"+proofDay)||"null"));}catch{}
    if(proof?.channel==="telegram"&&/^\d{1,20}$/.test(String(proof.provider_post_id||""))&&
       /^https:\/\/t\.me\/[A-Za-z0-9_]+\/\d{1,20}$/.test(String(proof.url||""))&&
       Number.isFinite(Date.parse(String(proof.publishedAt||"")))&&!seen.has(String(proof.provider_post_id))){
      evidence.push(proof);
      seen.add(String(proof.provider_post_id));
    }
  }
  const state={generatedAt:now.toISOString(),channels:channels.map(({id,configured,mode,missing,external_verification_pending})=>({id,configured,mode,missing,external_verification_pending})),blog,evidence};
  await kv?.put?.(CHANNEL_STATE_KEY,JSON.stringify(state),{expirationTtl:8*DAY});
  return state;
}

export async function renderChannelsPage(env={}){const proofs={};for(const id of ["telegram","youtube"]){try{proofs[id]=JSON.parse(String(await env.ZEVANORY_PRIVATE_ARTIFACTS?.get?.(`${CHANNEL_PROOF_PREFIX}${id}`)||"null"));}catch{}}const status=x=>x.configured&&["telegram","youtube"].includes(x.id)&&!proofs[x.id]?"Configurado; aguardando prova":x.configured?"Ativo":(["instagram","facebook"].includes(x.id)&&x.external_verification_pending)?"Aguardando verificação da empresa (em análise)":x.id==="tiktok"&&x.external_verification_pending?"Aguardando auditoria do aplicativo":x.id==="pinterest"&&x.missing.length?"Pendente credencial":x.mode==="dry_run"?"Dry run / aguardando verificação":"Pendente";const rows=channelChecklist(env).map(x=>`<tr><td>${esc(x.label)}</td><td>${esc(status(x))}</td><td>${esc([...x.secrets,...(x.scopes||[]).map(scope=>`scope:${scope}`),...(x.flag?[x.flag]:[])].join(", ")||"nenhum")}</td><td><a href="${esc(x.docs)}" rel="noreferrer">Configurar</a></td></tr>`).join("");return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex"><title>Sistema · Canais · ZEVANORY</title><link rel="stylesheet" href="/admin.css"></head><body><main><p><a href="/central">Sistema</a> → Canais</p><h1>Canais</h1><p>Credenciais ausentes deixam somente o canal pendente. Telegram e YouTube só ficam ativos após prova real. Meta e TikTok permanecem em dry run até a verificação externa. Google usa Search Console e blog; Perfil da Empresa não faz parte do plano.</p><table><thead><tr><th>Canal</th><th>Estado</th><th>Campo do CHANNEL_CREDENTIALS_JSON / validação</th><th>Link oficial</th></tr></thead><tbody>${rows}</tbody></table></main></body></html>`;}

export async function renderBlogIndex(env={}){let state={articles:[]};try{state=JSON.parse(String(await env.ZEVANORY_PRIVATE_ARTIFACTS?.get?.(BLOG_INDEX_KEY)||"{}"));}catch{}const cards=(state.articles||[]).map(x=>`<article><h2><a href="/blog/${esc(x.slug)}">${esc(x.title)}</a></h2><p>${esc(x.description)}</p><small>${esc(x.publishedAt)}</small></article>`).join("");return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Blog ZEVANORY</title><meta name="description" content="Guias práticos de IA, automação e operação."></head><body><main><h1>Blog ZEVANORY</h1>${cards||"<p>Novos artigos em preparação.</p>"}</main></body></html>`;}
export async function renderBlogArticle(env={},slug=""){let a=null;try{a=JSON.parse(String(await env.ZEVANORY_PRIVATE_ARTIFACTS?.get?.(`zpc:blog:article:${slug}`)||"null"));}catch{}if(!a)return null;const schema={"@context":"https://schema.org","@type":"Article",headline:a.title,datePublished:a.publishedAt,mainEntityOfPage:a.url,publisher:{"@type":"Organization",name:"ZEVANORY"}};const faq={"@context":"https://schema.org","@type":"FAQPage",mainEntity:a.faq.map(x=>({"@type":"Question",name:x.q,acceptedAnswer:{"@type":"Answer",text:x.a}}))};return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(a.title)} · ZEVANORY</title><meta name="description" content="${esc(a.description)}"><link rel="canonical" href="${esc(a.url)}"><script type="application/ld+json">${JSON.stringify(schema)}</script><script type="application/ld+json">${JSON.stringify(faq)}</script></head><body><main><a href="/blog">Blog</a><article><h1>${esc(a.title)}</h1>${a.body.split("\n\n").map(p=>`<p>${esc(p)}</p>`).join("")}<h2>Perguntas frequentes</h2>${a.faq.map(x=>`<h3>${esc(x.q)}</h3><p>${esc(x.a)}</p>`).join("")}<p><a href="/material-gratuito?utm_source=blog&utm_medium=organic&utm_campaign=${esc(a.slug)}">Acessar material gratuito</a></p><p><a href="https://vendas.zevanory.api.br/comprar/ZEV-IA-011?utm_source=blog&utm_medium=organic&utm_campaign=${esc(a.slug)}">Conhecer o produto</a></p></article></main></body></html>`;}
export async function appendBlogSitemap(env={},xml=""){let state={articles:[]};try{state=JSON.parse(String(await env.ZEVANORY_PRIVATE_ARTIFACTS?.get?.(BLOG_INDEX_KEY)||"{}"));}catch{}const entries=(state.articles||[]).map(x=>`<url><loc>${esc(x.url)}</loc><lastmod>${esc(x.publishedAt)}</lastmod></url>`).join("");return String(xml).replace("</urlset>",`${entries}</urlset>`);}
