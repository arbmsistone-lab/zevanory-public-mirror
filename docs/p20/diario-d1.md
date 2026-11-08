# P20: diário de eventos críticos no Cloudflare D1 (desenho; PR 1 de 7)

Fonte: Roteiro Mestre v4.7, seção 9.1 ("Diário de eventos críticos" e "Operação durante falha de backup") e
contestação 0-D, item 1. **Estado: módulo, migração e testes prontos (PR 1). O PR 2 liga o binding `DIARIO` do
Worker central ao banco de produção e aplica a migração no deploy (seção "Binding e migração").** A gravação em modo
sombra é o PR seguinte; até lá nenhum código lê `env.DIARIO`.

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
2. Binding `DIARIO` no Worker central (banco do proprietário) e migração no deploy (seção "Binding e migração").
   A gravação em **sombra** (grava sem bloquear nada, mede erros) vem logo depois, independente deste binding.
3. Fila de pendências e reenvio (webhooks e entregas) e evento `erase` (LGPD: apagar no Neon registra só o hash).
4. Reconciliação diária Neon × diário, com relatório sem PII (seção "Reconciliação diária (PR 4)").
5. Integração ao ensaio mensal P20: reconstruir os eventos pós-backup e verificar a cadeia.
6. Fail-closed no checkout próprio e no formulário de leads, depois de 7 dias em sombra sem divergência.
7. Certificado: o RPO medido passa a contar o diário. A lacuna do inventário só sai depois de um ensaio aprovado.

## Binding e migração

| Item | Valor |
|---|---|
| Banco D1 | `zevanory-diario-p20` (criado pelo proprietário) |
| UUID | `1b1bfa19-ccc5-423a-bc1f-62d89020c8e2` |
| Conta | `1b26415802588185a86c1d4d3ebf5bdb` (a mesma do Worker central `zevanory`) |
| Binding no Worker | `DIARIO` (`env.DIARIO`) |
| Migrações | `migrations/d1` (`migrations_dir` do binding) |
| Proibido | `zevanory-certification-only` (`7ff006f3-...`): o gerador recusa com `DIARIO_D1_CERTIFICATION_DATABASE_FORBIDDEN` |

- **Gerador** (`scripts/deploy/prepare-central-candidate.py`, constante `DIARIO_D1_BINDING`): injeta o binding em
  `wrangler.central-fix.jsonc`. Recusa o banco de certificação em qualquer posição e um `DIARIO` já presente com outro
  banco (`DIARIO_D1_BINDING_CONFLICT`). É idempotente.
- **Orçamento de bindings:** `check-binding-budget.py` conta só secrets e vars. O binding D1 não conta, então o
  planejado continua **59/60**. O UUID vai no binding `d1_databases`, nunca em var.
- **Deploy** (`.github/workflows/central-production-deploy.yml`), antes do `wrangler deploy`, sempre com a credencial
  D1 **dedicada** de cada passo (seção "Credenciais dedicadas (DEC-P20-D1-01)"), sem nunca reprovar o deploy central
  por causa do diário:
  1. sem o segredo `CF_TOKEN_D1_DIARIO_MIGRATE`, emite `::warning title=DIARIO_D1_TOKEN_DEDICADO_AUSENTE` e **tira o
     binding só deste deploy** (diário desligado, no-op). Nenhuma chamada D1 sai, e não há queda para outro token;
  2. lê o banco pela API (`GET /accounts/.../d1/database/<UUID>`) com o token de migração. Se ele não lê o banco, ou
     se o nome não for `zevanory-diario-p20`, emite `::warning title=DIARIO_D1_MIGRACAO_PENDENTE` (ou
     `DIARIO_D1_BANCO_DIVERGENTE`) e tira o binding só deste deploy;
  3. roda `wrangler d1 migrations apply zevanory-diario-p20 --remote` com o token de migração. Erro de autorização
     vira `::warning title=DIARIO_D1_MIGRACAO_PENDENTE`, e o binding fica, porque a gravação em sombra tolera a
     tabela ausente. Outra falha vira a anotação `::error title=DIARIO_D1_MIGRACAO_FALHOU`, e o deploy também segue;
  4. depois do deploy, um readback somente leitura (`select count(*) as n from diario_head`) roda com o token de
     leitura `CF_TOKEN_D1_DIARIO_READ` e registra `::notice`/`::warning title=DIARIO_D1_READBACK`, com
     `continue-on-error`. Sem esse segredo, o readback não roda (aviso). Ele nunca dispara o rollback.
