#!/usr/bin/env bash
# B07/F02-08 T2: classifica uma observação (obs.txt do t2_neon.sh) em PASS | FAIL | ERROR_INFRA.
# Princípio do F03: cenário não atingido conta como ERROR_INFRA, nunca PASS. Evidência de violação
# (escritor antigo confirmado sem ambiguidade, história autorizada errada, sucesso sem quórum) é FAIL.
# Uso: classify_t2.sh <obs.txt> <base_a|base_b|m8|m9>
set -u
OBS=${1:?obs}; SCEN=${2:?cenario}
v(){ sed -n "s/^$1=//p" "$OBS" | tail -1; }
# Confirmação SEM ambiguidade dada ao cliente. WARNING de commit local, timeout e erro NÃO são sucesso.
client_success(){ case "$1" in ACK_CLEAN) return 0;; esac; return 1; }
fail=(); infra=()
[ -n "$(v INFRA_FAIL)" ] && infra+=("INFRA_FAIL: $(v INFRA_FAIL)")
[ "$(v OBS_DONE)" = 1 ] || infra+=("observação incompleta")
[ "$(v OP1)" = ACK_CLEAN ] || infra+=("op1 não confirmada ($(v OP1))")
[ "$(v C2_FENCE)" = 2/W2 ] || infra+=("promoção não atingida ($(v C2_FENCE))")
[ "$(v FAILOVER_ELECTED)" = 1 ] || infra+=("compute2 não elegeu termo maior")
[ "$(v OP2_W2)" = ACK_CLEAN ] || infra+=("op2 W2@2 não confirmada ($(v OP2_W2))")
case "$SCEN" in base_b) OW=T2B;; *) OW=T2A;; esac
ow=$(v $OW)
case "$ow" in ''|NOT_REACHED|UNKNOWN) infra+=("$OW não atingido ($ow)");; esac
client_success "$ow" && fail+=("$OW: escritor antigo W1@1 recebeu confirmação sem ambiguidade ($ow)")
t2c=$(v T2C)
[ "$SCEN" = base_b ] && case "$t2c" in ''|NOT_REACHED|UNKNOWN) infra+=("T2C não atingido ($t2c)");; esac
indep=$(v ORACLE_INDEP); led=$(v ORACLE_LEDGER)
[ "$indep" = OK ] || infra+=("oráculo não independente ($indep)")
if [ "$indep" = OK ]; then
  [ -n "$led" ] || infra+=("oráculo sem leitura")
  case ",$led," in *,op2:W1@1,*) fail+=("op2:W1@1 na história autorizada");; esac
  case ",$led," in *,op3:*) fail+=("op3 (commit local cancelado) na história autorizada");; esac
  [ -n "$led" ] && [ "$led" != "op1:W1@1,op2:W2@2" ] && fail+=("ledger autorizado [$led] != [op1:W1@1,op2:W2@2]")
  if client_success "$t2c" && ! case ",$led," in *,op3:*) true;; *) false;; esac; then
    fail+=("T2C: cliente tratado como confirmado mas op3 ausente da história autorizada")
  fi
fi
if [ "$(v OBS_DONE)" = 1 ]; then
  [ "$(v SK_EQUAL)" = 1 ] || fail+=("safekeepers divergem: term=$(v SK_TERMS_FINAL) commit_lsn=$(v SK_COMMIT_FINAL)")
  t0=$(v TERM0); tf=$(v SK_TERM_FINAL)
  { [ -n "$t0" ] && [ -n "$tf" ] && [ "$tf" -gt "$t0" ]; } || fail+=("term não subiu na timeline autorizada (antes=$t0 depois=$tf)")
fi
m14=$(v M14_RESULT)
[ -n "$m14" ] && client_success "$m14" && fail+=("M14: sucesso reportado sem quórum de safekeepers ($m14)")
for r in "${fail[@]}"; do echo "REASON FAIL $r"; done
for r in "${infra[@]}"; do echo "REASON INFRA $r"; done
if [ ${#fail[@]} -gt 0 ]; then echo "VERDICT=FAIL"
elif [ ${#infra[@]} -gt 0 ]; then echo "VERDICT=ERROR_INFRA"
else echo "VERDICT=PASS"; fi
