# P12 Entrega digital idempotente: ensaio sintético de entrega

**Rótulo da evidência (roteiro v4.9.1, seção 6.4): SINTÉTICA.** Teste local e de CI, com fetch proibido, sem
produção, sem Hotmart real, sem segredo real e sem compra ou reembolso fabricado. Pela seção 6.4, esta evidência
dá no máximo homologação de engenharia. Ela **não** conta como ENSAIO EM PRODUÇÃO nem como OPERACIONAL, e não
atribui `HOMOLOGADO_075` sozinha (seção P1.4: faltam os critérios 7, 9 a 12).

- Data do ensaio: 07/11/2026. Base: `gh-pages@9a6f1a86`. O SHA do head está no PR.
- Reprodução: `node --test tests/p12-entrega-ensaio.test.mjs` (18 testes) e
  `python3 scripts/ci/mutants_p12_entrega.py` (28 mutantes). O gate só de PR é `.github/workflows/p12-entrega-ensaio.yml`.
- Decisão vigente: **DEC-06.** Depois da aprovação do pagamento, a Hotmart entrega o produto integral imediatamente
  na área de compras (Minhas compras). Não há retenção de 192 h (o modelo B foi revogado). A ZEVANORY não envia
  e-mail de produto. Ela **registra** a entrega e o estorno a partir do postback autenticado (`hottok`).

## 1. Contrato do motor (critério 1 da seção P1.4)

| Item | Definição |
|---|---|
| Escopo | Postback Hotmart dos 5 produtos v1.3.4 (IA na Prática, Vendas na Prática, Lucro & Caixa, Combo IA + Vendas e Negócio Completo): rota `/api/webhooks/hotmart` → `routeHotmartNc011` → `handleDigitalHotmartNc012` → `recordHotmartSale` (resumo de vendas no KV) + `emitActivity` (atividade `delivery_sent` ou `refund_requested`) |
| Entradas | `POST` JSON v2 da Hotmart com `x-hotmart-hottok`; eventos `PURCHASE_APPROVED`, `PURCHASE_COMPLETE`, `PURCHASE_REFUNDED`, `PURCHASE_CHARGEBACK`, `PURCHASE_PROTEST`, `PURCHASE_CANCELED` e os demais da lista permitida |
| Saídas | `200` com `duplicate` verdadeiro ou falso; `401` para `hottok` errado ou ausente; `422` para evento inválido; `503` para configuração ausente ou registro **não gravado** (a Hotmart reenvia) |
| Estados por transação e resultado | ausente → evento imutável gravado (`zpc:sales:v1:ev:<hash>:<desfecho>:<evento>`, TTL 400 dias). Não há estado intermediário: a chave existe ou não existe. O desfecho `approved` vale para APPROVED e COMPLETE; `reversed` vale para estorno, contestação e protesto (seção NC-989-01) |
| Invariante | Cada transação aprovada é contada **exatamente uma vez** no registro, e gera exatamente uma atividade de entrega. Cada reversão é contada no máximo uma vez. Nenhum e-mail, nome ou transação em claro fica no registro |
| Dependências | KV `ZEVANORY_PRIVATE_ARTIFACTS`. **Não** usa Neon, Resend nem rede |
| Concorrência | **Resolvida pela NC-989-01.** O resumo deixou de ser fonte de verdade: é uma projeção recalculada da listagem dos eventos imutáveis. Nenhuma gravação depende de uma leitura anterior do resumo |

## 2. Defeitos encontrados e corrigidos neste PR

| # | Defeito na base | Efeito | Correção | Prova |
|---|---|---|---|---|
| D1 | `recordHotmartSale` gravava o marcador da transação como concluído **antes** do resumo | Uma falha na gravação do resumo (cota de KV ou erro transitório) devolvia 503. A reentrega da Hotmart virava `duplicate` e a venda **sumia** do registro (entrega faltante no registro) | Primeira versão: marcador em duas fases. **Substituída pela NC-989-01:** a única gravação da verdade é o evento imutável; falha nele devolve 503, e a reentrega grava o mesmo par chave/valor | E3, E4, E13, mutantes M27 e M32 |
| D2 | A leitura do resumo era envolvida em `try/catch`, que transformava o erro em `null` | Com o KV fora só na leitura, o resumo era **recriado vazio por cima** do existente: todas as vendas anteriores se perdiam | O erro de leitura propaga e o handler devolve 503. Depois da NC-989-01, uma listagem que falha também propaga, e a projeção não é gravada (nunca a partir de lista vazia ou parcial) | E5, M25 e M33 |
| D3 | A atividade de entrega e de estorno era gravada com `.catch(() => null)`, e o postback respondia 200 | Com falha no KV, a Hotmart não reenviava e o registro de entrega ficava **faltante** | Atividade não confirmada (nem gravada, nem duplicata) devolve 503. A reentrega é idempotente | E6, M05–M07 |

