# EG-0052 — ZEVANORY Robot Observability / World-Class Control

Status: APROVADO COM RESTRICOES
Data: 2026-08-31

## Evidencias independentes
1. OpenAI Agents SDK tracing: trace completo de runs, geracoes, tool calls, guardrails, handoffs e eventos customizados.
2. AWS Bedrock AgentCore Observability: sessao -> trace -> spans, com inputs/outputs, tool calls, tempos, erros, recovery e recursos.
3. Microsoft Foundry Agent Monitoring: latencia, success rate, evaluacoes continuas, alertas e tracing OpenTelemetry.
4. Google SRE: latencia, trafego, erros e saturacao como sinais fundamentais de operacao.
5. OpenAI guardrails: validacao antes/depois de tool calls e bloqueio explicito de efeitos inseguros.

## Decisao
A ZEVANORY deve operar com trilha auditavel por acao, nunca apenas agregados. Cada execucao precisa expor: origem, objetivo, decisao, justificativa, confianca, politica, ferramenta, efeito externo, evidencia, duracao, resultado, retry, erro e proxima acao.

## Restricoes
- Nao fabricar atividade, venda, mensagem, publicacao ou pagamento.
- Estado visual deve distinguir planejado, bloqueado, executado e confirmado externamente.
- Dados sensiveis/PII nao entram em painel publico.
- Controles destrutivos exigem autenticacao e confirmacao dedicada.
- Nenhum gate comercial/financeiro sera aberto por esta frente.
