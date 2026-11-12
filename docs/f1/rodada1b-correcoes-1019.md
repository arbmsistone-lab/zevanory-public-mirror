# Correções rodada 1b — PR #1019

11/11/2026. Head de partida: `789ef20b4500818c3fe5e7e9c7c2622c966d2200`.
NCs implementadas para nova auditoria independente: NC-CL-1019-01.

O histórico ilegível é reconstruído dos recibos diários dos 30 dias locais (hoje e 29 anteriores), em ordem cronológica. Ausência real é permitida; erro, JSON inválido, status inválido ou recibo publicado sem text string impede a recuperação. Somente após validar todas as fontes se grava o histórico; o mesmo gate de similaridade continua obrigatório. O teste usa recibo com texto igual ao candidato e comprova rejeição por similaridade.

A recuperação é registrada como history_rebuilt no primeiro status diário e como history_rebuilt:true no outcome. A regra anterior de uma escrita de status por dia permanece: se já houver status válido de falha, ele não é sobrescrito; a recuperação posterior do mesmo dia fica no outcome. A gravação de recuperação do histórico é uma; eventual publicação posterior pode atualizar normalmente o histórico.

Com qualquer recibo diário ilegível não se inventa histórico vazio; 30 leituras bem-sucedidas e ausentes permitem histórico vazio legítimo. Não houve leitura de dados de produção.

## Provas locais

- Suíte completa: 1384/1384, sem falha/pulo/cancelamento/todo, com manifesto validado.
- 5 testes novos em tests/f1b-*.test.mjs, incluindo 2 mutantes exigidos mortos por asserção, após controle positivo.
- Price-gate PASS; runtime DDL PASS; portabilidade 3/3.
- Comando: node --test --test-reporter=tap --test-reporter-destination=all.tap --test-reporter=./scripts/ci/node-suite-reporter.mjs --test-reporter-destination=per-file.json tests/*.test.mjs.
- Manifesto: python3 scripts/ci/node_suite_check.py --manifest tests/node-suite.manifest --tap all.tap --per-file per-file.json.

Sem merge, rótulo, dispatch, reativação ou deploy. Sem mudança em caminhos reservados, T6/P03 e preços. #1023 e #1014 não foram alterados. CI remoto consultado após o push; não se declara aprovação independente neste registro.
