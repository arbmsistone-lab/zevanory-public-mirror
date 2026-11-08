# P12 Entrega digital idempotente: ensaio sintético de entrega

**Rótulo da evidência (roteiro v4.9.1, seção 6.4): SINTÉTICA.** Teste local e de CI, com fetch proibido, sem
produção, sem Hotmart real, sem segredo real e sem compra ou reembolso fabricado. Pela seção 6.4, esta evidência
dá no máximo homologação de engenharia. Ela **não** conta como ENSAIO EM PRODUÇÃO nem como OPERACIONAL, e não
atribui `HOMOLOGADO_075` sozinha (seção P1.4: faltam os critérios 7, 9 a 12).

- Data do ensaio: 07/11/2026. Base: `gh-pages@9a6f1a86`. O SHA do head está no PR.
- Reprodução: `node --test tests/p12-entrega-ensaio.test.mjs` (21 testes) e
  `python3 scripts/ci/mutants_p12_entrega.py` (35 mutantes). O gate só de PR é `.github/workflows/p12-entrega-ensaio.yml`.
- Decisão vigente: **DEC-06.** Depois da aprovação do pagamento, a Hotmart entrega o produto integral imediatamente
  na área de compras (Minhas compras). Não há retenção de 192 h (o modelo B foi revogado). A ZEVANORY não envia
  e-mail de produto. Ela **registra** a entrega e o estorno a partir do postback autenticado (`hottok`).

## 1. Contrato do motor (critério 1 da seção P1.4)

