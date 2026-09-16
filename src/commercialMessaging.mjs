export const COMMERCIAL_MESSAGE_VERSION='zevanory-commercial-messaging-v1';

export const COMMERCIAL_POSITIONING=Object.freeze({
  brand:'ZEVANORY',
  tagline:'Menos improviso. Mais execucao.',
  headline:'Organize, automatize e avance com controle.',
  value_proposition:'IA, automacao, software e produtos digitais aplicados a operacoes que precisam de clareza, controle e evolucao mensuravel.',
  proof_standard:'Demonstracao real, evidencia verificavel e metricas observadas antes de qualquer alegacao de performance.',
  tone:'direto, premium, didatico, confiante e orientado a acao',
  forbidden_claims:Object.freeze(['resultado garantido','urgencia falsa','escassez inventada','comparacao sem fonte','performance sem evidencia']),
});

const message=(role,headline,bio,body,preSaleCta,liveCta,proof,extra={})=>Object.freeze({
  role,headline,bio,body,cta_pre_sale:preSaleCta,cta_live:liveCta,proof,
  message_version:COMMERCIAL_MESSAGE_VERSION,
  ...extra,
});

export const COMMERCIAL_MESSAGES=Object.freeze({
  zevanory:message('conversion_hub','Pare de operar no improviso.','IA, automacao e software para organizar, executar e evoluir com controle.','Centralize decisoes, reduza trabalho disperso e transforme a operacao digital em um processo mais claro, rastreavel e pronto para evoluir.','Conheca as solucoes','Escolha sua solucao','Proposta, arquitetura, demonstracao e evidencias verificaveis no ambiente oficial.',{utm_source:'zevanory',cta_policy:'first_party_gated'}),
  whatsapp:message('conversation_support','Fale com quem entende a operacao.','Atendimento oficial ZEVANORY: diagnostico claro, orientacao objetiva e suporte.','Explique seu objetivo. A conversa deve identificar o problema, indicar a solucao adequada e deixar o proximo passo claro, sem empurrar produto inadequado.','Quero avaliar minha necessidade','Quero comprar','Identidade oficial, historico da conversa e oferta vinculada ao catalogo canonico.',{utm_source:'whatsapp',cta_policy:'conversation_gated'}),
  email:message('crm_nurture','Informacao util. Proximo passo claro.','Conteudo, relacionamento e suporte oficial da ZEVANORY.','Cada mensagem deve ensinar algo util, reduzir uma objecao real e conduzir a uma unica acao objetiva, com rastreabilidade e sem pressao artificial.','Quero entender melhor','Ver oferta disponivel','Dominio oficial, identidade autenticada e eventos de entrega/engajamento observaveis.',{utm_source:'email',cta_policy:'first_party_gated'}),
  instagram:message('proof_reach','Menos teoria. Mais execucao visivel.','IA + automacao + software na pratica. Bastidores, provas e solucoes ZEVANORY.','Mostre o problema em segundos, demonstre a execucao e termine com uma acao simples. Priorize antes/depois verificavel, bastidores e prova de processo.','Veja como funciona','Conheca a solucao','Demonstracao visual, origem rastreavel e nenhuma promessa de resultado sem dado observado.',{utm_source:'instagram',cta_policy:'profile_link_gated'}),
  facebook:message('proof_retargeting','Veja o que muda quando a operacao ganha metodo.','Tecnologia e automacao aplicadas com clareza, prova e foco em execucao.','Use conteudo explicativo, prova social verificavel e demonstracoes para educar, reengajar e conduzir o publico a uma decisao consciente.','Conheca a ZEVANORY','Ver solucao','Pagina oficial, conteudo rastreavel e confirmacao por plataforma.',{utm_source:'facebook',cta_policy:'profile_link_gated'}),
  tiktok:message('short_form_discovery','Um problema. Uma demonstracao. Um proximo passo.','Automacao, IA e bastidores reais em videos curtos.','Abra com dor concreta, mostre rapidamente o processo ou resultado observavel e finalize com uma acao simples. Sem exagero, sem numeros inventados.','Veja a demonstracao','Conheca a solucao','Conteudo demonstrativo, identidade oficial e performance somente quando houver evidencia suficiente.',{utm_source:'tiktok',cta_policy:'profile_link_gated'}),
  youtube:message('demo_authority','Entenda antes de decidir.','Demonstracoes, comparativos e guias oficiais da ZEVANORY.','Videos devem provar funcionamento, explicar limites, comparar criterios objetivos e ajudar o cliente a entender quando cada solucao faz sentido.','Assista a demonstracao completa','Conheca a solucao','Demos longas, criterios objetivos, fontes e artefatos verificaveis.',{utm_source:'youtube',cta_policy:'description_link_gated'}),
  linkedin:message('b2b_authority','Automacao com governanca para operacoes serias.','Software, IA e automacao com controle, seguranca e evidencia.','Foque em eficiencia operacional, governanca, arquitetura, reducao de risco e capacidade de execucao. Evite linguagem de hype e priorize credibilidade tecnica.','Conheca a abordagem','Fale sobre a solucao','Arquitetura, processos, seguranca, evidencias e casos somente quando comprovados.',{utm_source:'linkedin',cta_policy:'professional_gated'}),
  google:message('seo_discovery','Encontre a solucao certa para executar melhor.','ZEVANORY: IA, automacao, software e produtos digitais.','Conteudo deve responder a intencao de busca com clareza, demonstrar autoridade e direcionar para a pagina mais relevante, sem clickbait.','Ver guia ou solucao','Conheca a solucao','Conteudo first-party, dados estruturados e paginas oficiais.',{utm_source:'google',cta_policy:'organic_first_party'}),
  affiliate:message('partner_distribution','Recomende com transparencia.','Programa oficial de parceiros ZEVANORY com rastreabilidade e regras claras.','Parceiros devem comunicar beneficio, publico ideal, limites e condicoes reais. Proibida promessa de ganho, resultado garantido ou informacao nao aprovada.','Conheca o programa','Indique uma solucao','Clique, atribuicao, comissao confirmada e reversoes rastreaveis.',{utm_source:'affiliate',cta_policy:'partner_gated'}),
  nuvemshop:message('owned_store_distribution','Produtos digitais com entrega segura.','Catalogo oficial ZEVANORY com informacao clara e entrega controlada.','Pagina de produto deve destacar problema resolvido, para quem serve, o que inclui, limites, preco aprovado e entrega segura.','Ver detalhes do produto','Comprar na loja','Pedido, pagamento e entrega confirmados pela plataforma ou fluxo oficial.',{utm_source:'nuvemshop',cta_policy:'marketplace_native_gated'}),
  mercado_livre:message('marketplace_distribution','Escolha com informacao completa.','Produtos ZEVANORY com descricao objetiva, suporte e entrega digital segura.','Anuncio deve explicar exatamente o que o comprador recebe, requisitos, limites, suporte e forma de entrega, respeitando as regras do marketplace.','Ver detalhes','Comprar pelo Mercado Livre','Pedido e status confirmados pela API do marketplace; nenhuma venda presumida.',{utm_source:'mercado_livre',cta_policy:'marketplace_native_gated'}),
});

export function commercialMessageFor(channel,{salesEnabled=false}={}){
  const key=String(channel||'').trim().toLowerCase();
  const item=COMMERCIAL_MESSAGES[key]; if(!item)throw new Error('commercial_message_channel_unknown');
  return Object.freeze({...item,cta:salesEnabled?item.cta_live:item.cta_pre_sale,sales_enabled:Boolean(salesEnabled)});
}

export function commercialMessagingAudit(){
  const required=['zevanory','whatsapp','email','instagram','facebook','tiktok','youtube','linkedin','google','affiliate','nuvemshop','mercado_livre'];
  const failures=[];
  for(const key of required){const x=COMMERCIAL_MESSAGES[key];if(!x)failures.push(`${key}:missing`);else for(const f of ['role','headline','bio','body','cta_pre_sale','cta_live','proof','cta_policy'])if(!String(x[f]||'').trim())failures.push(`${key}:${f}`);}
  return Object.freeze({version:COMMERCIAL_MESSAGE_VERSION,total:required.length,complete:required.length-failures.filter(x=>x.endsWith(':missing')).length,failures:Object.freeze(failures),approved:failures.length===0});
}
