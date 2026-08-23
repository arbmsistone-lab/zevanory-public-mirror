# EVIDENCE GATE

ID: EG-0009 / Governanca de Continuidade ZEVANORY
Decisao: todo agente/chat deve consultar o documento mestre antes de pesquisar, alterar ou implementar.
Problema: impedir desvio de escopo, repeticao de erros e mudancas de trajeto sem evidencia.

## Evidencia 1
Fonte: NIST SP 800-218 SSDF - https://csrc.nist.gov/pubs/sp/800/218/final
Classe: A
Constatacao: praticas de desenvolvimento seguro devem ser integradas e repetiveis no ciclo de software.

## Evidencia 2
Fonte: OpenAI - A practical guide to building agents
Classe: B
Constatacao: guardrails, limites, intervencao humana e ciclos de avaliacao sao essenciais, especialmente no inicio.

## Evidencia 3
Fonte: Microsoft Experimentation Platform / Safe Velocity
Classe: B
Constatacao: mudancas confiaveis exigem qualidade de dados, metricas de sucesso e guardrails antes de ampliar rollout.

## Veredito
Veredito: APROVADO
Kill-switch: qualquer acao que nao identifique estado atual, proximo gate e evidencias exigidas fica BLOQUEADA.