| Item | Definição |
|---|---|
| Escopo | Postback Hotmart dos 5 produtos v1.3.4 (IA na Prática, Vendas na Prática, Lucro & Caixa, Combo IA + Vendas e Negócio Completo): rota `/api/webhooks/hotmart` → `routeHotmartNc011` → `handleDigitalHotmartNc012` → `recordHotmartSale` (resumo de vendas no KV) + `emitActivity` (atividade `delivery_sent` ou `refund_requested`) |
| Entradas | `POST` JSON v2 da Hotmart com `x-hotmart-hottok`; eventos `PURCHASE_APPROVED`, `PURCHASE_COMPLETE`, `PURCHASE_REFUNDED`, `PURCHASE_CHARGEBACK`, `PURCHASE_PROTEST`, `PURCHASE_CANCELED` e os demais da lista permitida |
| Saídas | `200` com `duplicate` verdadeiro ou falso; `401` para `hottok` errado ou ausente; `422` para evento inválido; `503` para configuração ausente ou registro **não gravado** (a Hotmart reenvia) |
| Estados por transação e resultado | ausente → evento imutável gravado (`zpc:sales:v1:ev:<dia>:<hash>:<desfecho>:<evento>:<hash do conteúdo>`, TTL 400 dias). Não há estado intermediário: a chave existe ou não existe. O desfecho `approved` vale para APPROVED e COMPLETE; `reversed` vale para estorno, contestação e protesto (seções NC-989-01 a 03) |
| Invariante | Cada transação aprovada é contada **exatamente uma vez** no registro, e gera exatamente uma atividade de entrega. Cada reversão é contada no máximo uma vez. Nenhum e-mail, nome ou transação em claro fica no registro |
| Dependências | KV `ZEVANORY_PRIVATE_ARTIFACTS`. **Não** usa Neon, Resend nem rede |
| Concorrência e cota | **Resolvidas pelas NC-989-01 a 03.** O resumo é uma projeção. O postback não lista nem recalcula nada, e o recomputo horário lista só os dias quentes, os dias com marcador e um dia de varredura |

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
| E4 | falha entre o evento e o marcador do dia frio → reentregas | 503; a reentrega é duplicata e grava o marcador; o recomputo conta 1 venda (zero faltante, zero duplicado) | PASS |
| E5 | leitura que falha (KV fora); depois listagem que falha no recomputo | 503 sem gravar; o recomputo falha e o resumo anterior fica intacto (não vazio); o recomputo seguinte soma | PASS |
| E6 | falha na gravação da atividade de entrega e de estorno | 503; a reentrega grava exatamente uma | PASS |
| E7 | Neon fora (`DATABASE_URL` sintético inalcançável) | 200 sem nenhuma chamada de rede | PASS |
| E8 | `hottok` errado ou ausente; segredo não configurado | 401, 401, 503; nada gravado | PASS |
| E9 | indisponibilidade parcial (12-B.4), na seção 4 | nenhuma lacuna cenário × direito; caminhos informados nas 5 páginas de venda; contraprovas | PASS |
| E10 | entrega mensal (Conteúdo Pronto): webhook × cron, 2 ciclos, resultado ambíguo | uma saída por ciclo com a chave `<id>/delivery/<ciclo>`; ambíguo espera conciliação | PASS |
| E11 | onboarding com microvitória (seção 5) | flag exata, mesmo plano para APPROVED e COMPLETE, prazo ≤ 24 h, cancelamento por estorno ou descadastro, texto sem oferta, **remetente nunca chamado** | PASS |
| E12 | rota oficial com a flag de 192 h ligada no ambiente | vai ao registro digital (DEC-06), nunca ao razão de 192 h | PASS |
| E13 | NC-989-01: 2 execuções concorrentes, **todos** os entrelaçamentos, dia quente (5 cenários) e dia frio (3 cenários, com o marcador), falha antes e depois de cada gravação, reentrega | contagem = transações únicas; resumo e conjunto de eventos iguais aos da sequência | PASS (18.240 entrelaçamentos) |
| E14 | NC-989-02: recomputo horário concorrente com 2 postbacks em dia frio, semente fixa `0x98902`, 1.500 casos com falha sorteada | o recomputo concorrente nunca conta a mais; o seguinte conta as duas | PASS |
| E15 | NC-989-01: propriedade, semente fixa `0x98901`, 800 casos de 2 a 5 entregas, dias quentes, frios e sem data, recomputo concorrente e falha sorteados | resumo = sequência; recomputo concorrente nunca acima da verdade | PASS |
| E16 | NC-989-01: retenção e tamanho | aos 399 dias ainda conta e deduplica; TTL ≥ 400 dias para eventos e projeções; 2.500 transações num dia, com list paginado | PASS |
| E17 | NC-989-01: migração do resumo legado | base congelada gravada antes da 1ª projeção; transação legada não conta duas vezes | PASS |
| E18 | NC-989-01: 3 entregas simultâneas pelo handler | 1 venda, 1 evento, 1 atividade por `sourceKey` | PASS |
| E19 | NC-989-02: orçamento de cota de um dia inteiro com 400 dias de histórico, 100 e 5 vendas/dia, todas as operações contadas | list, gravações e leituras ≤ 50% da cota free; prefixo global nunca listado; resumo do dia certo | PASS (seção NC-989-02) |
| E20 | NC-989-03: mesma transação, desfecho e evento com conteúdo diferente, **todos** os entrelaçamentos, falhas, dia quente e frio | as duas evidências preservadas; contagem 1; divergência sinalizada | PASS (5.810 entrelaçamentos) |
| E21 | NC-989-02: ciclo de vida do marcador e recomputo perdido | marcador nunca apagado, regravado depois de 2 h e expirado por TTL; dia sem projeção recuperado | PASS |

Contagens: ensaio **21/21** (zero pulados); mutantes **35/35 KILLED** (0 SURVIVED, 0 INCONCLUSIVE), com expectativas
em `scripts/ci/mutants_p12_entrega_allow.json` (M05 a M16 e M18 escritas antes de rodar; M19 a M40 nas seções NC-989);
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
- A concorrência e a cota foram resolvidas sem CAS (seções NC-989-01 a 03). Os resíduos que sobram estão listados lá.
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
- Venda não some: falha na gravação do evento ou do marcador devolve 503, e a reentrega grava o que faltou (E3, E4, E13).
- KV fora: leitura que falha devolve 503 sem gravar. A listagem que falha derruba o recomputo antes de gravar o total,
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

