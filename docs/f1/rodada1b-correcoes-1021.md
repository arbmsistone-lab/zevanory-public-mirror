# Correções rodada 1b — PR #1021

11/11/2026. Head de partida: `d4d81ef3910d9f7b477755f155b17dfda18bea9a`.
NCs implementadas para nova auditoria independente: NC-CL-1021-01.

A origem é gravada no recibo por canal na publicação, e também na reserva da tentativa. Recibo publicado reencontrado conserva sua origem; legado sem origem permanece null. Outcome publicado nunca recebe a origem do tick que apenas o reencontrou. Uma leitura ilegível do estado anterior impede regravar esse estado, sem apagar sua evidência.

O teste reproduz publicação manual → falha ao ler estado → execução cron: recibo e estado continuam manuais e semComando permanece zero. Há provas cron/cron e legado/null, e os três mutantes pedidos.

Também foi coberta adoção de registro já existente no provedor: quando a API confirma que o post já existia (adopted:true), conserva-se a origem da tentativa anterior ou null, nunca cron por suposição. Um recibo por canal vem antes do outcome no leitor já corrigido da rodada 1.

O contrato readAcquisitionKv/stateShape/receiptShape é idêntico ao de #1019, para a futura integração. Preservar as duas mudanças na atualização de branch; esta rodada não fez merge.

## Provas locais

- Suíte completa: 1379/1379, sem falha/pulo/cancelamento/todo, com manifesto validado.
- 7 testes novos em tests/f1b-*.test.mjs, incluindo 3 mutantes exigidos mortos por asserção, após controle positivo.
- Price-gate PASS; runtime DDL PASS; portabilidade 3/3.
- Comando: node --test --test-reporter=tap --test-reporter-destination=all.tap --test-reporter=./scripts/ci/node-suite-reporter.mjs --test-reporter-destination=per-file.json tests/*.test.mjs.
- Manifesto: python3 scripts/ci/node_suite_check.py --manifest tests/node-suite.manifest --tap all.tap --per-file per-file.json.

Sem merge, rótulo, dispatch, reativação ou deploy. Sem mudança em caminhos reservados, T6/P03 e preços. #1023 e #1014 não foram alterados. CI remoto consultado após o push; não se declara aprovação independente neste registro.

Mutantes completos do diagnóstico: 45/45 (DD35 agora reverte a origem vinculada ao recibo).
