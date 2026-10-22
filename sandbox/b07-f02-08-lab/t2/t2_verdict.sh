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