## NC-989-02 (capacidade): recomputo sem listar o histórico inteiro

**Achado.** A versão anterior listava o prefixo inteiro de eventos no postback e a cada hora. Com 100 vendas/dia por
400 dias (40.000 eventos), seriam cerca de 40 páginas por recomputo, ou ~4.960 list/dia, acima da cota free de 1.000.

**Desenho.**
1. **Partição por dia ESTÁVEL da transação.** A chave é
   `zpc:sales:v1:ev:<AAAAMMDD>:<sha256(transação)[0:32]>:<desfecho>:<evento>:<payloadhash16>`. O dia vem de
   `approved_date`, senão de `order_date`, do payload. A Hotmart repete esses campos em APPROVED, COMPLETE e estorno
   da mesma transação. Sem data no payload, a partição é `00000000`. O relógio do servidor nunca é usado, nem o
   `creation_date` do postback, que muda entre os eventos da mesma transação.
2. **O postback não lista nem recalcula nada.** Ele grava o evento e, se a partição estiver fria (fora de hoje,
   ontem e anteontem, em UTC), grava o marcador `zpc:sales:v1:dirty:<dia>`.
   - O marcador tem TTL de 12 h e só é regravado se tiver mais de 2 h.
   - O marcador **nunca é apagado** e expira por TTL. Então não existe a corrida de "apagar depois de recalcular":
     todo evento é seguido de ≥ 10 h de marcador vivo, ou seja, ≥ 9 recomputos horários (E21; o mutante M38, que
     apaga o marcador, é morto por E14 e E21).
   - A reentrega de um evento já gravado também regrava o marcador, se ele faltar. Isso cobre a queda entre o evento
     e o marcador (E4, M26).
3. **Recomputo horário** (`refreshSalesSummary`, em `/api/internal/funnel/run`). Ele lista só:
   - os 3 dias quentes, ao vivo (hoje e ontem nunca são gravados);
   - os dias com marcador;
   - os dias -2 a -7 que ainda não têm projeção gravada (recuperação de recomputo perdido, E21.6);
   - 1 dia da varredura rotativa, sem estado (hora mod 400: dias -3 a -401 e a partição sem data, ciclo de ~17 dias);
   - o prefixo `zpc:sales:v1:day:` (≤ 401 chaves, 1 página).

   A projeção do dia `zpc:sales:v1:day:<dia>` só é regravada quando muda a impressão digital (os nomes dos eventos).
   O total soma as projeções dos dias com a base legada e é gravado 1 vez por hora. Todo `list` é paginado
   (1.000 por página), então N páginas são tratadas.
4. **COMPLETE gêmeo não é regravado.** Se já existe um APPROVED da mesma transação com o mesmo conteúdo canônico,
   o COMPLETE não grava: mesmo desfecho e mesmos fatos, nada a preservar. Isso economiza 1 gravação por venda. Um
   COMPLETE com conteúdo diferente, ou sem APPROVED, é gravado.

**Conta de cota, medida por E19.** A conta cobre um dia inteiro em regime, com 400 dias de histórico já gravados
(40.000 eventos e 400 projeções de dia, no cenário de 100 vendas/dia). Toda operação de KV do caminho de vendas é
contada: postback pelo handler (evento, marcador, atividade `delivery_sent` ou `refund_requested`) e 24 recomputos
horários (listas, leituras, projeções de dia e total).

Postbacks do dia:
- N aprovações novas;
- COMPLETE de 90% das compras de 8 dias atrás (garantia vencida);
- estornos de 10% de N, em compras de 1 a 7 dias atrás;
- contestações de 2% de N, em compras de 30 dias atrás;
- 5% de reentregas.

