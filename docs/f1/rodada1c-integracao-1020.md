# Rodada 1c — Passo 1, PR #1020

Base integrada: `3cd47670b2c86a71696984ea9a40df349f1da585` (gh-pages, #1019).
Head de partida: `e3afec4f0246ba282d3e58591b7d236e1acc0fcd`.

Integração por commit com os dois pais, sem rebase ou force-push. Conflitos resolvidos em tests/acquisition-engine.test.mjs e tests/node-suite.manifest. O teste do sábado exige Bluesky publicado, Telegram desligado e blog fora_da_agenda; o manifesto conserva os testes dos dois PRs.

worker/acquisition-engine.mjs foi combinado automaticamente. Comparado à base, a única alteração nesse módulo continua sendo o tratamento do blog e a emissão de atividade apenas na criação. Leitura estrita, reconstrução de histórico e Telegram desligado permanecem intactos. Nenhuma alteração nova em caminhos reservados; os workflows já presentes no #1020 não foram editados nesta integração.

## Validação da árvore integrada

- Suíte completa: 1401/1401; manifesto PASS, zero falha, cancelamento, pulo ou todo.
- Mutantes do blog: 37/37 mortos, runner com saída 0.
- Testes das NCs originais e da rodada 1b, incluindo seus mutantes, presentes na suíte completa: f1-blog-kv, f1b-blog-recovery, f1-bluesky-kv e f1b-bluesky-recovery.
- Price-gate PASS (676 arquivos); runtime DDL PASS; portabilidade 3/3.
- Scripts adv1019.mjs e adv1020.mjs executados sem modificação, extraídos do anexo de codex-correcoes-rodada1b. Bluesky recupera histórico corrompido e publica; legado sem text também recupera dos recibos. Blog preserva legado sem body e publica nos dois dias; body objeto, sem fontes de recuperação, continua bloqueado por maioria inválida. URLs locais, IP, domínio enganoso, credenciais e porta explícita reprovam. Subdomínio gov.br e domínio curado com ponto final seguem aceitos conforme a política existente; isso não comprova pertinência semântica da fonte.
- O documento da rodada 1 não contém scripts anexos adicionais; seus cenários são cobertos pelos testes mencionados acima. Os scripts adv1021/adv1022 pertencem a outros PRs e não foram executados nem incorporados neste passo.

Não há nova NC corrigida neste passo: trata-se da integração das correções já auditadas. NC-F1B-INT-01 continua pendente para o Passo 2 do #1021, somente depois do merge autorizado do #1020.

CI remoto deve ser conferido no novo SHA; os resultados acima são locais. Sem merge do PR, rótulo, dispatch ou deploy. #1021 não foi alterado.
