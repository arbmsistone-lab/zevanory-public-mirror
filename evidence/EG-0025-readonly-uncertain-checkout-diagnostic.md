# EVIDENCE GATE

ID da implementacao: EG-0025
Decisao proposta: criar diagnostico read-only de pedidos checkout_uncertain consultando o Asaas Sandbox por externalReference, sem mutacao automatica.
Problema que resolve: permitir investigar incerteza do provedor sem repetir checkout, forjar pagamento ou alterar estado local.

## Evidencia 1
Fonte: Asaas Listar cobrancas - https://docs.asaas.com/reference/listar-cobrancas
Classe: A
Constatacao: a API permite filtrar cobrancas por externalReference e retorna estado atual para rotinas de conciliacao.
Limites: a consulta exige credencial Sandbox valida e pode retornar zero ou mais cobrancas.

## Evidencia 2
Fonte: Asaas Checkout - https://docs.asaas.com/docs/checkout-asaas
Classe: A
Constatacao: externalReference deve reconciliar o resultado do checkout com o pedido original; callback nao substitui Webhook.
Limites: checkout incerto antes de pagamento pode ainda nao produzir cobranca consultavel.

## Evidencia 3
Fonte: api/checkout/asaas.mjs + src/order.mjs
Classe: A
Constatacao: falha/ambiguidade do provedor leva a checkout_uncertain e a politica de replay bloqueia nova criacao automatica.
Limites: hoje falta uma rotina operacional read-only para investigar esses casos.

## Convergencia e contradicoes
O que as fontes concordam: incerteza deve ser reconciliada por identificador canonico e verdade do provedor, nao por retry cego.
O que diverge: nenhuma fonte garante que todo checkout incerto tera cobranca visivel imediatamente.
O que permanece nao comprovado: resposta real do Asaas Sandbox ZEVANORY sem credenciais proprias.
## Veredito
Veredito: APROVADO
Criterio de teste apos implementacao: rotina so roda em sandbox com DATABASE_URL e ASAAS_API_KEY; consulta por externalReference; nao executa INSERT/UPDATE/DELETE; retorna diagnostico sem segredos.
Kill-switch / rollback: ausencia de qualquer requisito bloqueia execucao; nenhuma mutacao de pedido ou evento financeiro e permitida nesta etapa.