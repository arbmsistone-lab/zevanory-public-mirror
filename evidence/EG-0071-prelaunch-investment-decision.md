# EG-0071 — Pre-launch Investment Decision v2

Status: APROVADO COM RESTRIÇÕES
Data: 2026-09-09
Objetivo: tornar a inteligência de produto acionável antes das primeiras vendas sem fabricar margem, lucro ou market fit.

## Evidência 1 — Shopify Product Research 2026
Fonte: https://www.shopify.com/blog/product-research
Classe: B — referência de mercado com metodologia de pesquisa de produto.
Constatação: pesquisa de produto deve validar demanda, concorrência e ideia antes de investir em desenvolvimento/comercialização.
Limite: não prova a economia específica de nenhum produto ZEVANORY.

## Evidência 2 — Google Ads Experiments
Fonte: https://support.google.com/google-ads/answer/7281575
Classe: A — documentação técnica oficial.
Constatação: mudanças devem partir de hipótese clara, métricas de sucesso pré-definidas e teste controlado antes de promover um vencedor.
Limite: metodologia de experimentação; não substitui venda e margem observadas.
## Evidência 3 — U.S. Small Business Administration
Fonte: https://www.sba.gov/counseling/plan-your-business/
Classe: A/B — orientação pública oficial para viabilidade econômica.
Constatação: preço, custo variável e margem de contribuição são necessários para avaliar ponto de equilíbrio e viabilidade; estimativas não equivalem a resultado contábil observado.
Limite: fornece a disciplina econômica, não valores da ZEVANORY.

## Decisão arquitetural
- Mercado + aderência técnica podem recomendar `TESTAR` ou `AGUARDAR` antes de existir margem observada.
- `INVESTIR` exige dimensões completas, incluindo margem econômica explícita; nenhuma margem será sintetizada.
- Fit estratégico e de execução podem usar somente fatos canônicos do catálogo/artefato, identificados como heurística técnica, nunca como demanda real.
- O portfólio deve ser pesquisável em lote, com concorrência limitada, cache e persistência auditável.
- Venda, checkout, mídia paga e publicação continuam subordinados ao `salesGate` canônico.

Veredito: APROVADO COM RESTRIÇÕES. Implementação pode melhorar priorização pré-lançamento, mas não pode promover `INVESTIR` sem economia completa nem abrir qualquer gate comercial.
## Evidence Gate formal
- 3 fontes independentes registradas: Shopify, Google Ads e U.S. Small Business Administration.
- Pelo menos uma evidência primária/oficial: PASS.
- Conflitos e limites explicitados: PASS.
- Nenhum valor econômico específico da ZEVANORY foi inventado: PASS.

Resultado do gate: APROVADO COM RESTRIÇÕES.
