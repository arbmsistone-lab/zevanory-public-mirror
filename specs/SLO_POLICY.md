# ZEVANORY - SERVICE LEVEL POLICY

Status: OBJETIVO OPERACIONAL, NAO HISTORICO COMPROVADO.
Release base: ZEVANORY-EG0037-FINAL.

## Objetivos
- Disponibilidade alvo: 99,9%.
- Error ratio 5xx alvo: <= 0,1%.
- Latencia p95 alvo: <= 1500 ms.
- Latencia p99 alvo: <= 3000 ms.
- Evento mais antigo da outbox pendente/retry: <= 300 s.
- Dead-letter da outbox: 0 como estado saudavel.
- Falhas de agent runs: <= 1% em janela medida.

## Regra de verdade
Os valores acima sao objetivos, nao resultados historicos.
Nenhum SLO pode ser declarado atingido sem janela de medicao e amostra suficientes.
Probe isolado comprova apenas o instante medido.

## Indicadores
SLI de disponibilidade: respostas 2xx/3xx sobre requisicoes medidas.
SLI de erro: respostas 5xx sobre requisicoes medidas.
SLI de latencia: p95 e p99 das amostras observadas.
SLI de outbox: backlog, idade do evento mais antigo, retry e dead-letter.
SLI de IA: runs, falhas, bloqueios e fallback deterministico.
