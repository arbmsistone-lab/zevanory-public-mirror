# P21: um token Cloudflare por Worker (R18)

Roteiro do proprietário e desenho da transição. Requisitos: roteiro mestre R18 (l.236), P21 (l.583, l.1220) e
incidentes I1 (l.169) e I4 (l.172). Decisão do contra-auditor GPT-6: a queda para o token compartilhado **não** é
solução final. Este documento descreve como sair do token compartilhado da conta sem derrubar nenhum deploy no meio
do caminho.

## 1. Situação hoje

- Cerca de 45 workflows recebem `secrets.CLOUDFLARE_PUBLIC_OWNER_API_TOKEN || secrets.CLOUDFLARE_API_TOKEN` ou só
  `secrets.CLOUDFLARE_API_TOKEN`. Os dois tokens alcançam a conta inteira (credential-scope: `CLOUDFLARE_API_TOKEN`
  enxerga 39 Workers).
- O D1 do diário já tem tokens próprios (#996: `CF_TOKEN_D1_DIARIO_MIGRATE` e `CF_TOKEN_D1_DIARIO_READ`).
- Este PR **não vira nenhum interruptor**: com `cutover: false` todo deploy usa exatamente o mesmo token de antes. Os
  testes provam isso (`tests/test_p21_token_cutover.py`, verificações p2 e p3).

## 2. Como funciona o interruptor

Arquivo versionado `ops/token-cutover.json`, com uma entrada por serviço (`cutover`, `secret`, `token_id`,
`edit_workers`, `edit_zones`, `workflows`).

1. Cada workflow listado ganha o job `p21_token`, que chama `.github/workflows/p21-token-cutover.yml`. Esse job lê
   o arquivo **no SHA do próprio run**, não recebe segredos e devolve `cutover`, `token_id`, `secret` e `account`.
2. Todo job com credencial depende de `p21_token` e monta o token sempre pela mesma expressão:
   `needs.p21_token.outputs.cutover == 'true' && secrets.CF_TOKEN_X || needs.p21_token.outputs.cutover == 'false' && (<expressão legada de antes>) || ''`
   - `false`: entrega exatamente a expressão legada de antes.
   - `true`: entrega **só** o dedicado. Se ele faltar, o valor fica vazio. O legado nunca entra.
   - Interruptor ilegível (job `p21_token` falhou): o valor fica vazio.
3. O **primeiro passo** de cada job com credencial é o gate canônico
   (`P21 credencial Cloudflare dedicada (interruptor ops/token-cutover.json)`):
   - `false`: emite `::warning title=TOKEN_LEGADO_EM_USO::` e segue.
   - `true` sem o segredo: emite `::error title=TOKEN_DEDICADO_AUSENTE::` e o job para.
   - `true` com o segredo: chama `GET /accounts/<conta>/tokens/verify` e exige `status=active` e `id` igual ao
     `token_id` registrado no arquivo. Se não bater, emite `::error title=TOKEN_ID_DIVERGENTE::`. Isso amarra o
     segredo do GitHub ao token cuja política foi auditada.
   - Valor ilegível: emite `TOKEN_CUTOVER_ILEGIVEL` e o job para.
4. `scripts/ci/p21_token_cutover.py check` roda em todo PR e reprova:
   - expressão fora da forma canônica (por exemplo `secrets.CF_TOKEN_X || secrets.CLOUDFLARE_API_TOKEN`);
   - gate ausente, fora da primeira posição ou com texto diferente do canônico;
   - job com credencial sem `needs: p21_token`;
   - `cutover: true` sem `token_id`;
   - token dedicado usado em workflow que não está listado para o serviço.
5. Enquanto algum serviço tiver `cutover: false`:
   - `credential-scope` dá `NOT_PROVEN`;
   - `t1_verdict` marca a condição **4c** como `NOT_PROVEN`;
   - a condição 4a continua `NOT_PROVEN` enquanto algum workflow citar os tokens compartilhados.

Para voltar atrás num serviço, basta um PR com `"cutover": false`: o comportamento anterior volta, idêntico.

## 3. Matriz final (verificada contra o uso real e a documentação Cloudflare)

Fontes oficiais:
- [Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/): papéis Metadata
  Read-Only, Content Read-Only, Editor e Admin; escopo "Individual Workers". Editor "não cria nem apaga Workers".
  Criar um Worker exige Admin no produto. Custom Domains ainda não aceitam papel por Worker.
- [Roles and permissions](https://developers.cloudflare.com/workers/authorization/), seção Bindings: subir um Worker
  com binding de KV, R2 ou D1 só exige Editor no Worker. Permissão no recurso só é necessária para acessá-lo
  diretamente.
- [Changelog de 15/09/2026](https://developers.cloudflare.com/changelog/post/2026-09-15-granular-worker-permissions/):
  token de conta com escopo **Specified Workers** e papel Editor.
- [Create token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/): tokens de conta ficam
  em **Manage Account > API Tokens**; tokens de usuário ficam em My Profile > API Tokens.
- [Formato de recursos](https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/#resources):
  `com.cloudflare.api.account.<ID>` e `com.cloudflare.api.account.zone.<ZONE_ID>`.

### Fase 1 (este PR): os 4 deploys canônicos

| Segredo (environment) | Workflow | Permissões | Correção em relação à matriz anterior |
|---|---|---|---|
| `CF_TOKEN_ZEVANORY` (producao-critica) | central-production-deploy.yml (jobs guard e deploy) | Conta > Workers, Specified Workers `zevanory` > **Editor**; Conta > Configurações da conta > **Ler** | **Sem KV.** A listagem de namespaces era só informativa e não roda com `cutover: true` (binding não exige KV). O `GET /accounts/<id>` exige leitura da conta. `wrangler whoami` e a lista de Workers são pulados com `cutover: true` (o gate já fez o verify). Sem rotas: o config não tem `routes`. D1 continua com os tokens próprios do #996. |
| `CF_TOKEN_SALES` (producao-critica) | zevanory-sales-public-release.yml | Editor em `zevanory-sales-public` **e** `zevanory-sales-candidate`; Conta > Configurações > Ler | Hoje o candidato é `zevanory-sales-candidate-<run_id>`: um Worker novo por run, criado e apagado. Editor por Worker **não cria nem apaga**. Com `cutover: true` o candidato passa a ser fixo, criado uma vez pelo proprietário, e no fim é **estacionado** (`scripts/deploy/sales-candidate-parked.mjs`, resposta 410) em vez de apagado. O rollback da produção usa POST deployments e fica coberto pelo Editor. |
| `CF_TOKEN_ROUTER` (producao-critica) | public-router-deploy.yml | Editor em `zevanory-public-router`; Conta > Configurações > Ler; Zona `zevanory.api.br` > **Workers Routes > Editar**; Zona `zevanory.api.br` > **Zona > Ler** | O "Zona > Ler" faltava: `router_routes.py` chama `GET /zones/{id}` e `/zones?name=`. Os nomes exatos dos papéis estão na subseção abaixo. |
| `CF_TOKEN_PANEL` (producao-critica) | zpc-control-worker-deploy.yml | Editor em `zevanory-product-control-portable`; Zona `zevanory.api.br` > Zona > Ler | **Sem KV Edit.** O deploy só sobe o binding `T2_CREATIVE_ASSETS`. KV Edit só seria necessário em owner-oauth-key-bootstrap.yml (fase 2). O script `cloudflare-authoritative-repair.mjs` confere a zona por `GET /zones?name=` e tira `routes`/`custom_domain` antes do deploy, então não precisa de Routes. |
| `CF_TOKEN_AUDIT` (gh-pages-automacao) | t1-publisher-guard.yml (job credential-scope) | Conta > **Account API Tokens > Ler** (nada mais) | Novo. Os tokens dedicados ficam em producao-critica, que o credential-scope (rodando em gh-pages-automacao) não enxerga. Por isso o escopo é lido nas políticas dos tokens via `GET /accounts/<conta>/tokens`. Esse endpoint devolve políticas, nunca valores. |

Nota sobre os papéis de zona do roteador: `router_routes.py` faz preflight, snapshot, verify e restore. Só o
"Workers Routes > Editar" escreve. "Zona > Ler" serve só para conferir a conta da zona.

### Fase 2 (PR seguinte): escritores de segredo, de KV e leitores

O inventário `write_paths` foi conferido contra o uso real. A tabela abaixo é a matriz proposta. Os nomes já ficam
reservados aqui; a ativação de cada um segue o mesmo interruptor.

| Segredo | Quem usa | Permissões | Observação |
|---|---|---|---|
| `CF_TOKEN_ZEVANORY` (o mesmo da fase 1) | Escritores de segredo do `zevanory`: channel-credentials-sync, channel-production-bootstrap, gemini-key-to-worker, lead-privacy-secret-to-worker, mercadopago-production-token-rotate, production-test-secret-cleanup, production-test-secret-readback, voice-gemini-*, voice-zero-spend-enable | Editor no `zevanory` já inclui `secret put/delete/list` | Não precisa de token separado: é o mesmo Worker. |
| `CF_TOKEN_KV_OPS` (gh-pages-automacao) | command-center-snapshot, market-weekly, plan-probe, short-pack, system-matrix, voice-cache-warm, voice-final-closure-reconcile, youtube-autonomous-short, zees16-control-reconciler, backup-preserve-archive (producao-critica) | Conta > Workers KV Storage > Editar | **Nenhuma permissão de Workers Scripts.** Limitação: a documentação não oferece escopo por namespace para KV em token de API ("where available"), então o token alcança **todos** os namespaces, inclusive `sales:open:v1`. A contenção vem da lista fechada de chaves por escritor, já verificada no CI. |
| `CF_TOKEN_SALES_SWITCH` (producao-critica) | zevanory-open-sales, zevanory-close-sales, zevanory-f7-emergency-close-drill | KV Storage > Editar | Separado do KV_OPS por governança, não por alcance: abrir venda exige producao-critica. Mesma limitação de namespace. |
| `CF_TOKEN_READ` (gh-pages-automacao) | Leitores: reach-snapshot, kv-write-census, zpc-cloudflare-route-discovery, zpc-sales-preflight-safe-inspection, cloudflare-commercial-binding-readiness, zevanory-first-order-watch, production-credential-identity, support-eval, engine-dispatcher, whatsapp-operational-audit | Workers (produto) > Metadata Read-Only; KV Storage > Ler; Zona > Workers Routes > Ler | Cada um precisa ser conferido no PR 2. |
| `CF_TOKEN_AI` | cf-ai-capability-probe, voice-cloudflare-free-tts-probe | Conta > Workers AI > Ler | |
| `CF_TOKEN_CERT` | certification-isolated-deploy | Editor em `zevanory-certification` | O ideal é mover o Worker para a conta sandbox 7876a190…, o que dá isolamento por conta (R9/I4). |
| `CF_TOKEN_P18` | zevanory-p18-monitor-only | Editor no próprio Worker | |
| sem token Cloudflare | sandbox-mail-routing.yml | — | Escreve configuração de zona (e-mail), fora de Workers. Fica de fora (`limits` do inventário). |

## 4. Roteiro do proprietário, um serviço por vez

Ordem recomendada:
1. `CF_TOKEN_AUDIT`
2. roteador (menor e mais isolado)
3. painel
4. vendas
5. central

Para cada serviço: criar o token, cadastrar o segredo, abrir o PR de cutover, fazer o deploy de prova e conferir o
credential-scope. Só depois passar ao próximo.

### 4.0 Uma vez: o candidato fixo de vendas

Antes do token de vendas, crie o Worker vazio `zevanory-sales-candidate`. Isso é necessário porque um papel por
Worker só pode ser dado a um Worker que já existe.

1. Painel Cloudflare > conta **Zevanory@gmail.com's Account** (1b26415802588185a86c1d4d3ebf5bdb).
2. **Workers & Pages** > **Create** > **Create Worker**.
3. Nome `zevanory-sales-candidate` > **Deploy**. O modelo "Hello World" é suficiente; o próximo release de vendas
   sobrescreve.

### 4.1 Criar cada token (cliques)

Use **token de conta**, não token de perfil. O token de perfil fica preso ao seu usuário e, pela documentação
Cloudflare, o escopo "Specified Workers" é configurado em **Account API Tokens**.

1. Painel Cloudflare, conta 1b26415802588185a86c1d4d3ebf5bdb > **Manage Account** > **Account API Tokens**
   (algumas telas mostram "API Tokens") > **Create Token** > **Create Custom Token** (personalizado).
2. **Token name**: use o `cloudflare_token_name` do arquivo: `p21-zevanory-deploy`, `p21-sales-deploy`,
   `p21-router-deploy`, `p21-panel-deploy` ou `p21-audit`.
3. **Permissions** (uma linha por permissão):

   | Token | Linhas |
   |---|---|
   | p21-router-deploy | (a) Account > Workers > Editor > **Specified Workers**: `zevanory-public-router`; (b) Account > Account Settings > Read; (c) Zone > Workers Routes > Edit; (d) Zone > Zone > Read |
   | p21-panel-deploy | (a) Workers > Editor > Specified Workers: `zevanory-product-control-portable`; (b) Zone > Zone > Read |
   | p21-sales-deploy | (a) Workers > Editor > Specified Workers: `zevanory-sales-public` **e** `zevanory-sales-candidate`; (b) Account Settings > Read |
   | p21-zevanory-deploy | (a) Workers > Editor > Specified Workers: `zevanory`; (b) Account Settings > Read |
   | p21-audit | Account > Account API Tokens > Read |

4. **Zone Resources** (só router e painel): **Include > Specific zone > zevanory.api.br**. Nunca "All zones".
5. **Client IP Address Filtering**: deixe vazio. Os runners do GitHub não têm IP fixo.
6. **TTL**: defina **End Date** com até 6 meses. O credential-scope reprova token sem validade
   (`TOKEN_SEM_VALIDADE`). Marque um lembrete para rotacionar antes do vencimento.
7. **Continue to summary** > confira que nenhuma linha diz "All Workers" ou "All zones" > **Create Token**.
8. Copie o valor (ele aparece uma vez só) e anote o **ID do token**: abra o token na lista, ou rode
   `curl -s -H "Authorization: Bearer <valor>" https://api.cloudflare.com/client/v4/accounts/1b26415802588185a86c1d4d3ebf5bdb/tokens/verify`
   e leia `result.id`. O ID não é segredo.

### 4.2 Cadastrar o segredo no GitHub

Repositório arbmsistone-lab/zevanory-public-mirror > **Settings** > **Environments**.

| Segredo | Environment |
|---|---|
| `CF_TOKEN_ROUTER`, `CF_TOKEN_PANEL`, `CF_TOKEN_SALES`, `CF_TOKEN_ZEVANORY` | **producao-critica** |
| `CF_TOKEN_AUDIT` | **gh-pages-automacao** |

Em cada caso: **Environment secrets** > **Add environment secret** > nome exato da tabela > cole o valor.

Não cadastre os tokens de deploy como segredo do repositório nem em gh-pages-automacao. O check reprova o uso de um
token dedicado fora dos workflows listados para o serviço.

### 4.3 Virar o interruptor (PR minúsculo, auditável)

Em `ops/token-cutover.json`, no serviço, mude `"cutover": false` para `"cutover": true` e `"token_id": null` para
`"token_id": "<id de 32 hex>"`. Nada mais.

- O CI (`p21-token-cutover-tests`) recusa `true` sem `token_id`.
- O teste p10 (`check_registry`) exige que este PR inicial tenha tudo em `false`. No PR de cutover, ajuste essa
  asserção para o serviço virado, numa linha. Isso deixa o cutover explícito no diff.
- Mescle com a sua frase de autorização (R16), como nos demais PRs.

### 4.4 Deploy de prova

Rode o workflow do serviço por **workflow_dispatch** (roteador, painel e vendas) ou faça o push do central. Confira:

- `::notice title=TOKEN_DEDICADO_EM_USO::` no primeiro passo, e nenhum `TOKEN_LEGADO_EM_USO` nesse serviço;
- readback e certificação PASS, como antes;
- se o deploy falhar por permissão: **nada foi promovido**, porque as falhas de permissão ocorrem antes da
  promoção ou caem no rollback já existente. Volte `cutover: false` por PR e ajuste o token.

Pontos a confirmar no primeiro deploy de prova (documentação não explícita):

| Ponto | O que fazer se falhar |
|---|---|
| Vendas: `GET /accounts/<id>/workers/subdomain` com token por Worker | Acrescentar Workers (produto) > Metadata Read-Only, que é só leitura. |
| `wrangler deploy` com `workers_dev` no central e no candidato | Abrir o caso com o log; o deploy falha antes da promoção. |

### 4.5 Conferir o escopo efetivo

Rode **t1-publisher-guard** por workflow_dispatch em gh-pages. O job credential-scope deve mostrar
`CRED_P21_<segredo>::<serviço> SCOPE_PROVEN edit_workers=[...]`.

Ele reprova com:

| Código | Motivo |
|---|---|
| `TOKEN_ALCANCE_CONTA` | escrita na conta inteira ou em todas as zonas |
| `TOKEN_WORKER_NAO_DECLARADO` | escrita em Worker fora de `edit_workers` |
| `TOKEN_ALCANCE_MAIS_DE_UM_WORKER` | escrita em mais Workers que os declarados |
| `TOKEN_ZONA_NAO_DECLARADA` | escrita em zona fora de `edit_zones` |
| `TOKEN_SEM_VALIDADE` | token sem TTL |
| `TOKEN_DEDICADO_AUSENTE` | `token_id` não existe na conta |
| `TOKEN_RECURSO_DESCONHECIDO` | chave de recurso que o leitor não sabe classificar |

O formato exato da chave de recurso "por Worker" ainda não está documentado. O leitor aceita
`com.cloudflare.edge.worker.script.…<nome>`. Se a primeira leitura vier em outro formato, o resultado é
`TOKEN_RECURSO_DESCONHECIDO` (fecha em falha): anexe o run e o leitor é ajustado com a evidência.

### 4.6 Prova de que um token não altera outro Worker (R18)

O roteiro exige teste negativo **entre Workers de teste isolados**, nunca contra a produção. O credential-scope dá a
leitura das permissões efetivas; o teste negativo de escrita fica para a conta sandbox
(ZEVANORY-L2-SANDBOX-ONLY, 7876a190…). Passos:
1. Dois Workers de teste, A e B.
2. Um token com Editor só em A.
3. Deploy em A: tem de passar.
4. Deploy em B: tem de dar erro de autorização.

É uma tarefa à parte; não foi feita neste PR.

### 4.7 Fim da transição: revogar os tokens compartilhados

Só depois de **todos** os serviços (fase 1 e fase 2) estarem em `cutover: true` com SCOPE_PROVEN:
1. PR de limpeza: remove de todos os workflows a parte legada das expressões e o próprio interruptor. Com isso a
   condição 4a do t1_verdict passa a poder ser PROVEN.
2. Painel Cloudflare: revogue o token por trás de `CLOUDFLARE_API_TOKEN` e o de `CLOUDFLARE_PUBLIC_OWNER_API_TOKEN`.
   O primeiro pode ser token de perfil; procure em My Profile > API Tokens **e** em Account API Tokens.
3. GitHub: apague os segredos `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_PUBLIC_OWNER_API_TOKEN` (repositório e os dois
   environments).
4. Rode t1-publisher-guard: `CRED_CLOUDFLARE_API_TOKEN::not configured`.

## 5. I4: credenciais de teste no Worker de produção

Conferido em `ops/r9-debt.json` e `production-test-secret-cleanup.yml`. O pedido citava CERTIFICATION_E2E_TOKEN,
CERTIFICATION_PILOT_* e STRIPE_SECRET_KEY, mas o estado real é diferente:

| Nome | Tipo | O que fazer | Pode apagar já? |
|---|---|---|---|
| `MERCADOPAGO_TEST_ACCESS_TOKEN`, `MERCADOPAGO_TEST_WEBHOOK_SECRET` | segredos (gravados pelo run 37365806405) | Remover com **production-test-secret-cleanup.yml** | Sim. É a única allowlist desse workflow. |
| `CERTIFICATION_E2E_TOKEN` (R9-D1) | segredo, mas é o token de **operador da produção** apesar do nome | **Não apagar.** Backup, voz, auditoria financeira e WhatsApp autenticam com ele, e o central recusa o deploy sem ele. Seguir docs/ops/operator-token-transition.md: `ZEVANORY_OPERATOR_TOKEN` novo, readback `primary`, depois exclusão com autorização própria. | Não |
| `CERTIFICATION_PILOT_ENABLED/ENV/PRODUCTION_ALLOWED/APPROVER` (R9-D2 a D5) | **vars** (não segredos) | `wrangler secret delete` não as remove. Saem com o merge e o deploy do #913 (o deploy sem keep_vars apaga a var). Prova: production-credential-identity.yml com `WORKER_BINDING_CERTIFICATION_PILOT=none`. | Não, pelo cleanup |
| `STRIPE_SECRET_KEY` (R9-D6) | presença no Worker **não lida** | Primeiro o readback `STRIPE_KEY_MODE` (#912). Se for `test`, remoção dirigida com allowlist (precisa de extensão do cleanup, ainda não existe). Mover financial-e2e-stripe.yml para sandbox-financial-approved. | Ainda não |

Como usar o cleanup (dois segredos MERCADOPAGO_TEST_*):

1. Rode **production-test-secret-readback.yml** (workflow_dispatch, `strict_certification=false`, environment
   producao-critica). Ele **falha por desenho** enquanto os dois segredos existem, mas imprime `INVENTORY_DIGEST`
   (sha256:…), `EFFECTIVE_VERSION_ID` e os conjuntos DELETE/KEEP.
2. O auditor revisa esse run.
3. Rode **production-test-secret-cleanup.yml** por workflow_dispatch, sem nenhum deploy do zevanory em andamento
   (fila deploy-zevanory), com:
   - `confirm_names` = `MERCADOPAGO_TEST_ACCESS_TOKEN,MERCADOPAGO_TEST_WEBHOOK_SECRET`;
   - `expected_inventory_digest` = o digest do passo 1;
   - `expected_version_id` = o EFFECTIVE_VERSION_ID do passo 1.

   Aprove o revisor do environment. Ele recusa se o estado mudou, apaga um nome por vez com releitura antes e depois,
   e no fim exige a allowlist ausente e todos os outros nomes presentes.
4. Rode o readback de novo: os dois nomes ausentes; as dívidas CERTIFICATION_* continuam como aviso até R9-D1 a D5.

Na fase 2 este workflow passa a usar `CF_TOKEN_ZEVANORY` (Editor no zevanory inclui `secret delete`).

## 6. Arquivos

- `ops/token-cutover.json`: o interruptor.
- `.github/workflows/p21-token-cutover.yml`: o leitor.
- `scripts/ci/p21_token_cutover.py`: emit, check, status e o texto canônico do gate.
- `scripts/ci/p21_credential_scope.py` e o job credential-scope de `.github/workflows/t1-publisher-guard.yml`.
- `scripts/ci/t1_verdict.py`: condição 4c.
- `scripts/ci/materialize_sales_configs.py` e `scripts/deploy/sales-candidate-parked.mjs`: candidato fixo.
- Testes:
  - `tests/test_p21_token_cutover.py`: 11 testes, 22 mutantes;
  - `tests/test_p21_credential_scope.py`: 7 testes, 12 mutantes;
  - `tests/gh_actions_sim.py`: avaliador de expressões;
  - `tests/test_diario_d1_credentials.py`: ajustado ao novo avaliador.
- CI: `.github/workflows/p21-token-cutover-tests.yml`.
