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

**Autenticação por consumidor.** O workflow `operator-token-consumer-auth.yml` roda só por `workflow_dispatch` e só em gh-pages.

- Para cada consumidor de produção, roda `credential_identity_readback.py --require-primary` com `secrets.ZEVANORY_OPERATOR_TOKEN`, sem queda, no Environment do consumidor.
- O endpoint é somente leitura (`GET /api/internal/audit/credential-identity`).
- `--require-primary` agora exige duas coisas:
  - `OPERATOR_TOKEN_SOURCE=primary`: o Worker usa o nome novo;
  - `OPERATOR_TOKEN_PRESENTED=primary`: a credencial do runner autenticou como a primária, e não como a antiga aceita na janela.

## Procedimento do proprietário

> **Ordem obrigatória: (a) → (d) → (b) → (c) → (e) → (f) → (g).**
>
> O Worker precisa conhecer o valor novo **antes** de qualquer cliente mandá-lo. Os consumidores leem `secrets.ZEVANORY_OPERATOR_TOKEN || secrets.CERTIFICATION_E2E_TOKEN`, então passam a mandar o valor novo assim que ele existe no Environment.
>
> Se (b) vier antes de (d), o Worker (sem o valor novo) devolve 401 para todos os consumidores entre (b) e (d). Com (d) primeiro e a janela aberta, o Worker aceita o antigo (que os clientes ainda mandam) e o novo, então nada quebra em nenhum passo.

**(a) Merge e deploy com a janela LIGADA.**

1. Antes do deploy, crie a variável **não secreta** de repositório `OPERATOR_TOKEN_MIGRATION_UNTIL` com uma data AAAA-MM-DD até 2026-12-31. Sugestão: hoje + 14 dias.
2. Faça o merge deste PR e aprove o deploy central (Environment `producao-critica`).
3. Confirme no readback pós-deploy:
   - `OPERATOR_TOKEN_MIGRATION=open`
   - `OPERATOR_TOKEN_SOURCE=legacy_fallback` (o Worker ainda não tem o nome novo)

**(d) Valor novo no Worker `zevanory`.** Este passo vem antes de (b); veja a ordem acima.

- `wrangler secret put ZEVANORY_OPERATOR_TOKEN --name zevanory` com o valor NOVO (conta 1b264158…).
- Não apague `CERTIFICATION_E2E_TOKEN`.
- A partir daqui o Worker aceita o novo (`primary`) e, dentro da janela, o antigo (`legacy`).

**(b) Valor novo nos Environments `producao-critica` e `gh-pages-automacao`.**

- Crie o secret `ZEVANORY_OPERATOR_TOKEN` com o mesmo valor NOVO nos dois.
- Não crie em `sandbox-financial-approved` nem como segredo de repositório.
- `production-credential-identity.yml` (dispatch) passa a relatar `VALUES_EQUAL=false` com `GITHUB_OPERATOR_TOKEN_MIGRATION=open`, e passa.

**(c) Verificação por consumidor.**

1. Dispare `operator-token-consumer-auth.yml` em gh-pages. Cada linha da matriz precisa terminar com `R9_CREDENTIAL_IDENTITY=PASS`, com `OPERATOR_TOKEN_SOURCE=primary` e `OPERATOR_TOKEN_PRESENTED=primary`.
2. Nos dias seguintes, os contadores `operator_token_auth_categories_in_isolate.legacy` do readback devem parar de crescer.
3. **Consumidor externo:** confirme também o Worker de controle (`controle.zevanory.api.br`, tabela "Fora deste repositório").

**(e) Readback com `require_primary`.**

- `production-credential-identity.yml` com `require_primary=true`.
- Esperado: `OPERATOR_TOKEN_SOURCE=primary`, `OPERATOR_TOKEN_PRESENTED=primary` e `WORKER_BINDING_ZEVANORY_OPERATOR_TOKEN=present` nos dois Environments.

**(f) PR A2 (seguimento): remove a queda e a janela.**

