# P20: diário de eventos críticos no Cloudflare D1 (desenho; PR 1 de 7)

Fonte: Roteiro Mestre v4.7, seção 9.1 ("Diário de eventos críticos" e "Operação durante falha de backup") e
contestação 0-D, item 1. **Estado: módulo, migração e testes prontos. Nada ligado em produção.** Nenhum Worker
importa `worker/diario-p20.mjs` neste PR, e nenhum banco D1 foi criado.

## Para que serve

Todo pedido, consentimento (opt-in, confirmação e revogação), entrega, pagamento ou estorno e referência fiscal é
gravado no Neon **e**, no mesmo ato, num diário somente de inclusão no D1, que é independente do Neon. Se o Neon se
perder dentro da janela do backup diário (RPO 24 h), o diário reconstrói os eventos posteriores à última cópia
íntegra. Ele fica sempre ligado, então é exercitado todos os dias e não só na crise.

## Esquema (`migrations/d1/0001_diario_v1.sql`)

| Tabela | Colunas | Regras |
|---|---|---|
| `diario_v1` | `seq` INTEGER PK AUTOINCREMENT, `event_key` TEXT UNIQUE NOT NULL, `tipo`, `ts_ms`, `ref`, `payload_json`, `payload_sha`, `prev_hash`, `chain_hash` UNIQUE | Triggers `diario_v1_sem_update` e `diario_v1_sem_delete` abortam UPDATE e DELETE (somente inclusão) |
| `diario_head` | `id` = 1 (CHECK), `seq`, `chain_hash` | Uma linha só. Começa na genesis (seq 0, 64 zeros). O trigger `diario_head_so_avanca` só deixa a cabeça avançar de 1 em 1, e `diario_head_sem_delete` impede apagá-la |

Tipos (`TIPOS`): `order_created`, `payment_status`, `delivery_sent`, `refund`, `consent_given`, `consent_confirmed`,
`consent_revoked`, `erase` e `fiscal_ref`. `fiscal_ref` fica reservado: o documento fiscal vive no emissor
(procedimento F3) e o diário guarda só a referência.

## Hash encadeado

- `payload_json` = JSON canônico do payload (chaves ordenadas em todos os níveis, sem espaços).
- `payload_sha` = SHA-256 hex de `payload_json`.
- `chain_hash` = SHA-256 hex de `"zevanory.p20.diario.v1\n" + prev_hash + "\n" + event_key + "\n" + payload_sha + "\n" + ts_ms`.
- `prev_hash` da primeira linha = genesis (64 zeros). Nas demais, `prev_hash` = `chain_hash` da linha anterior.
- `verifyChain(rows, {from?, head?})` confere a ordem de `seq`, o `prev_hash`, a forma canônica, o `payload_sha` e o
  `chain_hash`, e devolve `{ok, broken_at}` com o `seq` da primeira linha quebrada. Com `head`, também detecta corte
  do fim da cadeia. O teste DJ1 recalcula a fórmula fora do módulo, com `node:crypto`. Com isso, qualquer auditor
  reproduz a fórmula, por exemplo com `sha256sum`.

## Gravação (`appendEvent(db, ev)`): idempotente e com compare-and-set

1. Valida o tipo, a chave (`eventKey(tipo, ...partes)` é determinística: `tipo:parte:parte`), o `ts_ms`, a `ref` e o
   payload. Recusa PII **antes** de tocar o D1.
2. Se a `event_key` já existe: com o mesmo `payload_sha`, devolve `{ok:true, duplicate:true}`; com outro, devolve
   `{ok:false, code:"diario_conflito"}`. O diário nunca sobrescreve.
3. Lê a cabeça e calcula o `chain_hash`. Num único `db.batch` (atômico), roda o `UPDATE diario_head ... WHERE seq = ?
   AND chain_hash = ?`, que é o CAS, e o `INSERT ... SELECT ... WHERE EXISTS (cabeça = nova)`. Se outro escritor
   avançou a cabeça, nada é gravado e o módulo relê e tenta de novo, até `MAX_TENTATIVAS` = 3. Se a corrida persistir,
   devolve `diario_corrida`. Se o D1 falhar, devolve `diario_indisponivel`. O módulo nunca lança erro por falha do D1.

## LGPD

`assertNoPii` percorre todo o payload e recusa:
- valor string com e-mail, CPF (com ou sem pontuação) ou telefone brasileiro;
- chave que nomeia dado pessoal (`email`, `nome`/`name`, `cpf`, `cnpj`, `rg`, `telefone`/`phone`, `celular`,
  `whatsapp`, `endereco`/`address`, `ip`, inclusive em camelCase ou snake_case).

