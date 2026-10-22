#!/usr/bin/env bash
# B07/F02-08 T2: veredito do cenário + mutantes do classificador (M11, M14) e do oráculo (M10).
# Mutantes do classificador são aplicados NO PRÓPRIO classify_t2.sh e restaurados (SHA-256 antes/mutado/restaurado).
# Saída do job: base_a/base_b passam só com VERDICT=PASS; m8/m9 passam só se o mutante NÃO der PASS.
# Uso: t2_verdict.sh <cenario> <workdir>
set -u
SCEN=${1:?}; W=${2:?}; HERE=$(cd "$(dirname "$0")" && pwd); CL=$HERE/classify_t2.sh
enc(){ sed 's/%/%25/g' | tr '\n' '|' | sed 's/|$//; s/|/%0A/g'; }
note(){ echo "$2"; echo "::notice title=$1::$(printf '%s' "$2" | enc)"; }
sha(){ sha256sum "$1" | cut -d' ' -f1; }
[ -s "$W/obs.txt" ] || { echo "OBS_DONE=0" > "$W/obs.txt"; echo "INFRA_FAIL=orquestrador sem observação" >> "$W/obs.txt"; }
out=$(bash "$CL" "$W/obs.txt" "$SCEN"); verdict=$(sed -n 's/^VERDICT=//p' <<< "$out")
note "T2_${SCEN}_VERDICT" "$out"
keys='INFRA_FAIL|PS_CONFIG_PERM_ANTES|C1_VERSION|OP1|OP1_RAW|TERM0|SK_TERMS_AFTER_OP1|M9_[A-Z0-9_]+|S1|PARTITION|C1_REACH_SK_DURING_PARTITION|M8_BRANCH|SK_TERMS_C2_TIMELINE|FAILOVER_ELECTED|C2_TIMELINE|PROMOTE|C2_FENCE|T2A|T2A_RAW|T2A_C1_STATE|OP2_W2|OP2_W2_RAW|T2C|T2C_[A-Z_]+|PARTITION_HEALED|T2B|T2B_RAW|T2B_C1_STATE|ORACLE_[A-Z]+|SK_TERMS_FINAL|SK_COMMIT_FINAL|SK_EQUAL|SK_TERM_FINAL|M14_[A-Z]+'
note "T2_${SCEN}_OBS" "$(grep -E "^($keys)=" "$W/obs.txt" | cut -c1-420)"
note "T2_${SCEN}_PROVENIENCIA" "$(grep -E '^(IMAGE_|IDS=|S3_SUBSTITUTO|DOCKERFILE_B07)' "$W/obs.txt" | cut -c1-300)"
[ -s "$W/notes.txt" ] && note "T2_${SCEN}_DIAG" "$(grep -v '^$' "$W/notes.txt" | grep -E '^(PS_A|LOG_|PULL_FALHOU|M10 |TENANT_CREATE|TIMELINE_CREATE|SK_RAW1|M10_ORACLE_OUT|COMPOSE_NETS|S3_BUCKETS|BUILD_B07)' | cut -c1-1500 | head -c 12000)"
rc=0
case "$SCEN" in
  base_a|base_b) [ "$verdict" = PASS ] || rc=1 ;;
  # Mutante de infraestrutura só conta como morto se detectado como FAIL; ERROR_INFRA é inconclusivo (job falha).
  m8|m9) case "$verdict" in
           FAIL) note "T2_${SCEN}_MUTANT" "$SCEN KILLED (veredito=FAIL)" ;;
           PASS) note "T2_${SCEN}_MUTANT" "$SCEN SURVIVED"; rc=1 ;;
           *) note "T2_${SCEN}_MUTANT" "$SCEN INCONCLUSIVO (veredito=$verdict)"; rc=1 ;;
         esac ;;
esac
cmut(){ # $1 nome  $2 sed  $3 obs
  cp "$CL" "$W/cl.bak"; local s0 s1 s2 o vm; s0=$(sha "$CL")
  sed -i "$2" "$CL"; s1=$(sha "$CL")
  o=$(bash "$CL" "$3" "$SCEN"); vm=$(sed -n 's/^VERDICT=//p' <<< "$o")
  cp "$W/cl.bak" "$CL"; s2=$(sha "$CL")
  local res
  if [ "$s0" = "$s1" ]; then res="NAO_APLICADO"
  elif [ "$verdict" != PASS ]; then res="INCONCLUSIVO(base=$verdict, mutante=$vm)"
  elif [ "$vm" = PASS ]; then res="SURVIVED"; else res="KILLED(veredito=$vm)"; fi
  [ "$s0" = "$s2" ] || res="$res RESTAURACAO_FALHOU"
  note "T2_${SCEN}_$1" "$1 $res sha_antes=$s0 sha_mutado=$s1 sha_restaurado=$s2 | $(grep '^REASON' <<< "$o" | head -3 | tr '\n' ' ')"
}
case "$SCEN" in
  base_a|base_b)
    cmut M11_warning_como_sucesso 's/ACK_CLEAN) return 0;;/ACK_CLEAN|ACK_WARNING) return 0;;/' "$W/obs.txt"
    cmut M14_timeout_como_sucesso 's/ACK_CLEAN) return 0;;/ACK_CLEAN|TIMEOUT) return 0;;/' "$W/obs.txt" ;;
esac
if [ "$SCEN" = base_b ]; then
  if [ -s "$W/obs_m10.txt" ]; then
    echo "OBS_DONE=1" >> "$W/obs_m10.txt"
    o=$(bash "$CL" "$W/obs_m10.txt" "$SCEN"); vm=$(sed -n 's/^VERDICT=//p' <<< "$o")
    if [ "$verdict" != PASS ]; then res="INCONCLUSIVO(base=$verdict, mutante=$vm)"
    elif [ "$vm" = ERROR_INFRA ]; then res="KILLED(veredito=ERROR_INFRA)"; elif [ "$vm" = PASS ]; then res=SURVIVED; else res="KILLED(veredito=$vm)"; fi
    note "T2_base_b_M10_oraculo_le_compute1" "M10 $res $(cat "$W/m10.sha" 2>/dev/null) | $(grep -E '^ORACLE_' "$W/obs_m10.txt" | tr '\n' ' ' | cut -c1-400)"
  else note "T2_base_b_M10_oraculo_le_compute1" "M10 NAO_EXECUTADO (cenário não chegou ao oráculo)"; fi
fi
exit $rc
