import EPISODES from '../../data/shorts-episodios-v2.json' with {type:'json'};
// Practical steps follow product + calendar angle, using the episode's actual task
// and the niche's working documents. No script is selected by music theme.
const niches={
 'salão':{label:'seu salão',item:'agendamento',record:'agenda do salão',example:'horário de corte'},
 'loja':{label:'sua loja',item:'pedido',record:'lista de pedidos',example:'reserva de peça'},
 'prestador de serviço':{label:'seu serviço',item:'orçamento',record:'pasta de orçamentos',example:'visita de avaliação'},
 'delivery':{label:'seu delivery',item:'entrega',record:'fila de entregas',example:'pedido de jantar'},
 'autônomo':{label:'seu trabalho autônomo',item:'projeto',record:'quadro de projetos',example:'entrega de projeto'}
};
// Each recipe contains actions, not stock connective sentences.
const recipes={
 'ZEV-IA-011':[
  ['Copie um {item} fictício que exige resposta repetida.','Peça um rascunho explicando a rotina de {label}.','Confira as informações e salve na {record}.','Você tem uma resposta revisável para cada {item}.'],
  ['Descreva um {example} fictício para a inteligência artificial.','Peça três etapas para organizar esse {item} em sequência.','Teste as instruções com sua {record}, corrigindo cada detalhe.','O teste mostra onde a orientação precisa de contexto.'],
  ['Use um {example} fictício para explicar sua situação.','Peça duas respostas adequadas à rotina de {label}.','Compare os textos com o registro na {record}.','Você identifica qual versão explica melhor o próximo passo.'],
  ['Escolha apenas um {item} simples para testar hoje.','Informe à inteligência artificial os limites concretos de {label}.','Revise o rascunho antes de copiar para a {record}.','Assim você experimenta uma tarefa sem mudar toda a operação.'],
  ['Escreva manualmente uma orientação sobre {example} e guarde.','Peça outra versão, mantendo as condições desse {item}.','Compare clareza e erros usando sua {record} como referência.','A comparação ajuda a decidir onde a ferramenta faz sentido.']
 ],
 'ZEV-VEN-011':[
  ['Localize uma conversa sobre {item} que terminou sem resposta.','Anote a dúvida pendente de quem procura {label}.','Prepare uma pergunta objetiva e registre na {record}.','Você entende melhor onde a conversa perdeu a direção.'],
  ['Separe as informações necessárias para confirmar um {item}.','Explique condições e prazo usando um {example} como referência.','Finalize com uma pergunta e atualize a {record}.','O cliente consegue enxergar o próximo passo do atendimento.'],
  ['Pegue um {example} fictício para ensaiar uma conversa.','Responda primeiro a necessidade de quem procura {label}.','Registre o combinado na {record} antes de encerrar.','O exemplo vira uma referência concreta para revisar seu atendimento.'],
  ['Anote a objeção mais frequente ao confirmar um {item}.','Responda com uma condição verificável da rotina de {label}.','Confira se o combinado aparece completo na {record}.','A pessoa recebe informação para decidir sem pressão desnecessária.'],
  ['Separe duas respostas diferentes sobre o mesmo {item}.','Confira qual explica melhor as condições de {label}.','Anote dúvidas restantes e revise sua {record} depois.','Você compara clareza, sem transformar o atendimento numa promessa.']
 ],
 'ZEV-LCX-011':[
  ['Localize o comprovante ligado ao último {item} concluído.','Separe recebimento e despesa desse {example} em duas colunas.','Confronte o saldo com o registro na {record}.','A diferença aparece nos registros antes de virar uma suposição.'],
  ['Registre valor e data de cada {item} confirmado.','Separe os custos necessários para executar um {example}.','Confira os totais usando também sua {record} como apoio.','Você confere os movimentos sem confundir faturamento e saldo.'],
  ['Use um {example} fictício para simular entradas e despesas.','Inclua os materiais necessários para atender esse {item}.','Compare a simulação com os registros na {record}.','Você percebe quais custos ainda precisam ser anotados separadamente.'],
  ['Comece pelo último {item}, usando somente seu comprovante.','Anote o recebimento sem misturar com dinheiro de casa.','Marque a conferência financeira na {record} ainda hoje.','Uma conferência pequena já permite localizar registros que ficaram faltando.'],
  ['Separe preço cobrado e custo direto de um {item}.','Confira o que permanece após executar aquele {example}.','Compare esse cálculo com o registro na {record}.','Você distingue entrada de dinheiro e custo antes de decidir.']
 ],
 'ZEV-CMB-011':[
  ['Escolha uma pergunta repetida sobre {item} no atendimento.','Peça um rascunho com as condições reais de {label}.','Revise o texto junto do registro na {record}.','A revisão conecta a resposta ao que pode ser entregue.'],
  ['Descreva um {example} usando apenas informações fictícias.','Peça uma resposta e uma pergunta para confirmar o {item}.','Verifique os dois textos antes de atualizar a {record}.','Você testa a ferramenta e mantém a decisão no atendimento.'],
  ['Simule uma dúvida comum de quem procura {label}.','Peça à ferramenta uma explicação curta sobre esse {item}.','Confira cada condição consultando o registro na {record}.','O ensaio mostra onde a resposta precisa de revisão humana.'],
  ['Escolha um {item} simples que costuma gerar dúvida.','Prepare um rascunho sem inserir informações pessoais do cliente.','Confirme os detalhes com sua {record} antes de responder.','A tarefa fica limitada a um teste que você consegue revisar.'],
  ['Escreva uma resposta manual sobre um {example} fictício.','Compare com um rascunho feito para o mesmo {item}.','Revise condições e prazos na {record} antes de escolher.','Você escolhe pela clareza da resposta, sem delegar o julgamento.']
 ],
 'ZEV-NGC-011':[
  ['Anote onde um {item} costuma ficar sem responsável.','Defina quem confirma as condições de cada {example}.','Marque a próxima ação na {record} antes de fechar.','Você torna visível o ponto em que a tarefa estava parada.'],
  ['Escolha um {item} e descreva sua primeira etapa.','Defina uma conferência simples para concluir esse {example}.','Anote responsável e prazo junto da {record} do dia.','A sequência deixa claro o que precisa acontecer em seguida.'],
  ['Simule um {example} desde a solicitação até a conclusão.','Liste o que falta para confirmar aquele {item}.','Atualize a {record} a cada mudança de etapa.','O ensaio ajuda a localizar informações que somem durante a rotina.'],
  ['Comece por um {item} que depende só de você.','Reserve dez minutos para organizar o próximo {example}.','Registre o combinado na {record} para conferir depois.','Você testa uma mudança pequena antes de reorganizar o restante.'],
  ['Descreva dois caminhos para concluir o mesmo {item}.','Compare dependências e prazo usando um {example} fictício.','Anote a opção escolhida na {record} com seu motivo.','A comparação deixa visíveis os critérios usados para organizar a tarefa.']
 ]
};
const angles=['dor','tutorial','caso de uso','objeção','comparação'];
export function episodeScript(plan){
 const e=plan.entry,n= niches[e?.niche],row=recipes[e?.product?.sku]?.[(angles.indexOf(e?.angle)+((e?.short_variant||0)+(plan.v2Variant||0)))%5];
 if(plan.slot==='dica'||plan.slot==='calc'){
  const lesson=EPISODES.episodes.find(x=>x.theme_id===e?.theme_id&&x.tip===plan.screen?.tip);
  if(!lesson)throw Error('episode_steps_missing_for_calendar_task');
  const selected=plan.v2Variant>0?lesson.variants?.[(plan.v2Variant-1)%lesson.variants.length]:lesson;
  if(!selected)throw Error('episode_variant_missing');
  return {...lesson,...selected,context:{theme_id:e.theme_id,tip:lesson.tip,hook:plan.screen.hook,niche:e.short_context?.name,product:e.product?.sku}};
 }
 const tip=String(plan.screen?.tip||'').trim().replace(/\bIA\b/g,'inteligência artificial');
 if(!n||!row||!tip||!plan.screen?.hook)throw Error('episode_content_missing');
 const fill=s=>s.replace(/\{(\w+)\}/g,(_,key)=>n[key]);
 const issue=['o atendimento está gerando retrabalho','faltam etapas para conferir','quer testar um caso concreto','parece difícil começar pequeno','qual método deixa tudo mais claro'][(angles.indexOf(e.angle)+((e.short_variant||0)+(plan.v2Variant||0)))%5];
 const question=`Em ${n.label}, ${issue}?`;
 const rows=recipes[e.product.sku],v=plan.v2Variant||0;
 const steps=[tip,...[0,1,2].map(j=>fill(rows[(angles.indexOf(e.angle)+(e.short_variant||0)+Math.floor(v/5**j))%5][j]))];
 if(steps[0].split(/\s+/).length>12||/whatsapp|telegram|R\$|gr[aá]tis/i.test(steps[0]))steps[0]='Confira as condições do kit antes de escolher sua aplicação.';
 return {hook:question,steps,result:fill(row[3]),followup:fill('Confira esse {item} na {record} amanhã.'),context:{theme_id:e.theme_id,niche:e.niche,product:e.product.sku,hook:plan.screen.hook,tip}};
}
