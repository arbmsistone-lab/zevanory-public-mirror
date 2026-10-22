#!/usr/bin/env bash
# Mutação do desenho de cerca em ponto único (fence.sql). Laboratório descartável, socket Unix.
set -u
BIN=${PG_BIN:-/usr/lib/postgresql/16/bin}; HERE=$(cd "$(dirname "$0")" && pwd)
LAB=${1:-/var/tmp/zev-b07-mut}; P=56111
[ -e "$LAB" ] && { echo "LAB existe"; exit 2; }
mkdir -p $LAB/sock; chown -R postgres $LAB
as_pg(){ su postgres -s /bin/bash -c "$*"; }
as_pg "$BIN/initdb -D $LAB/d -A trust -U postgres" >/dev/null
as_pg "$BIN/pg_ctl -D $LAB/d -l $LAB/d.log -w -o \"-p $P -k $LAB/sock -c listen_addresses=''\" start" >/dev/null
trap 'as_pg "$BIN/pg_ctl -D $LAB/d -m immediate stop" >/dev/null 2>&1' EXIT
q(){ as_pg "$BIN/psql -X -q -At -h $LAB/sock -p $P -d $1 -c \"$2\"" 2>/dev/null; }
ok(){ as_pg "$BIN/psql -X -q -At -h $LAB/sock -p $P -d $1 -v ON_ERROR_STOP=1 -c \"$2\"" >/dev/null 2>&1; }

suite(){ # $1=db ; imprime nº de falhas
  local db=$1 f=0
  ok $db "INSERT INTO ledger VALUES('op1','W1',1,100)" || { f=$((f+1)); echo "  F0 escritor legítimo inicial negado"; }
  # promoções concorrentes: duas sessões, mesma época esperada
  as_pg "$BIN/psql -X -q -At -h $LAB/sock -p $P -d $db -c \"BEGIN; SELECT promote_writer(1,'W2'); SELECT pg_sleep(1); COMMIT;\"" > $LAB/$db.p1 2>&1 &
  sleep 0.3
  as_pg "$BIN/psql -X -q -At -h $LAB/sock -p $P -d $db -c \"SELECT promote_writer(1,'W3')\"" > $LAB/$db.p2 2>&1 &
  wait
  local wins; wins=$(cat $LAB/$db.p1 $LAB/$db.p2 | grep -c '^[0-9]\+$')
  [ "$wins" = 1 ] || { f=$((f+1)); echo "  F1 promoções vencedoras=$wins (esperado 1)"; }
  [ "$(q $db "SELECT epoch||'/'||owner FROM fence")" = "2/W2" ] || { f=$((f+1)); echo "  F2 fence=$(q $db "SELECT epoch||'/'||owner FROM fence")"; }
  ok $db "INSERT INTO ledger VALUES('op2','W1',1,100)" && { f=$((f+1)); echo "  F3 escritor antigo (época 1) aceito"; }
  ok $db "INSERT INTO ledger VALUES('op2n','W2',NULL,100)" && { f=$((f+1)); echo "  F4 época NULL aceita"; }
  ok $db "INSERT INTO ledger VALUES('op2x','W3',2,100)" && { f=$((f+1)); echo "  F5 não-dono com época atual aceito"; }
  ok $db "INSERT INTO ledger VALUES('op2f','W2',3,100)" && { f=$((f+1)); echo "  F6 época futura aceita"; }
  ok $db "UPDATE ledger SET amount=999 WHERE op_id='op1'" && { f=$((f+1)); echo "  F7 regressão: linha da época 1 alterada"; }
  ok $db "INSERT INTO ledger VALUES('op2','W2',2,100)" || { f=$((f+1)); echo "  F8 novo escritor legítimo negado"; }
  [ "$(q $db "SELECT count(*)||':'||sum(amount) FROM ledger")" = "2:200" ] || { f=$((f+1)); echo "  F9 ledger=$(q $db "SELECT string_agg(op_id||':'||writer||'@'||coalesce(epoch::text,'null')||'='||amount,',') FROM ledger")"; }
  echo "  falhas=$f"; return $f
}

run(){ # $1 nome $2 arquivo sql
  local db=m_$1; as_pg "$BIN/createdb -h $LAB/sock -p $P $db"
  cp "$2" $LAB/$db.sql; chown postgres $LAB/$db.sql
  as_pg "$BIN/psql -X -q -h $LAB/sock -p $P -d $db -v ON_ERROR_STOP=1 -f $LAB/$db.sql" >/dev/null || { echo "$1: SQL inválido"; return; }
  echo "== $1 (sha256 $(sha256sum "$2" | cut -c1-16))"; suite $db; local r=$?
  if [ "$1" = original ]; then [ $r = 0 ] && echo "RESULT original PASS" || echo "RESULT original FAIL"
  else [ $r -gt 0 ] && echo "RESULT $1 KILLED" || echo "RESULT $1 SURVIVED"; fi
}

M=$LAB/mut; mkdir -p $M
cp $HERE/fence.sql $M/original.sql
sed 's/NEW.epoch IS NULL OR NEW.epoch <> f.epoch OR //' $HERE/fence.sql > $M/M1_sem_epoca.sql
sed 's/NEW.epoch <> f.epoch/NEW.epoch < f.epoch/' $HERE/fence.sql > $M/M2_comparacao_frouxa.sql
sed 's/NEW.epoch IS NULL OR //' $HERE/fence.sql > $M/M3a_null_no_trigger.sql
sed -e 's/NEW.epoch IS NULL OR //' -e 's/epoch bigint NOT NULL, amount/epoch bigint, amount/' $HERE/fence.sql > $M/M3b_null_trigger_e_coluna.sql
sed 's/ OR NEW.writer IS DISTINCT FROM f.owner//' $HERE/fence.sql > $M/M4_sem_dono.sql
sed 's/RAISE EXCEPTION/RAISE WARNING/' $HERE/fence.sql > $M/M5_trigger_nao_bloqueante.sql
sed 's/ AND epoch=p_expected//' $HERE/fence.sql > $M/M6_promocao_sem_cas.sql
sed 's/BEFORE INSERT OR UPDATE ON ledger/BEFORE INSERT ON ledger/' $HERE/fence.sql > $M/M7_sem_update.sql
for f in $M/*.sql; do cmp -s $f $HERE/fence.sql && [ "$(basename $f)" != original.sql ] && echo "MUTANTE NÃO APLICADO: $f"; done
for f in $M/original.sql $M/M*.sql; do run "$(basename $f .sql)" $f; done
