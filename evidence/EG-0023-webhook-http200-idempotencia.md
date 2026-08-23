# EVIDENCE GATE

ID da implementacao: EG-0023
Decisao proposta: responder HTTP 200 para webhooks Asaas processados com sucesso ou reconhecidos como duplicados, preservando falha explicita para eventos nao persistidos/reconciliados.
Problema que resolve: evitar retries e penalizacao indevida da fila quando o evento foi processado corretamente.

## Evidencia 1
Fonte: Asaas Webhooks FAQ - https://docs.asaas.com/docs/webhooks-faq
Classe: A
Constatacao: o Asaas considera HTTP 200 como entrega bem-sucedida; respostas diferentes iniciam tratamento de falha e retries.
Limites: regra do provedor pode evoluir e deve ser revalidada antes de mudancas futuras.

## Evidencia 2
Fonte: Asaas Como implementar idempotencia em Webhooks - https://docs.asaas.com/docs/como-implementar-idempotencia-em-webhooks
Classe: A
Constatacao: entrega e at least once; duplicatas devem reutilizar o event id e manter resultado idempotente.
Limites: a recomendacao de processamento assincrono nao e implementada neste gate.

## Evidencia 3
Fonte: api/webhooks/asaas.mjs + financial_events unique provider_event_id
Classe: A
Constatacao: ZEVANORY ja deduplica eventos via ON CONFLICT DO NOTHING e hoje retorna 202 mesmo quando accepted=true.
Limites: credenciais Sandbox proprias ainda faltam para prova externa fim a fim.

## Convergencia e contradicoes
O que as fontes concordam: evento aceito/duplicado deve ser idempotente e reconhecido com sucesso ao provedor.
O que diverge: o handler atual usa 202, divergindo da regra atual do Asaas.
O que permanece nao comprovado: comportamento real da fila ZEVANORY no Sandbox sem credenciais proprias.
## Veredito
Veredito: APROVADO
Criterio de teste apos implementacao: accepted=true e duplicate=true/false retornam HTTP 200; auth, gate, payload, reconciliacao e persistencia invalidos continuam falhando explicitamente.
Kill-switch / rollback: manter FINANCIAL_EVENTS_ENABLED=false ate homologacao Sandbox; reverter a mudanca se qualquer teste, auditoria 3X ou prova operacional falhar.