Gate tocado: `worker/sales-ledger.mjs` e `worker/cp-nc012-digital-hotmart.mjs` casam com `worker/*.mjs`. O merge
dispara `central-production-deploy` (MERGE_CLASSE_B). Este PR não autoriza merge nem deploy.

## 3. Matriz de cenários (estados × transições × falhas) e resultado

| Caso | Transição ou falha | Esperado | Resultado |
|---|---|---|---|
| E1 | APPROVED → reentrega idêntica → COMPLETE | 1 venda, 1 atividade de entrega, nenhum fetch, sem dado pessoal | PASS |
| E2 | APPROVED → REFUNDED ×2 → CHARGEBACK; CANCELED sem aprovação | estorno contado uma vez, contestação posterior não reverte de novo, cancelamento sem entrega | PASS |
| E3 | falha na gravação do evento imutável → reentrega | 503, depois 200 aplicado; 1 venda (zero faltante) | PASS |
| E4 | falha depois do evento e antes da projeção → reentregas | 200 (a verdade está gravada); a reentrega é duplicata; 1 venda (zero duplicado) | PASS |
| E5 | leitura que falha (KV fora); depois listagem que falha | 503 sem gravar; com a listagem fora o resumo anterior fica intacto (não vazio); o recomputo seguinte soma | PASS |
| E6 | falha na gravação da atividade de entrega e de estorno | 503; a reentrega grava exatamente uma | PASS |
| E7 | Neon fora (`DATABASE_URL` sintético inalcançável) | 200 sem nenhuma chamada de rede | PASS |
| E8 | `hottok` errado ou ausente; segredo não configurado | 401, 401, 503; nada gravado | PASS |
| E9 | indisponibilidade parcial (12-B.4), na seção 4 | nenhuma lacuna cenário × direito; caminhos informados nas 5 páginas de venda; contraprovas | PASS |
| E10 | entrega mensal (Conteúdo Pronto): webhook × cron, 2 ciclos, resultado ambíguo | uma saída por ciclo com a chave `<id>/delivery/<ciclo>`; ambíguo espera conciliação | PASS |
| E11 | onboarding com microvitória (seção 5) | flag exata, mesmo plano para APPROVED e COMPLETE, prazo ≤ 24 h, cancelamento por estorno ou descadastro, texto sem oferta, **remetente nunca chamado** | PASS |
| E12 | rota oficial com a flag de 192 h ligada no ambiente | vai ao registro digital (DEC-06), nunca ao razão de 192 h | PASS |
| E13 | NC-989-01: 2 execuções concorrentes, 5 cenários, **todos** os entrelaçamentos, falha antes e depois de cada gravação, reentrega | contagem = transações únicas; resumo e conjunto de eventos idênticos aos da sequência | PASS (2.940 entrelaçamentos) |
| E14 | NC-989-01: caminho completo (evento + projeção), 2 transações, **todos** os entrelaçamentos, com e sem falha da projeção | sem 503; projeção nunca vazia nem acima da verdade; o postback seguinte a corrige | PASS (25.740 entrelaçamentos) |
| E15 | NC-989-01: propriedade, semente fixa `0x98901`, 1.000 casos de 2 a 5 entregas misturadas, falha sorteada | resumo = sequência; projeção nunca acima da verdade | PASS |
| E16 | NC-989-01: retenção e tamanho | 399 dias ainda conta e deduplica; TTL ≥ 400 dias; 2.500 transações com list paginado | PASS |
| E17 | NC-989-01: migração do resumo legado | base congelada gravada antes da 1ª projeção; transação legada não conta duas vezes | PASS |
| E18 | NC-989-01: 3 entregas simultâneas pelo handler | 1 venda, 1 evento, 1 atividade por `sourceKey` | PASS |

