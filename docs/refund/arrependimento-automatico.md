# Arrependimento com despacho automático

## Escopo e segurança

O fluxo cobre somente pedidos reais pagos pelo checkout próprio do Mercado Pago. Hotmart continua sob o fluxo da própria plataforma. O fechamento de vendas não bloqueia a devolução de um pagamento já confirmado e este código não cria cobranças.

`REFUND_AUTO_DISPATCH` nasce desligado. Somente o valor textual `true` ativa o despacho. Ausência, `false`, `0` ou qualquer outro valor mantêm o comportamento anterior: registro e decisão manual em `/admin/refunds`.

## Fluxo

1. O consumidor informa pedido e e-mail.
2. O Worker cruza o pedido local, o evento de pagamento confirmado, o destinatário da entrega e o pagamento consultado no Mercado Pago.
3. O pedido é registrado e o consumidor recebe imediatamente um e-mail com protocolo. O registro não armazena o e-mail completo, apenas a versão mascarada.
4. Com o interruptor ligado, o Worker só reserva e envia o estorno quando todas as verificações passam: janela vigente, identidade, pedido pago, pagamento aprovado, valor integral, `offer_id`, referência do pedido, ausência de reembolso, disputa ou chargeback, pedido não pertencente à certificação e credencial do ambiente correto.
5. A reserva é uma inserção transacional única em `refund_provider_claims`. Somente quem obtém a reserva pode fazer o `POST`, sempre com `X-Idempotency-Key: zevanory-refund-<order_id>`.
6. Confirmação inequívoca marca o registro como `approved`, revoga downloads e notifica consumidor e proprietário. A mensagem do proprietário é uma notificação, não uma aprovação.

## Estados e recuperação

- `pending`, `auto_eligible=true`: registrado e em despacho.
- `pending`, `manual_reason=<motivo>`: fila manual. O painel mostra o motivo e a idade do pedido.
- `approved`: o provedor confirmou o estorno; repetições não geram novo `POST`.
- `provider_outcome_unknown=true`: timeout, falha de rede, 5xx ou resposta não terminal. Nunca há repetição cega. O watchdog usa apenas `GET` para conciliar.
- `download_revocation_pending=true`: o estorno foi confirmado, mas a revogação local precisa ser reparada; não há novo `POST` financeiro.

As exceções manuais incluem identidade não confirmada, prazo encerrado, pedido ou pagamento não aprovado, valor/referência/oferta divergente, reembolso anterior, disputa/chargeback, certificação e credencial incompatível.

## Credenciais

Produção recusa tokens iniciados por `TEST-`; sandbox/certificação exige esse prefixo. A incompatibilidade falha fechado antes de qualquer chamada ao Mercado Pago, registra motivo manual e tenta alertar o proprietário. Nenhum teste ou documentação exige uma credencial real.

## Desligamento de emergência

Defina `REFUND_AUTO_DISPATCH=false` (ou remova a variável) e publique a configuração pelo processo operacional autorizado. Isso restaura o fluxo manual. O desligamento não apaga protocolos, reservas, estados ambíguos ou pedidos pendentes; eles continuam visíveis e conciliáveis.

## Revisão jurídica pendente

Este desenho implementa a regra técnica informada para o CDC art. 49 e o Decreto 7.962/2013, art. 5º, §3º. Ainda dependem de revisão jurídica: a redação final dos e-mails, o tratamento operacional de pedidos fora da janela que aleguem vício/falha de entrega, os prazos internos de atendimento manual e a política de retenção dos registros. Este documento não substitui parecer jurídico.
