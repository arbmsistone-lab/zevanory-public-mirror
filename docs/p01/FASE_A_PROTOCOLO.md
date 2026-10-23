# P01 · Fase A: triagem de demanda sem cobrança (protocolo pré-registrado)

Aprovação do proprietário: 22/10/2026 18:09 ("Fase A"). Desenho acordado com o auditor Sol (Ordem 080 AVAL);
correções das AVAL 085 e 092 incorporadas. Versão do protocolo: **v4 (23/10/2026)**, registrada **antes** de qualquer
coleta (v1 → v2: unidade pessoa experimental, consentimento separado, aviso, segredo, retenção, migração; v2 → v3:
origem do link na pessoa experimental, mistura de canais entre os braços, exclusão da rede pessoal/parceiros e
"semana de teste" antes da janela de 21 dias; v3 → v4 (AVAL 092): `wa_status`/`wa_lista` deixam de ser
"rede pessoal descartada" e viram a classe de origem `wa_owned`, fora da métrica primária e reportada como
**métrica secundária** pré-registrada; regras multi-aparelho e multi-nicho explícitas (§2.2); LIA registrada em
`docs/lgpd/LIA-fase-a.md`). Nenhum dado foi coletado sob v3 (bandeiras desligadas, sem tráfego). Os limiares e definições estão implementados em `worker/waitlist.mjs` (`RULE`, `decide`, `wilson`,
`reconcile`, `summarize`, `RETENTION`) e conferidos por `tests/fase-a/`. Mudar um limiar exige nova versão do
protocolo, registrada antes de olhar os dados da nova rodada.

## 1. Pergunta e escopo

Qual dos três nichos demonstra demanda suficiente por um kit digital de baixo preço para justificar a Fase B
(teste de preço)? A Fase A **não vende nada**: mostra um preço indicativo e oferece apenas uma lista de espera.

| Nicho (slug) | Conceito de oferta | Página |
|---|---|---|
| `confeitaria` | **Preço Certo na Confeitaria**: ficha técnica com taxa de maquininha/iFood, tabela de preços editável, mensagens de orçamento para WhatsApp, guia curto | `/lista-de-espera/confeitaria` |
| `loja-de-roupas` | **Preço e Estoque na Loja de Roupas**: precificação com markup e margem, controle de estoque simples, mensagens de venda para WhatsApp, guia curto | `/lista-de-espera/loja-de-roupas` |
| `salao-e-barbearia` | **Agenda e WhatsApp no Salão e na Barbearia**: mensagens de confirmação/remarcação/falta, ficha de atendimento, planilha de agenda/retorno, guia curto | `/lista-de-espera/salao-e-barbearia` |

As três páginas saem do **mesmo modelo** (`scripts/fase_a/template.html.tpl` + `data/fase-a-nichos.json`): mesma
estrutura, 4 itens, textos ±10%, o mesmo preço indicativo **"R$ 37 (pré-lançamento — vendas ainda fechadas)"** e o
mesmo formulário. Sem promessa de faturamento ou resultado, sem urgência/escassez, sem alegação médica ou regulada,
sem `/comprar/`, sem `schema.org/InStock` nem `Offer` (NO-GO da P13).

## 2. Unidade estatística e definições (AVAL 085 §1)

- **Unidade primária: pessoa experimental única por nicho na janela inteira.** Ao abrir a página, o núcleo emite
  um identificador aleatório de 128 bits num **cookie próprio** `zvfa` (assinado com HMAC e `WAITLIST_VISITOR_SECRET`,
  escopo `Path=/lista-de-espera`, `Secure; HttpOnly; SameSite=Lax`, expira no **fim da janela**, no máximo 60 dias).
  O banco guarda só `HMAC(segredo, identificador)`; o identificador em claro nunca é gravado.
