// Daily blog editorial (P0-2). One article per local day built from the content
// calendar (product x niche x angle) instead of a fixed library of six bodies.
// The fixed library made every repeat of a topic fail the <50% similarity gate
// ("blog_duplicate_editorial_content"), so publication stopped after one cycle.
//
// Uniqueness by construction: sections are keyed by niche (2), product (2) and
// angle (1); within a 25-day calendar cycle no two days share both niche and
// product, so at most 3 of 6 sections coincide (trigram Jaccard < 0.45). Two
// editorial variants alternate per cycle, so the same calendar slot 25 days later
// shares only its 2 invariant sections. Claims stay descriptive: no promise of
// revenue, profit or results.
const DAY = 86400000;
const EPOCH = "2026-10-10";
export const EDITORIAL_PRODUCTS = Object.freeze([
  { sku: "ZEV-IA-011", name: "IA na Prática" },
  { sku: "ZEV-VEN-011", name: "Vendas na Prática" },
  { sku: "ZEV-LCX-011", name: "Lucro & Caixa" },
  { sku: "ZEV-CMB-011", name: "Combo IA + Vendas" },
  { sku: "ZEV-NGC-011", name: "Negócio Completo" }
]);
export const EDITORIAL_NICHES = Object.freeze(["salão", "loja", "prestador de serviço", "delivery", "autônomo"]);
export const EDITORIAL_ANGLES = Object.freeze(["dor", "tutorial", "caso de uso", "objeção", "comparação"]);