Contagens: ensaio **18/18** (zero pulados); mutantes **28/28 KILLED** (0 SURVIVED, 0 INCONCLUSIVE), com expectativas
em `scripts/ci/mutants_p12_entrega_allow.json` (M05 a M16 e M18 escritas antes de rodar; M19 a M33 na seção NC-989-01);
suíte do manifesto no PR.

## 4. Entrega e arrependimento durante indisponibilidade parcial (seção 12-B.4)

Fonte: `data/p12-degradacao-12b4.json`, avaliada por `scripts/ci/p12_degradacao.mjs` (E9). Um caminho só conta se o
**recebimento** do pedido não depende do componente que caiu. O pedido ganha carimbo de horário, e o prazo legal
conta da solicitação. "Tratamento diferido" quer dizer que o pedido foi recebido e carimbado, e que a ZEVANORY o
trata quando o componente voltar.

| Cenário | Acesso ao conteúdo | Avisar falha de entrega | Arrependimento 7 dias |
|---|---|---|---|
| site_fora | `hotmart_minhas_compras`, `suporte_email` | `suporte_email`, `atendimento_formulario` | `hotmart_reembolso`, `suporte_email`, `atendimento_formulario` |
| worker_fora | `hotmart_minhas_compras`, `suporte_email` (tratamento diferido) | `suporte_email` (tratamento diferido) | `hotmart_reembolso`, `suporte_email` (tratamento diferido) |
| neon_fora | `hotmart_minhas_compras`, `suporte_email` (tratamento diferido) | `suporte_email` (tratamento diferido) | `hotmart_reembolso`, `suporte_email` (tratamento diferido) |
| kv_fora | `hotmart_minhas_compras`, `suporte_email` | `suporte_email`, `atendimento_formulario` | `hotmart_reembolso`, `suporte_email`, `atendimento_formulario` |
| email_fora | `hotmart_minhas_compras` | `atendimento_formulario` (tratamento diferido) | `hotmart_reembolso`, `atendimento_formulario` (tratamento diferido) |
| plataforma_fora | `suporte_email` (envio manual do arquivo) | `suporte_email`, `atendimento_formulario` | `suporte_email`, `atendimento_formulario` |

Informação ao cliente: as 5 páginas de venda publicadas (`sales-public/<produto>.html`) citam "Minhas compras",
"refund.hotmart.com", "suporte@zevanory.api.br" e "/atendimento" (E9.8).

### Procedimento de recuperação por modo de falha

| Modo de falha | O que acontece | Recuperação |
|---|---|---|
| KV fora (gravação ou leitura) | O postback devolve 503. A entrega na Hotmart não depende da ZEVANORY | A Hotmart reenvia o postback, e o registro conclui sem duplicar (E3 a E6). Se a queda passar do reenvio da Hotmart **[NÃO VERIFICADO: calendário de reenvio]**, o proprietário reconcilia pelo painel da Hotmart (seção 7.1, H-3) |
| Neon fora | O registro Hotmart segue normal (E7). O suporte@ recebe no Resend e encaminha depois | Depois da queda, conferir no Resend Receiving os e-mails do período e tratar cada pedido com o prazo contado do recebimento |
| Worker fora | Nenhum postback é registrado e o suporte@ não encaminha. A entrega e o reembolso na Hotmart seguem | Reenvio da Hotmart e do Resend. Na volta, reconciliar as vendas pelo painel da Hotmart e conferir o Resend Receiving |
| E-mail (Resend) fora | A Hotmart segue, e o `/atendimento` grava o protocolo no PostgreSQL antes de qualquer envio | O dreno horário envia as confirmações pendentes (worker/atendimento.mjs) |
| Hotmart fora | Sem acesso à área de compras | O suporte responde ao comprador e envia o arquivo da versão vendida (v1.3.4, conferido pelo `SHA256SUMS`) ao e-mail informado na compra. O arrependimento pedido por e-mail ou formulário vale da data do pedido e é executado na Hotmart quando ela voltar |
| Site fora | As páginas não abrem | Os canais seguem informados no e-mail de confirmação da Hotmart **[NÃO VERIFICADO: conteúdo desse e-mail na conta real]** |