O substituto permitido é um hash ou HMAC: chaves terminadas em `_sha`, `_hash` ou `_hmac`, ou um SHA-256 hex. A
chave de evento e a `ref` usam um alfabeto restrito (sem `@` nem espaço) e passam pelo mesmo detector. Para não
deixar passar dado pessoal, o detector às vezes recusa um identificador inocente: um id só de dígitos com formato
de CPF ou telefone é recusado, então use prefixo com letras (`ord_...`).

## Falha do diário (matriz da seção 9.1)

| Operação | Diário indisponível ou em corrida persistente |
|---|---|
| Checkout próprio (Mercado Pago) | **Fecha** (fail-closed): o pedido só abre o pagamento depois que o diário confirma |
| Captura de lead e consentimento | **Fecha** só o formulário, com aviso honesto |
| Webhooks de pagamento e estorno; entregas de pedido já pago | **Não bloqueiam**: seguem, e o evento vai para uma fila de pendências (reenvio idempotente pela `event_key`) |
| Hotmart, páginas e conteúdo | Não dependem do diário |

- **Reconciliação diária** Neon × diário. Uma divergência é falha de P20.
- **Ensaio mensal:** a restauração reconstrói os eventos posteriores à última cópia íntegra a partir do diário, e
  `verifyChain` passa na cadeia inteira contra a cabeça.

## Plano dos PRs

1. **(este)** Módulo puro, migração, testes num D1 falso com SQL real (node:sqlite) e 10 mutantes.
2. Binding `DIARIO_P20` no wrangler (banco do proprietário), em **sombra**: grava sem bloquear nada e mede latência
   e erros.
3. Fila de pendências e reenvio (webhooks e entregas) e evento `erase` (LGPD: apagar no Neon registra só o hash).
4. Reconciliação diária Neon × diário, com relatório sem PII.
5. Integração ao ensaio mensal P20: reconstruir os eventos pós-backup e verificar a cadeia.
6. Fail-closed no checkout próprio e no formulário de leads, depois de 7 dias em sombra sem divergência.
7. Certificado: o RPO medido passa a contar o diário. A lacuna do inventário só sai depois de um ensaio aprovado.

## Dependências do proprietário (nada disso foi feito pelo executor)

- Criar o banco D1 **`zevanory-diario-p20`** na conta `1b26415802588185a86c1d4d3ebf5bdb` e informar o UUID.
- **Nunca** reutilizar `zevanory-certification-only` (`7ff006f3-...`) nem banco de outra conta.
- Tokens separados: **D1 Edit** só para o deploy e a migração, e **D1 Read** para a reconciliação e o ensaio.
- **7 dias em sombra** antes de qualquer fail-closed.
- **Cota:** o D1 Free é por conta e é compartilhado com os bancos ARBM. O volume previsto é bem abaixo de 1% de
  100 mil linhas por dia, mas o uso conjunto precisa ser conferido antes do PR 2.

## Gravação em modo sombra (PR 3)

`worker/diario-sombra.mjs` liga o diário aos eventos críticos **sem mudar nenhum comportamento existente**. É
independente do binding (PR 2): sem `env.DIARIO`, tudo é no-op.

- **`diarioSombra(env, ctx, ev)`**: `ev` é o evento ou, de preferência, uma função que o constrói. A gravação vai para
  `ctx.waitUntil`. O gancho nunca é esperado (`await`), nunca lança (o construtor também roda protegido) e não devolve
  nada que o chamador use. Uma falha (tabela ausente, D1 indisponível, conflito, corrida, PII recusada, `diario_timeout`)
  vira o log `{"evt":"diario_sombra","tipo","ok","code","seq"}`, **sem PII** (nunca a chave, a `ref` nem o payload), e
  soma num contador em memória do isolate (`diarioSombraStats`). **Nada vai para KV.**
- **Contexto por requisição:** o Worker central chama `comDiario(env, ctx, fn)` em volta de `processFetch`. Os ganchos
  sem `env`/`ctx` (o bundle legado, que roda atrás do servidor `node:http`, e o `recordEvent` do lead-magnet) acham o
  banco e o `waitUntil` por `AsyncLocalStorage`, carregado sem import estático (`process.getBuiltinModule`). Sem ele,
  usam o binding guardado em `globalThis.__ZEVANORY_DIARIO__` e deixam a promessa correr sozinha. Nesse caso a gravação
  pode ser cortada no fim da requisição, o que é aceitável em sombra.