const NICHE = {
  "salão": {
    label: "salões de beleza",
    context: "Em um salão de beleza, a agenda é o centro da operação. Clientes pedem horário pelo WhatsApp, remarcam em cima da hora, perguntam preço de serviço que muda conforme o comprimento do cabelo e querem saber qual profissional está disponível. Ao mesmo tempo, a dona ou o dono do salão atende, corta, colore e ainda tenta responder mensagens nos intervalos. O resultado comum é uma fila de conversas sem resposta no fim do dia, horários vagos que poderiam ter sido preenchidos e pouca clareza sobre quais serviços realmente sustentam o mês. Qualquer melhoria precisa caber nessa rotina picada, sem exigir horas de computador.",
    cautions: [
      "Antes de deixar qualquer resposta pronta circular, separe o que é estável do que depende de avaliação. Duração de escova, endereço e formas de pagamento podem ser padronizados. Preço de química, tempo de coloração e indicação de tratamento dependem de ver o cabelo e precisam passar pela profissional. Também vale combinar uma regra simples para remarcações: até quando o horário pode ser trocado sem custo e quem confirma a troca. Registre essas decisões em um documento curto e revise uma vez por semana com a equipe, porque é ali que aparecem as perguntas novas que ainda não têm resposta segura.",
      "Cuidado com dados de clientes. Fotos de antes e depois, alergias informadas e telefone pessoal não devem ser colados em ferramentas sem necessidade. Use apelidos ou iniciais quando estiver organizando a agenda com ajuda de IA e mantenha a ficha completa só onde o salão já guarda essas informações. Outra atenção: mensagens automáticas de lembrete precisam respeitar quem pediu para não receber. Comece com um único lembrete na véspera, observe como as clientes reagem durante duas semanas e só então decida se vale acrescentar algo."
    ]
  },
  "loja": {
    label: "lojas de bairro",
    context: "Uma loja de bairro vive de relacionamento e de giro de estoque. A mesma pessoa abre a porta, atende no balcão, responde perguntas sobre tamanho e cor pelo celular, confere entregas de fornecedor e fecha o caixa. Muitas vendas começam com uma foto enviada por mensagem e terminam no balcão, o que torna difícil saber de onde veio cada cliente. Promoções são decididas no impulso, e o controle de quanto sobrou no mês costuma ficar para depois. Nesse contexto, organização não significa sistema caro: significa poucas rotinas repetidas com disciplina, que liberam tempo para atender bem quem entra.",
    cautions: [
      "Disponibilidade de produto é a informação que mais gera desgaste quando está errada. Nunca deixe uma resposta automática afirmar que há tamanho ou cor em estoque sem conferência; prefira uma frase que avise que a equipe vai confirmar em seguida. O mesmo vale para preço em promoção: defina data de início e fim por escrito antes de divulgar. Ao testar qualquer melhoria, escolha uma categoria de produto por vez, acompanhe por uma semana e compare com a semana anterior usando números simples que a loja já tem, como quantidade de pedidos e de trocas.",
      "Evite copiar mensagens prontas de outras lojas. O cliente do bairro reconhece o jeito de falar de quem atende, e um texto genérico quebra essa confiança. Use modelos apenas como ponto de partida e ajuste ao vocabulário da loja. Também é importante não acumular listas de contatos sem permissão: envie novidades só para quem pediu para receber, e ofereça sempre uma forma fácil de sair da lista. Isso protege a reputação da loja e evita bloqueios no aplicativo de mensagens."
    ]
  },
  "prestador de serviço": {
    label: "prestadores de serviço",
    context: "Quem presta serviço, como eletricista, técnico de manutenção, fotógrafo ou consultor, vende tempo e confiança. Cada orçamento exige entender o problema, estimar horas e materiais e explicar o que está incluído. Boa parte do dia é gasta em deslocamento e execução, e os pedidos de orçamento se acumulam no celular. Quando a resposta demora, o cliente fecha com outro; quando sai apressada, o preço fica mal calculado e a margem desaparece. O desafio é transformar um atendimento que hoje depende da memória de uma pessoa em passos claros que podem ser repetidos sem perder o cuidado técnico.",
    cautions: [
      "Orçamento não é texto de marketing: cada valor precisa ter origem. Antes de padronizar respostas, liste o que entra em todo serviço (deslocamento, visita técnica, garantia) e o que depende de avaliação no local. Nenhuma ferramenta deve informar prazo de execução ou preço final sem essa conferência. Registre também os motivos de orçamentos recusados, mesmo que de forma resumida, porque eles mostram se o problema está no preço, na demora da resposta ou na explicação do serviço.",
      "Guarde fotos e endereços de clientes apenas pelo tempo necessário para executar e dar garantia ao serviço. Ao usar IA para redigir propostas, troque nomes e endereços por referências genéricas e preencha os dados reais só no documento final. Outra atenção é com promessas de prazo em mensagens automáticas: prefira informar quando o orçamento será enviado, e não quando o serviço ficará pronto, até que a agenda esteja confirmada pela pessoa responsável."
    ]
  },
  "delivery": {
    label: "negócios de delivery",
    context: "Em um negócio de delivery, a pressão chega em ondas. No horário de pico, pedidos entram por aplicativo, telefone e mensagem ao mesmo tempo, enquanto a cozinha produz e o entregador espera. Fora do pico, sobra pouco tempo para olhar números, ajustar cardápio ou responder avaliações. Erros pequenos, como um item esquecido ou um endereço incompleto, viram reclamação pública e custo de reenvio. Taxas de plataforma e embalagens consomem parte do valor de cada pedido, e nem sempre fica claro quais pratos realmente compensam. Melhorar a operação significa reduzir retrabalho no pico e criar momentos curtos de análise fora dele.",
    cautions: [
      "Nunca automatize a confirmação de um pedido sem conferir disponibilidade de ingredientes e tempo de preparo do momento. Uma mensagem que promete entrega em trinta minutos durante o pico cria uma expectativa difícil de cumprir. Defina faixas de tempo realistas por período do dia e revise quando houver mudança de equipe. Para alergias e restrições alimentares, a resposta deve sempre passar por uma pessoa da cozinha; nenhuma ferramenta deve afirmar que um prato é seguro sem essa verificação.",
      "Tenha cuidado ao analisar avaliações e reclamações com IA: copie apenas o texto do comentário, sem nome, telefone ou endereço do cliente. Use o resumo para encontrar padrões, como atraso em um bairro específico ou embalagem que vaza, e não para responder automaticamente. Respostas públicas a avaliações negativas devem ser escritas ou revisadas pelo responsável, com tom respeitoso e uma proposta concreta de solução."
    ]
  },
  "autônomo": {
    label: "profissionais autônomos",
    context: "O profissional autônomo acumula todas as funções: produz, vende, cobra, responde mensagens e cuida da própria agenda. Não existe equipe para dividir tarefas nem horário fixo para administração, então o trabalho invisível fica para a noite ou para o fim de semana. É comum que a renda varie bastante de um mês para outro, que cobranças fiquem esquecidas e que propostas sejam escritas do zero a cada novo cliente. Para quem trabalha sozinho, qualquer rotina nova precisa economizar mais tempo do que consome e ser simples o bastante para continuar funcionando em semanas corridas.",
    cautions: [
      "Separe desde o início o dinheiro pessoal do dinheiro do trabalho, nem que seja com duas contas ou duas planilhas. Sem essa separação, nenhuma análise de caixa ou de preço faz sentido. Ao criar modelos de proposta ou de cobrança, revise cada envio antes de mandar: um valor desatualizado ou um prazo errado em um texto padrão se repete em todos os clientes. Comece com um único modelo, use durante um mês e ajuste com base nas dúvidas que os clientes realmente fizeram.",
      "Proteja informações de clientes mesmo trabalhando sozinho. Contratos, documentos e conversas não devem ser colados inteiros em ferramentas de IA; extraia só o trecho necessário e retire dados pessoais. Defina também limites de atendimento: um horário de resposta informado na saudação evita a sensação de que é preciso estar disponível o tempo todo e ajuda a manter a qualidade do trabalho principal."
    ]
  }
};