- **Pessoa experimental confirmada (= visitante elegível, denominador)**: identificador da janela cujo navegador
  **devolveu o cookie** (pedido da folha de estilo `/lista-de-espera/c/<nicho>.css` ou envio do formulário), cuja
  primeira visita passou no **mesmo filtro de robôs do funil** (`worker/funnel.mjs`: UA vazio ou de automação,
  ASN de datacenter, prefetch/prerender; `HEAD` e outros métodos não contam). A mesma pessoa em vários dias conta
  **uma** vez (a linha soma `days`). **M-SOL-085**: mesmo IP+navegador em dois dias = 1 pessoa (teste e mutante).
- **Entre aparelhos (onde comprovável)**: o mesmo contato inscrito a partir de dois identificadores no mesmo nicho
  é a mesma pessoa (`waitlist_person_alias`); conta uma vez no denominador e no numerador. Sem isso, cada aparelho é
  uma unidade (limitação em §2.2).
- **Inscrição válida (numerador)**: inscrição ativa, sem exclusão de UA/ASN, **ligada a uma pessoa experimental
  confirmada do mesmo nicho** (mesma unidade do denominador), contada por pessoa distinta. Idempotente por janela +
  nicho + contato. Honeypot nunca grava.
- **Inscrição sem identificador** (cookie ausente ou inválido no envio): fica guardada para o aviso, **fora** do
  numerador, e torna o nicho **INCONCLUSIVO** (a igualdade de unidade não pode ser provada).
- **Exposição pessoa-dia** (descritiva): `HMAC(segredo, dia|IP|navegador)` por nicho e dia. Sem identificador
  possível (segredo ausente ou janela não configurada), a visita conta **só** como pessoa-dia, e a decisão é
  **INCONCLUSIVO**. Nunca se calcula Wilson nem GO sobre pessoa-dia.
