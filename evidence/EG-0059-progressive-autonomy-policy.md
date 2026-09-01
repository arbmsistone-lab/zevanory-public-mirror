# EG-0059 — Progressive Autonomy Policy

Status: APROVADO COM RESTRICOES
Data: 2026-09-01

## Evidencias independentes
1. OpenAI Presence — agentes confiaveis usam simulacoes, evaluations, guardrails, permissoes, approvals/escalation paths, rollout controlado, monitoring e rollback; melhorias usam evidencias de producao.
2. Microsoft Copilot Studio — recomenda ampliar responsabilidade gradualmente e manter supervisao para acoes criticas, com least privilege e validacao de eventos.
3. Salesforce Agentforce — guardrails por risco, containment, monitoramento em logs, limites de comunicacao e handoff para humano sao padroes de confianca.

## Decisao
Desligar `AGENT_HUMAN_APPROVAL_REQUIRED` nao autoriza mais nenhuma acao comercial sozinho. Acoes sensiveis sempre entram no caminho de aprovacao e so podem receber bypass se `AGENT_AUTONOMY_MODE=progressive` e todos os gates de evidencia passarem.

## Autonomia progressiva v1
- read/write interno reversivel: permitido pela politica existente.
- send_message/publish_content: elegiveis apenas em progressive mode com gates comerciais abertos, eval >= 0.95, memoria de outcome com confianca >= 0.70 e >= 60 pagamentos observados, canal coerente com o vencedor aprendido, >= 50 runs em 24h, >= 99% cobertura de eval, >= 99% pass rate, <= 1% falhas, zero retry e zero dead-letter nas ultimas 24h.
- start_checkout: pode ser elegivel sob os mesmos criterios, somente com checkout, eventos financeiros e identidade do merchant explicitamente liberados.
- refund_payment: nunca autonomo em v1.
- destructive: nunca autonomo em v1.

## Default e rollback
`AGENT_AUTONOMY_MODE=guarded` permanece o default. Portanto esta entrega prepara a autonomia progressiva, mas nao a ativa em producao. Qualquer regressao de eval, integracao, memoria ou gates revoga o bypass automaticamente na proxima decisao.
