# EVIDENCE GATE

ID: EG-0013 / Provedor de pagamento autenticado
Decisao: priorizar Asaas como primeiro provedor de pagamento do EXP-0001.
Problema: confirmar pagamento/refund por fonte transacional autenticada, nunca por browser/callback.

## Evidencia 1
Fonte: Asaas Checkout - https://docs.asaas.com/docs/checkout-asaas
Classe: A
Constatacao: checkout hospedado suporta Pix/cartao, externalReference, callbacks e Webhooks; callback nao substitui Webhook financeiro.
Limite: requer conta, credenciais e validacao em Sandbox/Production.

## Evidencia 2
Fonte: Mercado Pago Pix/Orders - https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/payment-integration/pix
Classe: A
Constatacao: Pix usa credencial backend, X-Idempotency-Key obrigatoria, notificacoes de Order e GET para estado atualizado.
Limite: alternativa tecnica; nao foi escolhida como primeira integracao.

## Evidencia 3
Fonte: Stripe Pix/Webhooks - https://docs.stripe.com/payments/pix e https://docs.stripe.com/payments/payment-intents/verifying-status
Classe: A
Constatacao: suporta Pix e exige fluxo server-side/webhook para estado financeiro; webhooks podem ter assinatura verificada.
Limite: alternativa global; elegibilidade/operacao Pix deve ser validada na conta real.

## Convergencia e contradicoes
As tres alternativas exigem estado financeiro server-side e suportam notificacoes assincronas/idempotencia.
Asaas foi priorizado por checkout hospedado, Pix/cartao, Sandbox, externalReference e authToken obrigatorio de Webhook.
Ainda nao comprovado: aprovacao da conta ZEVANORY, tarifas reais, liquidacao, primeira cobranca e primeiro pagamento.

## Veredito
Veredito: APROVADO
Criterio: integrar primeiro em Sandbox; Webhook autenticado nunca confirma sozinho; reconciliar pela API antes de gravar evento financeiro.
Kill-switch: credencial ausente, token invalido, divergencia de valor/referencia/status ou API indisponivel bloqueiam confirmacao.
