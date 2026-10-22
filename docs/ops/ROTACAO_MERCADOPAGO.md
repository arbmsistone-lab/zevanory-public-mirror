# Rotação Mercado Pago — token de produção e segredo do webhook (B01, fase 2)

Estado: **PREPARADO, NÃO AUTORIZADO.** Determinação do Sol (21/10/2026 09:29): só correções e plano de
contingência, por análise estática ou em teste. Nenhuma credencial é lida ou alterada nesta etapa. A troca
real exige ordem específica do proprietário, e só ele cola valores. Claude e o Sol não colam valores.

## 1. Token de acesso (`MERCADOPAGO_ACCESS_TOKEN` no Worker `zevanory`)

Workflow: `.github/workflows/mercadopago-production-token-rotate.yml`. Ele só roda por `workflow_dispatch`
e no Environment `producao-critica`, que exige revisor.

| Ordem | Passo | Se falhar |
|---|---|---|
| 1 | `/users/me` responde 200, com conta MLB e sem a tag `test_user` | Para. O Worker continua com o token atual. |
| 2 | **MP-02:** `/v1/payments/search?limit=1` e `/v1/payment_methods` respondem 200 (só leitura) | Para. Nada foi gravado. |
| 3 | **MP-03:** captura a versão ativa do Worker, que tem de estar a 100% (ponto de retorno) | Para. Nada foi gravado. Em implantação gradual, recusa (fail-closed). |
| 4 | Registra `WRITE_ATTEMPTED_AT`, depois `wrangler secret put` grava o novo valor e registra `ROTATED_AT` | Mesmo que a gravação falhe, ela PODE ter sido aplicada com a resposta perdida (gravação ambígua): `MP_WRITE_UNCERTAIN`, retorno automático para a versão anterior e leitura de confirmação (passo 6). Não presuma "nada a desfazer". |
| 5 | Espera o preflight do Worker, mais novo que `ROTATED_AT`, com `mercadopago_production_token` ok (até 80 min, Ordem 046 R1; antes eram 40) | Executa o passo 6. |
| 6 | `wrangler rollback <versão anterior>` + leitura da versão ativa (tem de ser a anterior) | Leitura diferente => `MP_ROLLBACK_READBACK_FAIL`, incidente aberto. |

- **Perda do runner (risco Sol 038-R4):** se a máquina do GitHub morrer entre a gravação e o passo de
  retorno, nenhum passo do mesmo job roda. Protocolo:
  1. o preflight periódico do Worker alerta quando `mercadopago_production_token` não opera;
  2. o proprietário confere em Cloudflare → Workers → zevanory → Deployments a versão ativa e a anterior
     (`ROLLBACK_POINT` no log do run);
  3. com autorização expressa, faz rollback para `ROLLBACK_POINT` pelo painel ou por `wrangler rollback`;
  4. confirma pelo preflight seguinte; as vendas continuam fechadas o tempo todo.
- **Execução única e concorrência (risco Sol 038-R5):** o workflow só roda por dispatch manual no gh-pages,
  nunca por re-run (`run_attempt == 1`), e dois dispatches nunca rodam juntos (`concurrency`).
- **MP-01:** o token Cloudflare vem só de `secrets.CLOUDFLARE_API_TOKEN` (o do Environment). O nome antigo
  `…PUBLIC_OWNER…` não é mais lido. Espaços e quebras de linha são removidos do valor, como no #851.
- **Falha ambígua (contestação Sol 21/10) — BLOQUEANTE para a troca real:** a tentativa de gravação é
  registrada (`WRITE_ATTEMPTED_AT`) antes do `secret put`. Se o wrangler falhar sem confirmar, o run publica
  `MP_WRITE_UNCERTAIN`, executa o retorno e só aceita a versão anterior confirmada por leitura. A troca real
  continua bloqueada até o Sol reproduzir os testes e aceitar esse tratamento. Caso real do mesmo padrão em
  21/10: o deploy do site de vendas subiu a versão e falhou depois, na etapa de rotas.
- **Restauração do valor do segredo pelo rollback: YES_OBSERVED.** Ensaio B01, run 39643799156, num Worker
  descartável da conta Zevanory: segredo A → B → rollback. Depois do rollback, o Worker voltou a servir
  exatamente o digest de A. Classificação do Sol (Ordens 036/037): YES observado, com uma lacuna declarada
  (o id da versão A não foi impresso); resultado literal do workflow INCONCLUSIVE, porque a limpeza
  automática falhou; limpeza manual certificada pelo CODEX-005. Em produção, o preflight continua sendo a
  confirmação.
- **Restrição da plataforma (Cloudflare 10215):** quando a versão mais recente do Worker NÃO está implantada
  (por exemplo, logo depois de um rollback), `wrangler secret put` e `secret delete` são recusados.
  - O workflow agora para ANTES de gravar se a versão ativa não for a mais recente
    (`MP_LATEST_VERSION_NOT_DEPLOYED_10215`).
  - Para mudar um segredo nessa situação: (1) implantar a versão mais recente pelo deploy central e depois
    trocar; ou (2) `wrangler versions secret put MERCADOPAGO_ACCESS_TOKEN --name zevanory`, seguido de
    `wrangler versions deploy <nova-versão>@100 --name zevanory`. Isso exige autorização do proprietário.
  - Documentação: https://developers.cloudflare.com/workers/observability/errors/#secret-modification-with-worker-versions-10215