## 5. "Entrega mensal sem chave de idempotência" (situação de 24/10, seção 5.1-H)

A lacuna era da entrega mensal da assinatura Conteúdo Pronto. No código atual, a única rota da assinatura é o
Durable Object (`worker/cp-durable-ledger.mjs`). A saída de entrega é única por ciclo (`cycle UNIQUE`) e carrega
a chave do provedor `cp-do:<id>/delivery/<ciclo>`, derivada do ciclo e não do evento. Webhook e cron do mesmo
ciclo produzem uma única entrega (E10, mutante M13). Resultado ambíguo fica `uncertain` e nunca reenvia sozinho.
**A lacuna está fechada no código candidato.** A assinatura continua não ligada à venda: a outbox do Resend está
bloqueada, e a página de pacote responde 503. Pela DEC-06, ela fica fora do escopo dos 5 produtos da Hotmart.
Portanto, a lacuna não bloqueia o GO do VC-H. Ligar a assinatura exige um ensaio próprio.

## 6. Onboarding com microvitória em até 24 h (seções 5 e 12-B.2)

`worker/onboarding-microvitoria.mjs` é um módulo **puro e inativo**. Nenhuma rota o importa, ele não faz fetch e não
grava nada.

- **Flag:** `ONBOARDING_MICROVITORIA_ENABLED` liga só com `"true"` exato. Mesmo ligada, a constante de código
  `ONBOARDING_SEND_ENABLED = false` impede o envio, e o remetente injetado nunca é chamado (E11.25 e E11.26, M09).
- **Janela:** a mensagem fica elegível 2 h depois da entrega (aprovação na Hotmart) e vence em 24 h. Depois disso,
  vira falta registrada com alerta, nunca envio atrasado. Estorno, contestação, cancelamento ou descadastro
  cancelam. A chave de idempotência é por pedido e etapa (`onb-mv/v1/<hash>/mv1`), e APPROVED e COMPLETE geram
  o mesmo plano.
- **Base legal registrada (12-B.5):** legítimo interesse (LGPD art. 7º, IX), **a mesma** que a política de
  privacidade publicada declara para "Acompanhamento pós-compra", com descadastro em um clique. O teste E11.28
  confere essa correspondência contra `sales-public/privacidade.html` (M18).
- **Conteúdo:** uma ação concreta por produto, usando só arquivos que a página de venda promete. O texto não tem
  chamada de compra, preço, próximo produto nem promessa de ganho (E11.22, verificado por `hasCheckoutCta` e
  `bannedPolicyHits`).
- **Privacidade:** o plano carrega só o hash da transação. O identificador bruto é recusado (E11.14).

**O que falta para ligar** (fora deste PR): (1) ligação `product.id` da Hotmart → produto, configurada pelo
proprietário; (2) agendador e marcador por pedido; (3) conferência do texto de cada microvitória contra o material
v1.3.4 (P24); (4) decisão do proprietário e nova auditoria para trocar a constante de envio.

## 7. O que este ensaio NÃO prova

- Não prova o caminho real da Hotmart (critério 7 da seção P1.4): entrega na área de compras, reenvio de postback e
  revogação de acesso no estorno. Isso exige uma compra de teste **autorizada pelo proprietário** (nunca uma compra
  fabricada).
- Não é ENSAIO EM PRODUÇÃO nem OPERACIONAL (seção 6.4). A recuperação está escrita e simulada, mas não foi
  exercitada em produção com tempos medidos (critério 9).
- A concorrência sobre o resumo foi resolvida sem CAS (seção NC-989-01). Os resíduos que sobram estão listados lá.
- Falta o parecer independente sobre o SHA (critério 10), o readback da configuração efetiva (critério 11) e o
  registro das autorizações técnicas (critério 12).

## NC-989-01 (contra-auditoria do PR #989): leitura-modificação-gravação sem exclusão mútua

