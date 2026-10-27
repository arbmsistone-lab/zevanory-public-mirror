# P18 — orçamentos de latência por rota (estado de desempenho)

ORDEM 295, aval do Sol. Código: `scripts/b0/p18-latency.mjs`. Testes: `tests/p18-latency.test.mjs`.
Mutantes: `scripts/ci/mutants_p18_latency.py`.

## Estados (separados da disponibilidade)

| Estado | Regra |
|---|---|
| SAUDAVEL | nenhuma rota acima do orçamento em 2 janelas seguidas |
| DEGRADADO | uma rota acima do **seu** orçamento em 2 janelas de 5 min **consecutivas** |
| CRITICO | a falha de disponibilidade existente (`up=false`), inalterada; tem precedência na leitura |
| RECUPERADO | 2 janelas consecutivas dentro do orçamento depois de DEGRADADO |

- Janela = janela de 5 min do instante da sondagem agendada (mesma régua do `window_id`). A re-sondagem de
  confirmação não conta como janela.
- Janela pulada, rota sem latência medida ou rota fora do ar quebram a sequência: falta de dado não prova
  lentidão nem saúde.
- Latência da rota = `elapsed_ms` (todas as tentativas, mais a pausa de 3 s quando houve nova tentativa); em linhas
  antigas, `latency_ms`.
- `up`/`down`, o incidente de queda e o alerta de queda continuam iguais.

## Método

1. Amostra: `p18/probes-AAAA-MM.jsonl` do ramo `evidence/b0-baseline`, só sondagens agendadas, só rota com
   `ok=true` e HTTP 200, só latência medida.
2. Percentil pelo posto mais próximo (o mesmo de `percentile` em `b0-lib.mjs`): p50, p95, p99.
3. Orçamento = `min(5000, max(2000, arredondar_para_cima_500(2 × p95)))` ms. O teto é o padrão provisório do Sol
   (5 s). O piso de 2 s evita disparos em rotas muito rápidas, cujo máximo observado já chega a 2,9 s.
4. Com menos de 200 amostras, a rota fica no padrão de 5 s.
5. Para reproduzir: `node scripts/b0/p18-latency.mjs --derive probes-2026-10.jsonl` imprime a tabela, confere se
   ela bate com `ROUTE_BUDGETS_MS` e faz o replay do histórico com os orçamentos propostos e com 5 s fixo.

## Tabela proposta

Fonte: `evidence/b0-baseline@08b9f51ce49e`, `p18/probes-2026-10.jsonl`: 277 linhas, das quais 276 agendadas,
de 2026-10-26T19:00Z a 2026-10-27T18:00Z.

| Rota | n | p50 | p95 | p99 | máx | Orçamento | Base |
|---|---|---|---|---|---|---|---|
| vendas/ | 276 | 563 | 875 | 1112 | 2980 | 2000 | piso |
| vendas/solucoes | 276 | 494 | 758 | 974 | 2922 | 2000 | piso |
| vendas/ia-na-pratica | 276 | 1261 | 1915 | 3797 | 12833 | 4000 | 2×p95 |
| vendas/vendas-na-pratica | 276 | 1228 | 1925 | 3130 | 4607 | 4000 | 2×p95 |
| vendas/lucro-e-caixa | 276 | 1259 | 1893 | 2108 | 4638 | 4000 | 2×p95 |
| vendas/combo-ia-vendas | 275 | 1258 | 1962 | 3777 | 8403 | 4000 | 2×p95 |
| vendas/negocio-completo | 276 | 1237 | 1933 | 4094 | 9143 | 4000 | 2×p95 |
| zevanory.api.br/api/status | 276 | 1488 | 2291 | 8053 | 15418 | 5000 | teto |

Replay do histórico: com os orçamentos propostos, houve 1 incidente. negocio-completo entrou em DEGRADADO em
27/10 17:10:51Z (9,1 s e depois 4,1 s) e voltou em RECUPERADO às 17:20:34Z. Não houve outro disparo em 23 h.
Com 5 s fixo, o replay **não** dispara: o /api/status passou de 5 s em uma única janela (3,1 s e depois 15,4 s), e
o negocio-completo também (9,1 s e depois 4,1 s).

## Limites (riscos residuais)

- A amostra cobre só 23 h. Os orçamentos são PROVISÓRIOS e devem ser recalculados com 14 dias de B0.
- No episódio de 27/10, o /api/status não é detectado com orçamento de 5 s. Para detectá-lo, o orçamento teria de
  ser < 3075 ms, o que fica perto do p99 de 23 h. Não ajustamos o orçamento só para pegar esse caso.
- O runner hospedado do GitHub não expõe a região por variável. `runner.region` fica `null`, com o motivo, e não
  há chamada extra de rede para descobri-la.
- Mudar a tabela muda o `incident_id` de desempenho que o replay recalcula. Um incidente aberto durante essa
  mudança pode gerar um novo aviso.
