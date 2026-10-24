# Matriz de publicadores do Worker `zevanory`

Fonte de dados: `docs/ops/zevanory-publisher-matrix.json` (lida pela remoção dirigida e pelo teste N13). Pedido do auditor: Sol 189 A1.
Escopo: todo caminho que pode alterar o Worker de produção `zevanory`, seja código, segredo, var, settings, versão ou deployment.

## Workflows do GitHub que escrevem no `zevanory`

| Workflow | Operação | Grupo de concorrência | Serializado | Situação |
|---|---|---|---|---|
| `central-production-deploy.yml` | `wrangler deploy`, `wrangler rollback` | `deploy-zevanory` | sim | ativo (push gh-pages + manual) |
| `channel-credentials-sync.yml` | `secret put` | `deploy-zevanory` | sim | ativo (manual) |
| `channel-production-bootstrap.yml` | `secret put` | `deploy-zevanory` | sim | ativo (manual) |
| `gemini-key-to-worker.yml` | `secret delete` + `secret put` | `deploy-zevanory` | sim | ativo (manual) |
| `lead-privacy-secret-to-worker.yml` | `worker_secret_rotate.py --apply` (`versions secret bulk` + `versions deploy`) | `deploy-zevanory` | sim | ativo (manual) |
| `production-test-secret-cleanup.yml` | `secret delete` | `deploy-zevanory` | sim | ativo (manual) |
| `sandbox-worker-secret-audit.yml` | `PATCH .../settings` | `deploy-zevanory` | sim | aposentado (`if: false`) |
| `voice-gemini-auth-key-probe.yml` | `secret put` | `deploy-zevanory` | sim | ativo (manual) |
| `voice-gemini-production-provision.yml` | `secret put` | `deploy-zevanory` | sim | ativo (manual) |
| `voice-zero-spend-enable.yml` | `secret put` | `deploy-zevanory` | sim | ativo (manual) |
| `mercadopago-exact-sha-recovery.yml` | `wrangler deploy` (config gerada, name `zevanory`) | `mercadopago-exact-sha-recovery` | **não** | aposentado (`if: false`) |
| `mercadopago-production-token-rotate.yml` | `secret put MERCADOPAGO_ACCESS_TOKEN`, `rollback`, `worker-version-recover.sh` | `mercadopago-production-token-rotate` | **não** | ativo (manual) |

O workflow `financial-e2e-stripe.yml` está registrado em `ops/publishers.json` sob o `zevanory`, mas só escreve no Worker isolado `zevanory-certification`. A remoção dirigida vigia esse workflow mesmo assim.

Os dois financeiros fora do grupo seguem a regra do proprietário em `ops/publishers.json` (`unserialized_known`): qualquer mudança em workflow de pagamento exige autorização escrita dele. Por isso este PR **não** os altera. Para serializar o `mercadopago-production-token-rotate.yml`, bastam três linhas: `group: deploy-zevanory` e `queue: max`. A mudança fica pendente da autorização. Enquanto isso, `production-test-secret-cleanup.yml` recusa quando há run ativo desses workflows e detecta qualquer movimento de versão. O teste N13 fixa essa lista de exceções, e um workflow novo que escreva no `zevanory` fora do grupo reprova.

## Caminhos externos (não serializáveis)

| Caminho | O que pode mudar | Controle |
|---|---|---|
| Painel da Cloudflare (membros da conta) | tudo | detecção |
| Workers Builds (reserva; só com mudança em `ops/RESERVE_DEPLOY` em gh-pages) | código | detecção |
| Tokens de conta inteira usados fora deste repositório, tokens de sonda e Global API Key do proprietário | tudo pela API | detecção |
| `scripts/ops/worker-version-recover.sh` rodado à mão | `versions deploy` | detecção |
| Outros repositórios com o mesmo token (`zevanory-product-control-edge`) | tudo pela API | detecção; `ops/publishers.json` proíbe |

A detecção funciona antes e logo depois de cada DELETE. A remoção relê secret list, settings, deployments, a versão efetiva e `/api/release`, e recalcula o documento `zev-inventory/v1`. O único movimento aceito é o próprio DELETE, e ele é reconhecido por quatro condições:

- a cadeia de deployments avançou um único passo a partir da versão esperada;
- o etag do script e o runtime não mudaram;
- a configuração da versão é a anterior menos o nome apagado;
- o commit publicado não mudou.

Qualquer outro movimento gera `CONCURRENT_CHANGE` e `CLEANUP_PARTIAL`, a execução falha e o estado fica preservado, sem recuperação automática.

## Risco residual

Ainda existem janelas que a detecção não cobre:

- **Entre a leitura "antes" e o DELETE (segundos).** Se uma escrita externa entra nessa janela, a leitura "depois" mostra uma cadeia com dois passos ou um diff diferente. A execução falha, mas o DELETE já aconteceu. O estado fica parcial, mas visível e sem recriação.
- **Mudança que não publica versão** (dados em KV, rotas, domínios). Essas mudanças não alteram o Worker e não são vigiadas aqui. O único efeito que a pós-verificação lê é `/api/sales/status`.
- **Valor de segredo regravado com o mesmo nome por fora.** O valor não é legível, então a mudança só aparece como versão nova na cadeia. Ela é pega se cair dentro de um passo, mas não se ocorrer depois da verificação final.
- **Exclusividade por credencial.** Ela só passa a existir com `CF_TOKEN_ZEVANORY` e a revogação dos tokens compartilhados (`ops/t1-activation.md`, seção D, ação do proprietário).
