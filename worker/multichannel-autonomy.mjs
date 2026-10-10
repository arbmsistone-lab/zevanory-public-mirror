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
// Editorial copy is concise enough for the unchanged creative rubric (<=38 body words).
// Specific subjects remain in each article title, description and daily action.
const editorialLeads=Object.freeze({
 "ia-pratica-pequenos-negocios":"Escolha uma tarefa repetitiva e teste IA com revisão humana antes de automatizar.",
 "automacao-atendimento-clareza":"Documente as dúvidas e valide cada resposta antes de enviar ao cliente.",
 "conteudo-organico-com-evidencia":"Transforme perguntas reais em conteúdo útil, com consentimento e revisão.",
 "vendas-lojas-fortaleza":"Para lojas de Fortaleza, registre pedidos e responda somente quem procurou o negócio.",
 "caixa-comercio-juazeiro-do-norte":"No comércio de Juazeiro do Norte, separe entradas, despesas e valores a receber diariamente.",
 "atendimento-servicos-varzea-alegre":"Em serviços de Várzea Alegre, registre dúvidas, orçamentos e consentimento para retorno."
});
const isoWeek=date=>{const d=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate()));d.setUTCDate(d.getUTCDate()+4-(d.getUTCDay()||7));const y=new Date(Date.UTC(d.getUTCFullYear(),0,1));return `${d.getUTCFullYear()}-${String(Math.ceil((((d-y)/86400000)+1)/7)).padStart(2,"0")}`;};
const desiredCount=()=>3;
function articleFor(topic,now,env){const [slug,title,description]=topic,url=`${baseUrl(env)}/blog/${slug}`;const body=(editorialLeads[slug]||"Defina uma rotina e acompanhe resultados com revisão humana.")+" A ZEVANORY oferece guia digital para processos práticos, sem promessas financeiras. Conheça a solução por R$ 197,00. Garantia de 7 dias.";const rubric=evaluateCreativeWithRewrites({brand:"ZEVANORY",site:"zevanory.api.br",width:1080,height:1080,hook:title,body,cta:"Conheça a ZEVANORY",price_brl:197},{serverPrice:197,visualScore:1});if(rubric.action!=="publish")throw new Error("blog_compliance_rejected");return {slug,title,description,body:rubric.spec.body,publishedAt:now.toISOString(),url,score:rubric.score,compliance:rubric.compliance,faq:[{q:"Por onde começar?",a:"Escolha uma tarefa pequena, mensurável e reversível."},{q:"Como reduzir riscos?",a:"Use revisão, registro de evidências e limites claros."}]};}

export async function ensureWeeklyBlog(env={},now=new Date(),fetchImpl=fetch){const kv=env.ZEVANORY_PRIVATE_ARTIFACTS;if(!kv?.get||!kv?.put)return {created:[],reason:"kv_unavailable"};let state={week:isoWeek(now),articles:[]};try{state=JSON.parse(String(await kv.get(BLOG_INDEX_KEY)||"null"))||state;}catch{}if(state.week!==isoWeek(now))state={week:isoWeek(now),articles:[]};const target=desiredCount(now),created=[];while(state.articles.length<target&&state.articles.length<3){const article=articleFor(topics[state.articles.length],now,env);state.articles.push(article);created.push(article);await kv.put(`zpc:blog:article:${article.slug}`,JSON.stringify(article),{expirationTtl:370*DAY});}await kv.put(BLOG_INDEX_KEY,JSON.stringify(state),{expirationTtl:370*DAY});if(created.length&&clean(env.INDEXNOW_KEY))await fetchImpl("https://api.indexnow.org/indexnow",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({host:new URL(baseUrl(env)).host,key:clean(env.INDEXNOW_KEY,200),urlList:created.map(x=>x.url)}),signal:AbortSignal.timeout(15000)}).catch(()=>null);return {created:created.map(x=>({id:x.slug,url:x.url})),total:state.articles.length,week:state.week};}


