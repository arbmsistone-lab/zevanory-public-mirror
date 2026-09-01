# EG-0055 — Agent Effect Truth + Observability

Status: APROVADO COM RESTRICOES
Data: 2026-09-01

## Evidencias independentes
1. Salesforce Agentforce Observability (Salesforce Help, 2026-04-08): mede desempenho, efetividade, feedback, escalacao e sessoes com Session Tracing Data Model. Fonte: https://help.salesforce.com/s/articleView?id=005226932&language=en_US&type=1
2. Microsoft Dynamics 365 Sales AI Agents (Microsoft Learn, 2026): agentes autonomos exigem monitoramento de desempenho e operam sobre qualificacao, oportunidades e fechamento. Fonte: https://learn.microsoft.com/pt-br/dynamics365/sales/ai-agent-overview
3. Fin / Intercom (2026-07-31): um unico agente alterna papeis ao longo da jornada; workflows controlam canais, handoff e comportamento antes de ativacao. Fonte: https://www.intercom.com/help/pt-BR/articles/7120684-fin-ai-agent-explicado
4. Shopify Sidekick: executa tarefas no contexto da loja, respeita permissoes e apresenta alteracoes para revisao antes da aplicacao. Fonte: https://help.shopify.com/pt-BR/manual/ai-powered-tools/sidekick

## Decisao
ZEVANORY deve separar explicitamente decisao, solicitacao externa, entrega da solicitacao e verdade transacional. Um run que apenas enfileirou ou entregou uma requisicao a um canal nao pode ser apresentado como venda, pagamento, publicacao efetiva ou resultado de negocio confirmado.

O Robot Control deve expor metricas auditaveis de runs, latencia, cobertura de trace, aprovacoes e estado da outbox, sem PII e sem forecast inventado.

## Restricoes
- Nenhuma mudanca abre SALE_GLOBALLY_ENABLED, PRE_SALE_GATES_APPROVED, CHECKOUT_ENABLED, WHATSAPP_SALES_ENABLED ou FINANCIAL_EVENTS_ENABLED.
- `external_request_delivered` significa somente que o adapter aceitou/entregou a requisicao; nao prova pagamento, venda, publicacao visivel ou conversao.
- Pagamento continua verdadeiro somente apos reconciliacao autenticada do provedor.
- Nenhum novo schema e necessario; usar trace_id/run_id existentes e integration_outbox.
- Fechamento exige testes, auditoria 3X, Reliability 20X e prova operacional.