# EVIDENCE GATE

ID da implementacao: EG-0022
Decisao proposta: centralizar a politica deterministica de replay de checkout sem alterar gates comerciais.
Problema que resolve: reduzir risco de duplicidade, retry indevido e divergencia entre estados de pedido.

## Evidencia 1
Fonte: api/checkout/asaas.mjs
Classe: A
Constatacao: request_id e unico; conflito de session_id bloqueia; checkout_ready reutiliza URL; apenas created pode tentar novo checkout.
Limites: a regra esta hoje espalhada no handler e pouco testavel isoladamente.

## Evidencia 2
Fonte: api/webhooks/asaas.mjs
Classe: A
Constatacao: pagamento e refund so alteram pedido depois de reconciliacao autenticada com o provedor e estados permitidos.
Limites: callbacks do navegador nao sao fonte financeira autoritativa.

## Evidencia 3
Fonte: db/migrations/003_orders_checkout.sql e 005_order_financial_states.sql
Classe: A
Constatacao: banco exige request_id e external_reference unicos e restringe status a estados conhecidos, incluindo checkout_uncertain, canceled e expired.
Limites: restricao de banco nao substitui politica explicita de replay na aplicacao.

## Convergencia e contradicoes
O que as fontes concordam: retries devem ser fail-closed e estado financeiro depende de reconciliacao.
O que diverge: nenhuma divergencia material.
O que permanece nao comprovado: comportamento real do Asaas Sandbox sem credenciais proprias.

## Veredito
Veredito: APROVADO
Criterio de teste apos implementacao: replay de checkout_ready reutiliza URL; request_id com outra sessao bloqueia; apenas created e retryable; checkout_uncertain e estados finais nunca disparam novo checkout.
Kill-switch / rollback: manter SALE_GLOBALLY_ENABLED, PRE_SALE_GATES_APPROVED, CHECKOUT_ENABLED, WHATSAPP_SALES_ENABLED e FINANCIAL_EVENTS_ENABLED desligados; rollback do refactor se qualquer teste ou auditoria falhar.