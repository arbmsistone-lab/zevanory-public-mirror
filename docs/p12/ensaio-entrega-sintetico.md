# P12 Entrega digital idempotente: ensaio sintético de entrega

**Rótulo da evidência (roteiro v4.9.1, seção 6.4): SINTÉTICA.** Teste local e de CI, com fetch proibido, sem
produção, sem Hotmart real, sem segredo real e sem compra ou reembolso fabricado. Pela seção 6.4, esta evidência
dá no máximo homologação de engenharia. Ela **não** conta como ENSAIO EM PRODUÇÃO nem como OPERACIONAL, e não
atribui `HOMOLOGADO_075` sozinha (seção P1.4: faltam os critérios 7, 9 a 12).

- Data do ensaio: 07/11/2026. Base: `gh-pages@9a6f1a86`. O SHA do head está no PR.
- Reprodução: `node --test tests/p12-entrega-ensaio.test.mjs` (22 testes) e
  `python3 scripts/ci/mutants_p12_entrega.py` (39 mutantes). O gate só de PR é `.github/workflows/p12-entrega-ensaio.yml`.
- Decisão vigente: **DEC-06.** Depois da aprovação do pagamento, a Hotmart entrega o produto integral imediatamente
  na área de compras (Minhas compras). Não há retenção de 192 h (o modelo B foi revogado). A ZEVANORY não envia
  e-mail de produto. Ela **registra** a entrega e o estorno a partir do postback autenticado (`hottok`).

## 1. Contrato do motor (critério 1 da seção P1.4)

| Item | Definição |
|---|---|
| Escopo | Postback Hotmart dos 5 produtos v1.3.4 (IA na Prática, Vendas na Prática, Lucro & Caixa, Combo IA + Vendas e Negócio Completo): rota `/api/webhooks/hotmart` → `routeHotmartNc011` → `handleDigitalHotmartNc012` → `recordHotmartSale` (resumo de vendas no KV) + `emitActivity` (atividade `delivery_sent` ou `refund_requested`) |
| Entradas | `POST` JSON v2 da Hotmart com `x-hotmart-hottok`; eventos `PURCHASE_APPROVED`, `PURCHASE_COMPLETE`, `PURCHASE_REFUNDED`, `PURCHASE_CHARGEBACK`, `PURCHASE_PROTEST`, `PURCHASE_CANCELED` e os demais da lista permitida |
| Saídas | `200` com `duplicate` verdadeiro ou falso; `401` para `hottok` errado ou ausente; `422` para evento inválido; `503` para configuração ausente ou registro **não gravado** (a Hotmart reenvia) |
| Estados por transação e resultado | ausente → evento imutável gravado (`zpc:sales:v1:ev:<balde>:<hash>:<desfecho>:<evento>:<hash do conteúdo>`, TTL 400 dias). Não há estado intermediário: a chave existe ou não existe. O desfecho `approved` vale para APPROVED e COMPLETE; `reversed` vale para estorno, contestação e protesto (seções NC-989-01 a 04) |
| Invariante | Cada transação aprovada é contada **exatamente uma vez** no registro, e gera exatamente uma atividade de entrega. Cada reversão é contada no máximo uma vez. Nenhum e-mail, nome ou transação em claro fica no registro |
| Dependências | KV `ZEVANORY_PRIVATE_ARTIFACTS`. **Não** usa Neon, Resend nem rede |
| Concorrência, cota e deduplicação | **Resolvidas pelas NC-989-01 a 04.** O resumo é uma projeção. Os eventos de uma transação caem sempre no mesmo balde (256 baldes pelo hash da transação). O postback recalcula só o seu balde, e o recomputo horário varre 10 baldes e soma as projeções |

## 2. Defeitos encontrados e corrigidos neste PR