- **Identificador não confirmado** (navegador que não devolve o cookie): reportado, não entra no denominador.
- **Inscrição qualificada**: válida e com **sim** nas duas perguntas (recorrência do nicho; "Já comprou algum produto
  digital (planilha, curso, e-book)?"). Descritiva; não decide.
- **Conversão** = inscrições válidas ÷ pessoas experimentais confirmadas. **Wilson 95%** com z = 1,959964.
- **Violação de conformidade**: link `/comprar/` ou oferta estruturada publicada; consentimento pré-marcado ou
  ausente; contato gravado sem consentimento; mensagem enviada antes da P08; promessa de resultado, urgência/
  escassez ou alegação regulada na página ou na peça de tráfego; saída não atendida em até 15 dias.

## 2.1. Origem do link, classes de origem e mistura de canais (v3, classes v4)

- **Origem** gravada na pessoa experimental na **primeira visita** (rótulo de lista fechada, sem dado pessoal), a
  partir de `utm_source`: `wa_status`, `wa_lista`, `ig_story`, `ig_post`, `ig_reel`, `fb_grupo`, `parc_<nome>`
  (parceiro), `organico`, `direto`, `meta_<nome>` (reservado ao tráfego pago futuro: aceito e reportado). `utm_source`
  fora da lista = `invalido`; sem `utm_source`: referer externo = `organico`, nenhum = `direto`. A inscrição herda a
  origem da pessoa (mesma unidade); o formulário reenvia o rótulo, revalidado pela mesma lista.
- **Classes de origem (v4)**: `canal` (ig_*, fb_grupo, organico, direto), `wa_owned` (`wa_status`, `wa_lista`:
  WhatsApp do proprietário, status e lista de transmissão, seja conta pessoal ou comercial), `parceiro` (`parc_*`),
  `reservado_meta` (`meta_*`) e `sem_origem` (`sem_tag`, `invalido`).
- **`wa_owned` NÃO é descartado** (AVAL 092 §4): quem chega pelo WhatsApp do proprietário pode ser um prospect
  orgânico válido, mas a audiência é pré-selecionada pelo próprio proprietário e não é comparável entre os braços.
  Por isso `wa_owned` fica **fora da métrica primária** (população da decisão, Wilson e GO/NO-GO) e é reportado como
  **métrica secundária** pré-registrada, por nicho: `secondary.wa_owned` = pessoas experimentais confirmadas
  `wa_owned`, inscrições ligadas a elas (mesma unidade, mesmos filtros de robô), conversão e Wilson 95%, com
  `decides: false`. A secundária **nunca** cria, muda ou desfaz um GO/NO-GO; ela é lida na ata como contexto (ex.:
  "a audiência própria converte X% vs. Y% do tráfego independente").
- **Parceiros (`parc_*`)** continuam fora da população da decisão. O resumo traz as exclusões por classe
  (`excluded_source: { wa_owned, parceiro }`) e a sensibilidade "com wa_owned e parceiros"
  (`with_wa_owned_and_partners`).
- **Mistura de canais entre os braços** (pré-registrado, população da decisão): cada nicho com ≥ 1 pessoa; origem
  ausente (`sem_tag`/`invalido`) ≤ 5% em **cada** nicho (senão `NAO_VERIFICAVEL` — origem ausente **nunca** conta
  como equilibrada); diferença máxima de participação de qualquer origem entre nichos ≤ 10 pontos (`EQUILIBRADO`,
  senão `DESEQUILIBRADO`). **Finalistas só são escolhidos com mistura `EQUILIBRADO`**; caso contrário a comparação
  entre nichos não vale (`finalists: []`), e as decisões por nicho continuam sendo reportadas.

## 2.2. Multi-aparelho e multi-nicho (v4, AVAL 092 §3)

- **Multi-aparelho**: a unidade é o identificador do navegador. A mesma pessoa em dois aparelhos (ou dois
  navegadores, ou após apagar cookies) recebe dois identificadores e conta como **duas unidades**, **salvo identidade
  consentida**: o mesmo contato inscrito (com consentimento) a partir dos dois identificadores no mesmo nicho funde-os
  (`waitlist_person_alias`) em uma pessoa e uma inscrição. Um aparelho só de visita nunca é ligado a outro (não há
  impressão digital de aparelho, de propósito: minimização). **Limitação**: o denominador pode ficar **inflado** por
  pessoas multi-aparelho que não se inscrevem; o viés é **conservador** (reduz a conversão, nunca cria GO falso). O
  resumo traz `aliases` (fusões comprovadas) e `multi_day_persons`; a magnitude do viés não é estimada.
- **Multi-nicho**: cada nicho é um braço com **denominador próprio**. O cookie tem escopo `/lista-de-espera` (o mesmo
  identificador nos três nichos), mas a confirmação é **por nicho** (folha de estilo `/lista-de-espera/c/<nicho>.css`
  ou envio do formulário daquele nicho). Regra: a mesma pessoa confirmada em k nichos conta **1 vez em cada um** desses
  k denominadores e **nunca 2 vezes no mesmo**; visitar um nicho não confirma a pessoa em outro. A inscrição conta
  **só no numerador do nicho em que foi feita** (idempotente por janela + nicho + contato); o mesmo contato inscrito em
  dois nichos conta 1 em cada. Não há deduplicação global entre braços (os braços não são amostras independentes);
  a sobreposição é reportada, descritiva: `cross_niche_persons` por nicho e `cross_niche` no topo
  (`person_niche_rows`, `unique_persons`, `persons_2plus_niches`), na população da métrica primária.

## 3. Oráculo independente e sensibilidade

- **Oráculo**: contadores agregados por dia/nicho/métrica (`waitlist_raw_daily`, sem identificador), escritos na
  **mesma instrução SQL** que altera as linhas. `reconcile` confere 7 igualdades: visitas recebidas = soma das classes
  (incluída, ua, asn, prefetch, método, sem segredo); um desfecho de identificador por visita classificada; pessoas =
  criadas por visita + por inscrição; confirmadas = contador; aliases = contador; inscrições + revogadas + apagadas =
  novas; pessoa-dia = contador. **Qualquer divergência → INCONCLUSIVO** (`oraculo_divergente`).
- **Análise de sensibilidade** (sempre no resumo, antes de qualquer GO): pessoas, inscrições e conversão com
  filtros, sem filtro de ASN, sem filtro de UA, sem filtros e com `wa_owned`/parceiros. Exclusões por razão,
  mistura de canais por nicho e duplicatas pessoa-dia também.

## 3.1. Semana de teste e janela de 21 dias (v3, condição aprovada pelo Sol)

- Antes da janela: **semana de teste** de **7 dias consecutivos** com tráfego **gratuito** apontado às **calculadoras**
  existentes, com `utm_campaign=sdt-<nicho>` (ex.: `/calculadora-taxa-maquininha?utm_source=ig_story&utm_campaign=sdt-confeitaria`).
  Com `FASE_A_SEMANA_TESTE=on`, o funil (`worker/funnel.mjs`) conta por nicho e dia: `sdt:<nicho>:visita`,
  `sdt:<nicho>:qualificada` (visitante único do dia, já sem robôs/datacenter, com Accept-Language e país **BR**) e
  `sdt:<nicho>:pago` (`utm_source` `meta_*`, reservado a tráfego pago).
- **Autoriza somente a abertura do teste de 21 dias** (não decide GO/NO-GO) se, em **todos** os nichos: período de
  exatamente 7 dias, com tráfego em **cada** um dos 7 dias (consecutivos); **≥ 98 visitas qualificadas** no período;
  **distribuição estável** (nenhum dia com mais de 30% das qualificadas do nicho); **zero tráfego pago**. Razões de
  reprovação por nicho: `periodo_diferente_de_7_dias`, `dias_nao_consecutivos`, `menos_de_98_qualificadas`,
  `distribuicao_instavel`, `trafego_pago`. Leitura:
  `node scripts/fase_a/resumo.mjs --semana-teste --since AAAA-MM-DD --until AAAA-MM-DD` (`AUTORIZA_TESTE_21_DIAS`,
  `NAO_AUTORIZA` ou `PERIODO_INVALIDO`).
- **Janela**: 21 dias corridos a partir da abertura (`FASE_A_WINDOW_ID`, `FASE_A_WINDOW_END` = início + 20 dias).
  Leituras intermediárias só para conformidade e operação; não encerram a janela nem mudam limiares.

## 4. Coleta e dados pessoais (LGPD)

- Controladora: A. Renan Alves Moreira Bitu Ltda, CNPJ 69.077.233/0001-99.
- **Lista de espera** (consentimento obrigatório só para isto; versão `fase-a-lista-v2-2026-10-22`): avisar se as vendas
  do kit abrirem. Dados: contato (WhatsApp ou e-mail), nome opcional, as duas respostas, nicho, versão e data do
  consentimento, origem (rótulo curto). Índice `HMAC(LEAD_PRIVACY_SECRET, contato)` (sem a chave: 503).
- **Convite para entrevista**: caixa **separada, opcional e desmarcada** (`interview_ok`); a lista nunca depende dela.
- **Medição** (legítimo interesse, LGPD art. 7º, IX, com aviso na página): cookie próprio aleatório (acima); IP e dados
  do navegador **processados de forma transitória** para gerar o código pseudônimo diário (HMAC com
  `WAITLIST_VISITOR_SECRET`), **não guardados em claro**; e a origem do link (rótulo da campanha, sem dado pessoal). Segredo dedicado com ≥ 32 bytes, **sem fallback**
  (`RESEND_API_KEY`/`DATABASE_URL` nunca são usados); ausente = nada é contado e a decisão é INCONCLUSIVO.
- **Saída**: link assinado (mostrado na confirmação) apaga, numa instrução, **todas** as inscrições do contato; só a
  contagem agregada por nicho é somada. Nenhuma tabela além de `waitlist_signups` tem coluna de contato, nome ou
  referência do contato; não há registro de auditoria ligado ao contato. A prova do consentimento é a própria linha
  (versão + data) enquanto ela existe; depois da saída ou da retenção, o tratamento cessou e resta só a contagem.
- **Retenção por finalidade** (`RETENTION` no código, mesmo texto na página): contato e respostas até **30 dias após a
  decisão** da Fase A (`FASE_A_DECISION_DATE`), no máximo **12 meses** após a inscrição; identificadores e códigos de
  medição até **30 dias após a decisão**, no máximo **180 dias**; cópias de segurança internas (backup diário do Worker,
  `worker/data-backup.mjs`) apagadas em até **8 dias**. Avisar depois disso exige novo consentimento específico.
- **Dupla confirmação**: dependência P08 (issue #871). Até lá nenhuma mensagem é enviada.
- **Avaliação de legítimo interesse (LIA)**: `docs/lgpd/LIA-fase-a.md` (versionada; **pendente de revisão jurídica**
  pelo proprietário antes de ligar a medição). O contato continua exigindo **consentimento separado**.

## 5. Regra de decisão (pré-registrada)

Para cada nicho, ao fim da janela:

0. A população da decisão (métrica primária) exclui `wa_owned` e os parceiros marcados (§2.1); `wa_owned` é
   reportado como métrica secundária, que não decide.
1. **INCONCLUSIVO** se houver qualquer bloqueio: janela não informada, segredo de visitante ausente, identificador
   não estabelecido, inscrição sem identificador, oráculo divergente; ou **menos de 300 pessoas experimentais**
   confirmadas. Nunca NO-GO nesses casos.
2. Sem bloqueio e com ≥ 300 pessoas, **GO para a Fase B** se, e somente se: conversão **≥ 8%**; limite inferior de
   Wilson 95% **≥ 5%**; **≥ 20** inscrições válidas; **nenhuma** violação de conformidade.
3. Caso contrário, **NO-GO** (o nicho não avança nesta rodada).

Finalistas (até dois): só com mistura de canais `EQUILIBRADO` (§2.1); entre os GO, maiores limites inferiores de
Wilson (empate: mais inscrições válidas). A análise de
sensibilidade é lida antes de declarar GO; se o GO não se mantiver sem o filtro de ASN **ou** sem o filtro de UA,
isso é registrado na ata com a justificativa (a regra continua a dos filtros, que é a pré-registrada).

Leitura (somente leitura, sem dado pessoal):
`DATABASE_URL=… node scripts/fase_a/resumo.mjs --janela <FASE_A_WINDOW_ID> --since AAAA-MM-DD --until AAAA-MM-DD [--violacao nicho]`.

## 6. Entrevistas (qualitativo)

- **8 a 12 por nicho**, até saturação temática (duas seguidas sem tema novo, após no mínimo 8). Convite **só** a quem
  marcou a caixa opcional de entrevista, por ordem de inscrição, sem incentivo condicionado a resposta.
- Uso qualitativo: temas, linguagem, objeções. Frações (ex.: "7 de 10") podem ser reportadas **com Wilson**, mas
  **nunca** geram GO nem NO-GO. Notas sem nome nem contato (código E-<nicho>-NN); gravação só com autorização expressa.

### Roteiro (pt-BR, neutro, sem perguntas indutivas)

Abertura: "Obrigado por topar. São uns 15 minutos. Não estou vendendo nada; quero entender como você trabalha hoje.
Não existe resposta certa. Posso anotar? Não vou registrar seu nome."

1. Me conte como funciona um dia comum no seu negócio.
2. Pensando na última semana, como você decidiu o preço [de uma encomenda / de uma peça] **ou** como você organizou
   os horários dos clientes? (usar a do nicho)
3. O que você usou para isso? (caderno, planilha, aplicativo, cabeça, outra pessoa)
4. Como foi da última vez que isso deu errado? O que aconteceu depois?
5. Quanto tempo isso costuma tomar na sua semana?
6. Você já procurou alguma coisa para ajudar com isso? O que encontrou? O que achou?
7. Já pagou por alguma planilha, curso ou material parecido? Como foi a experiência?
8. Quando você leu a descrição do kit na página, o que passou pela sua cabeça?
9. O que você esperaria encontrar dentro dele? O que faria você não usar?
10. Como você costuma pagar por coisas assim? (sem citar valores; se a pessoa citar, apenas anotar)
11. Tem algo que eu não perguntei e que você acha importante?

Encerramento: "Obrigado. Se quiser sair da lista ou apagar seus dados, é só pedir pelo link que apareceu na
inscrição ou pelo suporte." Proibido: sugerir respostas, citar resultado, pedir compromisso de compra, criar urgência.

## 7. Fase B (depois, fora deste PR)

Dois finalistas. Randomização **persistente** por visitante entre **R$ 27** e **R$ 47**; vendas reais só com a política
única da P13 e o interruptor do proprietário. Protocolo próprio, registrado antes.

## 8. Esquema, cópias e lançamento

- **Migração versionada** `db/migrations/030_waitlist_fase_a.sql` (5 tabelas), reversão em
  `db/rollback/030_waitlist_fase_a.down.sql`, inventário em `db/migrations/MANIFEST` (lista **exata** das migrações e
  tabelas declaradas). A restauração (`scripts/ops/restore_new_database.py`) deixou de exigir "exatamente 30" e passou a
  exigir que os `.sql` em disco sejam **iguais** ao manifesto e que as tabelas declaradas existam após a carga. O backup
  diário copia todas as tabelas públicas, inclusive estas (por isso o prazo de 8 dias no aviso).
- Tudo nasce **desligado**: páginas só entram nos assets com `ZEVANORY_FASE_A_PAGES=on` (e a Política de Privacidade
  com a seção `id="lista-de-espera"`); rotas exigem `FASE_A_WAITLIST=on` nos dois Workers; o identificador exige
  `WAITLIST_VISITOR_SECRET`, `FASE_A_WINDOW_ID` e `FASE_A_WINDOW_END`; a retenção usa `FASE_A_DECISION_DATE`.
- Pré-requisitos: migração 030 aplicada; P03 (#867) e P13 (#878) integradas; P08 (#871) antes de qualquer mensagem;
  fonte de tráfego; seção da política publicada.

Texto proposto para a Política de Privacidade (seção `id="lista-de-espera"`):

> **Lista de espera (Fase A).** Se você entrar numa lista de espera de kit em pré-lançamento, tratamos seu contato
> (WhatsApp ou e-mail), seu nome (opcional), suas respostas às duas perguntas, o nicho e a data e versão do
> consentimento, só para avisar se as vendas do kit abrirem (base legal: consentimento). O convite para uma conversa
> curta é opcional e separado. Para medir a demanda do teste (base legal: legítimo interesse), as páginas da lista usam
> um cookie próprio com identificador aleatório, que expira no fim do teste (no máximo 60 dias), e processam de forma
> transitória o IP e os dados do navegador para gerar um código pseudônimo diário, sem guardá-los em claro; também
> registram a origem do link (rótulo da campanha), sem dado pessoal. Contatos e
> respostas são apagados até 30 dias após a decisão do teste (no máximo 12 meses); códigos de medição até 30 dias após
> a decisão (no máximo 180 dias); cópias de segurança internas em até 8 dias. Para sair, use o link mostrado na
> inscrição ou escreva para suporte@zevanory.api.br.

## 9. Dependências abertas

- **P08** (#871): dupla confirmação; bloqueia qualquer envio de mensagem.
- **P13** (#878) e **P03** (#867): páginas já seguem as regras; a matriz P03 roda com o commit fixado da #867.
- **Tráfego**: vídeos pausados; sem tráfego a janela não começa (e < 300 pessoas = INCONCLUSIVO).