const PRODUCT = {
  "ZEV-IA-011": {
    role: "O IA na Prática organiza o uso de inteligência artificial em processos que podem ser repetidos, revisados e adaptados à rotina, em vez de depender de tentativas soltas a cada tarefa. A proposta começa pela clareza de entrada: definir contexto, objetivo, restrições e critério de qualidade antes de pedir qualquer resposta. A partir de uma boa tentativa, o método transforma o resultado em um fluxo reutilizável, com revisão humana no final. O foco não é colecionar ferramentas novas, e sim escolher tarefas reais do negócio em que a IA ajuda a preparar, organizar ou revisar trabalho.",
    steps: [
      "Escolha uma tarefa que se repete toda semana e que hoje consome tempo, como responder perguntas frequentes ou redigir uma mensagem de retorno. Escreva em poucas linhas o contexto do negócio, o objetivo da tarefa e o que não pode acontecer. Faça três tentativas com a mesma estrutura de pedido e compare os resultados lado a lado. Fique com a versão mais clara, anote o que precisou ser corrigido e transforme isso em um modelo de pedido. Na semana seguinte, use o modelo novamente e registre se a revisão ficou mais rápida. Só depois disso passe para a próxima tarefa.",
      "Monte uma pequena biblioteca com no máximo cinco modelos de pedido para tarefas diferentes. Para cada modelo, anote quem revisa o resultado e em que situação ele não deve ser usado. Reserve quinze minutos na sexta-feira para olhar o que funcionou: quais modelos foram usados, quais respostas precisaram de muita correção e quais dúvidas novas surgiram. Ajuste um modelo por semana em vez de reescrever tudo. Com o tempo, a biblioteca reflete o jeito do negócio trabalhar e fica mais fácil treinar outra pessoa para usá-la."
    ]
  },
  "ZEV-VEN-011": {
    role: "O Vendas na Prática organiza os pedidos e oportunidades que chegam, com atendimento, oferta e acompanhamento em uma sequência que pode ser executada, medida e melhorada. A ideia central é que cada conversa termine com uma próxima ação definida e que cada oportunidade esteja em uma etapa conhecida do funil, em vez de viver só na memória de quem atende. O material trata de padronizar o atendimento sem transformar a conversa em roteiro robótico e de criar uma cadência de retorno que não vire insistência. É um processo comercial pensado para caber na rotina de quem tem pouco tempo.",
    steps: [
      "Liste as etapas que um cliente percorre hoje, do primeiro contato ao pagamento, usando palavras do próprio negócio. Para cada etapa, defina um critério simples que indica que o cliente avançou. Em seguida, pegue as conversas abertas da semana e classifique cada uma em uma etapa. Para todas que estiverem paradas, escreva a próxima ação e uma data. No fim da semana, conte quantas avançaram e quantas ficaram no mesmo lugar. Esse retrato simples já mostra onde o processo trava e qual mensagem merece ser melhorada primeiro.",
      "Defina uma cadência de acompanhamento com no máximo três contatos depois de um orçamento ou de uma dúvida sem resposta, com intervalos combinados e um motivo diferente em cada contato: esclarecer uma dúvida, oferecer uma alternativa e, por fim, encerrar com respeito. Escreva essas três mensagens como base e adapte ao cliente antes de enviar. Registre em uma lista simples quem recebeu cada contato. Ao final de quinze dias, observe em que contato as respostas aparecem e ajuste a cadência, sem aumentar a frequência de mensagens."
    ]
  },
  "ZEV-LCX-011": {
    role: "O Lucro & Caixa transforma a movimentação financeira em uma rotina de leitura simples para enxergar caixa, margem e decisões do negócio. Ele parte de uma distinção que muita gente sente na prática: faturar não significa necessariamente sobrar dinheiro. O material ajuda a separar entrada de lucro, organizar custos que passam despercebidos e criar um acompanhamento curto e frequente, em vez de olhar os números só quando aparece um problema. Não é contabilidade completa; é uma forma de transformar informação básica em visão útil para decidir preços, compras e prioridades.",
    steps: [
      "Durante uma semana, anote todas as entradas e saídas do negócio em uma única lista, com data, valor e uma categoria curta. No fim da semana, some por categoria e compare com o que você imaginava antes de anotar. Identifique os três custos recorrentes que mais surpreenderam e verifique se cada um ainda é necessário. Depois, escolha o produto ou serviço mais vendido e calcule quanto sobra em cada venda depois dos custos diretos. Esse número, mesmo aproximado, é a base para decidir promoções e reajustes com mais segurança.",
      "Crie um ritual financeiro de vinte minutos em um dia fixo da semana. Nesse horário, confira o saldo disponível, as contas a pagar dos próximos quinze dias e os valores a receber. Marque em vermelho qualquer semana em que as saídas previstas superam as entradas e decida com antecedência o que pode ser adiado ou renegociado. Uma vez por mês, revise a margem dos três itens mais vendidos. O objetivo é que nenhuma decisão de compra ou de desconto seja tomada sem olhar esse quadro."
    ]
  },
  "ZEV-CMB-011": {
    role: "O Combo IA + Vendas reúne dois treinamentos completos: IA na Prática, para organizar pedidos, rascunhos, tarefas e revisão com inteligência artificial, e Vendas na Prática, para organizar os pedidos e oportunidades que chegam, com atendimento, oferta e follow-up. A premissa é direta: a IA acelera o que já existe, inclusive a desorganização. Os dois treinamentos se complementam e funcionam de forma independente; para quem quer usar ambos, a ordem sugerida é começar pelo método de IA e depois estruturar o processo comercial, mantendo funil, conversa e acompanhamento guiados por processo.",
    steps: [
      "Antes de usar IA em vendas, desenhe em uma folha as etapas do seu atendimento e marque onde hoje você perde mais tempo. Escolha só uma dessas etapas, por exemplo o resumo de uma conversa antes do retorno. Crie um modelo de pedido que recebe o histórico da conversa sem dados pessoais e devolve três pontos: o que o cliente quer, a dúvida principal e a próxima ação sugerida. Revise o resultado e só então escreva a mensagem. Repita com dez conversas e veja se a qualidade do retorno melhorou.",
      "Organize uma rotina semanal em duas partes. Na primeira, revise o funil e escolha as oportunidades que merecem atenção, com base na etapa e na data da última conversa. Na segunda, use a IA apenas para preparar o material dessas oportunidades: uma resposta a uma objeção, um resumo do serviço ou uma comparação entre opções. Envie só depois de ajustar ao cliente. Registre quais materiais foram reaproveitados e quais precisaram ser refeitos, para melhorar os modelos aos poucos."
    ]
  },
  "ZEV-NGC-011": {
    role: "O Negócio Completo conecta IA aplicada, processo comercial e visão financeira em uma só jornada, para reduzir o improviso nas três áreas que mais pressionam a rotina de um pequeno negócio. A lógica é que melhorar uma área isolada costuma apenas mudar o problema de lugar: produzir mais sem vender melhor, vender mais sem enxergar margem ou controlar o caixa sem melhorar a execução. O pacote propõe uma sequência coerente entre produzir com método, vender com processo e acompanhar o resultado, para que as decisões do dia a dia considerem as três dimensões ao mesmo tempo.",
    steps: [
      "Faça um diagnóstico de uma página com três perguntas: qual tarefa operacional mais consome tempo, em que etapa as vendas mais travam e qual número financeiro você não sabe responder hoje. Escolha uma ação pequena para cada área e distribua ao longo de três semanas, uma área por semana. Na primeira, padronize a tarefa operacional; na segunda, organize o acompanhamento das oportunidades; na terceira, calcule a margem dos itens principais. Ao final, compare o tempo gasto e as decisões tomadas antes e depois.",
      "Monte um painel simples, em papel ou planilha, com um indicador por área: horas gastas na tarefa mais repetitiva, número de oportunidades com próxima ação definida e saldo previsto para as próximas duas semanas. Atualize o painel em um horário fixo da semana. Quando um indicador piorar, investigue a causa antes de mudar qualquer coisa nas outras áreas. Esse hábito evita decisões isoladas, como dar desconto para vender mais sem verificar se a margem permite."
    ]
  }
};