| Cenário | Postbacks | list/dia | Gravações/dia | Leituras/dia |
|---|---|---|---|---|
| 100 vendas/dia + estornos | 207 | **218** (21,8% da cota) | **378** (37,8%): eventos 112, atividades 224, total 24, dias 10, marcadores 8 | **10.579** (10,6%) |
| 5 vendas/dia (teto da abertura) | 13 | **156** (15,6%) | **47** (4,7%): total 24, atividades 14, eventos 7, marcador 1, dia 1 | **9.685** (9,7%) |
| Limite exigido (margem ≥ 50%) | — | ≤ 500 | ≤ 500 | ≤ 50.000 |

Leitura da conta:
- **Listas:** são 24 × (1 de marcadores + 3 quentes + dias sujos + 1 de varredura + 1 de projeções); os dias de
  recuperação só entram quando falta projeção. Não crescem com o histórico, porque cada dia é 1 página até 1.000
  eventos.
- **Leituras:** dominadas pelas ~400 projeções de dia lidas por recomputo (cerca de 9.600/dia, fixas).
- **Gravações:** crescem cerca de 3,1 por venda (evento + 2 da atividade), mais ~42 fixas. O limite de 50%
  (500/dia) seria atingido perto de **147 vendas/dia**.
- **Fora da conta:** o batimento do recomputo (`zpc:cron:v1:funnel`, 24 gravações/dia) já existia e não é do caminho
  de vendas. Eventos não financeiros em volume (carrinho abandonado, boleto impresso) somam 1 gravação cada e também
  ficaram fora; acima de ~100/dia, eles pediriam um contador agregado no lugar de um evento por mensagem.

Nada depende de mudança manual quando o histórico cresce: listas e gravações não dependem do tamanho do histórico,
e as leituras crescem até 401 por recomputo, no máximo.

## NC-989-03 (imutabilidade): conteúdo divergente nunca substitui evidência

**Achado.** Com a chave determinística só por transação, desfecho e evento, uma mensagem do mesmo evento com conteúdo
diferente podia sobrescrever a anterior (KV sem CAS, leitura desatualizada).

**Correção.** A chave termina em `payloadhash` = sha256 dos fatos canônicos do payload: produto, valores, comissões,
origem, pagamento e data. O nome do evento não entra; ele já está na chave.
- Conteúdo igual ⇒ mesma chave e valor idêntico: a gravação é idempotente.
- Conteúdo diferente ⇒ chave diferente: as duas evidências ficam preservadas.
- A contagem continua 1 por transação+desfecho. O representativo é determinístico: precedência e depois o menor
  `payloadhash`.
- Cada variante do mesmo evento com conteúdo diferente aparece em `divergent_events` (dia, ref pseudônima, desfecho,
  evento, número de variantes), no resumo e na projeção do dia, para revisão humana. A contagem não muda (E20; M34 e M39).

## Leitores do resumo e ajustes

| Leitor | Uso | Ajuste |
|---|---|---|
| `scripts/audit/command-center-snapshot.mjs` (+ `funnel-counting.mjs`) | `schema`, `totals`, `byDay`, `bySource`, `byProduct`, `updatedAt` | Nenhum. O esquema `zevanory-sales/v1` foi mantido. `updatedAt` é a hora do recomputo horário, e a hora da última venda está em `lastEventAt`. Campos novos: `source` (dias, eventos, grupos, `undated_groups`, base legada) e `divergent_events`. O resumo é atualizado de hora em hora, antes do snapshot, e não mais no postback |
| `worker/data-backup.mjs` | copia o prefixo `zpc:sales:` | Nenhum. Inclui eventos, marcadores, projeções de dia e a base legada |
| `tests/sales-ledger.test.mjs` | resumo depois de `recordHotmartSale` | Chama o recomputo antes de ler; as mesmas 3 asserções de contagem |
| `scripts/cp-nc013-regression.test.mjs` | conferia a gravação do resumo | Confere o evento imutável (`zpc:sales:v1:ev:`) |

