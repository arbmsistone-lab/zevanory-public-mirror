# Correções da rodada 1 — PR #1020

Data: 11/11/2026. Partida: `4519e5bc9c7a36615aadf39c7eaeeaa9b8f8d009`. Implementação para auditoria independente; este registro não dá PASS independente.

NCs atendidas: NC-F1-A3-01 e NC-F1-A3-02.

As correções parciais existentes foram mantidas. Status, marcador legado, contador semanal e índice usam leitura estrita antes das escritas. Índice precisa conter artigos com slug, título e corpo (o corpo alimenta a duplicidade). O artigo referenciado por status/legado precisa estar presente e legível; não se fabrica recibo de sucesso nem se republica quando sua leitura falha. Pausa ilegível ou valor desconhecido bloqueia sem escrita.

Fontes: lista curada versionada em data/fontes-permitidas.json; URL HTTPS sem credencial/porta, IP literal, host local ou domínio reservado. Porta explícita :443 é rejeitada mesmo que URL.port a normalize para vazio. Números por extenso e quantificadores são cobertos pelos testes e mutantes já acrescentados no head de partida.

Limitação: whitelist de domínio e sintaxe NÃO comprovam existência, atualidade ou pertinência da página ao dado. A expressão regular é parcial. Não houve fetch de fontes em produção; a revisão por amostragem continua necessária. O gerador atual não acrescenta estatísticas externas. Não se afirma validação semântica universal.

## Validação local

- Suíte completa: 1365/1365, sem falha/pulo/cancelamento/todo; manifesto validado.
- Novos casos: 5 testes novos (2 mutantes), além de 37 mutantes do gate.
- `node tests/governanca/price-gate.mjs`: PASS.
- `python3 scripts/ci/runtime_ddl_gate.py`: PASS.
- `node --test tests/guards/*.mjs`: 3/3.
- Execução integral com TAP e reporter `scripts/ci/node-suite-reporter.mjs`; verificação por `scripts/ci/node_suite_check.py`.

Os mutantes novos rodam na própria suíte Node, em cópias temporárias únicas. Só são mortos por falha de asserção do cenário, após controle positivo.

## Limites de execução

Sem merge, rótulo, dispatch, reativação ou deploy. Caminhos reservados, preços e T6/P03 não foram alterados por esta rodada. O CI remoto é consultado após atualizar esta branch e informado na resposta; não se declara CI verde antes de concluir.
