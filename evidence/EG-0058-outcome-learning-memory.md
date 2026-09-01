# EG-0058 — Outcome Learning Memory

Status: APROVADO COM RESTRICOES
Data: 2026-09-01

## Evidencias independentes
1. OpenAI — eval-driven development: avaliar continuamente, usar datasets representativos e evitar confiar em percepcao subjetiva isolada.
2. Microsoft Foundry — avaliacao de agentes inclui qualidade de trajetoria, selecao de ferramenta e resultados observados.
3. Google Cloud — avaliacao e governanca de agentes devem separar qualidade, seguranca, monitoramento e deploy.
4. Pratica estatistica conservadora — proporcoes com amostra pequena nao devem ser tratadas como taxa verdadeira; limite inferior de Wilson reduz falso vencedor.

## Decisao
A ZEVANORY aprende apenas de telemetria persistida e eventos financeiros reconciliados. O aprendizado e armazenado em agent_memory, sem nova tabela e sem migration 011.

## Guardrails
- Janela maxima: 90 dias.
- Minimo global: 30 resultados pagos observados.
- Minimo por arm: 20 resultados pagos e pelo menos 3 pagamentos.
- Ranking usa limite inferior de Wilson da taxa pago/sessao e refund como desempate negativo.
- Exploracao permanece 0 ate haver pelo menos 2 arms elegiveis e 60 resultados; depois fica limitada a 10%.
- Memoria expira em 168 horas e deve ser recalculada.
- Resultado de provider aceito nao e resultado comercial; pagamento/refund contam apenas apos reconciliacao financeira.
- Falha do learning job nunca invalida um webhook financeiro ja reconciliado.
- Learning review e escrita interna reversivel; nao abre venda, checkout, financeiro nem canal.

## Criterio de verdade
`learning_ready=true` significa apenas que o historico atingiu os limiares internos para orientar priorizacao. Nao significa causalidade, superioridade comercial garantida ou prova estatistica definitiva.
