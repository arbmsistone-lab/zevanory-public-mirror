# EG-0057 — Continuous Agent Evaluation

Status: APROVADO COM RESTRICOES
Data: 2026-09-01

## Evidencias independentes
1. OpenAI Agents SDK — tracing registra gerações, tool calls, guardrails e spans; testes determinísticos permitem validar workflows sem chamadas reais ao modelo.
2. Microsoft Foundry — avaliação de agentes mede sistema e processo, incluindo task adherence, tool selection, tool input accuracy e tool call success; quality gates podem falhar CI.
3. Google Vertex / Gemini Enterprise Agent Platform — avaliação separa resposta final de trajetória e mede sequência/uso de ferramentas, incluindo precisão, recall e single-tool use.

## Decisao
A ZEVANORY deve avaliar cada decisão antes da execução e manter uma suíte offline determinística com cenários positivos e adversariais.
Quality gate local usa critérios verificáveis; métricas sem ground truth real não serão apresentadas como qualidade comprovada em produção.

## Criterios obrigatorios
- ação, justificativa e confiança válidas;
- ferramenta coerente com a ação;
- ações externas exigem conteúdo e pré-condições mínimas;
- estágios terminais não disparam novas ações comerciais;
- alegações de venda/pagamento/ROAS sem fonte transacional são rejeitadas;
- autorização negada não pode ser contornada por execute=true.

## Restricoes
- Avaliação offline não prova conversão, receita, satisfação ou qualidade comercial.
- Nenhum gate comercial ou financeiro é aberto por esta fase.
- Falha de qualquer cenário crítico bloqueia promoção da versão do agente.
