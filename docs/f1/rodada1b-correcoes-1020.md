# Correções rodada 1b — PR #1020

11/11/2026. Head de partida: `46c384a7ccea02a42d12a7640a853c814108bb13`.
NCs implementadas para nova auditoria independente: NC-CL-1020-01.

O contêiner do índice precisa ser objeto com articles array. Apenas entradas com slug/title/body string entram na similaridade. As demais são preservadas inclusive além do limite de 45 entradas válidas, e indice_entradas_ignoradas é informado no status.

Esclarecimento solicitado ao proprietário nesta sessão: ele escolheu **Aceitar legado reconhecível**. Assim, objeto com slug e título string, sem propriedade body, é legado tolerado, não corrupção para o limiar de maioria. Ainda é contado como ignorado na similaridade. Tipo de body inválido ou falta de identidade continua sendo corrupção. Isso resolve a contradição do documento entre aceitar um único artigo sem body e bloquear quando a maioria está inválida.

Índice corrompido ou com maioria corrompida é reconstruído das chaves de status dos 105 dias locais (hoje e 104 anteriores) e respectivos artigos de sucesso. Todas as fontes presentes precisam ser legíveis e válidas; artigos referenciados ausentes impedem recuperação. Nenhuma escrita ocorre se uma fonte falhar. Em maioria corrompida já existente, reconstrução sem qualquer artigo válido não é aceita. Entradas legadas/corrompidas de um contêiner legível são preservadas durante a recuperação. Com fontes completas, registra o índice reconstruído e segue pelo gate normal.

A lista curada de fontes e sua limitação semântica da rodada anterior permanecem. Não houve inspeção do índice real ou migração de produção.

## Provas locais

- Suíte completa: 1372/1372, sem falha/pulo/cancelamento/todo, com manifesto validado.
- 7 testes novos em tests/f1b-*.test.mjs, incluindo 3 mutantes exigidos mortos por asserção, após controle positivo.
- Price-gate PASS; runtime DDL PASS; portabilidade 3/3.
- Comando: node --test --test-reporter=tap --test-reporter-destination=all.tap --test-reporter=./scripts/ci/node-suite-reporter.mjs --test-reporter-destination=per-file.json tests/*.test.mjs.
- Manifesto: python3 scripts/ci/node_suite_check.py --manifest tests/node-suite.manifest --tap all.tap --per-file per-file.json.

Sem merge, rótulo, dispatch, reativação ou deploy. Sem mudança em caminhos reservados, T6/P03 e preços. #1023 e #1014 não foram alterados. CI remoto consultado após o push; não se declara aprovação independente neste registro.

Mutantes completos do blog: 37/37 (âncoras do índice atualizadas sem reduzir os cenários).