- **Fila por isolate:** as gravações do mesmo isolate saem uma de cada vez. Sem a fila, gravações simultâneas esgotam o
  CAS (`diario_corrida`; medido no teste DS5 com 14 eventos). Cada gravação tem limite de 5 s (`diario_timeout`), para
  que um D1 travado não pare a fila. Uma rejeição nunca passa para a gravação seguinte.
- **Ids técnicos normalizados** (`techRef`): prefixo de letras mais só `[A-Za-z0-9]`. Pedido: `ord` + 32 hex. Mercado
  Pago: `mp` + id. Asaas, Stripe e Hotmart: `as`, `st` e `hm` + id. O detector de PII recusa dígitos com formato de CPF
  ou telefone delimitados por caractere não alfanumérico. Sem a normalização, ele recusava cerca de 1 em cada 10 mil
  UUIDs aleatórios (último bloco de 12 dígitos lido como `+55` e telefone) e também `mp_1234567890`. A forma é
  determinística: a reconciliação (PR 4) aplica a mesma função ao valor do Neon.

| Ponto | Arquivo / função | Tipo | Quando |
|---|---|---|---|
| Checkout Asaas | `cloudflare-worker.recovered.mjs` `handler11` | `order_created` | pedido novo inserido no Neon |
| Checkout Mercado Pago | idem `handler12` | `order_created` | idem |
| Checkout Stripe (certificação) | idem `handleStripeCheckout` | `order_created` | idem |
| Webhook Asaas | idem `handler15` | `payment_status` | evento financeiro novo (`inserted_count = 1`) |
| Webhook Mercado Pago | idem `handleMercadoPagoWebhook` | `payment_status` | idem |
| Entrega Mercado Pago | idem, depois de `ensureMercadoPagoDigitalDelivery` | `delivery_sent` | e-mail de entrega `sent` |
| Webhook Stripe (certificação) | idem `handleStripeWebhook` | `payment_status` | evento financeiro novo |
| Entrega Hotmart | `cp-nc012-digital-hotmart.mjs` | `delivery_sent` | `PURCHASE_APPROVED` / `PURCHASE_COMPLETE` |
| Estorno Hotmart | idem | `refund` | `PURCHASE_REFUNDED`, `CHARGEBACK`, ... |
| Reembolso próprio | `refund-flow.mjs` `executeRefund` | `refund` | claim gravado (antes do POST ao provedor) e estorno aprovado |
| Consentimento | `lead-magnet.mjs` `recordEvent` | `consent_given` / `consent_confirmed` / `consent_revoked` | depois do registro no Neon; `ref` = `subject_ref` (HMAC); sem `subject_ref`, nada |

Payloads só com fatos não pessoais: ids técnicos normalizados, valor, moeda, provedor, status, versão do consentimento
e `artifact_sha256`. Nunca e-mail, nome, CPF ou telefone, e o detector de `appendEvent` continua como última barreira.
O vigia de entregas pagas (cron) chama o webhook do Mercado Pago fora de `comDiario`. Lá só existe o binding global,
sem `waitUntil`.

## Testes e mutantes

- `tests/p20-diario-d1.test.mjs` (DJ1 a DJ8): encadeamento, adulteração, idempotência, conflito, corrida, LGPD,
  triggers e falhas do D1.
- `scripts/ci/mutants_p20_diario.py` com `mutants_p20_diario_allow.json`: 10 mutantes, todos precisam morrer.
- `tests/p20-diario-sombra.test.mjs` (DS1 a DS11): no-op sem binding, gravação e encadeamento via `waitUntil`, falhas
  que não lançam, PII recusada, construtores de cada tipo, contexto da requisição e integração real com Hotmart,
  lead-magnet e reembolso (resposta idêntica com, sem e com diário quebrado ou travado). Inclui também um teste
  estático dos 7 ganchos do bundle legado, que não carrega em Node.
- `scripts/ci/mutants_p20_diario_sombra.py` com `mutants_p20_diario_sombra_allow.json`: 13 mutantes, todos precisam
  morrer. Cobrem: bloquear a resposta, lançar, vazar PII no log, tentar gravar o comprador, gancho ausente de cada
  tipo, compat sem contexto, sem `waitUntil` e sem fila.
- `.github/workflows/p20-diario-d1-tests.yml` roda só em `pull_request`, sem segredo, com `contents: read`.
