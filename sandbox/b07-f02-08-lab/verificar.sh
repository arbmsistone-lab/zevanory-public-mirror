#!/usr/bin/env bash
# B07/F02-08 — confere os logs do laboratório contra a conclusão documentada ("F02-08 FAIL arquitetural").
# Uso: verificar.sh <log de f02_08_lab.sh> <log de mutantes.sh>
# Sai != 0 se QUALQUER comportamento observado divergir do documentado. Em especial: se o primário antigo
# RECUSAR a escrita do escritor antigo depois da partição, a afirmação "FAIL arquitetural" estaria errada
# e o job falha (CONCLUSAO_DIVERGE).
set -u
LAB_LOG=${1:?log do laboratório}; MUT_LOG=${2:?log dos mutantes}
falhas=0
exige(){ # $1 rótulo, $2 linha exata esperada (comparação literal da linha inteira)
  if grep -Fxq -- "$2" "$LAB_LOG"; then echo "OK   $1: $2"
  else echo "DIVERGE $1: esperado [$2]"; falhas=$((falhas+1)); fi
}
contem(){ # $1 rótulo, $2 trecho literal esperado em alguma linha
  if grep -Fq -- "$2" "$LAB_LOG"; then echo "OK   $1: $(grep -F -- "$2" "$LAB_LOG" | head -1)"
  else echo "DIVERGE $1: trecho ausente [$2]"; falhas=$((falhas+1)); fi
}

echo "--- Cenário 1: um nó (ponto único de linearização) — a cerca funciona"
exige C1_promocao_cas        "promocao W2 (CAS epoch=1): 2"
exige C1_promocao_perdedora  "promocao concorrente W3 (CAS epoch=1, perdedora): []"
exige C1_escritor_antigo     "escritor antigo W1 epoch=1 op2: ERROR:  FENCED: writer=W1 epoch=1 (atual owner=W2 epoch=2)"
exige C1_novo_escritor       "novo escritor W2 epoch=2 op2: INSERT 0 1"
exige C1_estado_final        "fence: 2/W2  ledger: op1:W1@1,op2:W2@2"

echo "--- Cenário 2: dois nós + partição — o MESMO trigger não cerca o primário antigo"
exige C2_replica_ro          "B em recuperação (RO): t  B ledger: 1"
exige C2_promocao_em_B       "B promovido; promocao W2 em B: 2"
exige C2_primario_antigo_rw  "A (primário antigo) RO/RW: in_recovery=f read_only=off fence_A=1/W1"
# Asserção central: o primário antigo ACEITA o escritor antigo. Se recusar, a conclusão documentada cai.
exige C2_A_aceita_antigo     "escritor antigo W1 epoch=1 op2 em A: INSERT 0 1"
exige C2_B_aceita_novo       "novo escritor W2 epoch=2 op2 em B: INSERT 0 1"
exige C2_ledger_A            "ledger A: op1:W1@1,op2:W1@1"
exige C2_ledger_B            "ledger B: op1:W1@1,op2:W2@2"
contem C2_divergencia        "RESULTADO C2: DIVERGENCIA (escrita dupla op2 em duas épocas)"

echo "--- Cenário 3: synchronous_standby_names não é cerca"
exige C3_espera_syncrep      "esperando SyncRep: 1  cancelando: t"
contem C3_commit_local       "The transaction has already committed locally, but might not have been replicated to the standby."
exige C3_visivel_em_A        "op3 visível em A após cancelamento: 1"

echo "--- Mutantes da cerca em ponto único (fence.sql)"
# Esperado: original PASS; M3a SOBREVIVE (equivalente: a coluna epoch é NOT NULL e já recusa NULL —
# por isso existe M3b, que tira o NOT NULL também e é morto); todos os demais KILLED.
esperado="original PASS
M1_sem_epoca KILLED
M2_comparacao_frouxa KILLED
M3a_null_no_trigger SURVIVED
M3b_null_trigger_e_coluna KILLED
M4_sem_dono KILLED
M5_trigger_nao_bloqueante KILLED
M6_promocao_sem_cas KILLED
M7_sem_update KILLED"
obtido="$(sed -n 's/^RESULT //p' "$MUT_LOG")"
printf '%-28s %-9s %s\n' MUTANTE OBTIDO ESPERADO
while read -r nome res; do
  o="$(printf '%s\n' "$obtido" | awk -v n="$nome" '$1==n{print $2}')"
  printf 'MUTANT %-28s %-9s esperado=%s\n' "$nome" "${o:-AUSENTE}" "$res"
done <<< "$esperado"
if [ "$obtido" != "$esperado" ]; then echo "DIVERGE tabela de mutantes"; falhas=$((falhas+1)); fi
grep -q "MUTANTE NÃO APLICADO" "$MUT_LOG" && { echo "DIVERGE mutante não aplicado"; falhas=$((falhas+1)); }

if [ "$falhas" -ne 0 ]; then
  echo "CONCLUSAO_DIVERGE: $falhas observação(ões) diferem do documentado — revisar a conclusão F02-08"
  exit 1
fi
echo "CONCLUSAO_CONFIRMADA: F02-08 FAIL arquitetural (cerca in-DB só vale com um ponto de linearização; com dois nós o primário antigo aceita o escritor antigo e os ledgers divergem; sync-rep não cerca)"
