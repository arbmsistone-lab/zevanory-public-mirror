# Correções da rodada 1 — PR #1021

Data: 11/11/2026. Partida: `679625990cc596489951c1eaa4b386c5cc63586e`. Implementação para auditoria independente; este registro não dá PASS independente.

NCs atendidas: NC-F1-A4-01 e NC-F1-A4-02; revisão de leituras KV.

Mantidas as correções parciais: origem não é herdada do trigger geral, apenas do recibo/outcome do canal; origem desconhecida não entra no numerador. O aviso dia UTC / intervalo diferente do dia America/Sao_Paulo é permanente, mesmo quando as datas coincidem.

Revisão de leituras: estado diário, recibos por canal, status do blog, agregado do funil, ledger e amostras. null significa ausente; JSON/tipo/estrutura inválida ou exceção significa não lido. Publicação não lida tem publicadas:null, status erro e não conta como autônoma; o diagnóstico é LEITURA_INCONCLUSIVA, sem afirmar canal parado ou saudável. Autonomia fica não medida quando há falha de leitura. Ledger com schema inválido é INCONCLUSIVO; funil inválido ou antigo não apresenta métricas como medidas. Amostras ilegíveis são mostradas explicitamente.

Os mutantes DD05/DD10/DD16 foram adaptados às novas âncoras sem retirar a falha adversa. O teste antigo de schema errado foi corrigido: erro estrutural não equivale a webhook não testado.

Compatibilidade: preservar, na futura atualização de branch, o leitor estrito de #1019 ao incorporar a gravação de trigger de #1021. Nenhum merge foi feito aqui.

## Validação local

- Suíte completa: 1372/1372, sem falha/pulo/cancelamento/todo; manifesto validado.
- Novos casos: 7 testes novos (3 mutantes), além de 45 mutantes do diagnóstico.
- `node tests/governanca/price-gate.mjs`: PASS.
- `python3 scripts/ci/runtime_ddl_gate.py`: PASS.
- `node --test tests/guards/*.mjs`: 3/3.
- Execução integral com TAP e reporter `scripts/ci/node-suite-reporter.mjs`; verificação por `scripts/ci/node_suite_check.py`.

Os mutantes novos rodam na própria suíte Node, em cópias temporárias únicas. Só são mortos por falha de asserção do cenário, após controle positivo.

## Limites de execução

Sem merge, rótulo, dispatch, reativação ou deploy. Caminhos reservados, preços e T6/P03 não foram alterados por esta rodada. O CI remoto é consultado após atualizar esta branch e informado na resposta; não se declara CI verde antes de concluir.