| # | Defeito na base | Efeito | Correção | Prova |
|---|---|---|---|---|
| D1 | `recordHotmartSale` gravava o marcador da transação como concluído **antes** do resumo | Uma falha na gravação do resumo (cota de KV ou erro transitório) devolvia 503. A reentrega da Hotmart virava `duplicate` e a venda **sumia** do registro (entrega faltante no registro) | Primeira versão: marcador em duas fases. **Substituída pela NC-989-01:** a única gravação da verdade é o evento imutável; falha nele devolve 503, e a reentrega grava o mesmo par chave/valor | E3, E4, E13, mutantes M26, M27, M32 e M36 |
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
| E4 | falha entre o evento e a projeção do balde → reentregas | 503; a reentrega é duplicata e recalcula o balde; o total conta 1 venda (zero faltante, zero duplicado) | PASS |
| E5 | leitura que falha (KV fora); depois listagem que falha no recomputo | 503 sem gravar; o recomputo falha e o total anterior fica intacto (não vazio); o recomputo seguinte soma | PASS |
| E6 | falha na gravação da atividade de entrega e de estorno | 503; a reentrega grava exatamente uma | PASS |
| E7 | Neon fora (`DATABASE_URL` sintético inalcançável) | 200 sem nenhuma chamada de rede | PASS |
| E8 | `hottok` errado ou ausente; segredo não configurado | 401, 401, 503; nada gravado | PASS |
| E9 | indisponibilidade parcial (12-B.4), na seção 4 | nenhuma lacuna cenário × direito; caminhos informados nas 5 páginas de venda; contraprovas | PASS |
| E10 | entrega mensal (Conteúdo Pronto): webhook × cron, 2 ciclos, resultado ambíguo | uma saída por ciclo com a chave `<id>/delivery/<ciclo>`; ambíguo espera conciliação | PASS |
| E11 | onboarding com microvitória (seção 5) | flag exata, mesmo plano para APPROVED e COMPLETE, prazo ≤ 24 h, cancelamento por estorno ou descadastro, texto sem oferta, **remetente nunca chamado** | PASS |
| E12 | rota oficial com a flag de 192 h ligada no ambiente | vai ao registro digital (DEC-06), nunca ao razão de 192 h | PASS |
| E13 | NC-989-01/04: 2 execuções concorrentes, 7 cenários (incluindo sem data → com data e o inverso), **todos** os entrelaçamentos, falha antes e depois da gravação do evento, reentrega | contagem = transações únicas; resumo e conjunto de eventos iguais aos da sequência | PASS (3.640 entrelaçamentos) |
| E14 | NC-989-02: caminho completo (evento + projeção do balde + recomputo concorrente), semente fixa `0x98902`, 1.500 casos com falha sorteada | nunca acima da verdade; a varredura conta exatamente as transações únicas | PASS |
| E15 | NC-989-04: propriedade, semente fixa `0x98901`, 800 casos com a data **variando entre eventos da mesma transação**, recomputo e falha sorteados | resumo = sequência; recomputo concorrente nunca acima da verdade | PASS |
| E16 | NC-989-01: retenção e tamanho | aos 399 dias ainda conta e deduplica; TTL ≥ 400 dias para eventos e projeções; 2.500 transações com páginas de 3 chaves | PASS |
| E17 | NC-989-01: migração do resumo legado | base congelada gravada antes da 1ª projeção; transação legada não conta duas vezes | PASS |
| E18 | NC-989-01: 3 entregas simultâneas pelo handler | 1 venda, 1 evento, 1 atividade por `sourceKey` | PASS |
| E19 | NC-989-02: orçamento de cota de um dia inteiro com 400 dias de histórico (256 baldes), 100 e 5 vendas/dia, todas as operações contadas | list, gravações e leituras ≤ 50% da cota free; prefixo global nunca listado; resumo certo | PASS (seção NC-989-02) |
| E20 | NC-989-03: mesma transação, desfecho e evento com conteúdo diferente, **todos** os entrelaçamentos × falhas | as duas evidências preservadas; contagem 1; divergência sinalizada; representativo independe da ordem | PASS (350 entrelaçamentos) |
| E21 | NC-989-02: varredura horária | cobre os 256 baldes em 26 h, sem estado; repara a projeção defasada por corrida | PASS |
| E22 | NC-989-04: transação sem data e depois com data, o inverso, e aprovação sem data com estorno datado; **todos** os entrelaçamentos do caminho completo × falhas | um balde só; contada 1 vez; competência no dia datado | PASS (28.050 entrelaçamentos) |

