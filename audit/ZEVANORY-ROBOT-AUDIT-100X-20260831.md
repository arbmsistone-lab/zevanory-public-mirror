# ZEVANORY — Auditoria Técnica 100X do Robô Comercial

Data: 2026-08-31
Status global: BLOCKED PARA AUTONOMIA TOTAL
Resultado automatizado: 84 PASS / 16 FAIL / 8 P0
Escopo: decisão, execução, canais, observabilidade, segurança, financeiro, recuperação e controle humano.

## Conclusão executiva
A ZEVANORY possui uma base forte de governança, CRM, fila, agente, memória, knowledge base, evals, outbox, checkout, reconciliação, telemetria e fail-closed. Ela ainda NÃO é um robô comercial ponta a ponta autônomo.

A principal regra desta auditoria é: decisão não é execução; execução não é entrega; entrega não é resultado financeiro confirmado. A interface precisa mostrar essas quatro camadas separadamente.

## P0 corrigido nesta frente
Foi encontrado risco de integridade referencial: `agent_tool_audit.run_id` referencia `agent_runs.run_id`, mas o worker gravava o audit antes do run. O worker foi corrigido para persistir o run primeiro, depois o tool audit, e registrar falha de execução da ferramenta de forma explícita. Teste dedicado adicionado.

## P0 ainda abertos
1. `send_message` existe na política, mas não é alcançado por `chooseTool()`.
2. `publish_content` existe na política, mas não é alcançado por `chooseTool()`.
3. `start_checkout` existe na política, mas não é alcançado por `chooseTool()`.
4. `refund_payment` existe na política, mas não é alcançado por `chooseTool()`.
5. Executor comercial real ainda não existe no worker.
6. Executor financeiro real ainda não existe no worker.
7. Não existe endpoint real de pausa/stop do robô.
8. Não existe fila explícita de aprovação humana para ações de alto risco.

## P1 abertos
- Falta um `trace_id/correlation_id` global ligando lead, decisão, ferramenta, outbox, canal, checkout, pagamento e entrega.
- Falta `span_id` por operação discreta para tracing de nível mundial.
- Falta hierarquia explícita sessão → trace → spans.
- Confirmação externa de entrega/publicação ainda não está ligada ao run do agente.
- Não há workflow de compensação/saga para desfazer efeitos parciais entre múltiplos canais/financeiro.
- Falta pipeline explícito de redaction/PII para prompt, output e observabilidade do modelo.

## P2 abertos
- `agent_runs` ainda não registra tokens de entrada/saída.
- `agent_runs` ainda não registra custo estimado/real por execução.

## Benchmark mundial aplicado
O padrão observado em OpenAI Agents SDK, AWS AgentCore, Microsoft Foundry, LangSmith, Google SRE e NIST converge para: tracing de ponta a ponta, spans de ferramenta/modelo, guardrails antes e depois de efeitos, métricas operacionais, avaliações contínuas, logs correlacionados e intervenção humana em ações de risco.

A ZEVANORY deve adotar internamente uma hierarquia equivalente:
`Jornada comercial → Trace → Decisão → Tool/Canal → Efeito externo → Confirmação → Resultado → Próxima ação`.

## Fluxo alvo quando tudo estiver desbloqueado
1. Pesquisa mercado e sinais de intenção.
2. Seleciona hipótese e público com evidência.
3. Gera criativo e registra versão/origem.
4. Submete publicação ao policy gate e, quando necessário, aprovação humana.
5. Publica pelo adapter do canal e aguarda confirmação real do provedor.
6. Captura origem/UTM e cria ou atualiza lead idempotente.
7. Analisa intenção/contexto e escolhe resposta segura.
8. Envia mensagem somente após policy/channel gate e registra delivery/erro.
9. Agenda follow-up conforme estágio, touchpoints e limites.
10. Gera oferta e checkout somente para oferta/preço autorizados.
11. Reconcilia pagamento server-side antes de declarar venda.
12. Libera entrega digital apenas após `payment_confirmed` reconciliado.
13. Confirma entrega e suporte sem misturar estado financeiro com estado operacional.
14. Atualiza CRM, funil e memória apenas com fatos observados.
15. Calcula receita, refunds, custos e margem com fontes transacionais autenticadas.
16. Executa avaliação online/offline sobre qualidade, segurança e resultado.
17. Compara hipótese, canal, criativo e etapa do funil somente quando houver baseline suficiente.
18. Recomenda a próxima ação e registra a justificativa.
19. Se houver falha crítica, bloqueio, dead-letter, anomalia ou risco: pausa a ação dependente e chama operador.
20. Nunca transforma ausência de erro em sucesso comercial.

## Contrato visual obrigatório do Control Room
Cada linha da timeline deve responder: quando aconteceu, quem/qual job iniciou, qual foi a decisão, qual ferramenta foi selecionada, qual política autorizou/bloqueou, qual efeito externo ocorreu, qual confirmação voltou, quanto demorou, qual foi o resultado e qual é a próxima ação.

Estados visuais canônicos:
- PREPARADO: capacidade existe, efeito externo ainda não executado.
- BLOQUEADO: guardrail/gate/canal impediu a ação.
- EXECUTANDO: operação iniciada e ainda sem confirmação final.
- CONCLUÍDO: operação técnica concluiu com evidência.
- CONFIRMADO: provedor/ledger confirmou o efeito externo ou financeiro.
- FALHOU: tentativa terminou com erro.
- RETRY: nova tentativa agendada com backoff.
- DEAD-LETTER: exige investigação humana.
- PAUSADO: operador ou circuit breaker suspendeu novas ações.

## Tela implementada nesta frente
`public/zevanory-robot-control.html` + CSS/JS dedicados, `noindex`, com modo demonstração explicitamente marcado e modo operador autenticado. A API `api/robot-control.mjs` exige `OPERATOR_TOKEN`, não retorna PII nem payload bruto e expõe runs, tool audits, jobs, outbox, gates e readiness de canais.

A tela mostra em uma única superfície: estado do robô, runs, execução, bloqueios, falhas, timeline, matriz ponta a ponta, gates, funil e saúde do outbox. O botão de pausa aparece como PENDENTE justamente porque o endpoint real ainda não existe; a interface não finge esse controle.

## Critério de GO para autonomia total
Autonomia total permanece NO-GO enquanto existir qualquer P0 do auditador 100X. Após implementação dos P0, repetir: testes completos, auditoria 100X, auditoria 3X, segurança, observabilidade, carga, DR, sandbox de canais, primeira transação piloto e prova operacional antes de escalar.

## Pesquisa mundial — 10 referências oficiais
1. OpenAI Agents SDK — Tracing: https://openai.github.io/openai-agents-js/guides/tracing/
2. OpenAI Agents SDK — Guardrails: https://openai.github.io/openai-agents-js/guides/guardrails/
3. AWS Bedrock AgentCore — Observability: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability.html
4. AWS Bedrock AgentCore — Sessions, traces e spans: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-telemetry.html
5. Microsoft Foundry — Agent Monitoring Dashboard: https://learn.microsoft.com/en-us/azure/foundry/observability/how-to/how-to-monitor-agents-dashboard
6. Microsoft Foundry — Agent tracing: https://learn.microsoft.com/en-us/azure/foundry/observability/how-to/trace-agent-setup
7. LangSmith — Observability: https://docs.langchain.com/langsmith/observability
8. LangSmith — Evaluation: https://docs.langchain.com/langsmith/evaluation
9. Google SRE — Monitoring Distributed Systems: https://sre.google/sre-book/monitoring-distributed-systems/
10. NIST AI RMF — Generative AI Profile: https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence
