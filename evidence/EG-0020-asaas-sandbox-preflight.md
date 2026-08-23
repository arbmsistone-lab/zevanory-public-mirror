# EVIDENCE GATE

ID: EG-0020 / Asaas Sandbox preflight
Decisao: preparar e validar a integracao de pagamento somente em Sandbox, mantendo canais comerciais e eventos financeiros publicos bloqueados ate os gates pre-venda.
Problema: impedir uso acidental de credencial/endpoint de producao e impedir que homologacao seja confundida com venda real.

## Evidencia 1
Fonte: Asaas Sandbox - https://docs.asaas.com/docs/sandbox
Classe: A
Constatacao: Sandbox e ambiente separado, usa chave propria e permite homologar checkout, pagamento e Webhooks sem movimentar valor real.
Limite: conta e credenciais Sandbox ZEVANORY ainda precisam existir e ser configuradas.

## Evidencia 2
Fonte: Mercado Pago - testes de integracao - https://www.mercadopago.com.br/developers/pt/docs/checkout-bricks/integration-test/test-payment-flow
Classe: A
Constatacao: testes exigem credenciais e meios de pagamento de teste antes de disponibilizar o fluxo aos compradores.
Limite: provedor alternativo; confirma o principio independente de separar teste e producao.

## Evidencia 3
Fonte: PayPal Sandbox - https://developer.paypal.com/sandbox-testing/overview/
Classe: A
Constatacao: Sandbox usa contas/credenciais ficticias e transacoes simuladas sem tocar contas ou dinheiro reais.
Limite: provedor alternativo; nao define contrato especifico do Asaas.

## Convergencia
As tres fontes separam explicitamente teste de producao, exigem credenciais proprias do ambiente de homologacao e permitem validar fluxos sem dinheiro real.
Para ZEVANORY, o preflight deve aceitar apenas ASAAS_ENV=sandbox, nunca exibir segredos e manter SALE_GLOBALLY_ENABLED, PRE_SALE_GATES_APPROVED, CHECKOUT_ENABLED, WHATSAPP_SALES_ENABLED e FINANCIAL_EVENTS_ENABLED desligados durante a preparacao.

## Veredito
Veredito: APROVADO
Criterio: credenciais Sandbox proprias + DATABASE_URL + PUBLIC_BASE_URL valida + ambiente Sandbox + canais comerciais/financeiros publicos desligados.
Kill-switch: qualquer credencial ausente, ambiente diferente de sandbox, base publica invalida ou flag comercial/financeira habilitada mantem o preflight BLOQUEADO.
