# Cadeia de publicação: Release consolidado (#937)

Sol, AVAL 271, item R271-02. Este documento prova a cadeia que leva o SHA candidato, depois do merge autorizado em gh-pages, até as duas superfícies de produção. Também define o que acontece se o smoke ou a leitura falharem.

Cada afirmação tem uma verificação executável, sem rede e sem segredos:

- `python3 scripts/release/publication_chain_check.py`: verificações C1–C7 sobre os YAML deste SHA.
- `python3 -m unittest discover -s tests -p test_publication_chain_check.py`: 9 mutantes da cadeia, todos precisam falhar.
- `python3 -m unittest discover -s tests -p test_release_readback.py`: ensaio do roteiro de leitura contra uma produção falsa (12 casos).
- Workflow `release-chain-proof.yml`: roda as três verificações em todo PR que toque a cadeia. Só `pull_request`, então nunca dispara no merge.
- Evidência online (leitura, via `gh`): `python3 scripts/release/publication_chain_check.py --online <run_id>...`.

## 1. A aprovação de `producao-critica` é obrigatória

| Workflow | Job que publica | `environment` | Evidência |
|---|---|---|---|
| `central-production-deploy.yml` | `guard` (pré-guarda T1) e `deploy` | `producao-critica` | C1 e C3 |
| `zevanory-sales-public-release.yml` | `deploy` | `producao-critica` | C1 e C3 |
| `zevanory-sales-public-release.yml` | `verify` (sem environment) | — | C2: só `wrangler deploy --dry-run` |

Na semântica do GitHub Actions, um job com `environment` protegido por revisor obrigatório **não começa** antes da aprovação. O C1 prova que **todo** passo que publica de fato está dentro desses jobs. Passo que publica significa `wrangler deploy|rollback|versions deploy` sem `--dry-run`, ou `POST` na API de deployments da Cloudflare. O C2 prova que nenhum job fora deles publica.

Registros da API de aprovações (`GET /repos/{repo}/actions/runs/{id}/approvals`) em execuções anteriores:

| Execução | Workflow | SHA | Aprovação | Início dos jobs |
|---|---|---|---|---|
| 40139801739 | central-production-deploy | `58821f58` | `approved` por arbmsistone-lab, env `producao-critica` (×2: guard e deploy) | guard 22:46:07Z, deploy 22:46:30Z (criada 22:43:53Z) |
| 40200954675 | zevanory-sales-public-release | `d7daf4a8` | `approved` por arbmsistone-lab, env `producao-critica` | verify 14:10:12Z (sem env); **deploy só às 15:54:50Z**, depois da aprovação |
| 40200954711 | central-production-deploy | `d7daf4a8` | `approved` (×2) | deploy `cancelled` às 16:28:01Z: o central **não** foi publicado em `d7daf4a8` |

Estado das superfícies segundo o histórico de execuções:

- **sales** = `d7daf4a8` (#914);
- **central** = `58821f58` (último deploy com sucesso).

É exatamente o caso de produção diferente de gh-pages que o contrato v3 do #936 registra por superfície (item 4).

## 2. Nada é promovido ao canônico antes da aprovação

- **central:**
  - `guard` (env `producao-critica`) roda `promotion_guard.py` contra `/api/release` antes de qualquer deploy.
  - `deploy` tem `needs: guard` e `if: needs.guard.outputs.decision == 'promote'`, e só existe em `refs/heads/gh-pages`.
  - Tudo verificado em C3.
- **sales:**
  - O job `deploy` (env `producao-critica`) cria primeiro um **candidato isolado** (worker sem rota), com smoke.
  - Depois roda o pré-guarda T1 (`id: guard`), dentro do grupo de deploy serializado.
  - Só então vem `Promote exact candidate source to canonical domain`, com `if: steps.guard.outputs.decision == 'promote'`. O pré-guarda vem antes da promoção.
  - Roda apenas em push ou dispatch em gh-pages (C3).
- `concurrency`: `deploy-zevanory` e `deploy-zevanory-sales-public` com `cancel-in-progress: false`, então nunca há duas promoções simultâneas na mesma superfície.

## 3. Os dois Workers recebem o SHA esperado

| Superfície | Publicação | Leitura de volta que exige o SHA |
|---|---|---|
| central (`zevanory`) | `TARGET_RUNTIME_SHA: ${{ github.sha }}`; `wrangler deploy --tag="$TARGET_RUNTIME_SHA"` | `promotion_guard.py --verify-promoted --candidate "$TARGET_RUNTIME_SHA" --readback-url https://zevanory.api.br/api/release --readback-path deployment.commit_sha` (passo `Post-promotion effective version (T1)`) |
| sales (`zevanory-sales-public`) | `wrangler deploy --config wrangler.sales.deploy.toml --tag="$GITHUB_SHA"` | `Verify canonical production readback`: `/health` com `release == GITHUB_SHA` (até 18 tentativas) + `promotion_guard.py --verify-promoted … --readback-path release` |

Provado em C4. Depois da publicação, `scripts/release/post_publication_readback.py --expected-sha <SHA>` confere de novo os dois endpoints.

## 4. A certificação pós-publicação espera a publicação (#936, contrato v3)

- **Encadeamento:** `portfolio-six-target-exact-cert.yml` reage a `workflow_run` de `ZEVANORY central production deploy` e `ZEVANORY SALES public release` (`types: [completed]`, `branches: [gh-pages]`). Os jobs só rodam com `conclusion == 'success'` de push ou dispatch em gh-pages. `EXPECTED_SHA = workflow_run.head_sha`, e `TRIGGER_SURFACE` vem do nome do workflow (C7).
- **`await_promotion`:**
  - A superfície do deploy que disparou precisa reportar **exatamente** o SHA implantado.
  - A superfície que serve a página precisa estar publicada num SHA cuja fonte da página seja a esperada.
  - Só então compara produção com a nova fonte, de forma exata.
  - Sem promoção dentro do prazo, falha com `promotion_not_observed` (workflow_run) ou `post_deploy_deferred` (push ou dispatch). Nunca passa e nunca acusa um falso `live_title_mismatch` durante a janela de deploy.
- **Pré-merge:** a base de comparação é a fonte no **SHA publicado** de cada superfície. A relação publicado x base fica registrada (`equal | behind_base | ahead_of_base`); fora da linhagem de gh-pages, ou ilegível, falha. A deriva real é `live_drift_vs_deployed`. Mudanças já mescladas mas ainda não publicadas viram `pending_undeployed` (anotação `::warning` e evidência), nunca em silêncio.

## 5. Falha de leitura

### 5.1 Dentro do deploy: contenção automática, verificada no código do workflow (C5/C6)

- **central:**
  - **Disparo:** o passo `Automatic rollback after failed post-deploy smoke` roda com `if: failure() && steps.auth.outputs.available == 'true' && steps.deployworker.outcome == 'success'`. Ou seja, qualquer smoke, verificação ou leitura falhando **depois** de um deploy bem-sucedido o aciona: asset UTF-8, superfícies legais, HSTS/CSP, ou `Post-promotion effective version` com estado FAIL.
  - **Rollback:** `npx wrangler@4.143.0 rollback --name zevanory --message "Automatic rollback after failed production smoke for <SHA>"`. Sem `--version`, o Wrangler volta à **versão implantada imediatamente antes** deste deploy, que é o SHA que estava em produção (hoje `58821f58`, conforme o item 1).
  - **Depois do rollback:** até 20 leituras de `/api/health` (`verify-rollback-health.py`). Saúde comprovada leva a `AUTO_ROLLBACK_HEALTH=PASS` e a um dispatch de `order12a-financial-proof-renewal.yml` (prova financeira somente GET). Saúde não comprovada leva a `AUTO_ROLLBACK_HEALTH=FAIL` e a execução falha.
  - **Portão T1:** com `NAO_COMPROVADO` (observador inalcançável), **não** há rollback. A execução falha com `CERTIFICATION_NAO_COMPROVADO` e a nova verificação fica com `t1-publisher-guard` (`recheck_service=zevanory`).
- **sales:**
  - **Snapshot:** antes da promoção, `Snapshot active canonical deployment` guarda a implantação ativa (version_ids e percentuais) em `/tmp/rollback-deployment.json`.
  - **Rollback:** se `Verify canonical production readback` falha (`/health` ≠ SHA, página, fundador e produtos, termos legais, ou T1 FAIL), `Roll back canonical deployment on failed readback` faz POST desse snapshot na API de deployments. Isso **restaura exatamente as versões que estavam ativas antes** (hoje, o deploy de `d7daf4a8`). A execução termina em `exit 1`.
  - **Sem snapshot** (primeiro release): nada é apagado (`SALES_NO_ROLLBACK_SNAPSHOT`) e a execução falha para recuperação manual autorizada.
  - **Portão T1:** com `NAO_COMPROVADO`, a execução falha sem rollback (`recheck_service=zevanory-sales-public`).

### 5.2 Depois do deploy: a leitura pós-publicação bloqueia a homologação

`post_publication_readback.py` sai com 1 e grava `homologation: BLOCKED_CONTAINMENT_REQUIRED`. A partir daí, o procedimento autorizado é:

1. **Não homologar.** O release continua como **não certificado** e os PRs componentes **não** são fechados como incluídos.
2. **Vendas.** Se a falha for de NO-GO (vendas abertas, checkout ou Hotmart atendendo), o proprietário roda `zevanory-close-sales.yml` (workflow_dispatch, env `gh-pages-automacao`, fecha incondicionalmente). O F7 (`zevanory-f7-emergency-close-drill.yml`) mede o tempo de fechamento.
3. **Superfície divergente** (title/h1/canonical, promessa, 404, cabeçalhos). O proprietário autoriza o rollback da superfície afetada:
   - central: `wrangler rollback --name zevanory` para a versão anterior ao SHA do release, conferida em `/api/release`;
   - sales: novo deploy da versão anterior (snapshot ou `workflow_dispatch` do release no SHA anterior), conferida em `/health`.
   - Nenhum rollback é feito por esta automação fora dos passos de 5.1.
4. **Nova leitura.** `post_publication_readback.py --expected-sha <SHA anterior> --skip-central-identity` (se só o sales voltou) até `READBACK=PASS`. A evidência JSON vai anexada ao incidente.
5. **Registro.** Incidente com o SHA, a saída da leitura e as execuções envolvidas. As pendências preservadas são listadas abaixo.

Este roteiro **nunca** faz POST, nunca segue redirecionamento para provedor de pagamento e nunca altera estado. Os testes de `test_release_readback.py` provam isso.

## 6. NO-GO verificado depois da publicação (R271-03)

| Item | Como é verificado (`post_publication_readback.py`) |
|---|---|
| `SALE_GLOBALLY_ENABLED=false` | A variável não é pública. O estado efetivo (junto com as demais travas) é `/api/sales/status` `open=false` e `/api/release` `sales_mode=globally-blocked` |
| Checkout próprio bloqueado | GET sem redirecionamento em `vendas/comprar/<SKU>` (5 SKUs): 200 "Vendas abrem em breve", sem `<form method=post>`, sem Mercado Pago. `/api/checkout/{mercadopago,stripe,asaas}` no apex: ≥400, sem `init_point` nem redirecionamento |
| Sem execução financeira real | Nenhum endpoint de pagamento atende compra (linha anterior) e nenhum link de pagamento aparece nas páginas (`pay.hotmart.com`, `mercadopago.com`, `checkout.stripe`, `/comprar/`) |
| P12 (Conteúdo Pronto) e P15 (funil v2) não abrem vendas | `/assinar/conteudo-pronto`: 200 "Assinaturas pausadas", sem redirecionamento. `/hotmart/<produto>`: 200 "Vendas pausadas". `conteudo-pronto`, `solucoes` e as páginas de produto: sem link de pagamento. O estado efetivo continua fechado |
| `P09_NURTURE_SEND` desligado | Não é exposto publicamente. Evidência de fonte no SHA publicado: nenhum workflow define a variável e `content/p09/*/sequence.json` tem `send_switch.default=off`. A conferência do valor vivo é feita pelo proprietário (nomes de variáveis no passo "R9 credential identity readback" do deploy central) |
| Processo fiscal `NAO_DEFINIDO` | `data/p23/fiscal-process.json` no SHA publicado. Com a trava P23, mesmo um interruptor liberado devolve `blocked=fiscal_process_undefined` |

**Pendências preservadas.** Ficam fora do escopo da certificação e continuam abertas: **I4**, **R9-D1–D6** e **T1**. O roteiro as imprime em `PRESERVED_PENDENCIES` e grava em `preserved_pendencies`.
