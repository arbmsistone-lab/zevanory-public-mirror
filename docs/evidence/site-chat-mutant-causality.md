# Causalidade dos mutantes do chat do site (#897)

Gerado de `scripts/ci/mutants_site_chat_allow.json` com `python3 scripts/ci/mutants_site_chat.py --doc`. O meta-teste `tests/test_mutants_site_chat_classifier.py` reprova se a tabela abaixo divergir da config.

As expectativas foram escritas **raciocinando sobre cada mutação**: qual regra o mutante quebra e qual asserção a verifica diretamente. Elas **não** foram tiradas das falhas observadas.

## O que mudou no runner (auditoria Sol)

O runner antigo contava `run_suite(tmp) != 0` como KILLED. Não tinha parser de TAP, não tinha asserção causal e não tinha INCONCLUSIVE. Qualquer queda, TypeError, timeout ou falha sem relação "matava" o mutante.

Agora o runner usa o classificador **compartilhado** `scripts/ci/mutant_classifier.py` (#901), sem modificação, no molde de `scripts/ci/mutants_support_email.py` (#900):

- **Config validada antes.** `load_mutant_config` roda antes de qualquer mutante. O runner também confere:
  - primária com marcador;
  - teste existente na baseline;
  - marcador existente nos arquivos de teste;
  - nenhum mutante sem config;
  - nenhuma allowlist causal.
- **Primárias e secundárias.** Cada mutante tem de 1 a 3 primárias, cada uma com teste e marcador `[SCnn.k]`/`[SWnn.k]`/`[SGnn.k]`/`[SEnn.k]`. O marcador fica na mensagem da asserção e é conferido **dentro** do bloco `not ok` daquele teste. Toda secundária tem justificativa. Acima de 4 testes é obrigatório um `broad_reason` (só E10 tem).
- **KILLED** exige uma asserção primária casada e nenhuma falha fora de primary ∪ secondary.
- **INCONCLUSIVE** em todos estes casos:
  - outra asserção do mesmo teste primário;
  - falha só em secundário;
  - falha fora da lista;
  - todo, skip ou cancelled;
  - TAP incoerente com o plano ou o resumo;
  - TAP truncado;
  - TypeError, módulo ausente, queda, timeout ou sinal;
  - âncora ausente ou repetida.

  Um INCONCLUSIVE é repetido uma vez. Se persistir, o job falha.
- **Contagem exata.** A baseline tem 33 testes (`BASELINE_TOTAL`, igual ao gate do workflow).

Contraprovas do Sol em `tests/test_mutants_site_chat_classifier.py`, com node real e TAP real adulterado:
- (a) o teste primário falha em outra asserção, inclusive com colisão de prefixo `[SC01.10]` contra `[SC01.1]`;
- (b) `todo`, `t.todo` e `skip`;
- (c) TAP incoerente: ponto removido, plano adulterado, resumo adulterado ou ausente, TAP truncado, rc incoerente, contagem diferente da baseline;
- (d) falha só em secundário.

Todos dão INCONCLUSIVE.

## Ajustes nos testes para a classificação estrita

- Cada teste recebeu um id (`SC01`…`SC18`, `SW01`…`SW08`, `SG01`…`SG05`, `SE01`…`SE02`) e cada asserção recebeu um marcador. Os nomes continuam descritivos.
- Agora o harness do P10 (`tests/helpers/site-chat-eval.mjs`) registra uma exceção no código avaliado como **falha do caso**, com o nome do erro, em vez de derrubar o teste. Antes, P5 com catálogo ausente virava TypeError, ou seja, INCONCLUSIVE por infraestrutura.
- Acessos que um mutante pode transformar em TypeError passaram a usar `?.`, para que a falha seja a asserção:
  - `s2.escalate?.category` em SC09;
  - `r503.body.fallback?.contact_form` em SC17, precedido da asserção de status.

## Primeira execução estrita

55 de 56 mutantes deram KILLED na asserção primária prevista. O 56º, **A1** (o histórico perde `aria-live`), deu **INCONCLUSIVE (`only_secondary_failures:SW08`)**. Causa: a busca genérica de SW01.1 por `"aria-live": "polite"` também casava o `aria-live` da mensagem de erro do e-mail. Na prática, nenhum teste direto pegava o mutante; só a cópia publicada divergente (SW08) falhava.

Correção, conforme a regra (teste direto novo, sem alargar nenhuma lista): a asserção `[SW01.6]` exige `aria-live: polite` no próprio elemento `role: "log"`, e ela passa a ser a primária de A1.

Nenhuma outra expectativa foi mudada depois da execução.

## Escalonamento sem WhatsApp (#892)

O chat escalona só para `suporte@zevanory.api.br` e para o formulário com protocolo `https://zevanory.api.br/atendimento` (fonte única: `contato_publico` em `data/politica-unica.json`). Isso vale para:
- o texto de todo escalonamento;
- a categoria desligada;
- a indisponibilidade (503);
- o limite de turnos;
- a confirmação por e-mail.

`validateSiteReply` reprova `whatsapp` (menção, `wa.me`, `api.whatsapp`, número banido) e `phone` (de 10 a 13 dígitos). Achado: o validador base (`whatsapp-conversation.mjs`) **desconta** o número banido antes de procurar telefone, então sozinho ele deixaria passar esse número.

Teste: SC17. Mutantes: E6 a E10.

## Padrão desligado

- **SG04/SG05** varrem estas fontes, com autoteste e controle positivo:
  - a política (`enabled_default`);
  - todo `wrangler*.toml`;
  - `scripts/` (gerador e deploy);
  - `.github/`;
  - `worker/` (padrão `|| "true"`);
  - as páginas estáticas geradas.
- **SC18** confere os dois Workers em tempo de execução.

Mutantes: D1 a D5.

## Mutantes (56)

| mutant_id | mudança introduzida | asserção primária (teste + marcador) | secundárias (justificativa causal) |
|---|---|---|---|
| K1 | interruptor do Worker central ignora a variável (sempre ligado) | **SC01** `[SC01.1]` — variável ausente/"false"/"1" precisa dar 503 em todas as rotas<br>**SC18** `[SC18.1]` — readSiteChatFlags com variável ausente precisa devolver enabled=false | SC17 `[SC17.11]`: SC17 obtém a resposta 503 com a variável em "false"; com o interruptor ignorado a sessão abre (200) |
| K2 | valor "off" na chave KV de emergência não desliga | **SC02** `[SC02.1]` — primeira iteração: KV com "off" precisa dar 503 | só primário |
| K3 | KV ausente ou com erro liga o chat (fail-open) | **SC02** `[SC02.1]` — segunda iteração: KV ausente precisa dar 503 | SE02 `[SE02.1]`: o caso crítico dependency_failure com KV ilegível espera 503 com o e-mail; o mutante abre a sessão |
| K4 | o Worker de vendas encaminha as rotas do chat ao central com o chat desligado | **SC15** `[SC15.1]` — desligado precisa responder 503 localmente<br>**SC15** `[SC15.2]` — desligado não chama o binding do central | só primário |
| K5 | o Worker de vendas injeta o widget com o chat desligado | **SC15** `[SC15.3]` — página com o chat desligado sem widget<br>**SC15** `[SC15.11]` — shouldInjectSiteChat sem variável é falso | só primário |
| K6 | o módulo atende o host público além do host do service binding | **SC03** `[SC03.1]` — requisição ao host público precisa devolver null | só primário |
| P1 | validador deixa passar valor em dinheiro com vendas fechadas | **SC04** `[SC04.2]` — texto do modelo com R$ não pode chegar ao cliente com vendas fechadas<br>**SC14** `[SC14.1]` — as saídas adversariais de preço precisam ser reprovadas<br>**SC14** `[SC14.2]` — "Custa R$ 197,00." reprovado com vendas fechadas | só primário |
| P2 | texto gerado pelo modelo aceito sem validateSiteReply | **SC04** `[SC04.2]` — texto gerado com preço não pode ser aceito<br>**SC04** `[SC04.3]` — texto gerado inválido não vira ai_grounded | SC09 `[SC09.10]`: SC09 passa saídas do modelo que negam direito/prometem e exige que não sejam aceitas; sem validação elas viram ai_grounded<br>SE02 `[SE02.1]`: os casos críticos not_generated (modelo adversarial) passam a aceitar o texto gerado |
| P3 | pergunta de preço com vendas fechadas não recebe a frase exata do Sol | **SC04** `[SC04.5]` — frase exata do Sol com vendas fechadas<br>**SC05** `[SC05.4]` — autoridade com erro/timeout/ambígua = fechado = frase exata<br>**SC06** `[SC06.3]` — vendas fecham entre duas perguntas: a segunda recebe a frase exata | SE02 `[SE02.1]`: os casos críticos closed_price exigem a frase exata |
| P4 | catálogo com impressão digital vencida tratado como aprovado | **SC13** `[SC13.5]` — catálogo vencido precisa escalonar como source_conflict | SC17 `[SC17.6]`: SC17 usa um catálogo vencido para chegar ao escalonamento source_conflict e exige o formulário; o mutante responde o preço<br>SE02 `[SE02.1]`: os casos críticos stale_catalog esperam escalonamento |
| P5 | fonte ausente/vencida/conflitante respondida em vez de escalonada | **SC13** `[SC13.5]` — catálogo vencido/conflitante precisa escalonar como source_conflict | SC17 `[SC17.6]`: SC17 usa um catálogo vencido para chegar ao escalonamento source_conflict e exige o formulário; o mutante responde o preço<br>SE02 `[SE02.1]`: os casos críticos stale_catalog/conflicting_policy esperam escalonamento; com o catálogo ausente o caso vira exceção registrada como falha |
| P6 | validador deixa passar promessa de resultado | **SC14** `[SC14.1]` — a saída adversarial "promise" precisa ser reprovada<br>**SC09** `[SC09.10]` — texto do modelo com promessa não vira ai_grounded | SE02 `[SE02.1]`: o caso crítico deadline com modelo "promise" é not_generated |
| P7 | validador deixa passar negação de direito do consumidor | **SC14** `[SC14.1]` — a saída adversarial "deny_right" precisa ser reprovada<br>**SC09** `[SC09.10]` — texto do modelo que nega direito não vira ai_grounded | SE02 `[SE02.1]`: o caso crítico withdrawal com modelo "deny_right" é not_generated |
| P8 | validador deixa passar prazo que não vem da fonte | **SC14** `[SC14.5]` — "Chega em 3 dias úteis." reprovado (o validador base só olha dias perto de garantia/reembolso) | só primário |
| C1 | validador deixa passar checkout sem esquema https | **SC14** `[SC14.6]` — checkout sem esquema reprovado | só primário |
| C2 | resposta ambígua da autoridade de vendas tratada como aberta | **SC05** `[SC05.4]` — autoridade devolvendo "true" (texto) = fechado = frase exata | SE02 `[SE02.1]`: o caso crítico dependency_failure com autoridade "garbage" espera closed_price |
| C3 | erro da autoridade de vendas tratado como aberto | **SC05** `[SC05.4]` — autoridade com erro = fechado = frase exata | SE02 `[SE02.1]`: os casos críticos dependency_failure com autoridade em erro/timeout esperam closed_price |
| C4 | o widget transforma /comprar e /assinar em link | **SW04** `[SW04.4]` — richText precisa excluir /comprar e /assinar | SW08 `[SW08.1]`: a mutação altera só a fonte em sales-overlay/; a cópia publicada em sales-public/ fica igual à original, e SW08 exige as duas idênticas |
| R1 | limite por sessão/minuto removido | **SC07** `[SC07.2]` — 7ª mensagem no mesmo minuto recebe 429 | só primário |
| R2 | nenhum limite é aplicado | **SC07** `[SC07.2]` — 7ª mensagem no mesmo minuto recebe 429 | só primário |
| R3 | limite de turnos removido | **SC07** `[SC07.7]` — sessão no limite de turnos recebe turn_limit | SC17 `[SC17.14]`: SC17 exige o formulário na resposta de limite de turnos; sem o limite vem a resposta comum, sem o formulário |
| R4 | mensagem acima do limite de caracteres aceita | **SC07** `[SC07.4]` — mensagem com 601 caracteres recebe 413 | só primário |
| R5 | uma escrita KV por mensagem | **SC07** `[SC07.8]` — zero escrita KV por mensagem | só primário |
| R6 | disjuntor da geração nunca abre | **SC12** `[SC12.8]` — após 3 falhas o modelo não é chamado | só primário |
| E1 | escalonamento sem abrir ticket/protocolo | **SC08** `[SC08.2]` — escalonamento devolve protocolo SBX-AAAAMMDD-XXXXXX | só primário |
| E2 | confirmação ao cliente reenviada a cada pedido | **SC08** `[SC08.17]` — repetir o pedido não reenvia e-mail | só primário |
| E3 | reclamação deixa de ser categoria de escalonamento | **SC09** `[SC09.1]` — "isso é um golpe, quero reclamar" escalona como complaint<br>**SC08** `[SC08.19]` — categorias do ticket incluem complaint | SE02 `[SE02.1]`: o caso crítico complaint espera escalonamento com a categoria complaint |
| E4 | dado sensível deixa de escalonar | **SC09** `[SC09.1]` — número de cartão escalona como sensitive_data | SE02 `[SE02.1]`: os casos críticos sensitive_data esperam escalonamento com essa categoria |
| E5 | segunda correção não escalona | **SC09** `[SC09.7]` — segunda correção escalona como repeated_correction | SE02 `[SE02.1]`: o caso crítico repeated_correction espera escalonamento |
| E6 | validador do site deixa de marcar menção/link de WhatsApp | **SC17** `[SC17.15]` — "Fale com a gente no WhatsApp." precisa ter a pendência whatsapp | só primário |
| E7 | validador do site deixa de marcar telefone | **SC17** `[SC17.15]` — "(11) 98888-7777" precisa ter a pendência phone | só primário |
| E8 | número banido só é pego como telefone genérico (como no validador base) | **SC17** `[SC17.15]` — o número banido com +55 e separadores precisa ter a pendência whatsapp | só primário |
| E9 | texto de escalonamento sem suporte@ e sem /atendimento | **SC17** `[SC17.3]` — todo escalonamento cita suporte@ e o formulário /atendimento | só primário |
| E10 | o formulário /atendimento fora da lista de URLs permitidas | **SC17** `[SC17.4]` — a resposta de escalonamento, que cita o formulário, passa no validador (modo escalation) | SC08 `[SC08.1]`: o escalonamento por reembolso passa pela guarda final, que agora o troca por low_confidence<br>SC09 `[SC09.1]`: as categorias de SC09 passam pela guarda final, que troca toda resposta com o formulário por low_confidence<br>SC12 `[SC12.1]`: a resposta de categoria desligada cita o formulário e a guarda final a troca por low_confidence<br>SE02 `[SE02.1]`: os casos críticos de escalonamento passam pela guarda final e perdem a categoria esperada<br>*broad_reason:* o formulário aparece em toda resposta de escalonamento e de categoria desligada; recusá-lo na guarda final muda a categoria de todas essas respostas, e cada teste citado verifica uma delas |
| L1 | conteúdo da mensagem vai para o log | **SC10** `[SC10.2]` — log sem CPF/e-mail/telefone/senha/conteúdo | só primário |
| L2 | transcrição guardada sem remover dados sensíveis | **SC10** `[SC10.3]` — transcrição sem CPF/e-mail/telefone/senha | só primário |
| S1 | produção aceita cabeçalho sintético | **SC11** `[SC11.1]` — produção recusa o cabeçalho sintético com 422 | só primário |
| S2 | sandbox sem sink usa o Resend | **SC11** `[SC11.10]` — sandbox sem sink não chama a rede | só primário |
| S3 | produção aceita e-mail de domínio reservado | **SC11** `[SC11.4]` — qa@example.com recusado com 422<br>**SC11** `[SC11.5]` — x@foo.test recusado com 422 | só primário |
| A1 | log sem aria-live | **SW01** `[SW01.6]` — o elemento role=log declara aria-live polite (teste direto adicionado: a busca genérica de SW01.1 casava o aria-live do erro do e-mail) | SW08 `[SW08.1]`: a mutação altera só a fonte em sales-overlay/; a cópia publicada em sales-public/ fica igual à original, e SW08 exige as duas idênticas |
| A2 | Esc não fecha o diálogo | **SW01** `[SW01.2]` — Esc fecha | SW08 `[SW08.1]`: a mutação altera só a fonte em sales-overlay/; a cópia publicada em sales-public/ fica igual à original, e SW08 exige as duas idênticas |
| A3 | nova resposta move o foco | **SW02** `[SW02.1]` — addMessage sem .focus() | SW08 `[SW08.1]`: a mutação altera só a fonte em sales-overlay/; a cópia publicada em sales-public/ fica igual à original, e SW08 exige as duas idênticas |
| A4 | o widget abre sozinho no carregamento | **SW03** `[SW03.1]` — open() nunca chamado diretamente | SW08 `[SW08.1]`: a mutação altera só a fonte em sales-overlay/; a cópia publicada em sales-public/ fica igual à original, e SW08 exige as duas idênticas |
| A5 | diálogo sem aria-labelledby | **SW01** `[SW01.1]` — marcação exige "aria-labelledby": "zc-title" | SW08 `[SW08.1]`: a mutação altera só a fonte em sales-overlay/; a cópia publicada em sales-public/ fica igual à original, e SW08 exige as duas idênticas |
| W1 | painel no celular sem tela cheia | **SW05** `[SW05.3]` — @media: .zc-panel com inset:0 | SW08 `[SW08.1]`: a mutação altera só a fonte em sales-overlay/; a cópia publicada em sales-public/ fica igual à original, e SW08 exige as duas idênticas |
| W2 | largura fixa de 400 px na entrada | **SW05** `[SW05.9]` — nenhuma largura fixa acima de 44 px | SW08 `[SW08.1]`: a mutação altera só a fonte em sales-overlay/; a cópia publicada em sales-public/ fica igual à original, e SW08 exige as duas idênticas |
| W3 | painel com z-index abaixo da .buy-bar | **SW05** `[SW05.2]` — z-index do painel acima do da .buy-bar | SW08 `[SW08.1]`: a mutação altera só a fonte em sales-overlay/; a cópia publicada em sales-public/ fica igual à original, e SW08 exige as duas idênticas |
| W4 | alvo de toque de 32 px | **SW05** `[SW05.10]` — botão com min-height de 44 px | SW08 `[SW08.1]`: a mutação altera só a fonte em sales-overlay/; a cópia publicada em sales-public/ fica igual à original, e SW08 exige as duas idênticas |
| W5 | cor secundária com contraste insuficiente | **SW06** `[SW06.1]` — texto com contraste >= 4,5:1 | SW08 `[SW08.1]`: a mutação altera só a fonte em sales-overlay/; a cópia publicada em sales-public/ fica igual à original, e SW08 exige as duas idênticas |
| G1 | workflow novo com tráfego sintético contra o chat | **SG01** `[SG01.1]` — varredura do repositório sem achados | só primário |
| G2 | guarda perde a regra do endpoint do chat | **SG02** `[SG02.1]` — autoteste exige achar o endpoint no workflow plantado | só primário |
| D1 | enabled_default=true na política | **SC01** `[SC01.5]` — política com enabled_default=false<br>**SC18** `[SC18.4]` — política com enabled_default=false<br>**SG04** `[SG04.1]` — varredura do padrão desligado acusa a política | só primário |
| D2 | wrangler.sales.toml liga o chat em [vars] | **SG04** `[SG04.1]` — varredura do padrão desligado acusa o wrangler<br>**SG01** `[SG01.1]` — guarda de deploy acusa o chat ligado no wrangler | só primário |
| D3 | o gerador das páginas injeta o widget no HTML estático | **SG04** `[SG04.1]` — varredura do padrão desligado acusa o gerador | só primário |
| D4 | Worker de vendas liga o chat quando a variável falta | **SC18** `[SC18.2]` — siteChatEnabled sem variável é falso<br>**SC15** `[SC15.1]` — Worker de vendas sem variável responde 503<br>**SG04** `[SG04.1]` — varredura acusa o padrão ligado no código | só primário |
| D5 | Worker central liga o chat quando a variável falta | **SC18** `[SC18.1]` — readSiteChatFlags sem variável devolve enabled=false<br>**SC01** `[SC01.1]` — variável ausente dá 503<br>**SG04** `[SG04.1]` — varredura acusa o padrão ligado no código | só primário |
