# Transição da credencial de operador da produção com valor NOVO (Sol 233)

Estado: preparado em PR rascunho. Nada foi executado: nenhum segredo, nenhum deploy, nenhum dispatch.

## Por que a janela de migração existe

O proprietário vai criar um valor **novo** para `ZEVANORY_OPERATOR_TOKEN`. Ele **não** será uma cópia de `CERTIFICATION_E2E_TOKEN`, porque o valor antigo não pode ser lido em lugar nenhum.

Sem esta mudança, o código atual quebraria em dois pontos (confirmados pelo Sol 233):

- **Worker.** `worker/operator-credential.mjs` usa só o nome novo quando ele existe. Com valores diferentes, todo cliente que ainda manda o valor antigo receberia 401.
- **GitHub.** `scripts/ci/operator-token-github-presence.sh` exigia valor novo igual ao antigo (`R9_OPERATOR_TOKEN_MISMATCH`).

## O que muda

### Flag da janela

`OPERATOR_TOKEN_MIGRATION_UNTIL=AAAA-MM-DD` é uma variável **não secreta** do repositório.

- No Worker, ela chega por `vars.OPERATOR_TOKEN_MIGRATION_UNTIL`: o deploy a grava dentro de `ZEVANORY_RUNTIME_CONFIG`, sem binding novo.
- No gate do GitHub, ela é lida da mesma variável.
- A janela fica aberta até 23:59:59.999Z desse dia (UTC).

### Teto em código

`MIGRATION_CODE_CEILING = "2026-12-31"` é o mesmo valor em quatro lugares:

- `worker/operator-credential.mjs`
- `scripts/ci/operator-token-github-presence.sh`
- `scripts/deploy/prepare-central-candidate.py`
- `scripts/deploy/verify-financial-boundary.py`

Uma flag acima do teto não abre a janela. O deploy reprova uma flag malformada ou acima do teto (`OPERATOR_TOKEN_MIGRATION_UNTIL_INVALID`).

### Worker

**Dentro da janela**, com o nome novo presente, a verificação aceita o valor novo (categoria `primary`) **e** o antigo (categoria `legacy`).

- A comparação é em tempo constante e sempre contra todos os candidatos.
- Valor desconhecido continua 401.
- Com os dois nomes ausentes, recusa (fail-closed).

**Fora da janela** (flag ausente, malformada, vencida ou acima do teto) vale o comportamento de hoje: o nome novo, se presente, é o único aceito. A queda `legacy_fallback`, que só ocorre na ausência do nome novo, não muda.

**Registro e métrica.** São só por categoria: `primary`, `legacy`, `legacy_fallback`, `certification`, `operator_token` e `none`.

- Há uma linha `operator_token_auth {"category":...}` por categoria por isolate, mais contadores.
- O readback `/api/internal/audit/credential-identity` agora expõe três campos novos:
  - `operator_token_presented`: a categoria com que a própria requisição autenticou;
  - `operator_token_migration`: o estado da janela;
  - `operator_token_auth_categories_in_isolate`: os contadores.
- Nunca aparece valor, tamanho ou hash.

Todos os verificadores de entrada passam pelo mesmo `verifyOperatorToken`, inclusive a sonda HMAC (`signed-audit-probe.mjs`).

### GitHub

**Presença.** `operator-token-github-presence.sh` aceita valores diferentes **só** com a janela aberta. As verificações de presença e de `REQUIRE_PRIMARY` continuam.

**Autenticação por consumidor.** O workflow `operator-token-consumer-auth.yml` roda só por `workflow_dispatch` e só em gh-pages. O job `control-edge-t2-hmac` prova os 4 jobs T2 no Worker de controle; veja o passo (6).

- Para cada consumidor de produção, roda `credential_identity_readback.py --require-primary` com `secrets.ZEVANORY_OPERATOR_TOKEN`, sem queda, no Environment do consumidor.
- O endpoint é somente leitura (`GET /api/internal/audit/credential-identity`).
- `--require-primary` agora exige duas coisas:
  - `OPERATOR_TOKEN_SOURCE=primary`: o Worker usa o nome novo;
  - `OPERATOR_TOKEN_PRESENTED=primary`: a credencial do runner autenticou como a primária, e não como a antiga aceita na janela.

### Worker de controle (`controle.zevanory.api.br`, Sol 237)

