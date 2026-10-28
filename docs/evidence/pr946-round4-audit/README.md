# Evidência: reauditoria rodada 4 do PR #946

Ferramentas do auditor (`scratchpad/audit-v12/pr946-r4/tools/`) rodadas contra o head que corrige a rodada 4 (commit `9a46908c`; o head final só acrescenta o teste G6.6 e esta pasta).

- `ma-attacks-r5.sh` / `ma-attacks-r5.txt`: o `ma-attacks.sh` do auditor com dois ajustes.
  - `H` passa a vir do ambiente.
  - O estado estável T0 também restaura `/privacidade` e `/afiliados` da base, porque agora fazem parte da impressão digital.
  - Resultados:
    - A1 (isca em comentário), depois do merge: `LEGAL_PUBLISH_GATE=BLOCKED`.
    - A1b (texto depois de `</main>`): a impressão digital muda (`85c3724e…`, diferente da gênese `aa8e8d73…`; o rótulo "gênese 4f8d…" do script é o valor antigo).
    - A2 `coe`, `ift`, `ortrue` e `newwf`: `TRUST_ANCHORS=CHANGED`.
- `mutation-r5.txt`: o `mutate.py` do auditor, sem alteração.
  - 22 de 23 mutantes **KILLED**: MA7, MA8, MA8b e L1b/L1c/L1d, que sobreviviam na rodada 4, agora morrem.
  - MA10 dá `ANCHOR_MISSING`, porque a função antiga `gate_removed` foi substituída pela validação estrutural.
- `mutate-r5-extra.py` / `mutation-r5-extra.txt`: mutantes que substituem o MA10, cobrindo a validação estrutural (X1–X10), a impressão digital (Y1–Y5) e a lista de espera (Z1). Todos **KILLED**. O X1 sobreviveu na 1ª execução e morreu depois que o teste G6.6 foi acrescentado.