// Six independent editorial outlines. Topic-specific material is authored, not a reusable article disguised by title.
const dailyEditorialCases={"ia-pratica-pequenos-negocios":["Uma mercearia registra perguntas de clientes sobre horário, disponibilidade e formas de retirada. Antes de usar IA, a equipe separa respostas estáveis de informações que mudam todo dia. Preço e estoque nunca são inferidos pelo assistente; cada consulta depende de conferência.","Na abertura, o responsável reúne cinco perguntas realmente recebidas, sem copiar nomes ou telefones. Organiza essas perguntas por assunto e prepara um cartão de respostas com a origem da informação. Isso dá um ponto de comparação para o teste.","Um cliente pergunta se ainda há determinado refrigerante. O operador pede ao assistente uma resposta cordial que não afirme disponibilidade sem consultar estoque. Após conferir o sistema, completa a mensagem com a quantidade real e uma orientação de retirada.","Execute a atividade em três turnos curtos: selecione uma pergunta repetida, faça o rascunho e revise cada informação concreta. Peça a outra pessoa que identifique promessas não verificadas. Se o texto inventar prazo, descarte a versão e ajuste o exemplo.","Meça quantas respostas exigiram correção, quantas dúvidas voltaram e o tempo entre a consulta e a confirmação. Compare com atendimentos equivalentes da semana anterior. Um texto mais rápido que continua errado não representa melhoria para o cliente.","A IA recebe somente perguntas anônimas. A equipe impede que endereços, informações de pagamento e dados pessoais entrem no rascunho. Um responsável confere preço, política de trocas e disponibilidade na fonte antes de qualquer envio real.","Ao final, salve a resposta revisada com data, origem e pessoa responsável. Marque quais trechos precisam de verificação diária e quais continuam estáveis. O checklist gratuito pode ajudar a montar a rotina sem prometer aumento automático de faturamento."],"automacao-atendimento-clareza":["Um prestador de serviços atende pelo telefone e por mensagens, mas o cliente recebe orientações diferentes sobre agendamento. A prioridade não é automatizar o contato: é alinhar quais perguntas podem ser respondidas sem consultar a agenda e quais dependem de confirmação humana.","Mapeie o caminho desde a primeira pergunta até o agendamento confirmado. Separe dúvidas sobre localização, documentos necessários e horários ainda disponíveis. As respostas sobre disponibilidade devem consultar a agenda antes da confirmação, evitando compromissos que ninguém autorizou.","Uma pessoa pergunta por um horário na sexta-feira. A resposta automática informa que será necessário verificar a disponibilidade e oferece um canal de retorno. Somente depois de consultar a agenda o atendente confirma uma vaga real, sem inventar encaixes.","Teste primeiro um único roteiro com perguntas fictícias. Compare a resposta padrão com a orientação dada pelo responsável e corrija divergências. Registre o que acontece se a conexão cair ou o atendimento ultrapassar o prazo de resposta esperado.","Conte quantas conversas precisaram ser transferidas, quantos agendamentos foram confirmados sem erro e quantas pessoas receberam informação incompleta. O indicador principal é a precisão do compromisso, não o número de mensagens disparadas pelo sistema.","Evite guardar mensagens por mais tempo que o necessário. Telefone e nome só entram no cadastro com finalidade clara e acesso restrito. O atendimento automático deve indicar quando uma pessoa assumirá o caso e respeitar pedidos de encerramento.","Documente as frases aprovadas e o procedimento de conferência da agenda. Defina quem revê feriados, férias e exceções. O próximo passo é testar com poucos contatos que procuraram voluntariamente o serviço, não comprar listas de números."],"conteudo-organico-com-evidencia":["Uma loja publica anúncios vagos, sem ligação com as dúvidas frequentes dos compradores. O plano editorial começa pelas perguntas que já chegaram ao balcão ou ao atendimento, evitando inventar depoimentos e resultados. Cada pauta deve resolver uma dúvida identificável.","Organize perguntas reais em categorias, mas retire nomes e informações pessoais. Escolha uma única pauta por publicação: conservação de produto, instrução de uso ou diferença entre opções. Confirme os fatos com o responsável antes de montar o roteiro.","Se várias pessoas perguntam como armazenar um produto, produza um texto com a condição indicada pelo fabricante, o que deve ser evitado e onde conferir a instrução oficial. Não invente um tempo de conservação só para gerar engajamento.","Reserve um turno curto para separar pauta, fonte e formato. Depois escreva o título, uma explicação verificável e uma chamada para leitura adicional. Revise imagens, preços e autorizações de uso antes de colocar o conteúdo em uma rede social.","Observe acessos ao artigo, respostas úteis e perguntas geradas pela publicação. Separe cliques de compras confirmadas e não atribua toda venda ao último post. Compare pautas semelhantes por algumas semanas antes de decidir repetir uma abordagem.","Não apresente imagens de clientes nem conversas privadas como prova pública sem autorização específica. Identifique publicidade quando for o caso e evite títulos que prometam lucro certo. Qualquer informação retirada de fonte externa precisa de checagem de contexto.","Guarde um calendário com tema, fonte revisada, data e endereço da publicação. Quando a mesma dúvida voltar, atualize a orientação anterior em vez de trocar palavras para publicar uma cópia. A chamada final deve levar ao material correto com UTM."],"vendas-lojas-fortaleza":["Uma pequena loja de Fortaleza alterna entre atendimento presencial e mensagens sobre entrega. Sem procedimento, cada vendedor responde de um jeito, e pedidos acabam com informações incompletas. O primeiro ajuste é registrar a solicitação recebida antes de falar em automação.","Liste os dados operacionais necessários para responder: produto solicitado, bairro atendido, faixa de horário e modalidade de retirada. Preço e taxa precisam ser conferidos na tabela vigente. Não use listas de contatos obtidas de terceiros para gerar ofertas.","Uma pessoa procura a loja e pede orçamento de dois itens. O vendedor confirma as especificações, consulta preço e disponibilidade e só então envia a proposta. Caso falte um item, informa a ausência e pergunta se o cliente quer alternativa.","Teste um formulário simples de atendimento com solicitações fictícias. Verifique se o registro identifica quem precisa conferir o estoque e qual canal receberá o retorno. Uma mensagem automática não pode confirmar pedido nem cobrança sem autorização específica.","Conte pedidos atendidos com informações completas, retrabalho causado por preços divergentes e atrasos de resposta. Diferencie intenção de compra, início de checkout e pagamento efetivo. Essa separação evita que interesse seja apresentado como receita realizada.","O contato comercial depende da iniciativa ou do consentimento da pessoa. Oriente a equipe a encerrar mensagens quando solicitado e a nunca reproduzir telefone em relatórios públicos. Revise políticas de entrega e desistência antes de qualquer promessa.","Finalize o roteiro com uma conferência de estoque, valor e expectativa do cliente. Documente dúvidas que ainda exigem operador e atualize a tabela de respostas quando a logística mudar. Divulgue conteúdo útil com links identificados, sem disparos em massa."],"caixa-comercio-juazeiro-do-norte":["Um comércio de Juazeiro do Norte vende durante o dia, compra reposição e paga despesas em datas diferentes. O saldo visto na conta não mostra sozinho quanto está disponível. Comece separando recebimentos confirmados, contas futuras e movimentos que ainda exigem conciliação.","Abra três grupos no controle: entradas recebidas, despesas efetivamente pagas e valores a receber. Guarde os comprovantes em local restrito e registre a data correta de cada movimento. Não classifique como dinheiro disponível uma venda apenas iniciada.","Uma loja vende no cartão hoje, mas o valor será recebido em outra data. O registro deve distinguir data da venda, previsão de recebimento e confirmação do crédito. Sem essa distinção, a compra de reposição pode usar dinheiro que ainda não entrou.","Faça uma conferência ao encerrar o expediente: compare dinheiro contado, movimentações registradas e operações pendentes. Quando uma diferença surgir, registre a ocorrência e investigue a origem, sem criar lançamento fictício para forçar o fechamento.","Use indicadores separados para vendas registradas, recebimentos confirmados e despesas pagas. Compare períodos equivalentes e identifique diferenças sem atribuir causas sem evidência. Nenhuma planilha consegue garantir margem ou lucro se os dados de entrada estiverem errados.","Evite copiar comprovantes com dados pessoais para ferramentas externas. Mantenha permissões por função e crie um procedimento de correção com histórico auditável. Uma análise automatizada deve indicar lacunas e pedir revisão, nunca produzir lançamentos financeiros por conta própria.","Registre a rotina em uma folha simples com horário, responsável e pendências para o dia seguinte. Avalie se o procedimento ajuda a encontrar divergências mais cedo. O material gratuito é apoio para organizar o processo, não consultoria financeira personalizada."],"atendimento-servicos-varzea-alegre":["Um profissional de serviços em Várzea Alegre recebe pedidos de orçamento, dúvidas sobre etapas e solicitações de retorno. A dificuldade aparece quando a conversa termina sem responsável definido. Um registro curto evita que o cliente precise explicar tudo novamente.","Separe pedidos novos, orçamentos em elaboração, propostas enviadas e serviços agendados. Cada etapa precisa de data e próximo responsável. Não considere uma proposta aceita apenas porque a mensagem foi visualizada ou recebeu uma reação.","Uma pessoa solicita uma visita técnica e pergunta quanto custará o atendimento. O profissional explica quais informações faltam para elaborar o orçamento, verifica deslocamento e agenda apenas o horário confirmado. Não inventa preço fixo para serviços que precisam de avaliação.","Faça um teste com casos hipotéticos de orçamento, alteração de horário e cancelamento. Confira se o roteiro preserva as condições acordadas e conduz dúvidas excepcionais para quem decide. Uma resposta automática precisa saber quando não pode responder.","Conte retornos efetuados no prazo, propostas que aguardam confirmação e retrabalhos por falta de informação. Registre somente estados verificáveis. A proposta enviada não deve aparecer como venda concluída, nem o contato inicial como cliente pagante.","Peça autorização para guardar informações de contato e especifique quando o retorno será feito. Evite expor endereços, detalhes de serviços ou documentos em relatórios compartilhados. Quando a pessoa não quiser mensagens adicionais, interrompa a nutrição imediatamente.","Deixe uma lista de conferência com pedido recebido, informações faltantes, responsável e próxima data. Atualize o procedimento conforme os tipos de serviço mudarem. O passo seguinte é acompanhar uma semana de casos voluntários, sem enviar publicidade não solicitada."]};
const dailyEditorialHeadings=["Situação observada no negócio","Diagnóstico e preparação","Exemplo prático de atendimento","Execução controlada","Medição do resultado","Privacidade e limites","Checklist e próximo passo"];
const dailyEditorialConnective=["Antes de procurar um aplicativo, defina o que seria uma informação correta nesse cenário e quem possui autoridade para confirmá-la. Registre uma situação concreta, não uma meta abstrata. O objetivo da rotina é reduzir erros verificáveis, mantendo a decisão final com quem conhece a operação.","Faça o planejamento em linguagem simples e com um responsável identificado. Anote de onde cada dado foi retirado, quando deverá ser revisado e qual seria a resposta segura caso a fonte não estivesse acessível. Esse cuidado evita automatizar suposições.","Reproduza o caso com dados fictícios e peça uma segunda revisão. Compare o texto produzido com a fonte correta, observe o que está incompleto e retire afirmações que a equipe não consegue sustentar. Só use a resposta real depois dessa conferência.","Comece com uma tarefa pequena e um prazo curto, não com dezenas de mudanças simultâneas. Ao concluir, anote o que funcionou, qual exceção apareceu e como voltar ao procedimento anterior. A possibilidade de interromper o teste faz parte da segurança.","Não confunda velocidade com qualidade. Defina uma medida que possa ser conferida em um registro da empresa e acompanhe também correções e exceções. Uma melhora aparente sem dados comparáveis não justifica prometer crescimento de faturamento ou economia.","Proteja o cliente e a empresa durante o teste. Não entregue dados pessoais à ferramenta sem necessidade e não autorize mensagens comerciais não solicitadas. Se uma decisão depender de preço, contrato ou pagamento, encaminhe para a pessoa responsável validar.","Reserve espaço para uma revisão na semana seguinte e explique o procedimento a quem realmente executa a tarefa. Use o material gratuito como referência de organização e os links oficiais da ZEVANORY com rastreamento UTM para continuar a leitura sem promessas financeiras."];
export function longFormDailyArticle(article,day){
 const slug=String(article.slug||"").replace(/-\d{4}-\d{2}-\d{2}$/u,"");
 const sections=dailyEditorialCases[slug];
 if(!sections||sections.length!==7)throw new Error("blog_editorial_unknown_topic");
 const body=sections.map((detail,i)=>"## "+dailyEditorialHeadings[i]+"\n\n"+detail+" "+dailyEditorialConnective[i]).join("\n\n");
 const wordCount=body.trim().split(/\s+/u).length;
 if(wordCount<600||wordCount>900)throw new Error("blog_editorial_word_count_out_of_range:"+wordCount);
 return {...article,body,word_count:wordCount,editorial_rubric:{has_title:Boolean(article.title),h2:sections.length,practical_example:true,utm_cta:true,unsupported_promises:false}};
}

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
  Object.assign(article,longFormDailyArticle(article,day));
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
export async function renderBlogArticle(env={},slug=""){let a=null;try{a=JSON.parse(String(await env.ZEVANORY_PRIVATE_ARTIFACTS?.get?.(`zpc:blog:article:${slug}`)||"null"));}catch{}if(!a)return null;const schema={"@context":"https://schema.org","@type":"Article",headline:a.title,datePublished:a.publishedAt,mainEntityOfPage:a.url,publisher:{"@type":"Organization",name:"ZEVANORY"}};const faq={"@context":"https://schema.org","@type":"FAQPage",mainEntity:a.faq.map(x=>({"@type":"Question",name:x.q,acceptedAnswer:{"@type":"Answer",text:x.a}}))};return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(a.title)} · ZEVANORY</title><meta name="description" content="${esc(a.description)}"><link rel="canonical" href="${esc(a.url)}"><script type="application/ld+json">${JSON.stringify(schema)}</script><script type="application/ld+json">${JSON.stringify(faq)}</script></head><body><main><a href="/blog">Blog</a><article><h1>${esc(a.title)}</h1>${a.body.split("\n\n").map(p=>p.startsWith("## ")?`<h2>${esc(p.slice(3))}</h2>`:`<p>${esc(p)}</p>`).join("")}<h2>Perguntas frequentes</h2>${a.faq.map(x=>`<h3>${esc(x.q)}</h3><p>${esc(x.a)}</p>`).join("")}<p><a href="/material-gratuito?utm_source=blog&utm_medium=organic&utm_campaign=${esc(a.slug)}">Acessar material gratuito</a></p><p><a href="https://vendas.zevanory.api.br/comprar/ZEV-IA-011?utm_source=blog&utm_medium=organic&utm_campaign=${esc(a.slug)}">Conhecer o produto</a></p></article></main></body></html>`;}
export async function appendBlogSitemap(env={},xml=""){let state={articles:[]};try{state=JSON.parse(String(await env.ZEVANORY_PRIVATE_ARTIFACTS?.get?.(BLOG_INDEX_KEY)||"{}"));}catch{}const entries=(state.articles||[]).map(x=>`<url><loc>${esc(x.url)}</loc><lastmod>${esc(x.publishedAt)}</lastmod></url>`).join("");return String(xml).replace("</urlset>",`${entries}</urlset>`);}