Os 4 jobs T2 assinam `x-commercial-signature` para o Worker de **controle** (`zevanory-product-control-portable`, código em `zevanory-product-control-edge`), e não para o Worker principal. Auditoria completa: [`control-edge-operator-token-audit.md`](control-edge-operator-token-audit.md).

- **Hoje.** O verificador aceita `COMMERCIAL_ROBOT_TICK_SECRET` e `CERTIFICATION_E2E_TOKEN`. O valor novo seria recusado, e os 4 jobs T2 receberiam `commercial_creative_factory_auth_required` assim que o Environment passasse a mandar o valor novo.
- **edge #211.**
  - Acrescenta `ZEVANORY_OPERATOR_TOKEN` (categoria `primary`) **só dentro da janela**, com a mesma flag `OPERATOR_TOKEN_MIGRATION_UNTIL` e o mesmo teto `2026-12-31`.
  - Fora da janela, os candidatos são exatamente os de hoje: `tick` e `legacy`.
  - Verificação em tempo constante contra todos os candidatos; registro só por categoria (`primary`, `legacy`, `tick`, `none`).
  - Cria a rota de prova `POST /api/commercial/auth/probe`, sem efeito colateral.
- **Deploy.** `zpc-control-worker-deploy.yml` passa `vars.OPERATOR_TOKEN_MIGRATION_UNTIL` ao script de deploy do edge, que valida a flag e a grava como `--var`.

**Assimetria depois da data.** Esta é a diferença importante em relação ao Worker principal:

| Depois da data, sem A2 | Valor novo | Valor antigo |
|---|---|---|
| Worker principal | aceito (`primary`) | recusado |
| Worker de controle | **recusado** | aceito (`legacy`) |

Os workflows mandam `secrets.ZEVANORY_OPERATOR_TOKEN || secrets.CERTIFICATION_E2E_TOKEN`, ou seja, o valor novo assim que ele existe no Environment. Por isso, depois da data e sem os A2, **os 4 jobs T2 falham com 401** e todos os outros consumidores continuam funcionando. A falha é visível e fechada (nada é publicado). É de propósito: força concluir os A2 em vez de deixar a migração pela metade sem ninguém perceber.

## Procedimento do proprietário

> **Ordem obrigatória: (1) → (2) → (3) → (4) → (5) → (6) → (7).**
>
> Cada Worker precisa conhecer o valor novo **antes** de qualquer cliente mandá-lo. Os consumidores leem `secrets.ZEVANORY_OPERATOR_TOKEN || secrets.CERTIFICATION_E2E_TOKEN` e passam a mandar o valor novo assim que ele existe no Environment. Por isso:
>
> - os valores entram nos **dois** Workers em (5);
> - os Environments só são atualizados em (6), com as **duas** janelas provadamente abertas em (3) e (4).

**(1) Auditar e preparar o Worker de controle.**

- Feito neste PR (auditoria) e no edge #211 (código).
- Nenhuma execução.

**(2) Autorizações separadas.** Cada item abaixo é uma decisão própria do proprietário; uma autorização não implica a outra:

- merge deste PR;
- merge do edge #211;
- deploy central (`producao-critica`);
- deploy do Worker de controle (`zpc-control-worker-deploy.yml`, `producao-critica`);
- criação da variável `OPERATOR_TOKEN_MIGRATION_UNTIL`, com uma data AAAA-MM-DD até 2026-12-31 (sugestão: hoje + 14 dias). Ela abre a janela **nos dois** Workers no deploy seguinte de cada um.

**(3) Deploy do Worker principal com a janela, sem o valor novo, e prova.**

1. Crie a variável, faça o merge deste PR e aprove o deploy central.
2. No readback pós-deploy, confirme:
   - `OPERATOR_TOKEN_MIGRATION=open`;
   - `OPERATOR_TOKEN_SOURCE=legacy_fallback` (o Worker ainda não tem o nome novo).
3. Nenhum segredo muda neste passo.

**(4) Deploy do Worker de controle com a dupla aceitação, e prova.**

1. Faça o merge do edge #211.
2. O reconciliador agendado (`t2-exact-control-worker-promotion.yml`) pede `zpc-control-worker-deploy.yml`. Aprove-o no Environment `producao-critica`, ou dispare com o SHA exato.
3. Confirme:
   - o log do deploy mostra `ZPC_OPERATOR_TOKEN_MIGRATION_FLAG=set until=<data>`;
   - `version.json` mostra o SHA do edge com o #211;
   - a rota T2 sem assinatura continua `401 commercial_creative_factory_auth_required` (readback do próprio deploy);
   - `POST /api/commercial/auth/probe` sem assinatura devolve 401 (rota presente, fail-closed).
