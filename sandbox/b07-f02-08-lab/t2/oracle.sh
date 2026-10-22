#!/usr/bin/env bash
# B07/F02-08 T2 passo 6: oráculo independente. Lê o ledger de uma compute NOVA (compute3), iniciada depois de
# compute1 e compute2 pararem, na mesma tenant/timeline: a história que ela vê é a dos safekeepers/pageserver,
# não a memória de nenhuma das computes do experimento. Verificação de independência antes de ler:
# alvo = compute3, compute1 e compute2 paradas, alvo iniciado depois de ambas pararem, mesma timeline.
# Uso: DCQ="<comando docker compose>" oracle.sh <workdir>   (saída: linhas ORACLE_*=valor)
set -u
ORACLE_TARGET=compute3
W=${1:?workdir}; read -r -a DC <<< "${DCQ:?DCQ}"
cid(){ "${DC[@]}" ps -a -q "$1"; }
ts(){ date -d "$1" +%s%N 2>/dev/null || echo 0; }
indep=OK; why=""
[ "$ORACLE_TARGET" = compute3 ] || { indep=FAIL; why="$why alvo=$ORACLE_TARGET(esperado compute3);"; }
tid=$(cid "$ORACLE_TARGET")
[ -n "$tid" ] || { indep=FAIL; why="$why alvo sem contêiner;"; }
tstart=$(ts "$(docker inspect -f '{{.State.StartedAt}}' "$tid" 2>/dev/null)")
[ "$(docker inspect -f '{{.State.Status}}' "$tid" 2>/dev/null)" = running ] || { indep=FAIL; why="$why alvo não está rodando;"; }
for c in compute1 compute2; do
  id=$(cid "$c"); st=$(docker inspect -f '{{.State.Status}}' "$id" 2>/dev/null)
  fin=$(ts "$(docker inspect -f '{{.State.FinishedAt}}' "$id" 2>/dev/null)")
  [ "$st" = exited ] || { indep=FAIL; why="$why $c status=$st (esperado exited);"; }
  [ "$tstart" -gt "$fin" ] || { indep=FAIL; why="$why alvo iniciou antes de $c parar;"; }
done
q(){ timeout 60 "${DC[@]}" exec -T -e PGPASSWORD=cloud_admin "$ORACLE_TARGET" \
     psql -X -q -At -h localhost -p 55433 -U cloud_admin -d postgres -v ON_ERROR_STOP=1 -c "$*" 2>&1 | tr '\n' ' ' | sed 's/ $//'; }
tl=$(q "SHOW neon.timeline_id")
[ "$tl" = "${TIMELINE_ID:-?}" ] || { indep=FAIL; why="$why timeline do alvo=$tl (esperado ${TIMELINE_ID:-?});"; }
echo "ORACLE_TARGET=$ORACLE_TARGET"
echo "ORACLE_INDEP=$indep${why:+:$why}"
echo "ORACLE_LEDGER=$(q "SELECT coalesce(string_agg(op_id||':'||writer||'@'||epoch, ',' ORDER BY op_id),'') FROM ledger")"
echo "ORACLE_FENCE=$(q "SELECT epoch||'/'||owner FROM write_fence")"