**Achado.** `recordHotmartSale` lia e gravava o resumo `zpc:sales:v1:summary` em passos separados no KV. O KV do
Cloudflare não tem compare-and-set. Duas entregas simultâneas, do mesmo webhook ou de webhooks diferentes, podiam
ler o mesmo estado, e uma sobrescrevia a outra. O conjunto `applied` tinha no máximo 2.000 entradas, e nada provava
a deduplicação durante os 400 dias de retenção.

### Desenho escolhido: eventos imutáveis e resumo derivado

1. **Fonte de verdade.** Cada postback grava uma única chave imutável
   `zpc:sales:v1:ev:<sha256("hotmart:"+transação)[0:32]>:<desfecho>:<evento>`, com TTL de 400 dias
   (`SALES_EVENT_TTL_DAYS`). O valor e o metadata (os mesmos fatos sem dado pessoal de antes) saem **só do payload**:
   a data vem de `approved_date` ou `order_date`, senão de `creation_date` do postback, senão fica sem data. O relógio
   do servidor nunca entra. A mesma entrega gera o mesmo par chave/valor. Uma gravação concorrente ou repetida grava
   valores idênticos (last-writer-wins entre iguais), então o conteúdo final do prefixo é a **união** das entregas
   bem-sucedidas, em qualquer entrelaçamento. A reentrega de um evento que já existe não regrava nada e não estende o TTL.
2. **Resumo = projeção.** `deriveSalesSummary` lista o prefixo com `kv.list` paginado (1.000 por página, sem limite
   total) e agrupa por transação+desfecho. Resultado: 1 venda por transação aprovada e 1 reversão por transação. O
   representativo vem de uma precedência fixa (APPROVED > COMPLETE; REFUNDED > CHARGEBACK > PROTEST, porque o protesto
   é provisório), nunca da ordem de chegada. Então o resumo é uma função pura do **conjunto** de eventos. A contagem é
   o número de grupos únicos. Não existe mais `applied` nem limite de 2.000.
3. **Quando a projeção é gravada.** (a) No próprio postback, como melhor esforço. Se a projeção falhar, o postback
   **não** devolve 503, porque a verdade já está gravada e o registro de entrega não pode depender da cota de list.
   (b) A cada hora, em `/api/internal/funnel/run`. O snapshot da central chama essa rota logo antes de ler o resumo
   (`beat.tasks.sales_summary`). Se uma projeção for gravada a partir de uma listagem anterior à gravação de outra
   entrega, ela fica defasada só até o postback ou o recomputo seguinte. Ela nunca conta a mais (E14 e E15).
4. **Correções aprovadas mantidas.** Venda não some: a falha na gravação do evento devolve 503, e a reentrega grava
   (E3, E13 com falha "antes"). KV fora: a leitura que falha propaga como 503 sem gravar nada, e a listagem que falha
   nunca grava um resumo vazio ou parcial (E5). Atividade não gravada continua devolvendo 503 (E6, sem mudança).
5. **Legado (resumo anterior a esta mudança).** No primeiro recomputo, o resumo atual, que ainda não tem `source`, é
   copiado byte a byte para `zpc:sales:v1:legacy-baseline` **antes** de a projeção sobrescrevê-lo. A cópia é
   idempotente: recomputos concorrentes copiam o mesmo valor. Depois disso, ele entra como base congelada. O marcador
   antigo `zpc:sales:v1:txn:<ref>:<desfecho>` = `"1"` faz a reentrega de uma transação já contada virar duplicata (E17).
   Um postback sem nenhum evento e sem resumo anterior não grava nada. Assim, `hotmartStatus` continua `no_events`
   ("não prova zero").

