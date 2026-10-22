#!/usr/bin/env bash
# B07/F02-08 — laboratório descartável (socket Unix, sem rede, sem segredos). NUNCA em banco real.
# Prova: (1) cerca por época+dono em trigger funciona com UM ponto de linearização;
#        (2) com dois nós PG e partição, o primário antigo aceita o escritor antigo mesmo com o trigger;
#        (3) synchronous_standby_names não é cerca: cancelar a espera deixa o commit visível localmente.
set -u
BIN=${PG_BIN:-/usr/lib/postgresql/16/bin}
LAB=${1:-/var/tmp/zev-b07-f0208}
[ -e "$LAB" ] && { echo "LAB existe: $LAB (recuso)"; exit 2; }
mkdir -p "$LAB/sock"; chown -R postgres:postgres "$LAB"
as_pg(){ su postgres -s /bin/bash -c "$*"; }
q(){ local port=$1; shift; as_pg "$BIN/psql -X -q -At -h $LAB/sock -p $port -d lab -v ON_ERROR_STOP=1 -c \"$*\"" 2>&1; }
qa(){ local port=$1; shift; as_pg "$BIN/psql -X -At -h $LAB/sock -p $port -d lab -c \"$*\"" 2>&1; }  # sem ON_ERROR_STOP, mostra erros
A=56101; B=56102; S=56103
cleanup(){ for d in A B S; do as_pg "$BIN/pg_ctl -D $LAB/$d -m immediate stop" >/dev/null 2>&1; done; }
trap cleanup EXIT

start(){ as_pg "$BIN/pg_ctl -D $LAB/$1 -l $LAB/$1.log -w -o \"-p $2 -k $LAB/sock -c listen_addresses=''\" start" >/dev/null; }

cp "$(dirname "$0")/fence.sql" $LAB/fence.sql; chown postgres $LAB/fence.sql
qf(){ as_pg "$BIN/psql -X -q -h $LAB/sock -p $1 -d lab -v ON_ERROR_STOP=1 -f $LAB/fence.sql"; }

echo "=== CENARIO 1: ponto único de linearização (um nó) ==="
as_pg "$BIN/initdb -D $LAB/S -A trust -U postgres" >/dev/null; start S $S
as_pg "$BIN/createdb -h $LAB/sock -p $S lab"; qf $S
q $S "INSERT INTO ledger VALUES('op1','W1',1,100)"
echo "promocao W2 (CAS epoch=1): $(q $S "SELECT promote_writer(1,'W2')")"
echo "promocao concorrente W3 (CAS epoch=1, perdedora): [$(q $S "SELECT promote_writer(1,'W3')")]"
echo "escritor antigo W1 epoch=1 op2: $(qa $S "INSERT INTO ledger VALUES('op2','W1',1,100)")"
echo "novo escritor W2 epoch=2 op2: $(qa $S "INSERT INTO ledger VALUES('op2','W2',2,100)")"
echo "fence: $(q $S "SELECT epoch||'/'||owner FROM fence")  ledger: $(q $S "SELECT string_agg(op_id||':'||writer||'@'||epoch,',' ORDER BY op_id) FROM ledger")"

echo "=== CENARIO 2: dois nós, partição, retorno do primário antigo (mesmo trigger) ==="
as_pg "$BIN/initdb -D $LAB/A -A trust -U postgres" >/dev/null
echo "wal_level=replica" >> $LAB/A/postgresql.conf; echo "local replication all trust" >> $LAB/A/pg_hba.conf
start A $A; as_pg "$BIN/createdb -h $LAB/sock -p $A lab"; qf $A
q $A "INSERT INTO ledger VALUES('op1','W1',1,100)"
as_pg "$BIN/pg_basebackup -h $LAB/sock -p $A -D $LAB/B -R -X stream -c fast" ; start B $B
sleep 1; echo "B em recuperação (RO): $(q $B "SELECT pg_is_in_recovery()")  B ledger: $(q $B "SELECT count(*) FROM ledger")"
# partição: B deixa de receber WAL de A (primary_conninfo vazio + reload) e é promovido
as_pg "$BIN/psql -X -q -h $LAB/sock -p $B -d lab -c \"ALTER SYSTEM SET primary_conninfo=''\" -c 'SELECT pg_reload_conf()'" >/dev/null
q $B "SELECT pg_promote(true,30)" >/dev/null
echo "B promovido; promocao W2 em B: $(q $B "SELECT promote_writer(1,'W2')")"
echo "A (primário antigo) RO/RW: in_recovery=$(q $A "SELECT pg_is_in_recovery()") read_only=$(q $A "SHOW transaction_read_only") fence_A=$(q $A "SELECT epoch||'/'||owner FROM fence")"
echo "escritor antigo W1 epoch=1 op2 em A: $(qa $A "INSERT INTO ledger VALUES('op2','W1',1,100)")"
echo "novo escritor W2 epoch=2 op2 em B: $(qa $B "INSERT INTO ledger VALUES('op2','W2',2,100)")"
LA=$(q $A "SELECT string_agg(op_id||':'||writer||'@'||epoch,',' ORDER BY op_id) FROM ledger")
LB=$(q $B "SELECT string_agg(op_id||':'||writer||'@'||epoch,',' ORDER BY op_id) FROM ledger")
echo "ledger A: $LA"; echo "ledger B: $LB"
[ "$LA" != "$LB" ] && echo "RESULTADO C2: DIVERGENCIA (escrita dupla op2 em duas épocas) — trigger in-DB NÃO cerca o primário antigo"

echo "=== CENARIO 3: synchronous_standby_names no primário antigo ==="
as_pg "$BIN/psql -X -q -h $LAB/sock -p $A -d lab -c \"ALTER SYSTEM SET synchronous_standby_names='walreceiver'\" -c 'SELECT pg_reload_conf()'" >/dev/null
( as_pg "$BIN/psql -X -At -h $LAB/sock -p $A -d lab -c \"INSERT INTO ledger VALUES('op3','W1',1,100)\"" > $LAB/op3.out 2>&1 ) &
sleep 3; echo "esperando SyncRep: $(q $A "SELECT count(*) FROM pg_stat_activity WHERE wait_event='SyncRep'")  cancelando: $(q $A "SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE wait_event='SyncRep'")"
wait; echo "W1 op3 em A: $(tr '\n' ' ' < $LAB/op3.out)"
echo "op3 visível em A após cancelamento: $(q $A "SELECT count(*) FROM ledger WHERE op_id='op3'")"
