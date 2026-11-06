# ZEVANORY | DEC-14 | Reconciliação de escopo e pré-requisitos da fase 2 do Conteúdo Pronto

**Data:** 04/11/2026. **Estado:** DRAFT / NO-GO para merge ou deploy. Não há autorização de abertura de vendas, alteração da Hotmart ou lançamento de Conteúdo Pronto.

## Decisões delegadas e escopo

DEC-14(a) e (b): CONSENSO TÉCNICO COM CONDIÇÕES. O proprietário exige aposentadoria individual de 41 testes (21 de campanha e 20 G1–G5), aposentadoria individual de 46 mutantes, eliminação real das 37 escritas KV legadas de `worker/content-service.mjs` e CI `fail 0` no SHA final. Os arquivos não podem ser apagados para fazer testes artificiais passarem.

O commit do Claude que retirou os links públicos para `/conteudo-pronto` está presente: `135700fd11086939b59d27d273b5b0b18d833baa`, seguido do reparo Windows `da9f55c99c7b122a0ad7317e4861e3071ba1adad`. A dependência de ordem foi cumprida.

## Resultado do censo independente (pré-correção)

- 41 testes legados com falhas observadas na CI e registrados **um por um** em `docs/ops/dec14-cp-41-legacy-test-inventory.json` (pré-correção: `RETIREMENT_CANDIDATE`; executado depois, ver "Execução DEC-14").
- 178 mutantes identificados **um por um** em `docs/ops/dec14-cp-mutants-178-anchor-inventory.json`: **51** têm trecho de origem não encontrado, **127** têm trecho encontrado. Isso é diferente do alvo informado de **46** mutantes aposentáveis. Ausência do trecho não significa automaticamente que um mutante deva ser aposentado, pois mudanças em HTML público, página lápide e conteúdo-fonte também podem explicar o resultado.
- A análise das asserções primárias dos mutantes encontrou **75** IDs cuja prova principal depende exclusivamente de testes de campanha candidatos à aposentadoria. Uma aposentadoria de 46 mutantes sem recompor asserções primárias dos demais pode produzir `INCONCLUSIVE` ou falsa cobertura. Exige mapa de causalidade individual novo, nunca redução oportunista de escopo.
- A fonte canônica dos **37** pontos de escrita KV ainda é `docs/ops/cp-kv-allowlist-NC009.json` (`remaining_baseline=37`, 37 itens com número de linha e texto exato). O gate `production-cutover-invariant` reportou `actual=37 expected=0`. Nenhuma escrita foi removida nesta etapa, justamente para não quebrar fluxos e cobertura ainda não reconciliados.

O script `scripts/ci/dec14-inventory.py` verifica, sobre o repositório real, a presença exata de trechos de cada mutante. Não altera testes e não declara mutantes mortos sem evidência.

## Condições para DEC-14(a) e (b)

1. Separar as 41 falhas de fluxos extintos dos validadores e controles ainda em vigor, mantendo em produção testes de autenticação Hotmart, idempotência, isolamento dos compradores históricos e bloqueio de checkout CP.
2. Classificar os 178 mutantes com resultado reprodutível e identificar precisamente quais 46 devem ser aposentados, quais outros tiveram seus trechos alterados por F-a/publicação, e quais necessitam de novo alvo ou nova asserção causal válida. Nenhum item pode desaparecer da lista sem linha datada com justificativa.
3. Remover as 37 escritas KV efetivamente, não renomear chamadas para enganar o scanner. Onde o comportamento não tiver implementação DO equivalente, deixar caminho explicitamente indisponível e registrar lacuna da fase 2. Nenhum fallback silencioso a KV.
4. Refazer o manifesto Node e os gates de contagem com testes realmente executados, sem tolerar falhas, skips indesejados ou falsos verdes. A mutação deve continuar comprovando morte causal, não apenas ausência de erro.
5. Exigir todos os checks verdes no MESMO SHA final, antes de qualquer parecer de aprovação. Bloqueios de vendas seguem fechados em todas as camadas.

## DEC-14(c) | Gates obrigatórios da fase 2 CP

**P2-BOUNCE:** evento de entrega não entregue/rejeitada, reconciliação de status e idempotência por assinatura, mês e mensagem; registrar evidência no DO e alerta do operador, nunca presumir `delivered` por HTTP 2xx. Testar repetição, concorrência, cancelamento e erro do provedor.