- **Espera do preflight (Ordem 046 R1):** o preflight do Worker roda só no cron horário (minuto :00). A espera
  passou de 40 min para 80 min (4800 s), o que cobre uma hora inteira mais 15 min de atraso, qualquer que seja o
  minuto da gravação. O timeout do job passou de 55 para 100 min. Um teste percorre todos os minutos da hora
  e a virada de hora e de dia.
- **Falha depois da renovação no Mercado Pago (Ordem 046 R2):** a renovação não tem volta, porque o token antigo
  morre 12 h depois. Se a rotação falhar depois de gravar, o retorno automático deixa o Worker com o token
  ANTIGO, e a versão com o token NOVO fica como a mais recente, não implantada (10215).
  1. O run da rotação imprime `NEW_SECRET_VERSION` (logo depois da gravação) e, no retorno,
     `RECOVERY_TARGET_VERSION` (a mais recente por `number`). Se as duas divergirem: `MP_RECOVERY_TARGET_MISMATCH`,
     parar e decidir com o proprietário.
  2. Recuperação, com autorização literal do proprietário: dispatch `mode=recover` com
     `target_version=<RECOVERY_TARGET_VERSION>` e `rollback_point=<ROLLBACK_POINT do mesmo run>`, e o
     proprietário aprova `producao-critica`. O passo roda `scripts/ops/worker-version-recover.sh`. Ele recusa se a
     versão ativa não for exatamente o ROLLBACK_POINT do incidente (Sol 047), se o alvo não for a mais recente ou
     se o alvo já estiver ativo,
     implanta o alvo a 100% e certifica por leitura. Depois espera um preflight novo com o token ok. O modo
     recover nunca faz retorno automático para o token antigo.
  3. Esse mesmo script é certificado pelo ensaio B01-R (`b01-recovery-probe.yml`), no Worker descartável. O
     ensaio reproduz A → B → rollback, exige a recusa real 10215 (controle negativo), recupera com o script e
     confirma que o Worker voltou a servir o digest de B. Resultado: `RECOVERY_CERTIFIED=YES`.
  4. Enquanto o B01-R não for YES, a rotação real continua NO-GO (Sol, Ordem 046).
  - Impacto se nada for feito em 12 h: consulta de pagamentos, reconciliação, watchdog, entrega, estornos e
    reclamações ficam sem token. Vendas fechadas não eliminam as obrigações pós-venda.
- **Escopo do segredo (concluído, B01 certificado pelo Sol):** `MERCADOPAGO_PROD_ACCESS_TOKEN` existe só no
  Environment `producao-critica`; a cópia antiga como segredo de repositório foi removida. O modo check-only
  imprime `MP_SECRET_SCOPE=NOT_CHECKED_IN_WORKFLOW`: o job não consegue verificar isso sozinho, porque listar
  os nomes dos segredos do repositório exige a permissão "Secrets", que o `GITHUB_TOKEN` não pode receber.
  A verificação é feita fora do workflow, por quem administra o repositório (Settings → Secrets, só nomes).

## 2. Segredo do webhook (`MERCADOPAGO_WEBHOOK_SECRET`)

Comportamento verificado no código (gh-pages):

- `verifyMercadoPagoSignature` (cloudflare-worker.recovered.mjs) valida um HMAC-SHA256 de
  `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`. A janela é de 10 min. Ele aceita **um** segredo.
- Uma assinatura inválida responde 401. Antes disso, `recordMercadoPagoWebhookSignature`
  (mercadopago-webhook-safety.mjs) põe o pagamento numa fila de reconciliação no KV, com validade de 7 dias,
  e alerta o proprietário.
- A cada tick do cron, `runPaidDeliveryWatchdog` esvazia até 10 itens da fila. Ele consulta o pagamento
  direto na API do Mercado Pago (`trustedRecovery`, com o token de acesso). Isso REDUZ o risco de perda na janela
  de segredos diferentes, mas NÃO está provado que elimina: falta provar persistência da fila, capacidade de
  drenagem, o que acontece após os 7 dias de validade e falhas simultâneas do KV ou da API do provedor (contestação Sol 21/10).
- A cadência do cron fica no painel e não foi determinada aqui.

Procedimento (o proprietário executa, depois de autorizar):

1. Conferir que a fila está vazia: o preflight está ok e não houve alerta "Assinatura inválida" recente.
2. No painel Mercado Pago (Suas integrações → aplicação de produção → Webhooks), gerar o novo segredo.
3. Logo em seguida, gravar o mesmo valor em `MERCADOPAGO_WEBHOOK_SECRET` do Worker `zevanory`. Pode ser pelo
   painel Cloudflare (conta Zevanory, `1b264158…`), em Settings → Variables and Secrets, ou por um workflow
   equivalente ao do token.
4. Nos minutos entre o passo 2 e o passo 3, os webhooks recebem 401 e vão para a fila. Isso é esperado.
5. Para dar como concluído:
   - um webhook real com `signature_valid=true` (chave KV `zpc-mercadopago-webhook-signature:v1` mais nova
     que a troca);
   - a fila de recuperação vazia;
   - nenhum pedido pago com entrega pendente por mais de 15 min.

Risco residual registrado: se a janela entre os passos 2 e 3 for longa e houver mais de 10 pagamentos por
tick, a fila esvazia em vários ticks. Isso atrasa a entrega, mas não a perde dentro dos 7 dias de validade.
Mitigação opcional: aceitar o segredo anterior por uma janela curta (`MERCADOPAGO_WEBHOOK_SECRET_PREVIOUS`).
Isso não foi implementado, porque muda a autenticação de produção; fica como proposta para contestação.

Vendas continuam fechadas até "LIBERAR VENDAS". Nenhum passo deste documento abre vendas.