4. Os jobs T2 continuam assinando com o valor antigo (`legacy`), sem mudança.

**(5) O proprietário grava o valor NOVO nos dois Workers. O antigo fica.**

- `wrangler secret put ZEVANORY_OPERATOR_TOKEN --name zevanory` (Worker principal, conta 1b264158…).
- `wrangler secret put ZEVANORY_OPERATOR_TOKEN --name zevanory-product-control-portable` (Worker de controle, mesma conta), com o **mesmo** valor.
- Não apague `CERTIFICATION_E2E_TOKEN` de nenhum dos dois.
- A partir daqui, nos dois Workers e dentro da janela, o novo autentica como `primary` e o antigo como `legacy`. No controle, `tick` continua.

**(6) Valor novo nos Environments e provas autenticadas.**

1. Crie o secret `ZEVANORY_OPERATOR_TOKEN` com o mesmo valor NOVO em `producao-critica` e em `gh-pages-automacao`.
   - Não crie em `sandbox-financial-approved` nem como segredo de repositório.
   - `production-credential-identity.yml` (dispatch) relata `VALUES_EQUAL=false` com `GITHUB_OPERATOR_TOKEN_MIGRATION=open`, e passa.
2. Dispare `operator-token-consumer-auth.yml` em gh-pages. São três jobs, todos somente leitura e sem efeito colateral:
   - `producao-critica-consumers` (3 linhas) e `gh-pages-automacao-consumers` (14 linhas): `R9_CREDENTIAL_IDENTITY=PASS`, com `OPERATOR_TOKEN_SOURCE=primary` e `OPERATOR_TOKEN_PRESENTED=primary`;
   - `control-edge-t2-hmac` (os 4 jobs T2): `CONTROL_EDGE_HMAC_PROBE=PASS CATEGORY=primary MIGRATION=open`.
     - A sonda assina a canônica separada `zevanory-commercial-auth-probe-v1` com o valor novo.
     - O Worker de controle verifica com o **mesmo** conjunto de candidatos das rotas T2.
     - Ela não gera imagem, não grava, não publica, não cobra e não muta.
3. `production-credential-identity.yml` com `require_primary=true`. Esperado nos dois Environments:
   - `OPERATOR_TOKEN_SOURCE=primary`;
   - `OPERATOR_TOKEN_PRESENTED=primary`;
   - `WORKER_BINDING_ZEVANORY_OPERATOR_TOKEN=present`.
4. Nos dias seguintes, os contadores `legacy` do readback do Worker principal devem parar de crescer. No controle, a linha `commercial_hmac_auth {"category":"legacy"}` deve sumir dos logs de novos isolates.

**Lacuna declarada da prova T2.** A sonda prova o conjunto de candidatos e o algoritmo, mas não executa as rotas T2 em si: as canônicas são diferentes, e as rotas têm efeito colateral.

- A equivalência é garantida por código no edge: as 5 rotas chamam o mesmo `verifyCommercialSignature`, e os testes H10 conferem isso estaticamente.
- A prova de ponta a ponta de uma rota T2 só acontece na próxima execução real de um job T2. Por exemplo, o cron diário `t2-content-calendar`, que manda um criativo para a fila de aprovação do proprietário (não publica).

**(7) Depois (A2 e exclusão do antigo), com autorizações próprias.**

- **PR A2 do mirror:**
  - `OPERATOR_TOKEN_LEGACY_FALLBACK=false`;
  - apaga `operatorTokenMigration`, o candidato `legacy` e o teto;
  - tira `|| secrets.CERTIFICATION_E2E_TOKEN` dos workflows;
  - gate em `--strict`;
  - remove `OPERATOR_TOKEN_MIGRATION_UNTIL` do deploy central, do deploy do controle e do script de presença;
  - remove R9-D1 de `ops/r9-debt.json`.
- **PR A2 do edge:**
  - `ZEVANORY_OPERATOR_TOKEN` passa a candidato permanente (`primary`, sem janela);
  - remove `CERTIFICATION_E2E_TOKEN` dos candidatos;
  - remove a flag do deploy.