**P2-REFUND:** reconhecer pedido, cobrança elegível, estorno parcial e integral, chargeback, confirmação e reversão; conciliar o mês certo sem duplicar crédito, sem reativar assinatura cancelada e sem movimentar dinheiro pelo sistema. Garantir estado durável, trilha de auditoria e proteção de históricos.

**P2-OPERADOR:** reenvio manual de pacote/boas-vindas/bounce somente com operador autenticado, justificativa, destinatário válido, nova chave quando apropriada e idempotência. Exigir autorização, registrar tentativas e limites, sem expor dados pessoais em logs.

**Portão final P2:** os grupos acima (e P2-LEGACY-PKG abaixo) com contratos e testes reais sobre DO/SQLite, simulação adversarial e auditoria independente. Até lá CP permanece inerte, oculto e com vendas fechadas.

**P2-LEGACY-PKG (novo, DEC-14(b)):** compradores anteriores com pacote gravado em KV (`zpc:cp:pkg:*`) não têm hoje acesso ao pacote pelo link privado (`/conteudo-pronto/pacote` responde 503 desde o NC-011) nem regeneração de pacote contaminado. Antes de qualquer reabertura: leitura somente do pacote histórico a partir de cópia importada para o DO (hash e contagem conferidos, sem dual-write), bloqueio de pacote contaminado na exibição (`packageBlocked`, já coberto por `(f)`/`(g6)`), regeneração com candidato/outbox no DO e entrega confirmada pelo provedor. Até lá, atendimento manual por suporte@zevanory.api.br com os dados preservados em KV e no backup diário.

## Execução DEC-14 (Claude, 04/11/2026, sobre `aafe510`)

- **(a) testes:** 49 aposentados, um a um, em `docs/ops/dec14-cp-retirement-registry.json` (os 41 do inventário, com ids preservados, mais `CP-CAMP-22` `[camp-regen-mes]` e `CP-ROT-F2/G1/G2/G3/G4/G5/G7`, que só exercitavam a regeneração em KV removida em (b)). `(f)` e `(g6)` foram reescritos sem KV com o mesmo rótulo (o bloqueio de pacote contaminado continua testado). Novos sem KV: `[dec14-datas]`, `[dec14-fuso]`, `[dec14-reembolso-texto]`; `(a)` e `(d)` ganharam rótulos causais. Contagens: contrato 51 → 25, G1–G5 21 → 1, manifesto Node ajustado só nessas três linhas.
- **(a) mutantes:** 178 = 59 ativos (59/59 KILLED localmente, classificador e limiares inalterados) + 119 aposentados com trecho ausente conferido por `scripts/ci/dec14-inventory.py`. Dos 119: 51 já ausentes em `aafe510` (37 apagados pelo NC-012 em `worker/content-service.mjs` + 14 em páginas públicas do CP ocultadas por NC-015/NC-016/DEC-04/DEC-06; a meta declarada de 46 não é reproduzível por id); 61 nas funções KV removidas em (b); 7 em código puro que ficou sem nenhum consumidor. Dos 75 que dependiam só de testes de campanha, 5 miram código vivo e foram reapontados (M106, M141, M174, M176, M177); 70 miram código removido. Também foram reapontados M06 (a página só é conferida com o CP à venda), M18 e M29.
- **(b) KV:** as 37 expressões de escrita foram removidas com o pipeline KV inteiro (`worker/content-service.mjs` 1027 → 342 linhas, só funções puras). Prova por escrita em `docs/ops/dec14-cp-37-kv-writer-inventory.json`: nenhuma era alcançável por ponto de entrada (pacote e operador já 503; webhook CP no DO). `docs/ops/cp-kv-allowlist-NC009.json` zerado; o invariante conta as mesmas expressões e passa com `actual=0`, sem ser silenciado. Nenhum dado KV apagado.
- **Fase 1 preservada:** CP oculto (lápide 404/noindex, `CP_SALES_ENABLED` falso), Hotmart apenas, checkout próprio MP travado, download imediato DEC-06, sem links públicos para `/conteudo-pronto`.

## Fronteira de execução

Nenhum merge, deploy, operação na Hotmart ou leitura/escrita de produção. A aposentadoria acima não abre vendas nem homologa a fase 2: CP continua inerte, oculto e com vendas fechadas até os portões P2-BOUNCE, P2-REFUND, P2-OPERADOR e P2-LEGACY-PKG.
