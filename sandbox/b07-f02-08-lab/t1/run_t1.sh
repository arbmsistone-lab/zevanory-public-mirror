#!/usr/bin/env bash
# B07/F02-08 T1: sobe um PostgreSQL 16 efêmero (trust, só 127.0.0.1), roda `node --test` com o SQL e o módulo
# do Worker originais e depois com cada mutante (M1–M7 em fence_worker.sql, M12 em worker_ledger.mjs).
# Cada mutante é aplicado NO PRÓPRIO arquivo e restaurado; registra SHA-256 antes/mutado/restaurado.
# Uso (como root, usuário postgres existente): run_t1.sh <diretório de trabalho inexistente>
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
BIN=${PG_BIN:-/usr/lib/postgresql/16/bin}
LAB=${1:?diretório de trabalho}; PORT=${T1_PORT:-56121}
[ -e "$LAB" ] && { echo "LAB existe: $LAB (recuso)"; exit 2; }
mkdir -p "$LAB"; chown postgres "$LAB"
as_pg(){ su postgres -s /bin/bash -c "$*"; }
as_pg "$BIN/initdb -D $LAB/d -A trust -U postgres" >/dev/null
as_pg "$BIN/pg_ctl -D $LAB/d -l $LAB/d.log -w -o \"-p $PORT -k $LAB -c listen_addresses=127.0.0.1\" start" >/dev/null
trap 'as_pg "$BIN/pg_ctl -D $LAB/d -m immediate stop" >/dev/null 2>&1' EXIT
echo "T1_PG $(as_pg "$BIN/postgres --version")"

SQL=$HERE/fence_worker.sql; MOD=$HERE/worker_ledger.mjs
run_suite(){ # imprime o resumo do node --test; devolve o exit code
  PGPORT=$PORT FENCE_SQL=$SQL WORKER_MODULE=$MOD node --test --test-force-exit --test-timeout=30000 --test-reporter=tap "$HERE/fence_worker.test.mjs" > "$LAB/out.tap" 2>&1
  local rc=$?
  grep -E '^# (pass|fail) ' "$LAB/out.tap" | tr '\n' ' '
  grep -E '^not ok ' "$LAB/out.tap" | sed 's/^/ | /' | tr '\n' ' '
  return $rc
}
sha(){ sha256sum "$1" | cut -c1-64; }

echo "== original sql=$(sha $SQL) mod=$(sha $MOD)"
summary=$(run_suite); rc=$?
echo "   $summary"
[ $rc = 0 ] && echo "RESULT original PASS" || { echo "RESULT original FAIL"; cat "$LAB/out.tap"; }

mutate(){ # $1 nome  $2 arquivo  $3 expressão sed
  local name=$1 f=$2 expr=$3 before mutated restored
  cp "$f" "$LAB/bak"; before=$(sha "$f")
  sed -i "$expr" "$f"; mutated=$(sha "$f")
  if [ "$before" = "$mutated" ]; then echo "MUTANTE NÃO APLICADO: $name"; cp "$LAB/bak" "$f"; return; fi
  summary=$(run_suite); local rc=$?
  cp "$LAB/bak" "$f"; restored=$(sha "$f")
  echo "== $name file=$(basename "$f") sha_antes=$before sha_mutado=$mutated sha_restaurado=$restored"
  echo "   $summary"
  [ "$before" = "$restored" ] || echo "RESTAURACAO FALHOU: $name"
  [ $rc != 0 ] && echo "RESULT $name KILLED" || echo "RESULT $name SURVIVED"
}
mutate M1_sem_epoca              "$SQL" 's/NEW.epoch IS NULL OR NEW.epoch <> f.epoch OR //'
mutate M2_comparacao_frouxa      "$SQL" 's/NEW.epoch <> f.epoch/NEW.epoch < f.epoch/'
mutate M3a_null_no_trigger       "$SQL" 's/NEW.epoch IS NULL OR //'
mutate M3b_null_trigger_e_coluna "$SQL" 's/NEW.epoch IS NULL OR //; s/epoch bigint NOT NULL, amount/epoch bigint, amount/'
mutate M4_sem_dono               "$SQL" 's/ OR NEW.writer IS DISTINCT FROM f.owner//'
mutate M5_trigger_nao_bloqueante "$SQL" 's/RAISE EXCEPTION/RAISE WARNING/'
mutate M6_promocao_sem_cas       "$SQL" 's/ AND epoch=p_expected//'
mutate M7_sem_update             "$SQL" 's/BEFORE INSERT OR UPDATE ON ledger/BEFORE INSERT ON ledger/'
mutate M12_worker_ignora_identidade "$MOD" 's/if (rows\[0\].db_identity !== cfg.dbIdentity)/if (false)/; s/f.db_identity = \$5::uuid/($5::uuid IS NOT NULL)/'
