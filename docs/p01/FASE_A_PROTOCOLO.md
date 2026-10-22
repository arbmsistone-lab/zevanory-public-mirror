# P01 · Fase A: triagem de demanda sem cobrança (protocolo pré-registrado)

Aprovação do proprietário: 22/10/2026 18:09 ("Fase A"). Desenho acordado com o auditor Sol (Ordem 080 AVAL).
Versão do protocolo: **v1 (22/10/2026)**. Este texto é registrado **antes** de qualquer coleta. Os limiares
abaixo estão implementados em `worker/waitlist.mjs` (`RULE`, `decide`, `wilson`) e conferidos por
`tests/fase-a/waitlist-rule.test.mjs`. Mudar um limiar exige nova versão do protocolo, registrada antes
de olhar os dados da nova rodada.

## 1. Pergunta e escopo

Qual dos três nichos demonstra demanda suficiente por um kit digital de baixo preço para justificar a
Fase B (teste de preço)? A Fase A **não vende nada**: mostra um preço indicativo e oferece apenas uma lista
de espera.

| Nicho (slug) | Conceito de oferta | Página |
|---|---|---|
| `confeitaria` (confeitaria/doceiras) | **Preço Certo na Confeitaria**: ficha técnica com taxa de maquininha/iFood, tabela de preços editável, mensagens de orçamento para WhatsApp, guia curto | `/lista-de-espera/confeitaria` |
| `loja-de-roupas` (loja de roupas de bairro) | **Preço e Estoque na Loja de Roupas**: precificação com markup e margem, controle de estoque simples, mensagens de venda para WhatsApp, guia curto | `/lista-de-espera/loja-de-roupas` |
| `salao-e-barbearia` (salão/barbearia) | **Agenda e WhatsApp no Salão e na Barbearia**: mensagens de confirmação/remarcação/falta, ficha de atendimento, planilha de agenda/retorno, guia curto | `/lista-de-espera/salao-e-barbearia` |

As três páginas saem do **mesmo modelo** (`scripts/fase_a/template.html.tpl` + `data/fase-a-nichos.json`):
mesma estrutura HTML, mesmo número de itens (4), textos de tamanho equivalente (±10%, auditado), o mesmo
preço indicativo **"R$ 37 (pré-lançamento — vendas ainda fechadas)"** e o mesmo formulário. Sem promessa
de faturamento ou resultado, sem urgência ou escassez, sem alegação médica ou regulada, sem link
`/comprar/`, sem `schema.org/InStock` nem `Offer` (regra NO-GO da P13).

## 2. Definições (fixadas antes da coleta)

- **Visitante elegível**: par único (dia UTC, nicho, hash diário) de uma
  requisição `GET` com resposta 200 da página do nicho, servida com a bandeira ligada, que **passa no mesmo
  filtro de robôs do funil** (`worker/funnel.mjs`): agente de usuário vazio ou de automação (`isAutomationUA`:
  bot, crawl, spider, preview, headless, lighthouse, monitor, curl, wget, python, node-fetch, axios, okhttp,
  zevanory etc.) excluído; rede de datacenter (`DATACENTER_ASNS`) excluída; `Sec-Purpose`/`Purpose`
  prefetch/prerender excluído; `HEAD` não conta. O hash diário é `sha256(dia|ip|ua|sal)` truncado, igual ao
  do funil: não é reversível nem ligável entre dias; o IP nunca é gravado. A mesma pessoa em dois dias
  conta duas vezes (efeito conservador: aumenta o denominador).
- **Inscrição válida (lead válido)**: linha ativa em `waitlist_signups` (contato válido, consentimento
  marcado, duas respostas sim/não), `counted = true` (enviada de navegador que passa no mesmo filtro de
  UA/datacenter), criada dentro da janela, **não revogada** até a leitura. Única por contato + nicho
  (idempotente: a repetição não cria linha). Honeypot preenchido nunca grava.
