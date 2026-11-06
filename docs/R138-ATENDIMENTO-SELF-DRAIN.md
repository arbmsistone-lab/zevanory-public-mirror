# R138 | /atendimento outbox em invocação SELF isolada

O cron de 11:00 BRT foi observado pelo Claude com `Too many subrequests by single Worker invocation`. O dreno executava dentro de `runRefundWatchdog`, depois de tarefas concorrentes e com limite de 50 subrequisições do Workers Free.

A proposta separa o dreno no endpoint `/api/internal/atendimento/outbox/drain` com HMAC (segredo pré-existente, método, caminho, minuto, nonce de 128 bits). Nonce consumido atomicamente no PostgreSQL através da tabela de suporte já existente. Somente minuto atual/anterior. Sem autorização por cabeçalhos arbitrários. A rota valida a assinatura ANTES de consultar a trava de vendas. O cron chama `dispatchAtendimentoDrain` via `SELF.fetch`, ANTES de preflight e do conjunto de tarefas pesadas, após o suporte. Falha de SELF é explícita; **sem fallback inline** para não reproduzir esgotamento de budget. Métrica `atendimento_outbox`: via/status/ok/checked/done/pending/dead/reason, sem dado pessoal.

`runRefundWatchdog` deixa de tocar a outbox e retorna apenas reconciliação de reembolsos. O algoritmo de `drainAtendimentoOutbox`, suas Idempotency-Keys, Resend, limite 23h e SQL permanecem intactos. Nenhuma alteração de produção ou credenciais neste PR. Testes R138 de ordem, assinatura, SELF, fail-closed e replay (uso de SQL mock). Revisar em CI PostgreSQL e Windows antes de merge.

Não presumir que o protocolo de 06/11 esteja dentro da janela no momento da publicação. Nenhum reenvio foi realizado pelo PR.