Contagens: ensaio **22/22** (zero pulados); mutantes **39/39 KILLED** (0 SURVIVED, 0 INCONCLUSIVE), com expectativas
em `scripts/ci/mutants_p12_entrega_allow.json` (M05 a M16 e M18 escritas antes de rodar; M19 a M44 nas seções NC-989);
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
- A concorrência, a cota e a deduplicação global foram resolvidas sem CAS (seções NC-989-01 a 04). Os resíduos que sobram estão listados lá.
- Falta o parecer independente sobre o SHA (critério 10), o readback da configuração efetiva (critério 11) e o
  registro das autorizações técnicas (critério 12).

## NC-989-01 (contra-auditoria do PR #989): leitura-modificação-gravação sem exclusão mútua

**Achado.** `recordHotmartSale` lia e gravava o resumo `zpc:sales:v1:summary` em passos separados, e o KV do
Cloudflare não tem compare-and-set. Duas entregas simultâneas podiam ler o mesmo estado, e uma sobrescrevia a outra.
O conjunto `applied` tinha no máximo 2.000 entradas.

**Correção.** A fonte de verdade é um conjunto de chaves imutáveis, uma por evento entregue. O formato atual da chave
está nas seções NC-989-02 e 03. Gravações concorrentes ou repetidas gravam pares chave/valor idênticos, então o
conteúdo final é a **união** das entregas bem-sucedidas, em qualquer entrelaçamento. O resumo é uma projeção: 1 venda
por transação aprovada e 1 reversão por transação. O representativo vem de uma precedência fixa (APPROVED > COMPLETE;
REFUNDED > CHARGEBACK > PROTEST, porque o protesto é provisório), nunca da ordem de chegada. O limite de 2.000 deixou
de existir.

**Correções aprovadas mantidas.**
- Venda não some: falha na gravação do evento ou da projeção do balde devolve 503, e a reentrega grava o que faltou (E3, E4, E13).
- KV fora: leitura ou listagem que falha no postback devolve 503. A listagem que falha derruba o recomputo antes de gravar o total,
  então nunca se grava total de lista vazia ou parcial (E5).
- Atividade não gravada: devolve 503 (E6).

**Legado.** No primeiro recomputo, o resumo anterior (sem `source`) é copiado byte a byte para
`zpc:sales:v1:legacy-baseline` antes de ser sobrescrito, e entra como base congelada. O marcador antigo
`zpc:sales:v1:txn:<ref>:<desfecho>` = `"1"` faz a reentrega de uma transação legada virar duplicata (E17). Sem
nenhum evento e sem resumo anterior, nada é gravado, e `hotmartStatus` continua `no_events`.

**Por que não um Durable Object.** O Worker já tem código de DO (`CP_SUBSCRIBER_DO`), mas a configuração de deploy do
Worker principal não está neste repositório. Uma classe, uma migração e um binding novos não poderiam ser verificados
aqui, e um componente a mais ficaria no caminho da entrega (12-B.4). As chaves imutáveis dão prova por construção,
sem mudar a infraestrutura e sem depender do Neon ou do D1.

## NC-989-02 (capacidade): nenhuma listagem do histórico inteiro

**Achado.** A primeira versão listava o prefixo inteiro de eventos no postback e a cada hora. Com 100 vendas/dia por
400 dias (40.000 eventos), seriam cerca de 40 páginas por recomputo, ou ~4.960 list/dia, acima da cota free de 1.000.

**Desenho atual** (balde pela transação, ver NC-989-04):
1. **Postback.** Grava o evento e recalcula **só o seu balde**: 1 list, que é 1 página no volume de projeto (~170
   eventos por balde com 400 dias de 100 vendas/dia). A projeção `zpc:sales:v1:bucket:<bb>` só é regravada se a
   impressão digital do balde mudou. A reentrega de um evento já gravado recalcula o balde, o que cobre a queda
   entre o evento e a projeção (E4, M26). Um COMPLETE idêntico a um APPROVED já gravado não grava nada.