- **Ordem dos A2:** o A2 do edge precisa estar **em produção antes do vencimento da data** (ver "Depois da data", abaixo). O A2 do edge vai antes ou junto do A2 do mirror.
- **Exclusão do antigo:** depois dos dois A2 e de readbacks `primary`:
  1. apague `CERTIFICATION_E2E_TOKEN` dos Workers `zevanory` e `zevanory-product-control-portable` e dos Environments `producao-critica` e `gh-pages-automacao`;
  2. gere um valor NOVO para `CERTIFICATION_E2E_TOKEN` só em `sandbox-financial-approved` e faça o redeploy da certificação;
  3. por fim, o proprietário apaga a variável `OPERATOR_TOKEN_MIGRATION_UNTIL`.

### Depois da data (janela vencida)

A janela fecha sozinha às 23:59:59.999Z do dia, sem deploy, nos dois Workers.

| Situação | Worker principal | Worker de controle | Efeito |
|---|---|---|---|
| Vence antes de (5) | valor novo ausente; antigo como `legacy_fallback` | `tick` e `legacy`, como hoje | nada quebra; a migração simplesmente não começou |
| Vence entre (5) e (6) (Environments ainda com o antigo) | o novo existe e é o único aceito; **o antigo é recusado** | antigo aceito | todo consumidor do Worker principal recebe 401; T2 segue funcionando |
| Vence depois de (6), sem os A2 | novo aceito | **novo recusado** | os 4 jobs T2 recebem 401; os demais funcionam |
| Vence depois do A2 do edge | novo aceito | novo aceito (permanente) | nada quebra |

### Falhas intermediárias

- **Regra geral:** em qualquer falha entre (3) e (6), não apague nada e não grave segredo novo. Enquanto as duas janelas estiverem abertas, os dois valores autenticam nos dois Workers.
- **(3) falha** (deploy central reprovado ou readback sem `open`): pare. O Worker principal continua no comportamento de hoje.
- **(4) falha** (deploy do controle reprovado, flag `absent` ou `OPERATOR_TOKEN_MIGRATION_UNTIL_INVALID`): pare antes de (5).
  - O Worker principal com a janela aberta e sem o valor novo é inofensivo.
  - Não grave o valor novo em nenhum Environment enquanto o controle não provar a dupla aceitação.
- **(5) feito só num Worker:** grave no outro antes de (6).
  - Se (6) vier antes, os consumidores do Worker que não recebeu o valor novo recebem 401: todos, se faltou no principal; os 4 T2, se faltou no controle.
  - Para recuar: apague o secret `ZEVANORY_OPERATOR_TOKEN` dos **Environments** (não dos Workers). Os clientes voltam ao antigo pela queda `||`.
- **(6) com alguma linha vermelha:**
  - Linha do Worker principal: veja `REASONS` no readback.
  - Linha `control-edge-t2-hmac`:
    - `PROBE_ROUTE_ABSENT`: o edge #211 não está em produção;
    - `CREDENTIAL_NOT_ACCEPTED`: valor diferente no Worker de controle, ou janela fechada lá;
    - `RUNNER_TOKEN_NOT_PRIMARY`: o Environment ainda manda o antigo.
  - Corrija e dispare de novo. O recuo é o mesmo de (5).
- **Um deploy do controle feito depois que a variável for apagada fecha a janela lá.** Isso vale também para o deploy que o reconciliador pede sozinho. Não apague a variável antes do A2 do edge estar em produção.

### Proibido estender a data para esconder migração incompleta

- A data **não** é prorrogada automaticamente: nem pelo código, nem por workflow, nem por reconciliador.
- O código aceita só o que está na variável, até o teto `2026-12-31`, e nenhum script reescreve a variável.
- Mudar `OPERATOR_TOKEN_MIGRATION_UNTIL` para uma data posterior exige três coisas:
  1. uma autorização própria do proprietário, registrada com o motivo;
  2. o estado dos passos (1)–(7) no momento;
  3. um novo deploy de cada Worker.
- Subir o teto exige PR de código revisado nos quatro arquivos do mirror e no edge.
- Prorrogar para que um 401 dos T2 (ou de qualquer consumidor) "desapareça" sem concluir os A2 é proibido. O 401 é o sinal de que a migração está incompleta.

## Inventário de consumidores

