# Correções da rodada 1 — PR #1023

Data: 11/11/2026. Partida: `2746e308c4ee5bfd0674bc789d32debbe1dcb092`. Implementação para auditoria independente; este registro não dá PASS independente.

NCs atendidas: NC-F1-A6-03 (identidade válida, SYSTEM_USER e sem expiração).

Identidade COMPROVADA exige app_id esperado, is_valid === true, type === SYSTEM_USER e expires_at === 0 (número). Valor ausente, string zero, token pessoal, inválido ou com expiração não fica pronto para prova; resposta debug_token bem-sucedida mas identidade inválida reprova token_identity. Falha do endpoint continua deixando identidade NAO_COMPROVADA e pronto_para_prova false.

Não se lê campo never_expires da API e ele foi retirado da saída; o dado usado é expires_at. data_access_expires_at é registrado, sem aprovar por ele. /me/accounts com data não array falha somente page_token, preserva as demais verificações e não tenta mascarar a resposta inválida com fallback. Redação sem esquema de URL foi mantida e ganhou teste/mutante.

Referências primárias conferidas em 11/11/2026:
- https://github.com/meta/agentic-tools/blob/main/plugins/devtools/skills/debug-access-token/SKILL.md (blob 5c13e9e308eed0d4079a27ad0b1722087b3d18e3): documenta os campos is_valid, type, app_id, expires_at e data_access_expires_at e expires_at zero como sem expiração.
- https://developers.facebook.com/docs/graph-api/reference/debug_token/ : referência oficial vinculada pela Meta; a consulta direta retornou HTTP 429 nesta sessão. Não se afirma leitura da página indisponível.

SYSTEM_USER é uma exigência explícita do proprietário; somente o valor literal informado pela API é aceito. Não se infere o tipo pelo nome retornado em /me. Testes usam apenas credenciais fictícias e fetch mockado; nenhuma chamada Graph real foi executada.

## Validação local

- Suíte completa: 1409/1409, sem falha/pulo/cancelamento/todo; manifesto validado.
- Novos casos: 10 testes novos (4 mutantes).
- `node tests/governanca/price-gate.mjs`: PASS.
- `python3 scripts/ci/runtime_ddl_gate.py`: PASS.
- `node --test tests/guards/*.mjs`: 3/3.
- Execução integral com TAP e reporter `scripts/ci/node-suite-reporter.mjs`; verificação por `scripts/ci/node_suite_check.py`.

Os mutantes novos rodam na própria suíte Node, em cópias temporárias únicas. Só são mortos por falha de asserção do cenário, após controle positivo.

## Limites de execução

Sem merge, rótulo, dispatch, reativação ou deploy. Caminhos reservados, preços e T6/P03 não foram alterados por esta rodada. O CI remoto é consultado após atualizar esta branch e informado na resposta; não se declara CI verde antes de concluir.