const ANGLE = {
  "dor": {
    heading: "O problema que mais trava a rotina",
    text: [
      "O ponto de dor mais citado por quem tem pouco tempo não é falta de esforço, e sim a sensação de começar tudo de novo a cada dia. A mesma pergunta é respondida de formas diferentes, a mesma conta é refeita e a mesma decisão é adiada porque falta informação organizada. Esse retrabalho não aparece em nenhum relatório, mas consome as melhores horas do dia e deixa pouco espaço para atender bem. Reconhecer onde ele acontece é o primeiro passo: anote, durante três dias, cada vez que precisou procurar uma informação ou refazer algo que já tinha feito antes.",
      "Muitas vezes o problema não está na falta de ferramenta, mas na falta de uma decisão anterior. Sem saber o que é prioridade, qualquer mensagem parece urgente e qualquer pedido entra na frente. O cansaço que vem disso leva a respostas apressadas, a preços definidos sem conta e a oportunidades esquecidas. Uma forma prática de enxergar a dor é listar as interrupções de um dia comum e marcar quais delas poderiam ter sido resolvidas com uma informação pronta ou com uma regra combinada antes."
    ]
  },
  "tutorial": {
    heading: "Passo a passo para começar sem complicar",
    text: [
      "Um bom começo cabe em uma hora por semana. Primeiro, escolha um único problema concreto e descreva como ele acontece hoje, sem tentar resolver tudo de uma vez. Depois, defina como você vai saber que melhorou: menos tempo gasto, menos erros ou menos perguntas repetidas. Em seguida, teste a mudança em pequena escala por uma semana, anotando o que deu certo e o que atrapalhou. Por fim, decida se mantém, ajusta ou descarta. Esse ciclo curto evita investir energia em mudanças grandes que não se sustentam na rotina real.",
      "O tutorial mais útil é aquele que pode ser repetido por outra pessoa. Por isso, ao testar qualquer melhoria, escreva o passo a passo enquanto faz, com frases curtas e na ordem em que as coisas acontecem. Inclua onde a informação fica guardada, quem revisa e o que fazer quando algo foge do padrão. Depois de duas semanas, peça para alguém de confiança seguir o roteiro sem ajuda. As dúvidas que surgirem mostram exatamente quais passos ainda estão vagos."
    ]
  },
  "caso de uso": {
    heading: "Um caso de uso com dados fictícios",
    text: [
      "Imagine uma semana típica com vinte contatos de clientes, metade deles com a mesma dúvida. Em vez de responder cada um do zero, a equipe separa as cinco perguntas mais comuns, escreve uma resposta base para cada uma e marca o que precisa ser conferido antes de enviar. Na semana seguinte, as respostas saem mais rápidas e mais consistentes, e o tempo economizado vai para os contatos que exigem atenção individual. Os números deste exemplo são ilustrativos; o importante é medir a própria rotina antes e depois de qualquer mudança.",
      "Considere um negócio fictício que decide revisar seu atendimento durante quinze dias. Na primeira semana, apenas registra cada pedido recebido, o canal de origem e o tempo até a primeira resposta. Na segunda, aplica uma regra simples de priorização e prepara respostas base para os casos mais frequentes. Ao comparar as duas semanas, percebe que a maior perda não estava no volume, mas nos retornos esquecidos. O caso é inventado para ilustrar o método; os resultados reais dependem de cada operação e precisam ser medidos."
    ]
  },
  "objeção": {
    heading: "Objeções comuns antes de mudar a rotina",
    text: [
      "A objeção mais frequente é a falta de tempo para organizar qualquer coisa. Ela faz sentido: quem está sobrecarregado não consegue parar a operação para implantar um sistema novo. Por isso, a recomendação é não parar nada, e sim reservar um intervalo curto e fixo para uma única melhoria. Outra objeção comum é o receio de perder o toque pessoal no atendimento. Rotinas bem feitas fazem o oposto: tiram do caminho as tarefas repetidas e liberam atenção para a parte da conversa que realmente depende de você.",
      "Também aparece o medo de errar com o cliente ao usar modelos ou automações. Esse cuidado é saudável e deve continuar existindo: nada deve ser enviado sem revisão enquanto a rotina não estiver madura. Há ainda quem ache que organização é coisa de empresa grande. Na prática, negócios pequenos sentem mais o efeito de cada hora perdida e de cada venda esquecida. Começar com uma mudança mínima, medir e só então ampliar é a forma mais segura de responder a todas essas objeções."
    ]
  },
  "comparação": {
    heading: "Comparação: manual ou assistido",
    text: [
      "Fazer tudo manualmente dá controle total, mas depende da memória e da disponibilidade de uma pessoa. Uma rotina assistida, com modelos e registros simples, reduz o esforço repetido e torna o trabalho mais previsível, desde que exista revisão humana. Para comparar com honestidade, avalie quatro pontos em cada opção: tempo gasto por semana, quantidade de erros ou retrabalho, clareza para outra pessoa assumir a tarefa e facilidade de desfazer a mudança se ela não funcionar. Nenhuma opção é melhor em todos os casos.",
      "Antes de adotar qualquer ferramenta ou rotina nova, compare com o jeito atual usando a mesma régua. Registre por uma semana como a tarefa é feita hoje e, na semana seguinte, como ela é feita com o apoio proposto. Observe também o que não aparece nos números: o quanto a mudança exige de treinamento, se protege os dados dos clientes e se continua funcionando nos dias mais cheios. Quando a diferença for pequena, manter o processo atual pode ser a escolha mais sensata."
    ]
  }
};

