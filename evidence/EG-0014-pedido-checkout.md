# EVIDENCE GATE

ID: EG-0014 / Pedido interno e checkout
Decisao: criar pedido interno antes do checkout e usar o order_id como referencia externa do provedor.
Problema: impedir checkout orfao, duplicidade e falsa confirmacao financeira.

## Evidencia 1
Fonte: Asaas Checkout - https://docs.asaas.com/docs/checkout-asaas
Classe: A
Constatacao: o fluxo recomendado cria o pedido no sistema de origem, envia externalReference, salva id/link/status e confirma resultado por Webhook/API.
Limite: contrato especifico do Asaas; exige credenciais e teste Sandbox.

## Evidencia 2
Fonte: Mercado Pago Orders/Pix - https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/payment-integration/pix
Classe: A
Constatacao: order usa external_reference e X-Idempotency-Key obrigatoria para evitar duplicidade.
Limite: provedor alternativo; nomes de campos diferem do Asaas.

## Evidencia 3
Fonte: Stripe Checkout/Idempotency - https://docs.stripe.com/payments/checkout-sessions e https://docs.stripe.com/api/idempotent_requests
Classe: A
Constatacao: checkout server-side suporta client_reference_id/metadata para reconciliar pedido e idempotency key para retries seguros.
Limite: provedor alternativo; nao define o contrato Asaas.

## Convergencia e contradicoes
As tres fontes convergem em referencia interna, criacao server-side e protecao contra duplicidade.
Nenhuma fonte autoriza tratar redirect/sucesso de checkout como pagamento confirmado.
Ainda nao comprovado: credenciais Asaas ZEVANORY, primeiro checkout Sandbox e primeiro pagamento real.

## Veredito
Veredito: APROVADO
Criterio: pedido interno persistido antes do checkout; retries nao podem criar pedidos duplicados; checkout so em Sandbox ate prova operacional.
Kill-switch: sem credenciais, sem pedido valido, divergencia de valor/referencia ou provider indisponivel bloqueiam criacao.