2. **Sem marcador e sem documento compartilhado.** Dois postbacks concorrentes no mesmo balde podem gravar uma
   projeção defasada. Ela nunca fica acima da verdade, porque sai de uma listagem (E14). Quem corrige:
   - qualquer postback seguinte ao mesmo balde;
   - a **varredura horária rotativa**: 10 baldes por hora, sem estado (hora × 10 mod 256), ciclo de 25,6 h (E21).
     Na varredura, a projeção só é regravada se a listagem tiver evento que a projeção gravada não cobre (hash curto
     de cada nome de evento, `nameHashes`). A saída de eventos expirados por TTL fica para a próxima gravação do
     balde, para a expiração não custar 1 gravação por balde varrido (M37).
3. **Recomputo horário** (`/api/internal/funnel/run`): 10 baldes da varredura, o prefixo das projeções (≤ 256 chaves,
   1 página), as leituras das projeções e 1 gravação do total. Todo list é paginado.

Desenhos avaliados e descartados pela conta de gravações:
- **Partição por dia com marcador** (versão 420aa65f): 378 gravações/dia, mas não deduplica entre partições (NC-989-04).
- **Balde pela transação com marcador `dirty:<balde>`**: cada evento cai num balde diferente, então o marcador custa
  ~1 gravação por evento. Com a projeção, seriam ~580 gravações/dia (margem de 42%).

**Conta de cota, medida por E19** (256 baldes). A conta cobre um dia inteiro em regime, com 400 dias de histórico já
gravados (40.000 eventos e 256 projeções). Toda operação de KV do caminho de vendas é contada: postback pelo handler
(evento, projeção do balde, atividade) e 24 recomputos horários (varredura, listas, leituras e total).

Postbacks do dia:
- N aprovações novas;
- COMPLETE de 90% das compras de 8 dias atrás;
- estornos de 10% de N, em compras de 1 a 7 dias;
- contestações de 2% de N, em compras de 30 dias;
- 5% de reentregas.

| Cenário | Postbacks | list/dia | Gravações/dia | Leituras/dia |
|---|---|---|---|---|
| 100 vendas/dia + estornos | 207 | **381** (38,1% da cota) | **472** (47,2%): eventos 112, projeções de balde 112, atividades 224, total 24 | **7.256** (7,3%) |
| 5 vendas/dia (teto da abertura) | 13 | **272** (27,2%) | **52** (5,2%): total 24, atividades 14, eventos 7, baldes 7 | **6.260** (6,3%) |
| Limite exigido (margem ≥ 50%) | — | ≤ 500 | ≤ 500 | ≤ 50.000 |

Leitura da conta:
- **Listas:** 1 por postback que grava (ou reentrega), mais 24 × (10 da varredura + 1 do prefixo das projeções) = 264
  fixas.
- **Leituras:** dominadas pelas 256 projeções lidas por recomputo (~6.100/dia).
- **Gravações:** ~4,1 por venda aprovada (evento, projeção do balde e 2 da atividade), mais as reversões e 24 do
  total. A margem de 50% (500/dia) seria atingida perto de **107 vendas/dia**.
- **Comparação:** a partição por dia tinha mais folga de gravação (378), mas contava em dobro a transação que muda de
  data. Troquei folga por correção. No teto da abertura (5/dia), a margem é de 95%.
- **Fora da conta:** o batimento `zpc:cron:v1:funnel` (24/dia), que já existia. Eventos não financeiros em volume
  (carrinho abandonado, boleto impresso) custam ~2 gravações cada (evento + projeção) e também ficaram fora.

Listas e gravações não dependem do tamanho do histórico enquanto cada balde couber em 1 página (até ~1.000 eventos
por balde, ou ~256.000 eventos retidos). Acima disso, o list já é paginado e custa 1 página a mais por balde;
`BUCKET_HEX = 3` (4.096 baldes) reduz isso, mas multiplica as leituras do total por 16.

## NC-989-04 (deduplicação global entre partições)

**Achado.** Na partição por dia, a mesma transação podia ser contada em duas partições, por exemplo primeiro sem data
(`00000000`) e depois com data. `computeDay` agrupava só dentro do dia, e o total somava as projeções.
`source.undated_groups` dava visibilidade, mas não impedia a duplicação financeira.