- Um binding no candidato com banco diferente do UUID acima reprova o passo (`DIARIO_D1_BINDING`), antes do deploy.
  Isso só acontece se o gerador estiver quebrado.
- Testes: `tests/test_binding_budget_compaction.py` (classes `DiarioD1*`). Elas rodam o gerador real sobre a base
  fixada e o texto real dos dois passos do workflow, com `curl` e `npx` falsos. O isolamento das credenciais está em
  `tests/test_diario_d1_credentials.py`.

**O que o proprietário precisa fazer se aparecer `DIARIO_D1_TOKEN_DEDICADO_AUSENTE` ou `DIARIO_D1_MIGRACAO_PENDENTE`:**
criar e cadastrar os tokens dedicados (roteiro na seção "Credenciais dedicadas (DEC-P20-D1-01)"). **Não** dê permissão
D1 ao token do deploy central: o contra-auditor recusou isso (DEC-P20-D1-01), e o deploy não precisa dela. O próximo
deploy aplica a migração sozinho. Até lá, o diário fica sem binding (ou sem tabela), e nada mais muda.

## Credenciais dedicadas (DEC-P20-D1-01)

**Decisão.** O contra-auditor GPT-6 deu NO-GO para ampliar o token compartilhado do deploy. Cada papel tem a sua
credencial, e a CI entrega cada uma **só** ao passo autorizado, no `env` do passo (nunca no do job):

| Papel | Segredo (environment `producao-critica`) | Permissão mínima | Único passo que recebe |
|---|---|---|---|
| Deploy do Worker | `CLOUDFLARE_PUBLIC_OWNER_API_TOKEN` (ou o legado `CLOUDFLARE_API_TOKEN`), sem mudança | **nenhuma permissão D1** | todos os passos do deploy, exceto os dois passos D1 |
| Migração D1 | `CF_TOKEN_D1_DIARIO_MIGRATE` | Conta > **D1 > Editar**, só a conta `1b26415802588185a86c1d4d3ebf5bdb` | `P20 diário D1 - migrações` |
| Leitura D1 (readback) | `CF_TOKEN_D1_DIARIO_READ` | Conta > **D1 > Ler**, só a mesma conta | `P20 diário D1 - readback` |

Nos dois passos D1, `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_PUBLIC_OWNER_API_TOKEN` ficam **vazios**. O token
compartilhado não chega ao processo, e cada chamada D1 passa o token dedicado de forma explícita. O registro está em
`ops/publishers.json` (`services.zevanory.d1_credentials`).

**O que a documentação da Cloudflare diz** (consultada em 07/11/2026):

