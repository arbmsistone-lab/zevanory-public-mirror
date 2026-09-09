# EG-0070 — MARKET + PRODUCT + INVESTMENT INTELLIGENCE

Status: APROVADO PARA IMPLEMENTACAO TECNICA / VENDAS CONTINUAM BLOQUEADAS.
Data: 2026-09-09.
Escopo: pesquisa de mercado auditavel, ranking de produtos, decisao de investimento e telemetria operacional.

## Evidencias independentes

1. **MDN / Mozilla — Server-Sent Events (A, documentacao tecnica primaria).**
   `EventSource` recebe eventos `text/event-stream` por conexao HTTP persistente e e adequado a atualizacoes unidirecionais servidor -> navegador.
   Fonte: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events

2. **Google Ads — Experimentos (A, documentacao oficial).**
   Experimentos A/B exigem hipotese, comparacao controle/tratamento e metrica primaria; criativos devem ser avaliados com variaveis controladas e resultados podem permanecer inconclusivos.
   Fonte: https://support.google.com/google-ads/answer/13719071

3. **Shopify — Product Research 2026 (B, guia metodologico de mercado).**
   Pesquisa de produto deve avaliar demanda, tendencias, concorrencia, publico, precificacao e validacao antes do investimento.
   Fonte: https://www.shopify.com/blog/product-research
4. **Statsig — Experiments Overview (B, metodologia de experimentacao).**
   Significancia estatistica deve separar efeito observado de variacao aleatoria; intervalos de confianca e tamanho de amostra sustentam decisoes, nao intuicao isolada.
   Fonte: https://docs.statsig.com/experiments/overview

## Conclusao do Evidence Gate

APROVADO. As quatro fontes sao independentes e incluem documentacao tecnica primaria.
A arquitetura deve separar: coleta/evidencia -> normalizacao -> score -> decisao -> experimento -> resultado observado.
Nenhum score pode fabricar demanda, margem, tendencia, conversao ou retorno ausente.
Sem no minimo 3 fontes verificadas e 3 organizacoes distintas, a decisao obrigatoria e `EVIDENCIA_INSUFICIENTE`.
Dados comerciais observados prevalecem sobre sinais proxy; previsao sem baseline permanece bloqueada.
Criativo pode ser gerado e avaliado offline, mas alegacao de performance exige resultado observado.
Atualizacao em tempo real pode usar SSE com fallback para polling seguro.

## Decisoes implementaveis

- `INVESTIR`: somente com evidencia suficiente, score alto e economia observada/validada quando exigida.
- `TESTAR`: oportunidade promissora, mas ainda exige experimento controlado antes de escala.
- `AGUARDAR`: evidencia insuficiente ou sinais conflitantes.
- `DESCARTAR`: evidencia suficiente e score/riscos abaixo do limiar predefinido.
- Venda, checkout, midia paga e autonomia comercial permanecem sob `salesGate` canonico e fail-closed.
