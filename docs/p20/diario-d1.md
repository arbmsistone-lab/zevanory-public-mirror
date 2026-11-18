# P20: diário de eventos críticos no Cloudflare D1 (desenho; PR 1 de 7)

Fonte: Roteiro Mestre v4.7, seção 9.1 ("Diário de eventos críticos" e "Operação durante falha de backup") e
contestação 0-D, item 1. **Estado: módulo, migração e testes prontos (PR 1). O PR 2 liga o binding `DIARIO` do
Worker central ao banco de produção e aplica a migração no deploy (seção "Binding e migração").** A gravação em modo
sombra é o PR seguinte; até lá nenhum código lê `env.DIARIO`.

**Desde o NO-GO do GPT-6 sobre o primeiro deploy (NC-P2b-DEP-01/02/03), o binding só entra num deploy disparado com
`diario_d1=certificar` e `motivo=d1-config`, que é fail-closed, ou, depois de uma certificação PASS e da troca do padrão
versionado, no modo `manter` (religa só um banco já certificado); todo o resto sai sem `DIARIO` (seção "Primeiro deploy
com D1: modos off, certificar e rollback").**

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
5. Integração ao ensaio mensal P20: reconstruir os eventos pós-backup e verificar a cadeia (seção "Ensaio mensal lê
   o diário").
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
  `wrangler.central-fix.jsonc` **só quando `DIARIO_D1_MODO=certificar`**. Em `off`, `rollback` ou sem modo (push,
  dry-runs e os outros workflows que chamam o gerador), o candidato sai **sem** `DIARIO`, e um `DIARIO` que viesse da
  base é tirado. Modo desconhecido é recusado (`DIARIO_D1_MODO_INVALIDO`). Recusa o banco de certificação em qualquer
  posição e em qualquer modo, e um `DIARIO` já presente com outro banco (`DIARIO_D1_BINDING_CONFLICT`). É idempotente.
- **Orçamento de bindings:** `check-binding-budget.py` conta só secrets e vars. O binding D1 não conta, então o
  planejado continua **59/60**. O UUID vai no binding `d1_databases`, nunca em var.
- **Deploy** (`.github/workflows/central-production-deploy.yml`): o comportamento depende do input `diario_d1`
  (seção "Primeiro deploy com D1: modos off, certificar e rollback"). Até o #1015 a migração e o readback eram
  best-effort; o GPT-6 deu NO-GO (NC-P2b-DEP-01/02/03) e agora `certificar` é fail-closed e `off` é o padrão.
- Testes: `tests/test_binding_budget_compaction.py` (classes `DiarioD1*`) e `tests/test_diario_d1_credentials.py`.
  Elas rodam o gerador real sobre a base fixada, o texto real dos passos do workflow, o `promotion_guard.py` real e o
  `scripts/deploy/diario_d1_certify.py` real, com `curl` e `npx` falsos. Os mutantes estão nos dois arquivos.

## Primeiro deploy com D1: modos off, certificar e rollback

**Por quê.** O GPT-6 deu NO-GO para o primeiro deploy central com o D1. Os segredos `CF_TOKEN_D1_DIARIO_MIGRATE` e
`CF_TOKEN_D1_DIARIO_READ` já estavam cadastrados no environment `producao-critica`. Com o workflow anterior, qualquer
deploy central (inclusive um push rotineiro) teria migrado e ligado o binding em modo best-effort: uma migração que
falhasse só gerava aviso, o binding podia ficar, e um readback que falhasse não reprovava o job. Os três pontos:

| NC | O que pedia | Como ficou |
|---|---|---|
| NC-P2b-DEP-01 | Rollback real: redeploy controlado sem `DIARIO`, com conferência na Cloudflare, sem apagar tabelas | `diario_d1=rollback` (e o rollback automático de uma certificação que falha) |
| NC-P2b-DEP-02 | Migração e readback fail-closed; aviso nunca vira PASS | `diario_d1=certificar` |
| NC-P2b-DEP-03 | Promover o MESMO SHA quando a mudança é só de configuração, sem afrouxar a proteção contra regressão | `motivo=d1-config` no `promotion_guard.py` |
| NC-1017-01 (follow-up) | "Qualquer falha depois do deploy dispara rollback" valia para FAIL, mas o pós-promoção `NAO_COMPROVADO` mantinha a versão e só reprovava depois | em `certificar`, `NAO_COMPROVADO` também dispara o rollback automático; conferência do binding exige as duas fontes; modo `manter` para a sombra |

**Os modos (input `diario_d1` do `workflow_dispatch`).** O job `guard` valida o modo e o motivo antes do guard de
promoção (passo `P20 diário D1 - modo e motivo do dispatch`, depois do checkout). Push e dispatch com
`diario_d1=padrao` usam o **padrão versionado** em `.github/diario-d1-modo.json` (`"padrao": "off"` hoje; só `off` ou
`manter` são aceitos ali; arquivo ausente ou inválido reprova com `DIARIO_D1_PADRAO_INVALIDO`). O motivo padrão é
`rotina`. Push não aceita input.

| Modo | Binding `DIARIO` | Chamadas D1 | Segredos D1 no passo | Falha |
|---|---|---|---|---|
| `off` (padrão de hoje) | nunca, mesmo com os segredos cadastrados | nenhuma | valor vazio (a expressão só entrega no modo que usa o segredo) | binding presente depois do deploy reprova (e dispara o rollback automático); API da Cloudflare inalcançável vira aviso **"NAO_COMPROVADO (não é PASS)"** |
| `manter` (sombra, depois de uma certificação; **só** com `"padrao": "manter"` no arquivo versionado) | religa só se o banco **já** estiver certificado | SELECT de conferência antes (token de **leitura**); o mesmo SELECT depois (token de leitura); **nunca** migra | só `CF_TOKEN_D1_DIARIO_READ`; o de migração fica vazio | banco não certificado, token ausente ou qualquer conferência que falhe: tira o binding **e reprova antes do deploy**; falha depois (inclusive pós-promoção `NAO_COMPROVADO`) reprova e o rollback automático volta à versão anterior, conferindo a configuração do `DIARIO` (coerente) nas duas fontes; binding efetivo exige as **duas** fontes |
| `certificar` | só se toda a pré-promoção passar | migração + SELECT de certificação (token de migração) antes; SELECT de certificação (token de leitura) depois | migração só aqui; leitura aqui e em `manter` | qualquer falha antes da promoção tira o binding **e reprova o job antes do deploy** (produção fica como estava); qualquer falha depois, **inclusive pós-promoção `NAO_COMPROVADO`** (NC-1017-01), reprova o job e o rollback automático volta à versão anterior (sem `DIARIO`), com conferência nas duas fontes |
| `rollback` | nunca | nenhuma | valor vazio | binding ainda presente **ou** configuração efetiva não comprovada reprova |

`certificar` e `rollback` exigem `motivo=d1-config`, e `d1-config` só vale com eles (`manter` e `off` são rotina).
`manter` por dispatch só é aceito com o padrão versionado em `manter` (NC-1018-01): com o padrão em `off`, um dispatch
`manter` é erro (`DIARIO_D1_MODO_INVALIDO`), senão ele ligaria o D1 junto com código novo por fora do arquivo protegido.
O único caminho para ligar o D1 com o padrão em `off` é `certificar` + `d1-config` (mesmo SHA). Nenhum caminho do workflow apaga tabela, índice, gatilho ou banco D1 (há teste disso): o rollback só tira o
binding, e as tabelas e as migrações ficam no banco para a próxima certificação.

**`certificar`, passo a passo** (`scripts/deploy/diario_d1_certify.py` faz as conferências; ele não grava nada):

1. o gerador injeta `DIARIO` (UUID `1b1bfa19-...`); o passo `P20 diário D1 - migrações` confere o UUID no candidato;
2. segredo de migração ausente, `GET /d1/database/<UUID>` sem 200 ou com outro nome: `::error` e reprova;
3. `wrangler d1 migrations apply zevanory-diario-p20 --remote` (aplica 0001, 0002 e 0003 que faltarem): falha reprova;
4. um único SELECT só de leitura (`diario_d1_certify.py sql`) devolve `diario_head`, `d1_migrations`, os objetos de
   `sqlite_master` e as contagens `abandono_*`. `check --fase antes` exige: `diario_head` = 1 linha; `d1_migrations` =
   exatamente `0001_diario_v1.sql`, `0002_diario_v1_ts.sql`, `0003_abandono_v1.sql`, nessa ordem; os objetos iguais aos
   `CREATE ... IF NOT EXISTS` das três migrações mais `d1_migrations` (6 tabelas, 4 índices, 6 gatilhos; sem faltar e
   sem sobrar); `abandono_envio_v1`, `abandono_compra_v1` e `abandono_supressao_v1` com 0 linhas (o abandono está no
   estágio desligado). Uma migração nova em `migrations/d1` recusa a certificação até ser revisada
   (`DIARIO_D1_MIGRACOES_NAO_REVISADAS`);
5. só então o `wrangler deploy` sobe o Worker com o binding;
6. `P20 diário D1 - binding efetivo no Worker publicado`: lê na Cloudflare o deployment ativo (uma versão a 100%), a
   tag dessa versão (= este SHA) e os bindings da versão (`result.resources.bindings` de `/versions/<id>`) e de
   `/settings`; em `certificar` e `manter` exige as **duas** listas (NC-1017-01), com `DIARIO` do tipo `d1` e o UUID
   certo nas duas, concordando entre si. A documentação pública da Cloudflare não garante a lista de bindings na
   resposta de `/versions/<id>`; se ela não vier, o resultado é `NAO_COMPROVADO` e a certificação **reprova**
   (fail-closed). Se isso acontecer no primeiro dispatch, a correção é revisar a fonte com o GPT-6, nunca aceitar uma
   fonte só. Em **qualquer** fonte lida e em qualquer modo, uma lista **vazia** ou sem o binding sentinela
   `ZEVANORY_PRIVATE_ARTIFACTS` (que todo candidato carrega) é `NAO_COMPROVADO`, nunca "ausente"; com as duas fontes,
   os nomes dos bindings precisam coincidir, senão também é `NAO_COMPROVADO` (NC-1018-02);
7. `P20 diário D1 - readback obrigatório da certificação`: com o token de leitura, o mesmo SELECT; `check --fase
   depois` exige tudo do item 4 **e** igualdade com o resumo de antes (migrações, objetos, `diario_head`, contagens
   `abandono_*`). Exige também o PASS do item 6. Sem `continue-on-error`. Só aqui sai
   `::notice title=DIARIO_D1_CERTIFICACAO::PASS`.

**Qual token lê a configuração efetiva.** O token do **deploy** deste job (`CF_TOKEN_ZEVANORY` com cutover P21, ou o
legado). Ele já lê `/workers/scripts/zevanory/settings` no passo `Inspect current zevanory bindings` e
`/deployments` + `/versions/<id>` no `promotion_guard.py`, ou seja, já tem a leitura de scripts do Worker `zevanory`
que essas rotas exigem. O `CF_TOKEN_D1_DIARIO_READ` é só D1 Read e **não** lê Worker; dar Workers a ele quebraria a
separação do DEC-P20-D1-01. Se um dia o token do deploy perder essa leitura, a conferência sai `NAO_COMPROVADO`:
reprova em `certificar` e `rollback`. A alternativa, nesse caso, é um token próprio só com **Workers Scripts Read** na
conta, entregue só ao passo de conferência (decisão do GPT-6), e nunca ampliar o token D1.

**NC-P2b-DEP-03: o guard e o mesmo SHA.** Lido no código (`scripts/deploy/promotion_guard.py`, `decide`), o guard de
rotina **já** promove o mesmo SHA (`promote`, `same_as_live_redeploy`) quando as fontes concordam ou só uma é
legível; `skip-superseded` só acontece com candidato mais antigo que o vivo. O que impede um dispatch do mesmo SHA é
`refuse` (fontes divergentes ou produção ilegível). O risco real era outro: o dispatch roda na **ponta** de
`gh-pages`, e se a ponta tiver commits que não dispararam deploy (como o #1015), um dispatch "só de configuração"
promoveria código junto (`forward_of_live`). Por isso `--motivo d1-config` é estreito: promove só se o candidato for
**exatamente** o SHA vivo e as **duas** fontes (tag da Cloudflare e `/api/release`) estiverem legíveis e iguais
(`same_sha_config_only_d1`). Candidato à frente (`config_only_candidate_not_live`), mais antigo
(`config_only_candidate_older_than_live`, que na rotina seria `skip-superseded`), divergente, com uma fonte só ou
motivo desconhecido: `refuse`. A rotina não mudou. Teste: `DiarioD1PromotionGuardTest`.

**NC-1017-01: pós-promoção `NAO_COMPROVADO` em `certificar` (e em `manter`, NC-1018-01).** O passo `Post-promotion effective version (T1)` roda o
guard com `--unproven-exit 0` em todos os modos de rotina: um observador inalcançável não desfaz uma versão boa, e o
`Certification gate` reprova o run depois. Em `certificar` isso contradizia a promessa "qualquer falha depois do deploy
dispara o rollback". Agora, só em `certificar`, o passo próprio `P20 diário D1 - pós-promoção NAO_COMPROVADO em
certificar dispara o rollback`, logo depois do pós-promoção, falha com `::error title=DIARIO_D1_POS_PROMOCAO_NAO_COMPROVADO`;
o rollback automático (que roda em `failure()`) volta à versão anterior e confere `--expect ausente --duas-fontes`. A
regra geral (`--unproven-exit 0`) e os testes do T1 que a fixam ficam intactos. É seguro porque `certificar` só promove o SHA já
vivo (`d1-config`): o rollback volta à versão anterior do **mesmo código**, sem o `DIARIO`. A mesma exceção vale para
`manter` (recomendação do GPT-6 na NC-1018-01): um deploy com o D1 ligado não fica no ar sem prova da versão efetiva.
Em `manter` o rollback volta também o código anterior (é um deploy de rotina) e confere, nas duas fontes, que a
configuração do `DIARIO` ficou **coerente** (`--expect coerente`: ausente nas duas fontes, ou presente com o UUID certo
nas duas). Em `off` e `rollback` o comportamento não mudou. Testes: `check_wf_postpromo`, `check_wf_auto_rollback` e
`check_wf_certification_gate` (os dois últimos **executam** os passos).

**Período de sombra: por que `manter` e não congelamento.** Depois de uma certificação PASS, um push rotineiro em `off`
tiraria o binding sem querer. Avaliei duas saídas:

- **congelar os deploys por 7 dias** (push/rotina recusados enquanto houver certificação ativa): bloqueia correções
  urgentes do Worker central por uma semana e exige um estado "certificação ativa" fora do Git (ou outro interruptor)
  e uma válvula de escape, que reabre o problema;
- **`manter`** (escolhido): um modo de rotina que religa o binding **só se o banco já estiver certificado** (a mesma
  conferência do item 4: 3 migrações, objetos, `diario_head` = 1, `abandono_*` = 0), com o token de **leitura**, sem
  nunca migrar, com o binding efetivo nas duas fontes e o readback obrigatório. Qualquer falha tira o binding e
  reprova antes do deploy. Os deploys de código continuam fluindo, e o D1 nunca é ligado num banco não certificado.

O padrão é versionado (`.github/diario-d1-modo.json`, caminho reservado ao proprietário porque está em `.github/**`), e
o push do merge que troca o padrão já roda no novo modo. A ordem é obrigatória: **primeiro** a certificação PASS,
**depois** o PR que troca `"padrao": "off"` por `"manter"` (decisão do proprietário e do GPT-6). Ao contrário, todo push
reprovaria até a certificação, e o dispatch `certificar` (que exige o SHA vivo) não teria como rodar. Entre a
certificação e o merge da troca, não mescle outro PR que dispare o deploy central (ele rodaria em `off` e tiraria o
binding; seguro, mas exigiria nova certificação). Para desligar o D1 de propósito durante a sombra: dispatch
`diario_d1=off` (rotina) ou `rollback` + `d1-config`. Limite conhecido: a conferência exige `abandono_*` = 0; ligar o
e-mail de abandono (estágio além de "desligado") exige rever essa regra antes, senão `manter` reprova.

**Riscos residuais e recuperação determinística.**

- **Smoke falha num `diario_d1=rollback`.** O redeploy sem `DIARIO` falhou num smoke, e o rollback automático volta à
  versão **anterior**, que tinha o `DIARIO`. A saúde vem primeiro: a sombra tolera o binding. O log mostra
  `::error title=DIARIO_D1_ROLLBACK_NAO_CONCLUIDO` e o run fica vermelho. Recuperação: (1) ler o smoke que falhou
  (é o mesmo código, então a causa não é o D1); (2) corrigir a causa ou esperar a instabilidade passar; (3) repetir
  `diario_d1=rollback` + `motivo=d1-config` no mesmo SHA vivo até verde. Enquanto isso, o diário segue em sombra.
- **Health não volta depois do rollback automático** (`AUTO_ROLLBACK_HEALTH=FAIL`, `::error title=AUTO_ROLLBACK_HEALTH_FAIL`).
  A produção está num estado não comprovado. Recuperação: (1) não disparar nada às cegas; (2) conferir no painel da
  Cloudflare a versão ativa e se ela tem `DIARIO` (Workers > zevanory > Deployments/Settings); (3) se `/api/release` e
  `/api/health` voltarem, rodar `t1-publisher-guard` com `recheck_service=zevanory` e, se o `DIARIO` precisar sair,
  `diario_d1=rollback` + `d1-config`; (4) se a produção seguir ilegível, o guard recusa qualquer deploy
  (`production_version_unknown`) e vale o procedimento `recovery_when_production_unreadable` de
  `ops/publishers.json` (o proprietário confirma a versão viva e dispara o workflow canônico). Nenhum passo apaga
  tabela; o banco fica intacto para a próxima certificação.
- **Rollback automático de uma certificação sem conferência** (API inalcançável depois do `wrangler rollback`):
  `::error title=DIARIO_D1_ROLLBACK_AUTOMATICO`. Recuperação: `diario_d1=rollback` + `d1-config` no mesmo SHA.
- **Rollback automático de um `manter`** confere a configuração (`--expect coerente --duas-fontes`). Incoerente ou não
  comprovada: `::error title=DIARIO_D1_ROLLBACK_AUTOMATICO`. Recuperação: dispatch `diario_d1=off` (rotina) ou
  `rollback` + `d1-config`, e conferir o binding efetivo verde.
- **Padrão em `manter` com o banco quebrado** (NC-1018-04). Se o banco deixar de passar na conferência (migração
  faltando, objeto a mais, `diario_head` diferente de 1, `abandono_*` com linhas, token de leitura revogado, API D1
  fora), **todo** deploy de rotina reprova antes da promoção e nada novo vai ao ar. A versão anterior, **com** o
  `DIARIO`, continua servindo (a sombra tolera o banco quebrado: falha do diário não afeta a resposta). Procedimento:
  (1) ler o `::error` do passo `P20 diário D1 - migrações` (título `DIARIO_D1_*`) para saber o que falhou;
  (2) para destravar os deploys **já**: dispatch `diario_d1=off` (rotina, sai sem `DIARIO`) ou `rollback` +
  `d1-config` (mesmo SHA, com conferência obrigatória); (3) PR que volta `.github/diario-d1-modo.json` para `"off"`,
  senão o próximo push tenta `manter` de novo; (4) corrigir o banco ou o token e só então recertificar (`certificar` +
  `d1-config`) e voltar o padrão para `manter`. Nenhum passo apaga tabela.

### Roteiro do primeiro deploy com D1

Pré-condições: este PR mergeado; o push do merge dispara um deploy `off` (sem `DIARIO`) que precisa terminar verde;
os dois segredos D1 no environment `producao-critica`.

1. **Confirmar o SHA vivo.** Em Actions > ZEVANORY central production deploy, o run do push do merge: no job
   `guard`, `PROMOTION_GUARD_zevanory: promote` e, no job `deploy`, `DIARIO_D1_MODO::diario_d1=off`,
   `DIARIO_D1_BINDING_EFETIVO::PASS: binding DIARIO ausente` e `POST_PROMOTION_zevanory: PASS`. Anote o SHA. Este
   follow-up (NC-1017-01) também precisa estar mesclado e com o deploy dele verde antes do dispatch. A ponta de
   `gh-pages` precisa ser esse SHA (sem merge depois dele); se não for, primeiro deixe o deploy rotineiro da ponta
   terminar.
2. **Disparar a certificação.** Run workflow em `gh-pages` com `diario_d1 = certificar` e `motivo = d1-config`.
3. **No log, em ordem:**
   - job `guard`: `DIARIO_D1_MODO::diario_d1=certificar motivo=d1-config`, depois
     `PROMOTION_GUARD_zevanory::promote (same_sha_config_only_d1) cloudflare=<SHA> readback=<SHA>`;
   - `Reconstruct exact production candidate`: `DIARIO_D1_CANDIDATO=com_binding modo=certificar`;
   - `P20 diário D1 - migrações`: `DIARIO_D1_MIGRACAO::...`, `DIARIO_D1_CHECK_ANTES=PASS head=1 migracoes=3 objetos=16
     abandono=0` e `DIARIO_D1_PRE_PROMOCAO::PASS`;
   - `Deploy repaired production worker`: a tabela de bindings do wrangler lista `env.DIARIO (zevanory-diario-p20)`;
   - `P20 diário D1 - binding efetivo`: `DIARIO_D1_BINDING_EFETIVO={... "estado": "PASS" ...}` e o notice PASS;
   - `P20 diário D1 - readback obrigatório`: `DIARIO_D1_CHECK_DEPOIS=PASS ...` e
     `DIARIO_D1_CERTIFICACAO::PASS`;
   - `Post-promotion effective version (T1)`: `POST_PROMOTION_zevanory: PASS`.
4. **O que reprova** (o run fica vermelho e nada disso é "aviso"): qualquer `::error` com título `DIARIO_D1_*`,
   `DIARIO_D1_MODO_INVALIDO`, `MOTIVO_INVALIDO` ou `PROMOTION_GUARD_zevanory::refuse (config_only_...)`. Antes do deploy
   (migrações e conferência), a produção fica como estava, sem `DIARIO`. Depois do deploy, o rollback automático roda
   (também quando o pós-promoção sai `NAO_COMPROVADO`) e confere `DIARIO_D1_ROLLBACK_AUTOMATICO::versão ativa sem o
   binding DIARIO`; se essa conferência falhar, rode o item 6.
5. **Período de sombra:** depois do PASS, abrir o PR que troca `.github/diario-d1-modo.json` para `"padrao": "manter"`
   (decisão do proprietário e do GPT-6). No push desse merge: `DIARIO_D1_MODO::diario_d1=manter ... padrao=manter`,
   `DIARIO_D1_PRE_PROMOCAO::PASS (diario_d1=manter)`, binding efetivo PASS nas duas fontes e
   `DIARIO_D1_CERTIFICACAO::PASS (diario_d1=manter)`. Nenhuma linha `DIARIO_D1_MIGRACAO`.
6. **Rollback manual (se precisar desligar o D1 depois de uma certificação PASS):** Run workflow com
   `diario_d1 = rollback` e `motivo = d1-config` no mesmo SHA vivo. Verde só com `DIARIO_D1_MODO::diario_d1=rollback`,
   `DIARIO_D1_CANDIDATO=sem_binding modo=rollback` e `DIARIO_D1_BINDING_EFETIVO::PASS: binding DIARIO ausente`. As
   tabelas e as migrações ficam no banco. Um deploy `off` também tira o binding, mas sem o rigor do rollback (em
   `off`, API inalcançável é só "não comprovado"). Com o padrão em `manter`, volte também o arquivo para `off` por PR,
   senão o próximo push religa o binding (o banco continua certificado).

## Credenciais dedicadas (DEC-P20-D1-01)

**Decisão.** O contra-auditor GPT-6 deu NO-GO para ampliar o token compartilhado do deploy. Cada papel tem a sua
credencial, e a CI entrega cada uma **só** ao passo autorizado, no `env` do passo (nunca no do job):

| Papel | Segredo (environment `producao-critica`) | Permissão mínima | Único passo que recebe |
|---|---|---|---|
| Deploy do Worker | `CLOUDFLARE_PUBLIC_OWNER_API_TOKEN` (ou o legado `CLOUDFLARE_API_TOKEN`), sem mudança | **nenhuma permissão D1** | todos os passos do deploy, exceto os dois passos D1 |
| Migração D1 | `CF_TOKEN_D1_DIARIO_MIGRATE` | Conta > **D1 > Editar**, só a conta `1b26415802588185a86c1d4d3ebf5bdb` | `P20 diário D1 - migrações`, e só com `diario_d1=certificar` |
| Leitura D1 (readback) | `CF_TOKEN_D1_DIARIO_READ` | Conta > **D1 > Ler**, só a mesma conta | `P20 diário D1 - readback`, e só com `diario_d1=certificar` |

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

- Nenhum deploy rotineiro usa os tokens (`diario_d1=off` é o padrão). Eles só entram na certificação disparada pelo
  proprietário (seção "Primeiro deploy com D1: modos off, certificar e rollback", roteiro).
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
  `divergente`, `incompleto` (fonte do Neon com erro ou com linha que os construtores recusam, `fonte:linha_invalida`;
  D1 indisponível; páginas excedidas) e `nao_configurado` (sem `env.DIARIO`: nenhuma consulta; sem falha e sem alerta
  em sombra, falha de P20 `diario_nao_configurado` em ativo). Tabela de origem ainda inexistente conta como fonte vazia.
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

## Ensaio mensal lê o diário

O ensaio mensal (`.github/workflows/p20-monthly-restore-drill.yml`) ganhou um passo próprio, antes do ensaio:
**`P20 diário D1 - leitura para o ensaio`**. Só esse passo recebe `CF_TOKEN_D1_DIARIO_READ` (D1 Read, no `env` do
passo, nunca do job). Ele roda `scripts/p20/diario-d1-read.mjs`, que usa só `POST /accounts/<conta>/d1/database/<id>/query`
com duas consultas `SELECT` fixas: a cabeça e uma página de linhas por `seq`, até o `seq` da cabeça lida (retrato
consistente de um diário só de inclusão). O leitor recusa qualquer outra SQL antes da rede. A leitura vai para um
arquivo `0600` no `RUNNER_TEMP`, nunca para artefato nem log. Sem o segredo, o passo emite um aviso, e o ensaio dos dados
segue igual.

Depois da restauração conferida, `scripts/p20/restore-drill-diario.mjs` faz a prova no **mesmo** Postgres efêmero (de
novo `assertEphemeralTarget`):

1. **Cadeia:** `verifyChain` de todas as linhas, da genesis até a cabeça lida (detecta adulteração e corte do fim).
2. **Reaplicação mínima:** as linhas com `ts_ms` maior que o corte menos 15 min vão para a tabela
   `p20_diario_reconstruido` (as colunas do diário) e são relidas. A releitura tem de ser idêntica, coluna a coluna. O
   corte é o início mais antigo das partes da cópia restaurada.
3. **Conjunto:** na janela [corte − 48 h, leitura], restaurado ∪ reconstruído = diário. "Restaurado" são as event_key
   que o banco restaurado gera pelas mesmas consultas e construtores da reconciliação diária (`NEON_FONTES`). Falta é um
   evento da cópia que o diário não tem. Sobra é um evento do diário que não está nem na cópia nem na reconstrução.
4. **`rpo_critico_medido_s`** = falha simulada (início do ensaio) − instante da leitura do diário. Só com a prova
   completa; caso contrário, `null`.

O registro do ensaio leva o bloco `diario` (contagens, booleanos, `seq` da cabeça, até 10 event_key) e
`rpo_critico_medido_s`. **`diario_d1` só sai de `not_covered` com a prova completa num ensaio `APROVADO`**
(`diarioProvado`): estado `provado`, cadeia, reaplicação e conjunto conferidos, falta e sobra zero, linhas = `seq` da
cabeça e RPO crítico igual ao medido. A releitura estrita (`validateRecord`) recusa um registro que tire a lacuna sem
essa prova (`diario_d1_unproven`) ou que publique RPO crítico sem ela. Sem prova, a linha fica com o motivo medido (por
exemplo, `diario_d1: token CF_TOKEN_D1_DIARIO_READ ausente no ensaio`, `diario_d1: cadeia_quebrada`,
`diario_d1: conjunto_divergente`).

**Fase (NC-PR6-01, lista positiva):** em `DIARIO_FASE = "sombra"`, um diário sem prova não reprova o ensaio dos dados.
Fora da sombra (`"ativo"` ou qualquer valor desconhecido), **só** o estado `provado` com a prova completa passa
(`DIARIO_ESTADOS_APROVADOS = ["provado"]` e `diarioProvado`). Qualquer outro estado reprova com
`diario_sem_prova:<estado>[:<motivo>]`: `nao_lido` (token ausente, leitura ausente, incompleta ou com erro),
`nao_provado` (cadeia, reaplicação, conjunto, exceção), um `provado` sem a prova completa ou um estado desconhecido. A fase
do registro é sempre a do ensaio (`runDrill({ diarioFase })`), nunca a que a implementação da prova declara, e a releitura
recusa um APROVADO fora da sombra sem a prova (`diario_ativo_sem_prova`).

**Integração com a cópia KV -> Neon (#999):** `copia_kv_para_neon` e `diario_d1` são lacunas independentes em
`notCoveredFor(allEncrypted, kvCopyProven, diario)`. Cada uma só sai com a própria prova (`kvProofComplete` e
`diarioProvado`), e `validateRecord` confere as duas separadamente (`copia_kv_unproven` e `diario_d1_unproven`). O mesmo
Postgres efêmero recebe a cópia do KV (`zevanory_kv_backup`) e a reconstrução do diário (`p20_diario_reconstruido`).

Testes: `tests/p20-diario-ensaio.test.mjs` (DE1 a DE9: leitor, prova, sem token, cadeia, conjunto, reaplicação,
releitura estrita, workflow e lista positiva fora da sombra) e `tests/test_p20_restore_drill.py` (testes 11 a 13: código real do Worker, restauração real
e reaplicação real num PostgreSQL). Mutantes M62 a M83 em `scripts/ci/mutants_p20_restore_drill.py` (M44 a M61 são os da
cópia KV -> Neon, #999).

## Testes e mutantes

- `tests/p20-diario-d1.test.mjs` (DJ1 a DJ8): encadeamento, adulteração, idempotência, conflito, corrida, LGPD,
  triggers e falhas do D1.
- `scripts/ci/mutants_p20_diario.py` com `mutants_p20_diario_allow.json`: 10 mutantes, todos precisam morrer.
- `tests/p20-diario-sombra.test.mjs` (DS1 a DS11): no-op sem binding, gravação e encadeamento via `waitUntil`, falhas
  que não lançam, PII recusada, construtores de cada tipo, contexto da requisição e integração real com Hotmart,
  lead-magnet e reembolso (resposta idêntica com, sem e com diário quebrado ou travado). Inclui também um teste
  estático dos 7 ganchos do bundle legado, que não carrega em Node.
  O limite de 5 s de cada gravação usa um agendador injetável (`configurarDiarioSombra({ agendar })`): os testes usam
  um relógio manual que só dispara quando o teste manda, então uma gravação legítima lenta (máquina carregada) nunca vira
  `diario_timeout` por acaso, e "a resposta sai com a gravação pendente" não depende do tempo real.
- `scripts/ci/mutants_p20_diario_sombra.py` com `mutants_p20_diario_sombra_allow.json`: 13 mutantes, todos precisam
  morrer. Cobrem: bloquear a resposta, lançar, vazar PII no log, tentar gravar o comprador, gancho ausente de cada
  tipo, compat sem contexto, sem `waitUntil` e sem fila.
- `tests/test_diario_d1_credentials.py` (C1 a C16, DEC-P20-D1-01 e NO-GO do primeiro deploy). Lê o workflow real e
  simula o `env` que o GitHub monta em cada passo de cada job, em cada modo, com segredos falsos de valores distintos.
  Depois executa os passos reais com `curl` e `npx` falsos, que registram o token de cada chamada. Prova que cada token
  D1 aparece só no seu passo e só em `certificar`; que `off` e `rollback` não fazem nenhuma chamada D1 e saem sem
  binding mesmo com os segredos; que em `certificar` segredo ausente, banco inacessível ou divergente, migração que
  falha e esquema que não confere (head, migrações, gatilho ausente, objeto a mais, abandono com linha, SELECT que
  falha) tiram o binding e reprovam; que o readback certifica com o token de leitura e que toda falha dele reprova o job
  (sem `continue-on-error`); que o deploy segue com o token atual, que o compartilhado nunca recebe chamada D1 e que
  nenhum caminho apaga tabela. Confere ainda o registro em `ops/publishers.json` e o detector T1
  (`scripts/deploy/t1-write-scan.mjs`). Cobre também o modo `manter` (token de leitura, nunca migra, banco não certificado reprova) e a conferência do UUID do
  `DIARIO` no candidato antes de qualquer chamada D1. São 28 mutantes,
  e todos precisam morrer.
- `tests/test_binding_budget_compaction.py`, classes `DiarioD1*`: gerador real nos modos (sem modo, `off`,
  `rollback`, `certificar`, inválido), validação do modo e do motivo no job `guard`, ordem dos passos, conferência do
  binding efetivo com a API falsa (presente, ausente, UUID errado, tag errada, rollout parcial, API inalcançável),
  `promotion_guard.py` com `motivo=d1-config` (mesmo SHA promove; à frente, mais antigo, divergente e uma fonte só
  recusam), o padrão versionado (`manter` por dispatch só com o padrão em `manter`), o pós-promoção `NAO_COMPROVADO` em
  `certificar` e `manter` (rollback), o rollback automático e o gate de certificação **executados**, as duas fontes do
  binding (lista vazia ou sem sentinela, nomes divergentes, `coerente`) e o script de certificação rodando a SQL real
  num SQLite com as migrações reais. 57 mutantes (guard, script, gerador e workflow), todos precisam morrer.
- `tests/p20-diario-reconcilia.test.mjs` (RC1 a RC10): D1 falso com as migrações reais e Neon falso. Cobre sem
  binding, tudo casa, falta, sobra, normalização diferente, cadeia e âncora adulteradas, bordas da janela, paginação e
  índice, fontes ausentes ou com erro, sombra contra ativo no relatório e os ganchos reais de consentimento e de
  `reconcileRefund`. `tests/integration/diario-reconcilia-postgres.test.mjs` roda as consultas reais num PostgreSQL
  descartável (opcional, com `DIARIO_PG_HOST`).
- `scripts/ci/mutants_p20_diario_reconcilia.py` com `mutants_p20_diario_reconcilia_allow.json`: 20 mutantes, todos
  precisam morrer.
- `.github/workflows/p20-diario-d1-tests.yml` roda só em `pull_request`, sem segredo, com `contents: read`.