- **Inscrição qualificada**: inscrição válida com **sim** nas duas perguntas: (1) a pergunta de
  recorrência do nicho ("Você refaz seus preços pelo menos 1 vez por mês?" / "Você revisa o preço ou o
  estoque das peças pelo menos 1 vez por mês?" / "Você confirma os horários com os clientes pelo WhatsApp
  toda semana?") e (2) "Já comprou algum produto digital (planilha, curso, e-book)?". Reportada; **não**
  entra na regra de GO (é descritiva).
- **Conversão** = inscrições válidas ÷ visitantes elegíveis, por nicho, na janela.
- **Wilson 95%**: intervalo de score de Wilson (z = 1,959964) da conversão.
- **Violação de conformidade**: qualquer um destes, constatado no nicho durante a janela: link `/comprar/`
  ou oferta estruturada publicada; consentimento pré-marcado ou ausente; contato gravado sem consentimento;
  mensagem enviada a quem não confirmou (antes da P08); promessa de resultado, urgência/escassez ou
  alegação regulada na página ou na peça de tráfego; pedido de saída não atendido em até 15 dias.

## 3. Janela e tráfego

- Início: quando o proprietário ligar as bandeiras (seção 8). Fim: quando **cada** nicho atingir 300
  visitantes elegíveis, ou 28 dias corridos, o que vier primeiro. Os nichos são avaliados juntos, na mesma
  janela, com a mesma fonte de tráfego distribuída de forma equivalente (mesmo tipo de peça, mesmo texto-base
  adaptado ao nicho). A fonte de tráfego é dependência aberta (seção 9): os vídeos estão pausados.
- Leituras intermediárias são permitidas só para conformidade e operação; **não** encerram a janela antes
  e **não** mudam limiares.

## 4. Coleta e dados pessoais (LGPD)

- Controladora: A. Renan Alves Moreira Bitu Ltda, CNPJ 69.077.233/0001-99.
- Finalidade (texto do consentimento, versão `fase-a-lista-v1-2026-10-22`): avisar se as vendas do kit
  abrirem e convidar, se a pessoa quiser, para uma conversa curta sobre o kit.
- Dados: contato (WhatsApp ou e-mail, normalizado), nome opcional, as duas respostas, nicho, versão e data do
  consentimento, origem (utm_source/referer em rótulo curto). Sem IP, sem cookie.
- Pseudonimização: índice único por `HMAC(LEAD_PRIVACY_SECRET, contato)` (mesmo padrão dos leads do material
  gratuito; sem a chave o endpoint recusa: fail-closed).
- Retenção: 12 meses após a inscrição ou até a saída, o que vier primeiro (`runWaitlistRetention`, diária).
  Registro de auditoria (evento, nicho, versão, referência pseudonimizada): 2 anos.
- Saída: link assinado mostrado na confirmação (apaga o contato em todos os nichos) ou pedido em
  suporte@zevanory.api.br / WhatsApp +55 88 99254-5413 (atendido em até 15 dias).
- Dupla confirmação (double opt-in): **dependência P08** (issue #871). Até ela existir, nenhuma mensagem é
  enviada pela lista; a confirmação é só na tela.

## 5. Regra de decisão (pré-registrada)

Para cada nicho, ao fim da janela:

1. **Menos de 300 visitantes elegíveis → INCONCLUSIVO** (nunca NO-GO). O nicho pode ser repetido numa nova
   janela, com nova versão do protocolo.
2. Com 300 visitantes elegíveis ou mais, **GO para a Fase B** se, e somente se, **todas** valerem:
   - conversão **≥ 8%**;
   - limite inferior de Wilson 95% **≥ 5%**;
   - **≥ 20** inscrições válidas;
   - **nenhuma** violação de conformidade no nicho.
3. Caso contrário, **NO-GO** para a Fase B (o nicho não avança nesta rodada).

Se mais de dois nichos tiverem GO, os dois finalistas são os de maior limite inferior de Wilson (empate:
maior número de inscrições válidas). Se só um tiver GO, a Fase B roda com ele. As inscrições qualificadas e
seus intervalos são reportados para contexto, sem decidir nada.

Leitura das métricas (somente leitura, sem dado pessoal):
`DATABASE_URL=… node scripts/fase_a/resumo.mjs --since AAAA-MM-DD --until AAAA-MM-DD [--violacao nicho]`.

## 6. Entrevistas (qualitativo)

- **8 a 12 entrevistas por nicho**, até saturação temática (duas entrevistas seguidas sem tema novo, após
  no mínimo 8). Convite só a quem está na lista e consentiu (finalidade "conversa curta"), por ordem de
  inscrição, sem incentivo condicionado a resposta.
- Uso estritamente qualitativo: temas, linguagem, objeções. Frações observadas (por exemplo "7 de 10 disseram…")
  podem ser reportadas **com intervalo de Wilson**, mas **nunca** geram GO nem NO-GO.
- Registro: notas sem nome nem contato (código E-<nicho>-NN); gravação só com autorização expressa.

### Roteiro (pt-BR, neutro, sem perguntas indutivas)

Abertura: "Obrigado por topar. São uns 15 minutos. Não estou vendendo nada; quero entender como você
trabalha hoje. Não existe resposta certa. Posso anotar? Não vou registrar seu nome."

1. Me conte como funciona um dia comum no seu negócio.
2. Pensando na última semana, como você decidiu o preço [de uma encomenda / de uma peça] **ou** como você
   organizou os horários dos clientes? (usar a do nicho)
3. O que você usou para isso? (caderno, planilha, aplicativo, cabeça, outra pessoa)
4. Como foi da última vez que isso deu errado? O que aconteceu depois?
5. Quanto tempo isso costuma tomar na sua semana?
6. Você já procurou alguma coisa para ajudar com isso? O que encontrou? O que achou?
7. Já pagou por alguma planilha, curso ou material parecido? Como foi a experiência?
8. Quando você leu a descrição do kit na página, o que passou pela sua cabeça?
9. O que você esperaria encontrar dentro dele? O que faria você não usar?
10. Como você costuma pagar por coisas assim? (sem citar valores; se a pessoa citar, apenas anotar)
11. Tem algo que eu não perguntei e que você acha importante?

Encerramento: "Obrigado. Se você quiser sair da lista ou apagar seus dados, é só pedir pelo link que
apareceu na inscrição ou pelo suporte." Proibido: sugerir respostas, citar resultado ("você venderia mais"),
pedir compromisso de compra, criar urgência.

## 7. Fase B (depois, fora deste PR)

Dois finalistas (seção 5). Randomização **persistente** por visitante entre **R$ 27** e **R$ 47** (mesma
pessoa vê sempre o mesmo preço), vendas reais só com a política única da P13 e o interruptor do proprietário.
Protocolo próprio, registrado antes da Fase B.

## 8. Lançamento (decisão do proprietário, PR próprio)

Tudo nasce **desligado**:

- Páginas: só existem nos assets se o build rodar com `ZEVANORY_FASE_A_PAGES=on`
  (`scripts/fase_a/build_fase_a.py --out sales-public`); `--preview` nunca escreve em `sales-public/`. Com a
  bandeira ligada o build **falha** se a Política de Privacidade não tiver a seção `id="lista-de-espera"`
  (texto proposto abaixo). Sempre `noindex,nofollow`, fora da navegação, do sitemap e das rotas fixas.
- Rotas: `FASE_A_WAITLIST=on` nos **dois** Workers (vendas e núcleo); ausente = 404 em tudo.
- Pré-requisitos: P03 (paginação, #867) e P13 (política única/NO-GO) integradas; P08 (dupla confirmação,
  #871) integrada antes de qualquer mensagem; fonte de tráfego definida; seção da política publicada.

Texto proposto para a Política de Privacidade (seção `id="lista-de-espera"`):

> **Lista de espera (Fase A).** Se você entrar numa lista de espera de kit em pré-lançamento, tratamos seu
> contato (WhatsApp ou e-mail), seu nome (opcional), suas respostas às duas perguntas do formulário, o nicho
> e a data e versão do consentimento, para avisar se as vendas do kit abrirem e, se você quiser, convidar
> para uma conversa curta. Base legal: consentimento. Guardamos por até 12 meses ou até você sair, o que vier
> primeiro; o registro do consentimento e da saída (sem o contato) por até 2 anos. Para sair, use o link
> mostrado na inscrição ou escreva para suporte@zevanory.api.br.

## 9. Dependências abertas

- **P08** (issue #871, Copilot): dupla confirmação. Bloqueia qualquer envio de mensagem.
- **P13** (PR "política única / NO-GO"): páginas da Fase A já seguem a regra (sem `/comprar/`, sem InStock).
- **P03** (#867): paginação/sem rolagem; as páginas passam na matriz 5 viewports × 2 temas + axe A/AA com os
  assets da P03 (CI deste PR usa o commit fixado da #867 até ela ser integrada).
- **Tráfego**: os vídeos estão pausados; sem fonte de tráfego a janela não começa (e < 300 é INCONCLUSIVO).