O PR A2 faz o seguinte:

- `OPERATOR_TOKEN_LEGACY_FALLBACK=false`;
- apaga `operatorTokenMigration`, o candidato `legacy` e o teto;
- tira `|| secrets.CERTIFICATION_E2E_TOKEN` dos workflows;
- gate em `--strict`;
- remove `OPERATOR_TOKEN_MIGRATION_UNTIL` do deploy e do script de presença;
- remove R9-D1 de `ops/r9-debt.json`.

Depois do merge, o proprietário apaga a variável `OPERATOR_TOKEN_MIGRATION_UNTIL`.

**(g) Exclusão do valor antigo, com autorização própria.**

1. Depois do deploy do A2 e de um readback `primary`, apague `CERTIFICATION_E2E_TOKEN` do Worker `zevanory` e dos Environments `producao-critica` e `gh-pages-automacao`.
2. Gere um valor NOVO para `CERTIFICATION_E2E_TOKEN` só em `sandbox-financial-approved` e faça o redeploy da certificação.

Esta exclusão não faz parte deste PR nem do A2.

**Se algo falhar entre (a) e (e):** não apague nada. Enquanto a janela estiver aberta, os dois valores autenticam. Se a data passar, o Worker volta sozinho ao comportamento de hoje (nome novo primeiro), sem deploy.

## Inventário de consumidores

O bloco JSON abaixo é a fonte conferida por `tests/ci/operator-token-inventory.test.mjs`. O teste falha se aparecer algo fora dele:

- um workflow ou job que leia qualquer um dos dois nomes (inventário do gate `operator_token_gate.py`);
- um script em `scripts/` que cite um dos nomes;
- um módulo do Worker que importe `operator-credential.mjs` ou cite um dos nomes;
- uma linha a mais ou a menos na matriz de `operator-token-consumer-auth.yml`.

Resumo:

- **21 jobs ativos de produção:**
  - 17 na forma `new+fallback`, todos com prova por consumidor em (c): 3 em `producao-critica` e 14 em `gh-pages-automacao`;
  - 3 de readback;
  - 1 dispensado (R9-D6, fala só com o Worker de certificação).
- 2 jobs do próprio workflow de prova (forma `new`).
- 2 jobs de certificação (sandbox, credencial própria).
- 4 jobs aposentados (`if: false`).
- 20 scripts que citam um dos nomes.
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

- Ele valida a assinatura HMAC `x-commercial-signature` das rotas `/api/commercial/creative/*`, assinada pelos jobs T2 com `ZEVANORY_OPERATOR_TOKEN`.
- O segredo dele e a regra de verificação não estão aqui.
- **Antes de (b)**, o valor novo precisa ser aceito lá também (segredo novo, ou dupla aceitação equivalente). Sem isso, os 4 jobs T2 recebem `commercial_creative_factory_auth_required` depois de (b).

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
    {"workflow": "operator-token-consumer-auth.yml", "job": "gh-pages-automacao-consumers", "environment": "gh-pages-automacao", "form": "new", "trigger": "dispatch", "uses": "prova (c): GET /api/internal/audit/credential-identity --require-primary", "read_only": true},
    {"workflow": "operator-token-consumer-auth.yml", "job": "producao-critica-consumers", "environment": "producao-critica", "form": "new", "trigger": "dispatch", "uses": "prova (c): GET /api/internal/audit/credential-identity --require-primary", "read_only": true},
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
    {"name": "controle.zevanory.api.br (zevanory-product-control-edge)", "verifies": "x-commercial-signature (HMAC com ZEVANORY_OPERATOR_TOKEN) em /api/commercial/creative/*", "callers": ["t2-content-calendar.yml", "t2-creative-compose.yml", "t2-regenerate-ia-clean.yml", "t2-workers-ai-creative-factory.yml"], "action": "aceitar o valor novo antes do passo (b)"}
  ]
}
```
<!-- operator-token-inventory:end -->
