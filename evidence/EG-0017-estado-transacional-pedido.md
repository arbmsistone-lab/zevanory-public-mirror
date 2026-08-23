# EVIDENCE GATE

ID: EG-0017 / Estado transacional do pedido
Decisao: atualizar orders.status somente a partir de evento financeiro autenticado e reconciliado, na mesma operacao atomica que persiste financial_events.
Problema: impedir divergencia entre verdade financeira e estado interno do pedido.

## Evidencia 1
Fonte: Asaas Payment Events - https://docs.asaas.com/docs/payment-events
Classe: A
Constatacao: Asaas diferencia pagamento confirmado/recebido, estorno parcial e estorno total em eventos distintos.
Limite: contrato especifico do provedor Asaas.

## Evidencia 2
Fonte: Mercado Pago Refund Order - https://www.mercadopago.com.br/developers/en/reference/online-payments/checkout-api/refund-order/post
Classe: A
Constatacao: order distingue refunded de partially_refunded e atrela refund a uma order transacional.
Limite: provedor alternativo; nomes de status diferem.

## Evidencia 3
Fonte: Stripe Refunds - https://docs.stripe.com/refunds
Classe: A
Constatacao: Stripe envia eventos para refunds, incluindo parciais, e recomenda logica interna para acompanhar o estado do processo com webhook verificado.
Limite: provedor alternativo; modelo de evento diferente do Asaas.

## Convergencia
As tres fontes exigem separar sucesso financeiro, estorno parcial e estorno total.
O navegador/redirect nunca define orders.status financeiro.

## Veredito
Veredito: APROVADO
Criterio: evento autenticado + consulta ao provedor + persistencia financeira + transicao do pedido em uma unica operacao atomica.
Kill-switch: estado previo invalido, divergencia de order_id/valor/refund ou conflito de persistencia bloqueia a transicao.
