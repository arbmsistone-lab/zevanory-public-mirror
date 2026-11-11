# Correções da rodada 1 — PR #1019

Data: 11/11/2026. Partida: `6bfd10c3de01f21874c8d22996ffffaae7b0c125`. Implementação para auditoria independente; este registro não dá PASS independente.

NCs atendidas: NC-F1-A1-02.

| Leitura | Decisão |
|---|---|
| Histórico por canal | null é vazio; erro, JSON inválido, tipo diferente de array ou item sem texto/dia: history_unreadable, sem publicar e sem sobrescrever histórico. |
| Recibo diário por canal | Estrutura/status obrigatórios; erro bloqueia antes de reservar/publicar. |
| Marcador Telegram legado | Leitura estrita; canal permanece desligado por constante. |
| Status diário Bluesky | Erro/estrutura inválida não permite sobrescrever; status válido nunca é regravado no dia. |
| Pausa criativa | Somente null/0/1 são aceitos; desconhecido interrompe sem escrever. |
| Calendário e estado diário | Erro não permite substituir a chave por um estado vazio. Não constituem autorização para publicação. |
| Marcador e fonte do digest | Erro não permite reservar nem enviar e-mail. |
| sales:open:v1 / sales:hotmart:v1 | Leitores canônicos já fecham em falha; preservados, sem alterar caminhos reservados. |
| Snapshot (safeJson restante) | Somente observação; não alimenta publicação, gate ou idempotência. Não foi convertido neste PR. |

A gravação leitura→escrita do KV não é uma operação atômica; não se promete exclusão concorrente.

## Validação local

- Suíte completa: 1379/1379, sem falha/pulo/cancelamento/todo; manifesto validado.
- Novos casos: 11 testes novos (3 mutantes).
- `node tests/governanca/price-gate.mjs`: PASS.
- `python3 scripts/ci/runtime_ddl_gate.py`: PASS.
- `node --test tests/guards/*.mjs`: 3/3.
- Execução integral com TAP e reporter `scripts/ci/node-suite-reporter.mjs`; verificação por `scripts/ci/node_suite_check.py`.

Os mutantes novos rodam na própria suíte Node, em cópias temporárias únicas. Só são mortos por falha de asserção do cenário, após controle positivo.

## Limites de execução

Sem merge, rótulo, dispatch, reativação ou deploy. Caminhos reservados, preços e T6/P03 não foram alterados por esta rodada. O CI remoto é consultado após atualizar esta branch e informado na resposta; não se declara CI verde antes de concluir.