O bloco JSON abaixo é a fonte conferida por `tests/ci/operator-token-inventory.test.mjs`. O teste falha se aparecer algo fora dele:

- um workflow ou job que leia qualquer um dos dois nomes (inventário do gate `operator_token_gate.py`);
- um script em `scripts/` que cite um dos nomes;
- um módulo do Worker que importe `operator-credential.mjs` ou cite um dos nomes;
- uma linha a mais ou a menos na matriz de `operator-token-consumer-auth.yml`, incluindo a matriz `control-edge-t2-hmac`, que precisa ser exatamente os chamadores do verificador externo.

Resumo:

- **21 jobs ativos de produção:**
  - 17 na forma `new+fallback`, todos com prova por consumidor em (6): 3 em `producao-critica` e 14 em `gh-pages-automacao`. Os 4 jobs T2 têm também a prova HMAC no Worker de controle;
  - 3 de readback;
  - 1 dispensado (R9-D6, fala só com o Worker de certificação).
- 3 jobs do próprio workflow de prova (forma `new`): 2 de readback no Worker principal e 1 de sonda HMAC no Worker de controle.
- 2 jobs de certificação (sandbox, credencial própria).
- 4 jobs aposentados (`if: false`).
- 21 scripts que citam um dos nomes.
- 11 módulos do Worker.
- 1 verificador fora deste repositório.

**Rotinas agendadas que usam a credencial** (todas em `gh-pages-automacao`):

| Workflow | Agenda |
|---|---|
| command-center-snapshot | `17 * * * *` |
| data-backup | `10 5 * * *` |
| order12a-financial-proof-renewal | `11,41 * * * *` |
| t2-content-calendar | `7 11 * * *` |
| voice-eval | `30 12 * * 0` |
| zevanory-first-order-watch | `7 * * * *` |

Os crons do próprio Worker não enviam a credencial.

**Chamadas do Worker para si mesmo:**

- `sandbox-proof-v2.mjs` repassa o cabeçalho recebido para a rota irmã. A rota irmã verifica de novo, com a mesma regra.
- `cloudflare-worker.recovered.mjs` repassa a requisição ao handler Node interno (`/api/internal/certification/e2e/status`), que verifica com `verifyOperatorToken(process.env, …)`.

**Fora deste repositório:** o Worker de controle `controle.zevanory.api.br`, código em `zevanory-product-control-edge`.

- **O que verifica.** A assinatura HMAC `x-commercial-signature` das rotas `/api/commercial/creative/{background,upload,factory/tick}` e `/api/commercial/publish/{tick,status}`.
- **Quem assina.** Os 4 jobs T2, com `secrets.ZEVANORY_OPERATOR_TOKEN || secrets.CERTIFICATION_E2E_TOKEN`; o Render (`server.ts`) e o cron do próprio Worker assinam com `COMMERCIAL_ROBOT_TICK_SECRET`.
- **Candidatos hoje:** `COMMERCIAL_ROBOT_TICK_SECRET` e `CERTIFICATION_E2E_TOKEN`. Com o edge #211 e a janela aberta, também `ZEVANORY_OPERATOR_TOKEN`.
- **Segredos.** São gravados fora de banda: nenhum workflow grava esses nomes no Worker de controle.
- **Detalhes:** [`control-edge-operator-token-audit.md`](control-edge-operator-token-audit.md).
- **Ordem:** os passos (4) e (5) do procedimento vêm **antes** de (6). Sem eles, os 4 jobs T2 recebem `commercial_creative_factory_auth_required` depois de (6).

