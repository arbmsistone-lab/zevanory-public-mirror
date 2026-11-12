# Correções rodada 1b — PR #1022

11/11/2026. Head de partida: `deaa62f6065444b27c421819a2b60a1a427d543f`.
NCs implementadas para nova auditoria independente: NC-CL-1022-01 e NC-CL-1022-02.

Registro de congelamento ilegível recebe id ilegivel:<primeiros 16 hex de SHA-256 do conteúdo bruto>. A leitura preserva essa identidade sem imprimir o conteúdo bruto. Liberar A libera somente o mesmo conteúdo A; conteúdo diferente B permanece congelado. O literal antigo ilegivel não é uma liberação genérica.

Recibo diário presente com JSON/estrutura inválida conta como publicado desconhecido (true) e emite warning por slot, sem incluir o valor bruto. O slot não volta a publicar; erro de transporte do KV continua propagado e impede publicação. Ausência real continua false. Não foram alteradas rampas, provas Meta, workflows, credenciais ou configuração de liberação.

Dois mutantes novos revertem, respectivamente, o hash ao literal fixo e o bloqueio de recibo ilegível a false. Os mutantes antigos F03/F05/Y05 foram adaptados às novas âncoras sem retirar cenários adversos.

## Provas locais

- Suíte completa: 1423/1423, sem falha/pulo/cancelamento/todo, com manifesto validado.
- 4 testes novos em tests/f1b-*.test.mjs, incluindo 2 mutantes exigidos mortos por asserção, após controle positivo.
- Price-gate PASS; runtime DDL PASS; portabilidade 3/3.
- Comando: node --test --test-reporter=tap --test-reporter-destination=all.tap --test-reporter=./scripts/ci/node-suite-reporter.mjs --test-reporter-destination=per-file.json tests/*.test.mjs.
- Manifesto: python3 scripts/ci/node_suite_check.py --manifest tests/node-suite.manifest --tap all.tap --per-file per-file.json.

Sem merge, rótulo, dispatch, reativação ou deploy. Sem mudança em caminhos reservados, T6/P03 e preços. #1023 e #1014 não foram alterados. CI remoto consultado após o push; não se declara aprovação independente neste registro.