**Correção.** A partição passou a ser a **transação**, não a data:
- O balde é formado pelos 2 primeiros hex de `sha256("hotmart:" + transação)`, em 256 baldes. Todos os eventos de uma
  transação caem **sempre** no mesmo balde, com ou sem data, e a projeção do balde agrupa por transação+desfecho.
- Uma transação nunca aparece em dois baldes, e o total soma baldes **disjuntos**. A deduplicação é global por
  construção, sem índice nem documento compartilhado sujeito a concorrência.
- A data de competência é só atributo do representativo. O evento datado vence o sem data no mesmo nível de
  precedência, e só ele entra em `byDay`. Sem nenhuma data, a venda conta 1 vez e fica fora de `byDay`
  (`source.undated_groups`).
- Quando a mesma transação chega sem data e depois com data, os dois conteúdos ficam preservados (chaves diferentes,
  NC-989-03) e aparecem em `divergent_events`.

**Provas.**
- **E22:** transação sem data e depois com data, o inverso, e aprovação sem data com estorno datado. Todos os
  entrelaçamentos do caminho completo (evento + projeção do balde), com e sem falha antes e depois das gravações e
  reprocessamento: **28.050 entrelaçamentos**. Resultado: um único balde, contagem 1, competência no dia datado.
- **E13:** inclui os dois cenários NC-989-04 na busca exaustiva da camada de eventos.
- **E15:** 800 casos com a data **variando entre eventos da mesma transação**; o resumo é idêntico ao da sequência.
- **Mutantes:** M40 (partição pela data), M41 (agrupar sem o desfecho), M42 (balde pelo conteúdo, ou seja, somar
  projeções sem deduplicar) e M43 (competência pelo evento sem data).

## NC-989-03 (imutabilidade): conteúdo divergente nunca substitui evidência

**Achado.** Com a chave determinística só por transação, desfecho e evento, uma mensagem do mesmo evento com conteúdo
diferente podia sobrescrever a anterior (KV sem CAS, leitura desatualizada).

**Correção.** A chave termina em `payloadhash` = sha256 dos fatos canônicos do payload: produto, valores, comissões,
origem, pagamento e data. O nome do evento não entra; ele já está na chave.
- Conteúdo igual ⇒ mesma chave e valor idêntico: a gravação é idempotente.
- Conteúdo diferente ⇒ chave diferente: as duas evidências ficam preservadas.
- A contagem continua 1 por transação+desfecho. O representativo é determinístico: precedência do evento, depois o
  que tem data, depois o menor `payloadhash`.
- Cada variante do mesmo evento com conteúdo diferente aparece em `divergent_events` (ref pseudônima, desfecho,
  evento, número de variantes), no resumo e na projeção do balde, para revisão humana. A contagem não muda (E20; M34 e M39).
  Um COMPLETE idêntico a um APPROVED gravado pode ou não existir, conforme a corrida; por isso não conta como
  variante (M44).

## Leitores do resumo e ajustes

| Leitor | Uso | Ajuste |
|---|---|---|
| `scripts/audit/command-center-snapshot.mjs` (+ `funnel-counting.mjs`) | `schema`, `totals`, `byDay`, `bySource`, `byProduct`, `updatedAt` | Nenhum. O esquema `zevanory-sales/v1` foi mantido. `updatedAt` é a hora do recomputo horário, e a hora da última venda está em `lastEventAt`. Campos novos: `source` (baldes, eventos, grupos, `undated_groups`, base legada) e `divergent_events`. O total é atualizado de hora em hora, antes do snapshot; a projeção do balde, no postback |
| `worker/data-backup.mjs` | copia o prefixo `zpc:sales:` | Nenhum. Inclui eventos, projeções de balde e a base legada |
| `tests/sales-ledger.test.mjs` | resumo depois de `recordHotmartSale` | Chama o recomputo antes de ler; as mesmas 3 asserções de contagem |
| `scripts/cp-nc013-regression.test.mjs` | conferia a gravação do resumo | Confere o evento imutável (`zpc:sales:v1:ev:`) |