- Para subir um Worker com binding D1, basta o papel **Editor no Worker**. Nenhuma permissão é necessária no banco
  vinculado. Permissão no recurso só é necessária para acessá-lo diretamente, por exemplo para consultar o D1
  ([Workers, Roles and permissions, Bindings](https://developers.cloudflare.com/workers/authorization/#bindings)).
  Por isso o token do deploy continua **sem D1**, e o upload com o binding não depende de nenhuma credencial D1.
- As permissões D1 de token são **D1 Read** e **D1 Edit** (na API, "D1 Write"), na categoria Conta
  ([API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)). A
  documentação não oferece escopo por banco para D1: o recorte mínimo documentado é a **conta**.
- `wrangler d1 execute --remote` usa o endpoint de consulta, que aceita **D1 Read** ou D1 Write
  ([Query D1 Database](https://developers.cloudflare.com/api/operations/cloudflare-d1-query-database)). O
  `GET` do banco também aceita D1 Read
  ([Get D1 Database](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/get/)). Logo,
  D1 Read basta para o readback.
- `wrangler d1 migrations apply --remote` grava (DDL e a tabela `d1_migrations`), e por isso precisa de **D1 Edit**.
  Erros `10000` e `7403` significam token sem a permissão do endpoint
  ([Debug D1](https://developers.cloudflare.com/d1/observability/debug-d1/)).
- O Wrangler usa as permissões do token em `CLOUDFLARE_API_TOKEN`, com `CLOUDFLARE_ACCOUNT_ID` definido. A CI fixa a
  conta nos dois passos
  ([Use granular permissions with Wrangler](https://developers.cloudflare.com/workers/authorization/#use-granular-permissions-with-wrangler)).

### Roteiro do proprietário: criar e cadastrar os dois tokens

Nunca envie o valor de um token a ninguém, nem ao executor, nem em issue, PR ou chat. Ele vai direto do painel da
Cloudflare para o GitHub.

**Token de migração (`CF_TOKEN_D1_DIARIO_MIGRATE`)**

1. No painel da Cloudflare, abra **Perfil** (ícone do usuário, canto superior direito) > **Tokens de API** >
   **Criar token** > **Criar token personalizado** (modelo personalizado, "Começar").
2. **Nome do token:** `zevanory-d1-diario-migrate`.
3. **Permissões:** uma única linha, **Conta** > **D1** > **Editar**. Não adicione mais nada: nem Workers, nem KV, nem
   Zona, nem Usuário.
4. **Recursos da conta:** **Incluir** > a conta `1b26415802588185a86c1d4d3ebf5bdb` (a conta "Zevanory@gmail.com's
   Account"). Não use "Todas as contas". Se a tela oferecer a escolha de um banco D1 específico, escolha só
   `zevanory-diario-p20`. A documentação atual não oferece essa opção, então a conta é o recorte esperado.
5. **Filtragem de endereço IP:** deixe em branco. Os executores do GitHub Actions mudam de IP, e um filtro quebraria o
   deploy.
6. **TTL:** defina uma data de término, por exemplo 90 dias, e anote para renovar antes.
7. **Continuar para o resumo**. Confira que o resumo mostra só "D1:Edit" em uma conta. Depois clique em **Criar
   token** e **copie o valor uma vez** (ele não aparece de novo).

**Token de leitura (`CF_TOKEN_D1_DIARIO_READ`)**

Repita os passos 1 a 7, com duas diferenças: o nome é `zevanory-d1-diario-read`, e a permissão é **Conta** >
**D1** > **Ler**.

**Cadastrar no GitHub (para cada token)**

1. Em `github.com/arbmsistone-lab/zevanory-public-mirror`, abra **Settings** > **Environments** >
   **producao-critica** > **Environment secrets** > **Add environment secret**.
2. **Name:** `CF_TOKEN_D1_DIARIO_MIGRATE` (ou `CF_TOKEN_D1_DIARIO_READ`). **Value:** cole o token. Clique em
   **Add secret**. Use o environment, não "Repository secrets": só o job do deploy (`environment: producao-critica`)
   pode ler.

**Depois de cadastrar**

- O próximo deploy central deve mostrar `::notice title=DIARIO_D1_MIGRACAO` e, após o deploy,
  `::notice title=DIARIO_D1_READBACK::diario_head presente (linhas=1)`.
- **Token do deploy sem D1:** se em algum momento você adicionou uma permissão D1 ao token do deploy central, remova-a
  (Perfil > Tokens de API > editar o token). O deploy não precisa dela.
- **P21 (token por Worker):** o token por Worker do `zevanory` também **não** precisa de D1. A documentação garante
  que subir o binding exige só Editor no Worker. Se um deploy real contrariar isso (falha do upload que cite o D1),
  o caminho mínimo é dar **D1 Read** (nunca Edit) só a esse token por Worker. Ele não seria usado em nenhuma chamada
  D1 da CI. Essa mudança exigiria nova decisão do contra-auditor.
- **Limitação:** a CI não consegue provar o escopo real de um token. Ela garante só *qual* segredo chega a cada passo.
  Conferir no resumo do painel que cada token tem só a permissão da tabela é responsabilidade do proprietário.

## Dependências do proprietário (nada disso foi feito pelo executor)

- Criar o banco D1 **`zevanory-diario-p20`** na conta `1b26415802588185a86c1d4d3ebf5bdb` e informar o UUID. **Feito:** UUID acima; banco vazio até o primeiro deploy com a migração.
- **Nunca** reutilizar `zevanory-certification-only` (`7ff006f3-...`) nem banco de outra conta.
- Tokens separados (DEC-P20-D1-01): **D1 Edit** só para a migração (`CF_TOKEN_D1_DIARIO_MIGRATE`) e **D1 Read** para o readback, a reconciliação e o ensaio (`CF_TOKEN_D1_DIARIO_READ`). O token do deploy fica sem D1. **Pendente:** criação e cadastro pelo proprietário (roteiro acima).
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

## Reconciliação diária (PR 4)

`worker/diario-reconcilia.mjs` (`reconciliaDiario`) roda dentro de `finalizeBackup` (o passo final do backup diário,
`/api/internal/backup/run?finalize=1`), que agora recebe o `sqlFactory` do Neon. O resultado vai para o campo `diario`
de `zpc:backup:v1:report`, e `scripts/ops/data-backup.mjs` imprime `DATA_BACKUP_DIARIO` (aviso quando não está `ok`).

- **Janela:** de T−48h a T−1h. A última hora fica de fora porque um evento pode ainda estar na fila do isolate. Cada
  evento é conferido em duas execuções seguidas.
- **Esperado (Neon):** uma consulta por fonte, sem nenhuma coluna pessoal. Cada linha passa pelos **mesmos
  construtores dos ganchos** (`eventoPedidoCriado`, `eventoPagamento`, `eventoEntrega`, `eventoReembolso`,
  `eventoConsentimento`), então a normalização (`techRef`, `parte`) é uma só:

  | Fonte | Linhas | Evento esperado |
  |---|---|---|
  | `orders` | `created_at` na janela | `order_created` |
  | `financial_events` | `received_at` na janela, com `order_id` | `payment_status` (status do provedor e `refunded_total`) |
  | `service_fulfillment` + `orders` | Mercado Pago, `delivered`, evidência com `email_status` `sent`, `delivered_at` na janela | `delivery_sent` (canal `email`) |
  | `refund_provider_claims` | `claimed_at` na janela (exceto `legacy_unknown`); `reconciled_status` `approved` com `reconciled_at` na janela | `refund` `provider_call_may_have_been_sent`; `refund` `approved` |
  | `zevanory_lead_events` | `consent_given`, `confirmed`, `revoked_and_erased` com `subject_ref` | `consent_*` |

  O id do estorno do provedor fica só no KV, então o `refund approved` é conferido pela chave-base mais `:`
  (qualquer `refund_ref`). A chave de consentimento leva o instante: o gancho agora usa o instante gravado no Neon
  (`insert ... returning`, expressão `neonTsMs` compartilhada), e a reconciliação usa a mesma expressão. O estorno
  confirmado pela consulta ao provedor (`reconcileRefund`) ganhou o gancho `refund approved` que faltava.
- **Fora do escopo** (contados em `fora_escopo`, nunca como sobra): eventos Hotmart (vivem no KV e no provedor) e os
  tipos `erase` e `fiscal_ref`.
- **Presente (D1):** uma consulta fixa (`SQL_JANELA_D1`, só `SELECT`) por página de 500 linhas, ordenada por `seq`.
  Os limites da janela são achados por `ts_ms` com o índice `diario_v1_ts` (migração `0002_diario_v1_ts.sql`, só um
  índice), e a linha anterior ao trecho vem junto como âncora. Acima de 40 páginas, o resultado é `incompleto`.
- **Margem de 15 min:** o `ts_ms` do diário é o relógio do Worker; o do Neon é o `now()` da transação. Falta =
  esperado no núcleo da janela e ausente no diário lido com margem; sobra = presente no núcleo e sem origem no Neon lido
  com margem.
- **Cadeia:** `verifyChain` do trecho a partir da âncora. Quebra = divergência.
- **Resultado:** `{estado, fase, janela, esperados, presentes, faltando, sobrando, cadeia_ok, cadeia, por_tipo,
  fora_escopo, amostra (até 20 chaves de cada lado), neon.fontes, d1.consultas, d1.linhas}`. Estados: `ok`,
  `divergente`, `incompleto` (fonte do Neon com erro, D1 indisponível, páginas excedidas) e `nao_configurado` (sem
  `env.DIARIO`: nenhuma consulta, sem falha e sem alerta). Tabela de origem ainda inexistente conta como fonte vazia.
- **Cota:** por dia, 5 consultas ao Neon e 1 consulta D1 por página. As linhas lidas no D1 ficam proporcionais à janela
  (centenas por dia no volume previsto), muito abaixo de 30% da cota do D1 Free (5 milhões de linhas lidas por dia).

### Fase: sombra agora, corte para "ativo" depois

`DIARIO_FASE = "sombra"` no código. Em sombra, `divergente` e `incompleto` viram o alerta
`diario_<estado>:sombra` em `warnings`, e o backup **não** reprova. Em `"ativo"`, viram a falha de P20
`diario_<estado>` em `failures`, e o relatório sai com `ok: false`. Um valor desconhecido cai em `"ativo"` (o lado
estrito).

**Corte para "ativo"** (um PR revisado que muda só a constante): depois de **7 dias seguidos** com o binding ligado,
os dois tokens cadastrados e `DATA_BACKUP_DIARIO` com `estado: "ok"` em todas as execuções. Qualquer `divergente` ou
`incompleto` zera a contagem, e a causa precisa ser explicada antes de recomeçar. O fail-closed do checkout e dos leads
(item 6 do plano) só vem depois do corte.

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
- `tests/test_diario_d1_credentials.py` (C1 a C13, DEC-P20-D1-01). Lê o workflow real e simula o `env` que o GitHub
  monta em cada passo de cada job, com segredos falsos de valores distintos. Depois executa os passos reais com `curl`
  e `npx` falsos, que registram o token de cada chamada. Prova que cada token D1 aparece só no seu passo. Prova também
  que, sem o segredo dedicado, há aviso e o deploy sai sem binding, sem nenhuma chamada D1. A migração usa o token
  dedicado, o readback usa o token de leitura (sem queda para outro), o deploy segue com o token atual e o token
  compartilhado nunca recebe chamada D1. Confere ainda o registro em `ops/publishers.json` e o detector T1
  (`scripts/deploy/t1-write-scan.mjs`, PR #990: classe `d1` vista na migração, `TOKEN_OWNER` com os dois tokens
  dedicados do serviço `zevanory`, entrada `write_paths` com a credencial dedicada). Se o detector sair da árvore, o
  teste usa o mesmo critério da classe `d1`. São 12 mutantes, e todos precisam
  morrer.
- `tests/p20-diario-reconcilia.test.mjs` (RC1 a RC10): D1 falso com as migrações reais e Neon falso. Cobre sem
  binding, tudo casa, falta, sobra, normalização diferente, cadeia e âncora adulteradas, bordas da janela, paginação e
  índice, fontes ausentes ou com erro, sombra contra ativo no relatório e os ganchos reais de consentimento e de
  `reconcileRefund`. `tests/integration/diario-reconcilia-postgres.test.mjs` roda as consultas reais num PostgreSQL
  descartável (opcional, com `DIARIO_PG_HOST`).
- `scripts/ci/mutants_p20_diario_reconcilia.py` com `mutants_p20_diario_reconcilia_allow.json`: 18 mutantes, todos
  precisam morrer.
- `.github/workflows/p20-diario-d1-tests.yml` roda só em `pull_request`, sem segredo, com `contents: read`.
