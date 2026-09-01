# EG-0060 — Provider Delivery Confirmation

Status: APROVADO COM RESTRICOES
Data: 2026-09-01

## Evidencias independentes
1. Meta WhatsApp Cloud API — mensagens aceitas retornam provider message id e mudancas de status sao observadas por webhook; sent, delivered, read e failed sao estados distintos e podem chegar fora da ordem cronologica de recepcao.
2. Resend Webhooks — eventos de email distinguem delivered, delivery_delayed, bounced, complained, opened e clicked; assinatura do webhook deve ser verificada sobre o payload recebido.
3. Stripe Webhooks — webhooks podem ser entregues mais de uma vez e consumidores devem implementar deduplicacao/idempotencia e nao depender da ordem de entrega.

## Decisao
Provider HTTP acceptance e provider-confirmed external effect sao verdades separadas. O integration_outbox guarda a aceitacao pelo provider e a confirmacao posterior no mesmo registro, sem nova tabela.

A correlacao usa provider_message_id persistido no momento da aceitacao. Confirmacoes posteriores so atualizam o registro correspondente e usam timestamp + rank para impedir regressao causada por eventos fora de ordem.

## Restricoes
- Nenhum webhook confirma venda, receita ou pagamento.
- WhatsApp delivery/read confirma estado da mensagem, nao conversao.
- Resend delivered/opened/clicked confirma evento do email, nao resultado comercial.
- Falha de persistencia apos provider acceptance nao autoriza reenvio cego.
- Nenhum canal e ativado por esta mudanca; credenciais e gates continuam fail-closed.