## Mutantes NC-989 (M19 a M40, todos KILLED)

Os antigos M01 a M04 e M17 foram removidos, porque o marcador em duas fases e o `applied` não existem mais.

| Mutante | Regra quebrada | Morto por |
|---|---|---|
| M19 | resumo por leitura-modificação-gravação como fonte | E13.1, E1.4, E3.1 |
| M20 | derivação parte do resumo atual | E4.8, E5.5, E14.2 |
| M21 | postback lista o prefixo global | E19.1 (a cota de list estoura) |
| M22 | chave por transação não determinística | E13.1, E1.4, E16.4 |
| M23 | TTL do evento abaixo de 400 dias | E16.2 |
| M24 | contagem de entradas não únicas | E13.1, E20.3 |
| M25 | falha de listagem engolida | E5.6 |
| M26 | reentrega não regrava o marcador que faltou | E4.4 |
| M27 | evento gravado só se o grupo for novo | E13.3 |
| M28 | representativo pela ordem da listagem | E2.3, E13.1 |
| M29 | marcador legado ignorado | E17.3 |
| M30 | base legada não gravada antes da projeção | E17.2 |
| M31 | paginação do list ignorada | E16.6 |
| M32 | falha de gravação do evento engolida | E3.1, E13.3, E20.1 |
| M33 | leitura com falha engolida | E5.1 |
| M34 | chave sem `payloadhash` | E20.1 |
| M35 | total recalculado de todos os eventos | E19.2 |
| M36 | dia frio sem marcador | E4.1, E13.1, E21.1 |
| M37 | marcador nunca regravado | E21.3 |
| M38 | marcador apagado depois do recomputo, sem verificação | E21.2, E14.2 |
| M39 | divergência não sinalizada | E20.5 |
| M40 | recuperação de dias sem projeção desligada | E21.6 |

As expectativas foram derivadas por raciocínio sobre cada mutação e conferidas numa execução de sondagem antes da
execução oficial. O que mudou depois da sondagem:
- **M21 e M35:** o primeiro desenho do teste de orçamento estourava o tempo, porque cada postback listava 40 páginas.
  O KV falso do E19 passou a recusar o list depois de 1.000 por dia, como a cota real, e o teste agora falha por asserção.
- **M29:** remover a leitura do marcador legado tira uma operação por execução. O piso de entrelaçamentos do E13
  (E13.5) cai e foi registrado como secundário.
- **M06** (antigo): os testes E4, E18 e E19 também fazem reentrega com a atividade já gravada e foram incluídos como
  secundários.

## Resíduos declarados

- **Consistência eventual do KV** (até cerca de 60 s entre locais). Uma entrega pode não ver a chave de outra, e as
  duas gravam o mesmo valor. A listagem pode atrasar: o marcador, vivo por ≥ 10 h, faz os recomputos seguintes verem
  o evento.
- **Transação com data em um evento e sem data em outro**: os eventos caem em partições diferentes e o grupo se
  divide. A Hotmart envia `approved_date` e `order_date` nos eventos de compra aprovada. A partição sem data é
  contada à parte em `source.undated_groups`, para revisão.
- **Cron parado por mais de 7 dias**: os dias que esfriaram nesse período só entram pela varredura, em até cerca de
  17 dias. Isso nunca conta a mais.
- **Atividade** (`worker/activity-ledger.mjs`, fora destas NC): entregas simultâneas podem gerar mais de um evento com
  o mesmo `sourceKey`, que o consumidor deduplica (E18.3).
- **Rollback para o código anterior** exige reconciliação pelo painel da Hotmart. Uma venda que já tinha sumido pelo
  defeito D1 em produção continua fora da base (seção 7.1, H-3).
