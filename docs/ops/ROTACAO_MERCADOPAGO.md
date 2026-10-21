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
| 4 | `wrangler secret put` grava o novo valor e registra `ROTATED_AT` | Se a própria gravação falhar, não há o que desfazer. |
| 5 | Espera o preflight do Worker, mais novo que `ROTATED_AT`, com `mercadopago_production_token` ok (até 40 min; antes eram 70) | Executa o passo 6. |
| 6 | `wrangler rollback <versão anterior>` + leitura da versão ativa (tem de ser a anterior) | Leitura diferente => `MP_ROLLBACK_READBACK_FAIL`, incidente aberto. |

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
- **Recomendação ao proprietário:** mover `MERCADOPAGO_PROD_ACCESS_TOKEN` para o Environment
  `producao-critica`. Como segredo de repositório, ele fica disponível a qualquer workflow do repositório.

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
