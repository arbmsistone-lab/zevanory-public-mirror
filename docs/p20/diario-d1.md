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
4. Reconciliação diária Neon × diário, com relatório sem PII.
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
- **Deploy** (`.github/workflows/central-production-deploy.yml`), antes do `wrangler deploy`, no mesmo token e na mesma
  conta (nenhum segredo novo), sem nunca reprovar o deploy central por causa do diário:
  1. lê o banco pela API (`GET /accounts/.../d1/database/<UUID>`). Se o token não lê o banco, ou o nome não for
     `zevanory-diario-p20`, emite `::warning title=DIARIO_D1_MIGRACAO_PENDENTE` (ou `DIARIO_D1_BANCO_DIVERGENTE`) e
     **tira o binding só deste deploy**: o diário fica desligado (no-op), e o resto do Worker sobe igual;
  2. roda `wrangler d1 migrations apply zevanory-diario-p20 --remote`. Erro de autorização vira
     `::warning title=DIARIO_D1_MIGRACAO_PENDENTE`, e o binding fica, porque a gravação em sombra tolera a tabela
     ausente. Outra falha vira a anotação `::error title=DIARIO_D1_MIGRACAO_FALHOU`, e o deploy também segue;
  3. depois do deploy, um readback somente leitura (`select count(*) as n from diario_head`) registra
     `::notice`/`::warning title=DIARIO_D1_READBACK`, com `continue-on-error`. Ele nunca dispara o rollback.
- Um binding no candidato com banco diferente do UUID acima reprova o passo (`DIARIO_D1_BINDING`), antes do deploy.
  Isso só acontece se o gerador estiver quebrado.
- Testes: `tests/test_binding_budget_compaction.py` (classes `DiarioD1*`). Elas rodam o gerador real sobre a base
  fixada e o texto real dos dois passos do workflow, com `curl` e `npx` falsos.

**O que o proprietário precisa fazer se aparecer `DIARIO_D1_MIGRACAO_PENDENTE`:** dar a permissão **D1:Edit**, na
conta `1b26415802588185a86c1d4d3ebf5bdb`, ao token que o deploy central já usa (`CLOUDFLARE_PUBLIC_OWNER_API_TOKEN`).
Nenhum token ou segredo novo é necessário. O próximo deploy aplica a migração sozinho. Até lá, o diário fica sem
tabela (ou sem binding), e nada mais muda.

## Dependências do proprietário (nada disso foi feito pelo executor)

- Criar o banco D1 **`zevanory-diario-p20`** na conta `1b26415802588185a86c1d4d3ebf5bdb` e informar o UUID. **Feito:** UUID acima; banco vazio até o primeiro deploy com a migração.
- **Nunca** reutilizar `zevanory-certification-only` (`7ff006f3-...`) nem banco de outra conta.
- Tokens separados: **D1 Edit** só para o deploy e a migração, e **D1 Read** para a reconciliação e o ensaio.
- **7 dias em sombra** antes de qualquer fail-closed.
- **Cota:** o D1 Free é por conta e é compartilhado com os bancos ARBM. O volume previsto é bem abaixo de 1% de
  100 mil linhas por dia, mas o uso conjunto precisa ser conferido antes do PR 2.

## Testes e mutantes

- `tests/p20-diario-d1.test.mjs` (DJ1 a DJ8): encadeamento, adulteração, idempotência, conflito, corrida, LGPD,
  triggers e falhas do D1.
- `scripts/ci/mutants_p20_diario.py` com `mutants_p20_diario_allow.json`: 10 mutantes, todos precisam morrer.
- `.github/workflows/p20-diario-d1-tests.yml` roda só em `pull_request`, sem segredo, com `contents: read`.