<!-- operator-token-inventory:begin -->
```json
{
  "workflows": [
    {"workflow": "central-production-deploy.yml", "job": "deploy", "environment": "producao-critica", "form": "new+fallback", "trigger": "push gh-pages (paths) + dispatch", "uses": "readback pós-deploy GET /api/internal/audit/credential-identity", "read_only": true},
    {"workflow": "certification-isolated-deploy.yml", "job": "certification", "environment": "sandbox-financial-approved", "form": "certification", "trigger": "dispatch", "uses": "credencial própria do Worker de certificação", "read_only": false},
    {"workflow": "channel-production-bootstrap.yml", "job": "channels", "environment": "producao-critica", "form": "new+fallback", "trigger": "dispatch", "uses": "POST /api/internal/channels/telegram-proof e /api/internal/channels/evidence (scripts/channels/prove-youtube.mjs)", "read_only": false},
    {"workflow": "command-center-snapshot.yml", "job": "snapshot", "environment": "gh-pages-automacao", "form": "new+fallback", "trigger": "schedule 17 * * * * + dispatch", "uses": "POST /api/internal/funnel/run (x-backup-token)", "read_only": false},
    {"workflow": "data-backup.yml", "job": "backup", "environment": "gh-pages-automacao", "form": "new+fallback", "trigger": "schedule 10 5 * * * + dispatch", "uses": "POST /api/internal/backup/run (scripts/ops/data-backup.mjs)", "read_only": false},
    {"workflow": "financial-e2e-closure.yml", "job": "financial-e2e", "environment": "producao-critica", "form": "retired", "trigger": "if: false", "uses": "aposentado", "read_only": false},
    {"workflow": "financial-e2e-stripe.yml", "job": "stripe-financial-e2e", "environment": "producao-critica", "form": "legacy", "trigger": "push + dispatch", "uses": "dispensa R9-D6: fala só com o Worker de certificação", "read_only": false},
    {"workflow": "mercadopago-checkout-pro-manual-payment.yml", "job": "create-clean-order-and-preference", "environment": "producao-critica", "form": "retired", "trigger": "if: false", "uses": "aposentado", "read_only": false},
    {"workflow": "mercadopago-combo-sandbox.yml", "job": "purchase", "environment": "sandbox-financial-approved", "form": "certification", "trigger": "dispatch", "uses": "credencial própria do Worker de certificação", "read_only": false},
    {"workflow": "mercadopago-exact-sha-recovery.yml", "job": "recover-and-certify", "environment": "producao-critica", "form": "retired", "trigger": "if: false", "uses": "aposentado", "read_only": false},
    {"workflow": "mercadopago-post-payment-verification.yml", "job": "verify", "environment": "producao-critica", "form": "retired", "trigger": "if: false", "uses": "aposentado", "read_only": false},
    {"workflow": "mercadopago-prod-payments-readonly.yml", "job": "payments-readonly", "environment": "producao-critica", "form": "new+fallback", "trigger": "dispatch", "uses": "GET /api/internal/audit/order-lookup", "read_only": true},
    {"workflow": "operator-token-consumer-auth.yml", "job": "control-edge-t2-hmac", "environment": "gh-pages-automacao", "form": "new", "trigger": "dispatch", "uses": "prova (6) T2: POST assinado HMAC /api/commercial/auth/probe no Worker de controle --require-primary (sem efeito colateral)", "read_only": true},
    {"workflow": "operator-token-consumer-auth.yml", "job": "gh-pages-automacao-consumers", "environment": "gh-pages-automacao", "form": "new", "trigger": "dispatch", "uses": "prova (6): GET /api/internal/audit/credential-identity --require-primary", "read_only": true},
    {"workflow": "operator-token-consumer-auth.yml", "job": "producao-critica-consumers", "environment": "producao-critica", "form": "new", "trigger": "dispatch", "uses": "prova (6): GET /api/internal/audit/credential-identity --require-primary", "read_only": true},
    {"workflow": "order12a-financial-proof-renewal.yml", "job": "signed-renewal", "environment": "gh-pages-automacao", "form": "new+fallback", "trigger": "schedule 11,41 * * * * + dispatch", "uses": "GET assinado HMAC /api/internal/audit/financial-classification (scripts/financial_proof_renewal.py)", "read_only": false},
    {"workflow": "production-credential-identity.yml", "job": "automation-environment", "environment": "gh-pages-automacao", "form": "readback", "trigger": "dispatch", "uses": "presença/igualdade (só categorias)", "read_only": true},
    {"workflow": "production-credential-identity.yml", "job": "worker-binding", "environment": "producao-critica", "form": "readback", "trigger": "dispatch", "uses": "presença + GET /api/internal/audit/credential-identity", "read_only": true},
    {"workflow": "production-secret-readiness.yml", "job": "inspect", "environment": "producao-critica", "form": "readback", "trigger": "pull_request + dispatch", "uses": "presença de nomes (só categorias)", "read_only": true},
    {"workflow": "t2-content-calendar.yml", "job": "compose", "environment": "gh-pages-automacao", "form": "new+fallback", "trigger": "schedule 7 11 * * * + dispatch", "uses": "HMAC x-commercial-signature para controle.zevanory.api.br (scripts/t2/compose-creatives.mjs) — verificador externo", "read_only": false},
    {"workflow": "t2-creative-compose.yml", "job": "compose", "environment": "gh-pages-automacao", "form": "new+fallback", "trigger": "dispatch", "uses": "HMAC x-commercial-signature para controle.zevanory.api.br — verificador externo", "read_only": false},
    {"workflow": "t2-regenerate-ia-clean.yml", "job": "regenerate", "environment": "gh-pages-automacao", "form": "new+fallback", "trigger": "push (próprio arquivo) + dispatch", "uses": "HMAC x-commercial-signature para controle.zevanory.api.br — verificador externo", "read_only": false},
    {"workflow": "t2-workers-ai-creative-factory.yml", "job": "generate", "environment": "gh-pages-automacao", "form": "new+fallback", "trigger": "push (próprio arquivo) + dispatch", "uses": "HMAC x-commercial-signature para controle.zevanory.api.br — verificador externo", "read_only": false},
    {"workflow": "voice-cache-repair.yml", "job": "warm", "environment": "gh-pages-automacao", "form": "new+fallback", "trigger": "pull_request (sem segredo) + dispatch", "uses": "POST /api/admin/voice/audit (Bearer; cadeia || secrets.OPERATOR_TOKEN)", "read_only": false},
    {"workflow": "voice-cache-warm.yml", "job": "warm", "environment": "gh-pages-automacao", "form": "new+fallback", "trigger": "dispatch", "uses": "POST /api/admin/voice/audit (Bearer; cadeia || secrets.OPERATOR_TOKEN)", "read_only": false},
    {"workflow": "voice-eval.yml", "job": "eval", "environment": "gh-pages-automacao", "form": "new+fallback", "trigger": "schedule 30 12 * * 0 + dispatch", "uses": "POST /api/internal/voice-eval/run (scripts/ops/voice-eval.mjs)", "read_only": false},
    {"workflow": "whatsapp-neon-live-proof.yml", "job": "whatsapp-neon-stats", "environment": "gh-pages-automacao", "form": "new+fallback", "trigger": "dispatch", "uses": "POST /api/internal/whatsapp/stats-refresh", "read_only": false},
    {"workflow": "whatsapp-operational-audit.yml", "job": "audit", "environment": "gh-pages-automacao", "form": "new+fallback", "trigger": "dispatch + workflow_run + pull_request", "uses": "OPERATOR_TOKEN para auditorias de voz (cadeia || secrets.OPERATOR_TOKEN)", "read_only": false},
    {"workflow": "zevanory-f7-emergency-close-drill.yml", "job": "drill", "environment": "gh-pages-automacao", "form": "new+fallback", "trigger": "dispatch", "uses": "GET assinado HMAC /api/sales/status", "read_only": true},
    {"workflow": "zevanory-first-order-watch.yml", "job": "first-order-watch", "environment": "gh-pages-automacao", "form": "new+fallback", "trigger": "schedule 7 * * * * + dispatch", "uses": "GET assinado HMAC /api/internal/watch/paid-delivery", "read_only": true}
  ],
  "scripts": [
    {"path": "scripts/channels/prove-youtube.mjs", "role": "consumidor", "environment": "producao-critica (channel-production-bootstrap)"},
    {"path": "scripts/ci/credential_identity_readback.py", "role": "readback (só categorias)", "environment": "producao-critica, gh-pages-automacao"},
    {"path": "scripts/ci/control_edge_hmac_probe.mjs", "role": "prova (6) T2: sonda HMAC sem efeito colateral no Worker de controle (só categorias)", "environment": "gh-pages-automacao"},
    {"path": "scripts/ci/credential_separation_gate.py", "role": "gate de CI (nome como dado)", "environment": "CI sem segredo"},
    {"path": "scripts/ci/mutants_credential_separation.py", "role": "mutantes de CI (nome como dado)", "environment": "CI sem segredo"},
    {"path": "scripts/ci/mutants_operator_token.py", "role": "mutantes de CI (nome como dado)", "environment": "CI sem segredo"},
    {"path": "scripts/ci/mutants_operator_token_migration.py", "role": "mutantes de CI (nome como dado)", "environment": "CI sem segredo"},
    {"path": "scripts/ci/operator-token-github-presence.sh", "role": "presença/igualdade (só categorias)", "environment": "producao-critica, gh-pages-automacao"},
    {"path": "scripts/ci/operator_token_gate.py", "role": "gate de CI (nome como dado)", "environment": "CI sem segredo"},
    {"path": "scripts/financial_e2e_closure.py", "role": "aposentado (citado em filtros de caminho)", "environment": "nenhum job ativo"},
    {"path": "scripts/financial_e2e_mercadopago.py", "role": "aposentado (financial-e2e-closure, if: false)", "environment": "nenhum job ativo"},
    {"path": "scripts/financial_e2e_stripe.py", "role": "certificação (dispensa R9-D6)", "environment": "producao-critica → Worker de certificação"},
    {"path": "scripts/financial_proof_renewal.py", "role": "consumidor (HMAC)", "environment": "gh-pages-automacao"},
    {"path": "scripts/mercadopago_combo_sandbox.py", "role": "certificação", "environment": "sandbox-financial-approved"},
    {"path": "scripts/mercadopago_readonly_payments_audit.py", "role": "consumidor somente leitura", "environment": "producao-critica"},
    {"path": "scripts/ops/data-backup.mjs", "role": "consumidor", "environment": "gh-pages-automacao"},
    {"path": "scripts/ops/voice-eval.mjs", "role": "consumidor", "environment": "gh-pages-automacao"},
    {"path": "scripts/sandbox_static_checks.py", "role": "verificação estática (nome como dado)", "environment": "CI sem segredo"},
    {"path": "scripts/t2/compose-creatives.mjs", "role": "consumidor (HMAC para o Worker de controle externo)", "environment": "gh-pages-automacao"},
    {"path": "scripts/whatsapp_delivery_proof_test.mjs", "role": "teste (job sem o segredo; gate: não consumidor)", "environment": "CI sem segredo"},
    {"path": "scripts/zevanory_first_order_watch.py", "role": "consumidor somente leitura (HMAC)", "environment": "gh-pages-automacao"}
  ],
  "worker": [
    {"path": "worker/operator-credential.mjs", "role": "resolvedor único, janela, verificação em tempo constante, categorias"},
    {"path": "worker/cloudflare-worker.compat.mjs", "role": "verifica: backup, funil, voice-eval, convite do piloto (recusado na produção), voice audit"},
    {"path": "worker/cloudflare-worker.recovered.mjs", "role": "verifica: telegram-proof, channel evidence, whatsapp stats-refresh, handler Node e2e/status (repasse interno)"},
    {"path": "worker/internal-financial-audit.mjs", "role": "verifica: /api/internal/audit/* e expõe categorias no readback"},
    {"path": "worker/signed-audit-probe.mjs", "role": "verifica: sondas HMAC de leitura (todos os candidatos)"},
    {"path": "worker/voice-chunks.mjs", "role": "verifica: voice encode audit"},
    {"path": "worker/post-sale.mjs", "role": "verifica: pós-venda de certificação"},
    {"path": "worker/refund-flow.mjs", "role": "verifica: diagnóstico e reembolso de certificação"},
    {"path": "worker/sandbox-proof-v2.mjs", "role": "verifica: sandbox v2 (recusado na produção pela trava do piloto); repasse do cabeçalho à rota irmã"},
    {"path": "worker/production-pilot-guard.mjs", "role": "só o perímetro de certificação (não lê a credencial)"},
    {"path": "certification-worker.mjs", "role": "Worker de certificação: credencial própria; ZEVANORY_OPERATOR_TOKEN proibido"}
  ],
  "external": [
    {"name": "controle.zevanory.api.br (zevanory-product-control-edge)", "verifies": "x-commercial-signature HMAC-SHA256 em /api/commercial/creative/{background,upload,factory/tick} e /api/commercial/publish/{tick,status}; candidatos COMMERCIAL_ROBOT_TICK_SECRET + CERTIFICATION_E2E_TOKEN (+ ZEVANORY_OPERATOR_TOKEN só na janela, edge #211)", "callers": ["t2-content-calendar.yml", "t2-creative-compose.yml", "t2-regenerate-ia-clean.yml", "t2-workers-ai-creative-factory.yml"], "proof": "operator-token-consumer-auth.yml#control-edge-t2-hmac", "action": "passos (4) e (5) antes de (6)"}
  ]
}
```
<!-- operator-token-inventory:end -->