const TITLES = {
  "dor": ["{Niche}: o retrabalho que trava a rotina e onde o {product} entra", "Por que {niche} perdem tempo com tarefas repetidas — e o papel do {product}"],
  "tutorial": ["Passo a passo: {product} na rotina de {niche}", "Guia rápido para {niche}: começar com o {product} em uma semana"],
  "caso de uso": ["Caso prático: {product} aplicado a {niche}", "Exemplo comentado: como {niche} podem testar o {product}"],
  "objeção": ["Vale a pena? Objeções comuns de {niche} sobre o {product}", "Sem tempo para organizar? Respostas para {niche} sobre o {product}"],
  "comparação": ["Manual ou assistido: como {niche} podem avaliar o {product}", "Antes de adotar o {product}: uma comparação honesta para {niche}"]
};

const dayOrdinal = day => Math.floor(Date.parse(day + "T00:00:00Z") / DAY);
const capital = s => s.charAt(0).toLocaleUpperCase("pt-BR") + s.slice(1);
export function slugify(text) {
  const full = String(text).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/&/g, " e ").replace(/\+/g, " mais ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return full.length <= 96 ? full : full.slice(0, 96).replace(/-[^-]*$/u, "");
}
// Same calendar formula as acquisition-engine.calendarEntry (enforced by test).
export function editorialCalendar(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) throw new Error("calendar_day_invalid");
  const n = dayOrdinal(day) - dayOrdinal(EPOCH);
  const product = EDITORIAL_PRODUCTS[((n % 5) + 5) % 5];
  const niche = EDITORIAL_NICHES[((Math.floor(n / 5) % 5) + 5) % 5];
  const angle = EDITORIAL_ANGLES[((n * 3 + Math.floor(n / 5)) % 5 + 5) % 5];
  const variant = ((Math.floor(n / 25) % 2) + 2) % 2;
  return { day, n, product, niche, angle, variant };
}
export function dailyEditorialArticle(day, { baseUrl = "https://zevanory.api.br", now = new Date() } = {}) {
  const e = editorialCalendar(day);
  const nd = NICHE[e.niche], pd = PRODUCT[e.product.sku], ad = ANGLE[e.angle];
  const title = TITLES[e.angle][e.variant].replaceAll("{Niche}", capital(nd.label)).replaceAll("{niche}", nd.label).replaceAll("{product}", e.product.name);
  const slug = slugify(title) + "-" + day;
  const link = "https://vendas.zevanory.api.br/comprar/" + e.product.sku + "?utm_source=blog&utm_medium=organic&utm_campaign=conteudo_" + day.replaceAll("-", "");
  const sections = [
    ["## " + ad.heading, ad.text[e.variant]],
    ["## O contexto em " + nd.label, nd.context],
    ["## Onde o " + e.product.name + " ajuda", pd.role],
    ["## Roteiro prático desta semana", pd.steps[e.variant]],
    ["## Cuidados antes de automatizar", nd.cautions[e.variant]],
    ["## Próximo passo", "Se o tema fizer sentido para a sua operação, conheça o " + e.product.name + " e veja escopo, limites e garantia antes de decidir. Comece pela menor mudança possível e meça antes de ampliar."]
  ];
  const body = sections.map(([h, t]) => h + "\n\n" + t).join("\n\n");
  const wordCount = body.trim().split(/\s+/u).length;
  if (wordCount < 400 || wordCount > 900) throw new Error("blog_editorial_word_count_out_of_range:" + wordCount);
  const description = capital(e.angle) + " para " + nd.label + " com o " + e.product.name + ": rotina prática, revisão humana e sem promessas de faturamento.";
  return {
    slug, title, description, body, word_count: wordCount,
    url: baseUrl.replace(/\/$/, "") + "/blog/" + slug,
    publishedAt: now.toISOString(), day,
    theme_id: [e.product.sku, e.niche, e.angle].join(":"), product: e.product.sku, niche: e.niche, angle: e.angle, variant: e.variant,
    cta_url: link,
    faq: [
      { q: "O " + e.product.name + " substitui a revisão humana?", a: "Não. O material organiza a rotina e os modelos de trabalho, mas preços, prazos, disponibilidade e qualquer informação sensível continuam passando por uma pessoa responsável antes de chegar ao cliente." },
      { q: "Por onde " + nd.label + " devem começar?", a: "Por uma única tarefa que se repete toda semana. Descreva como ela acontece hoje, teste uma mudança pequena por sete dias e compare antes de ampliar para outras áreas." }
    ],
    editorial_rubric: { has_title: true, h2: sections.length, practical_example: true, utm_cta: true, unsupported_promises: false }
  };
}
export function trigramSimilarity(a, b) {
  const grams = text => { const w = String(text || "").toLocaleLowerCase("pt-BR").match(/[\p{L}\p{N}]+/gu) || []; return new Set(w.slice(0, -2).map((_, i) => w.slice(i, i + 3).join(" "))); };
  const x = grams(a), y = grams(b); const overlap = [...x].filter(g => y.has(g)).length;
  return overlap / (x.size + y.size - overlap || 1);
}