## Mutantes NC-989 (M19 a M44, todos KILLED)

Os antigos M01 a M04 e M17 foram removidos, porque o marcador em duas fases e o `applied` não existem mais. Os
mutantes do marcador `dirty:<dia>` (versão 420aa65f) foram trocados pelos equivalentes do desenho por balde.

| Mutante | Regra quebrada | Morto por (primárias) |
|---|---|---|
| M19 | resumo por leitura-modificação-gravação como fonte | E13.1, E1.4, E3.1 |
| M20 | derivação parte do resumo atual | E4.8, E5.5, E14.2 |
| M21 | postback lista o prefixo global | E19.1 (a cota de list estoura) |
| M22 | chave por transação não determinística | E13.1, E1.4, E16.4 |
| M23 | TTL do evento abaixo de 400 dias | E16.2 |
| M24 | contagem de entradas não únicas | E13.1, E20.3 |
| M25 | falha de listagem engolida | E5.6 |
| M26 | reentrega não recalcula o balde que faltou | E4.4 |
| M27 | evento gravado só se o grupo for novo | E13.3 |
| M28 | representativo pela ordem da listagem | E2.3, E13.1 |
| M29 | marcador legado ignorado | E17.3 |
| M30 | base legada não gravada antes da projeção | E17.2 |
| M31 | paginação do list ignorada | E16.6 |
| M32 | falha de gravação do evento engolida | E3.1, E13.3, E20.1 |
| M33 | leitura com falha engolida | E5.1 |
| M34 | chave sem `payloadhash` | E20.1 |
| M35 | total recalculado de todos os baldes a cada hora | E19.1 (a cota de list estoura) |
| M36 | postback não recalcula o balde | E4.1, E3.5 |
| M37 | varredura nunca repara balde defasado | E21.4, E14.2 |
| M38 | varredura cobre só metade dos baldes | E21.1 |
| M39 | divergência não sinalizada | E20.5 |
| M40 | partição pela data da compra (não pela transação) | E22.2, E13.1 |
| M41 | agrupamento sem o desfecho | E13.1, E2.3 |
| M42 | balde pelo conteúdo (soma de projeções sem deduplicação) | E22.2, E13.1 |
| M43 | representativo prefere o evento sem data | E22.3 |
| M44 | COMPLETE gêmeo contado como divergência | E15.2 |

As expectativas foram derivadas por raciocínio sobre cada mutação e conferidas numa execução de sondagem antes da
execução oficial. As secundárias são as falhas que a sondagem mostrou nos outros testes, cada uma com justificativa.
O que mudou depois da sondagem:
- **M21:** a primeira versão também listava o prefixo global no caminho sem projeção de E16, e o teste estourava o
  tempo. A mutação passou a ficar só no caminho que projeta.
- **M21 e M35:** o KV falso do E19 recusa o list depois de 1.000 por dia, como a cota real, então o teste falha por
  asserção em vez de estourar o tempo.

## Resíduos declarados

- **Consistência eventual do KV** (até cerca de 60 s entre locais). Uma entrega pode não ver a chave de outra, e as
  duas gravam o mesmo valor. Uma projeção de balde defasada por corrida ou por atraso da listagem nunca fica acima da
  verdade, e é corrigida pelo próximo postback ao balde ou pela varredura (até 25,6 h).
- **Expiração** (TTL de 400 dias): a saída de eventos expirados entra no total na próxima gravação do balde, não na
  varredura. Os totais podem conter vendas com até alguns dias além dos 400; `byDay` mantém os 400 dias mais recentes.
- **CPU do Worker Free (10 ms):** o recomputo lê e soma 256 projeções. A conta acima é de operações de KV; o tempo
  de CPU no Worker real **não foi medido** aqui.
- **Atividade** (`worker/activity-ledger.mjs`, fora destas NC): entregas simultâneas podem gerar mais de um evento com
  o mesmo `sourceKey`, que o consumidor deduplica (E18.3).
- **Rollback para o código anterior** exige reconciliação pelo painel da Hotmart. Uma venda que já tinha sumido pelo
  defeito D1 em produção continua fora da base (seção 7.1, H-3).