**Por que não um Durable Object como serializador.** O Worker já tem código de DO (`CP_SUBSCRIBER_DO`, Conteúdo
Pronto), mas a configuração de deploy do Worker principal não está neste repositório. Um DO de vendas exigiria uma
classe nova, uma migração e um binding. O binding não conta no orçamento de vars, mas a mudança de deploy não pode
ser verificada aqui. Ele também poria um componente a mais no caminho da entrega (12-B.4). As chaves imutáveis dão
uma prova mais forte e por construção: o estado é a união de gravações deterministas, e a projeção é uma função pura
desse conjunto. Não há mudança de infraestrutura, Neon nem D1, e o diário P20 (#987/#988) não foi tocado.

### Custo de cota (KV, plano free: 1.000 list, 1.000 gravações e 100.000 leituras por dia)

| Operação | Antes | Agora |
|---|---|---|
| Postback novo | 2 leituras, 3 gravações (marcador pendente, resumo, marcador concluído) | 4 a 6 leituras (marcador legado, 1 a 3 eventos do grupo, resumo, base), 2 gravações (evento e projeção), `ceil(N/1000)` list |
| Reentrega de evento já gravado | 2 leituras, 1 gravação | as mesmas leituras, 1 gravação (projeção), `ceil(N/1000)` list |
| Recomputo horário (`funnel/run`) | — | 2 leituras, 1 gravação, `ceil(N/1000)` list; 24 por dia |

N é o número de eventos retidos (400 dias). Com N ≤ 1.000, o gasto de list por dia é postbacks + 24. Com 100 vendas
por dia (cerca de 200 postbacks, APPROVED + COMPLETE), são cerca de 224 list por dia. Quando N passar de cerca de
3.000, ou o list do dia passar de 50% da cota, desliga-se o recomputo no postback (`refresh: false` no handler) e fica
só o horário. Isso é uma linha no handler e não muda a correção. O backup (`KV_PREFIXES` inclui `zpc:sales:`) passa a
copiar os eventos no lugar dos marcadores antigos, com a mesma ordem de grandeza (1 chave por transação+desfecho).

### Leitores do resumo e ajustes

| Leitor | Uso | Ajuste |
|---|---|---|
| `scripts/audit/command-center-snapshot.mjs` (+ `scripts/audit/funnel-counting.mjs`) | `schema`, `totals`, `byDay`, `bySource`, `byProduct`, `updatedAt` | Nenhum. O esquema `zevanory-sales/v1` foi mantido. Agora `updatedAt` é a hora do recomputo (horário, logo antes do snapshot), e não a da última venda; a hora da última venda está em `lastEventAt`. A métrica `maxAgeHours: 3` deixa de ficar "stale" só por falta de venda. `source` informa a procedência (`derived`, número de eventos, base legada) |
| `worker/data-backup.mjs` | copia o prefixo `zpc:sales:` | Nenhum. Inclui os eventos e a base legada |
| `tests/sales-ledger.test.mjs` | resumo depois de `recordHotmartSale` | KV falso com `list` e metadata; mesmas 3 asserções de contagem |
| `scripts/cp-nc013-regression.test.mjs` | conferia gravação em `zpc:sales:v1:summary` | Agora confere o evento imutável (`zpc:sales:v1:ev:`), que é a fonte. O KV falso desse teste não tem `list` |
| `tests/funnel-counting.test.mjs`, `tests/data-backup.test.mjs`, `tests/content-service.test.mjs` | semeiam ou procuram chaves `zpc:sales:` | Nenhum |

### Provas (tests/p12-entrega-ensaio.test.mjs, E13 a E18)

Agendador controlado: cada `get`, `put` e `list` de cada execução fica suspenso até o agendador escolher qual
operação acontece. A busca em profundidade percorre todas as escolhas. A falha é injetada na N-ésima gravação de uma
execução, **antes** (não grava) ou **depois** (grava e a chamada falha). A rodada seguinte reprocessa as execuções que
falharam (reentrega da Hotmart).

- **E13** (exaustivo, camada da verdade): cenários mesmo webhook 2×, APPROVED+COMPLETE, transações diferentes,
  contestação × estorno e aprovação × estorno. Combinações: sem falha e falha antes/depois na gravação de cada
  execução; **2.940 entrelaçamentos**. Em todos, a contagem é igual ao modelo de transações únicas, e o resumo e o
  conjunto de eventos são idênticos aos da execução em sequência.
- **E14** (exaustivo, caminho completo com projeção): **25.740 entrelaçamentos**, com e sem falha na gravação da
  projeção. Nenhum 503. A projeção intermediária nunca fica vazia nem acima da verdade, e o postback seguinte a corrige.
- **E15** (propriedade, semente fixa): 1.000 casos de 2 a 5 entregas misturadas (6 eventos, 3 transações),
  entrelaçamento e falha sorteados. Em todos, o resumo final é igual ao da sequência.
- **E16**: o evento continua contado e deduplicado com 399 dias, todo evento tem TTL ≥ 400 dias, e 2.500 transações
  são contadas com list paginado (a mais antiga ainda deduplica). Evento sem metadata é lido pelo valor.
- **E17**: migração do legado. **E18**: 3 postbacks simultâneos pelo handler dão 1 venda e 1 atividade por `sourceKey`.

Mutantes novos (M19 a M33, todos KILLED). Os antigos M01 a M04 e M17 foram removidos, porque o código que mutavam
(marcador em duas fases e `applied`) não existe mais.

| Mutante | Regra quebrada | Morto por |
|---|---|---|
| M19 | resumo por leitura-modificação-gravação como fonte (sem evento imutável) | E13.1, E1.4, E3.1 |
| M20 | derivação parte do resumo atual (projeção usada como fonte) | E1.6, E4.8, E14.2 |
| M21 | projeção incremental por leitura-modificação-gravação no postback | E4.5, E14.3 |
| M22 | chave por transação não determinística | E13.1, E1.4, E16.4 |
| M23 | TTL do evento abaixo de 400 dias | E16.2 |
| M24 | contagem de entradas não únicas | E13.1, E1.6 |
| M25 | falha de listagem engolida (projeção vazia ou parcial) | E5.4 |
| M26 | falha da projeção devolve 503 | E4.1, E14.1 |
| M27 | evento gravado só se o grupo for novo (a ordem decide a reversão) | E13.3 (o conjunto final deixa de ser a união) |
| M28 | representativo pela ordem da listagem, não pela precedência | E2.3, E13.1 |
| M29 | marcador legado ignorado | E17.3 |
| M30 | base legada não gravada antes da projeção | E17.2 |
| M31 | paginação do list ignorada | E16.6 |
| M32 | falha de gravação do evento engolida | E3.1, E13.3 |
| M33 | leitura com falha engolida (KV fora sem 503) | E5.1 |

As expectativas de M19 a M33 foram derivadas por raciocínio sobre cada mutação e depois conferidas numa execução.
A primeira execução deu 21 KILLED e 7 INCONCLUSIVE (nenhum SURVIVED). As 7 divergências e o que foi mudado:

- **M06** (antigo): os testes E4 e E18 novos também fazem a reentrega com a atividade já gravada. Foram incluídos como
  secundários.
- **M19, M20 e M22**: essas mutações quebram a contagem em quase todo teste que conta vendas. Os secundários foram
  listados um a um, com `broad_reason`.
- **M21**: eu esperava E14.5, mas o primeiro a falhar é E14.3. O resumo incremental, que não tem `source`, é tomado
  como base legada pelo recomputo e somado de novo aos eventos. Isso é coerente com a regra: qualquer gravação de
  resumo fora da derivação é tratada como legado.
- **M27 e M32**: falha [E13.3] (o conjunto de eventos difere da união das entregas) antes de [E13.1].

Segunda execução: 28/28 KILLED.


### Resíduos declarados

- **Consistência eventual do KV** (até cerca de 60 s entre locais). Duas entregas em locais diferentes podem não ver
  a chave uma da outra. As duas gravam o mesmo valor, e a contagem não muda. A listagem pode atrasar, e a projeção
  fica defasada até o recomputo seguinte. A verdade não é afetada.
- **Mesmo evento com payload diferente** (a Hotmart muda valores ao reenviar o mesmo evento da mesma transação): a
  contagem não muda, e os valores ficam com o último gravado. Não foi observado e não é verificável sem a conta real.
- **Atividade** (`worker/activity-ledger.mjs`, fora desta NC): a chave do evento de atividade inclui o horário. Entregas
  simultâneas podem gerar mais de um evento com o mesmo `sourceKey`, que o consumidor deduplica (E18.3).
- **Rollback para o código anterior**: o código antigo faria leitura-modificação-gravação sobre a projeção, e o campo
  `source` seria mantido. Os incrementos desse período ficariam fora do recomputo seguinte, e o evento imutável não
  existiria. Um rollback desta mudança exige reconciliação pelo painel da Hotmart.
- **Legado**: uma venda que já tinha sumido pelo defeito D1 em produção (marcador `"1"` sem a venda no resumo) continua
  fora da base. A reconciliação é pelo painel da Hotmart (seção 7.1, H-3).
