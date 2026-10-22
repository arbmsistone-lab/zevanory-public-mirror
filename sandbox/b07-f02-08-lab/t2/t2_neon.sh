#!/usr/bin/env bash
# B07/F02-08 T2 (PROPOSTA_B07 §7): cerca de armazenamento com a pilha Neon de código aberto (docker compose
# oficial do neondatabase/neon). Runner descartável; nenhum recurso em nuvem; nenhum segredo (as credenciais
# minio/cloud_admin são as fixas do compose público).
# Uso: t2_neon.sh <base_a|base_b|m8|m9> <workdir>   (NEON_DIR = docker-compose/ do checkout do Neon)
# Gera <workdir>/obs.txt (CHAVE=valor) para classify_t2.sh. Cenário não atingido => INFRA_FAIL (=> ERROR_INFRA).
set -u
SCEN=${1:?base_a|base_b|m8|m9}; W=${2:?workdir}
HERE=$(cd "$(dirname "$0")" && pwd); LAB=$(cd "$HERE/.." && pwd)
NEON_DIR=${NEON_DIR:?NEON_DIR}
mkdir -p "$W"; OBS=$W/obs.txt; : > "$OBS"
export COMPOSE_PROJECT_NAME=b07
DC=(docker compose -f "$NEON_DIR/docker-compose.yml" -f "$NEON_DIR/docker-compose.b07.yml")
[ "$SCEN" = m9 ] && DC+=(--profile m9)
CLIENT_TIMEOUT=${CLIENT_TIMEOUT:-30}

enc(){ sed 's/%/%25/g' | tr '\n' '|' | sed 's/|$//; s/|/%0A/g'; }
note(){ echo "T2[$SCEN] $*"; echo "::notice title=T2_${SCEN}::$(printf '%s' "$*" | enc)"; }
obs(){ echo "$1=$2" >> "$OBS"; note "$1=$2"; }
infra_fail(){ obs INFRA_FAIL "$1"; dump_logs; exit 0; }
dump_logs(){
  for c in compute1 compute2 compute3; do
    local id; id=$("${DC[@]}" ps -a -q "$c" 2>/dev/null)
    [ -n "$id" ] || continue
    docker logs "$id" > "$W/$c.log" 2>&1
    note "LOG_${c}_WALPROPOSER: $(grep -E 'rejects our connection|rejected our request|collected propTermStartLsn|PANIC|terminating|committed locally|elected|proposer' "$W/$c.log" | grep -v '^+' | tail -12 | cut -c1-300)"
  done
}
cid(){ "${DC[@]}" ps -a -q "$1"; }
q(){ local c=$1; shift; timeout "${QT:-60}" "${DC[@]}" exec -T -e PGPASSWORD=cloud_admin "$c" \
     psql -X -q -At -h localhost -p 55433 -U cloud_admin -d postgres -v ON_ERROR_STOP=1 -c "$*" 2>&1; }
qa(){ local c=$1; shift; timeout "${QT:-60}" "${DC[@]}" exec -T -e PGPASSWORD=cloud_admin "$c" \
     psql -X -At -h localhost -p 55433 -U cloud_admin -d postgres -c "$*" 2>&1; }
wait_ready(){ # $1 compute, $2 segundos
  local i; for i in $(seq 1 "$2"); do [ "$(QT=10 q "$1" 'SELECT 1' 2>/dev/null)" = 1 ] && return 0; sleep 1; done; return 1; }
# Classe da resposta vista pelo cliente: ACK_CLEAN (INSERT 0 1 sem WARNING), ACK_WARNING, ERROR, CONN_LOST, TIMEOUT.
classify_out(){ # $1 arquivo de saída, $2 concluiu(1/0)
  if [ "$2" != 1 ]; then echo TIMEOUT
  elif grep -q '^INSERT 0 1' "$1" && grep -q 'WARNING' "$1"; then echo ACK_WARNING
  elif grep -q '^INSERT 0 1' "$1"; then echo ACK_CLEAN
  elif grep -Eqi 'server closed the connection|connection to server.*lost|terminating connection|FATAL|PANIC|no connection to the server|container .* is not running|is not running' "$1"; then echo CONN_LOST
  elif grep -q 'ERROR' "$1"; then echo ERROR
  else echo UNKNOWN; fi
}
SQL_INS(){ # op writer epoch  — a instrução do Worker (t1/worker_ledger.mjs SQL_LEDGER_INSERT) com literais
  echo "INSERT INTO ledger(op_id, writer, epoch, amount) SELECT '$1', '$2', $3, 100 FROM write_fence f WHERE f.id = 1 AND f.db_identity = '$IDENT'::uuid RETURNING op_id;"; }
sk_ports(){ if [ "${1:-}" = m9set ]; then echo "7679 7680 7681"; else echo "7676 7677 7678"; fi; }
sk_json(){ curl -s -m 5 "http://localhost:$1/v1/tenant/$TENANT_ID/timeline/$2"; }
sk_terms(){ # $1 timeline -> "t1,t2,t3"
  local p out=""; for p in $(sk_ports); do out="$out$(sk_json "$p" "$1" | jq -r '.acceptor_state.term // "NA"' 2>/dev/null || echo NA),"; done; echo "${out%,}"; }
sk_commits(){ local p out=""; for p in $(sk_ports); do out="$out$(sk_json "$p" "$1" | jq -r '.commit_lsn // "NA"' 2>/dev/null || echo NA),"; done; echo "${out%,}"; }
maxterm(){ tr ',' '\n' <<< "$1" | grep -E '^[0-9]+$' | sort -n | tail -1; }

# ---------- imagens fixadas ----------
# images.lock: uma linha por imagem; candidatos separados por "|" (o primeiro que baixar é usado e registrado).
declare -A PICK
lock(){ echo "${PICK[$1]}"; }
for k in NEON COMPUTE MINIO; do
  ok=0
  IFS='|' read -r -a cands <<< "$(sed -n "s/^$k=//p" "$HERE/images.lock")"
  for ref in "${cands[@]}"; do
    for t in 1 2; do docker pull -q "$ref" > "$W/pull_$k.log" 2>&1 && { ok=1; break; }; sleep 5; done
    [ $ok = 1 ] && break
    note "PULL_FALHOU $k $ref: $(tail -c 250 "$W/pull_$k.log" | tr '\n' ' ')"
  done
  [ $ok = 1 ] || infra_fail "pull $k: nenhum candidato baixou"
  PICK[$k]=$ref
  dig=$(docker image inspect --format '{{index .RepoDigests 0}}' "$ref")
  obs "IMAGE_$k" "$ref => $dig"
  case "$ref" in *@sha256:*) ;; *) obs IMAGES_UNPINNED "$k";; esac
done
# As imagens quay.io/minio/* do compose oficial deixaram de ser públicas (pull "unauthorized", registrado na
# PR). O S3 local passa a ser o MinIO empacotado pela Bitnami (mesmo servidor MinIO); o bucket "neon" é criado
# pelo próprio entrypoint (MINIO_DEFAULT_BUCKETS) e conferido pelo mc embutido na imagem.
export NEON_IMAGE=$(lock NEON) MINIO_IMAGE=$(lock MINIO) MC_IMAGE=$(lock MINIO)
cat > "$NEON_DIR/docker-compose.s3.yml" <<'YML'
services:
  minio:
    command: ["/opt/bitnami/scripts/minio/run.sh"]
    environment:
      - MINIO_DEFAULT_BUCKETS=neon
      - MINIO_API_PORT_NUMBER=9000
      - MINIO_CONSOLE_PORT_NUMBER=9001
  minio_create_buckets:
    entrypoint: ["/bin/sh", "-c"]
    command:
      - "for i in $$(seq 1 60); do /opt/bitnami/minio-client/bin/mc alias set m http://minio:9000 minio password >/dev/null 2>&1 && break; sleep 1; done; /opt/bitnami/minio-client/bin/mc mb --ignore-existing --region=eu-north-1 m/neon; /opt/bitnami/minio-client/bin/mc ls m; exit 0"
YML
DC+=(-f "$NEON_DIR/docker-compose.s3.yml")
obs S3_SUBSTITUTO "minio=$MINIO_IMAGE sha256(docker-compose.s3.yml)=$(sha256sum "$NEON_DIR/docker-compose.s3.yml" | cut -d' ' -f1)"
docker tag "$(lock COMPUTE)" ghcr.io/neondatabase/compute-node-v16:b07pinned
docker build -q --build-arg REPOSITORY=ghcr.io/neondatabase --build-arg COMPUTE_IMAGE=compute-node-v16 \
  --build-arg TAG=b07pinned -t built-compute "$NEON_DIR/compute_wrapper" > /dev/null || infra_fail "build compute_wrapper"

export TENANT_ID=$(openssl rand -hex 16) TIMELINE_ID=$(openssl rand -hex 16)
IDENT=$(cat /proc/sys/kernel/random/uuid)
obs IDS "tenant=$TENANT_ID timeline=$TIMELINE_ID db_identity=$IDENT"
"${DC[@]}" config > "$W/compose.resolved.yml" 2> "$W/compose.err" || infra_fail "compose config: $(head -c 300 "$W/compose.err")"
note "COMPOSE_NETS: $(for s in safekeeper1 pageserver compute1 compute2 compute3; do printf '%s=%s ' "$s" "$(docker compose -f "$W/compose.resolved.yml" config --format json 2>/dev/null | jq -c --arg s "$s" '.services[$s].networks|keys' 2>/dev/null)"; done)"

# ---------- pilha ----------
SVC=(minio minio_create_buckets storage_broker pageserver safekeeper1 safekeeper2 safekeeper3)
[ "$SCEN" = m9 ] && SVC+=(safekeeper4 safekeeper5 safekeeper6)
"${DC[@]}" up -d --no-build "${SVC[@]}" > "$W/up.log" 2>&1 || infra_fail "compose up storage: $(tail -c 400 "$W/up.log")"
for i in $(seq 1 90); do curl -sf -m 3 http://localhost:9898/v1/status > /dev/null && break; sleep 2; done
sleep 5; note "S3_BUCKETS: $(docker logs "$(cid minio_create_buckets)" 2>&1 | tail -3 | tr '\n' ' ')"
curl -sf -m 3 http://localhost:9898/v1/status > /dev/null || infra_fail "pageserver http não respondeu"
r=$(curl -s -m 20 -X PUT -H 'Content-Type: application/json' -d '{"mode":"AttachedSingle","generation":1,"tenant_conf":{}}' \
    "http://localhost:9898/v1/tenant/$TENANT_ID/location_config"); note "TENANT_CREATE: $(echo "$r" | head -c 200)"
for i in $(seq 1 10); do
  r=$(curl -s -m 30 -w ' http=%{http_code}' -X POST -H 'Content-Type: application/json' \
      -d "{\"new_timeline_id\":\"$TIMELINE_ID\",\"pg_version\":16}" "http://localhost:9898/v1/tenant/$TENANT_ID/timeline/")
  case "$r" in *http=201*|*http=200*|*http=409*) break;; esac; sleep 3
done
note "TIMELINE_CREATE: $(echo "$r" | head -c 300)"
case "$r" in *http=201*|*http=200*|*http=409*) ;; *) infra_fail "timeline não criada";; esac

"${DC[@]}" up -d --no-build --no-deps compute1 >> "$W/up.log" 2>&1 || infra_fail "compute1 up"
wait_ready compute1 240 || infra_fail "compute1 não ficou pronta em 240s"
obs C1_VERSION "$(q compute1 'SELECT version()' | cut -c1-80)"

# ---------- passo 1: fence + op1 em compute1 ----------
q compute1 "$(cat "$LAB/t1/fence_worker.sql")" > "$W/fence_apply.out" || infra_fail "fence_worker.sql: $(head -c 300 "$W/fence_apply.out")"
q compute1 "INSERT INTO write_fence VALUES (1, 1, 'W1', '$IDENT'::uuid)" > /dev/null || infra_fail "seed write_fence"
o=$(qa compute1 "$(SQL_INS op1 W1 1)"); printf '%s\n' "$o" > "$W/op1.out"
obs OP1 "$(classify_out "$W/op1.out" 1)"
obs OP1_RAW "$(tr '\n' ' ' < "$W/op1.out")"
sleep 2
TERM0=$(sk_terms "$TIMELINE_ID"); obs SK_TERMS_AFTER_OP1 "$TERM0"; obs TERM0 "$(maxterm "$TERM0")"

if [ "$SCEN" = m9 ]; then
  # M9: compute1 reinicia apontando para OUTRO conjunto de safekeepers (segundo escritor autogerido).
  mkdir -p "$W/configs_m9"; cp "$NEON_DIR/compute_wrapper/var/db/postgres/configs/config.json" "$W/configs_m9/"
  sed -i 's/safekeeper1:5454,safekeeper2:5454,safekeeper3:5454/safekeeper4:5454,safekeeper5:5454,safekeeper6:5454/' "$W/configs_m9/config.json"
  obs M9_CONFIG "$(grep -o 'safekeeper[0-9]:5454[^"]*' "$W/configs_m9/config.json" | head -1)"
  obs M9_SHA "original=$(sha256sum "$NEON_DIR/compute_wrapper/var/db/postgres/configs/config.json" | cut -d' ' -f1) mutado=$(sha256sum "$W/configs_m9/config.json" | cut -d' ' -f1)"
  "${DC[@]}" stop -t 10 compute1 > /dev/null 2>&1
  COMPUTE1_CONFIGS="$W/configs_m9/" "${DC[@]}" up -d --no-build --no-deps --force-recreate compute1 >> "$W/up.log" 2>&1 || infra_fail "M9 compute1 recreate"
  export COMPUTE1_CONFIGS="$W/configs_m9/"
  wait_ready compute1 240 || infra_fail "M9 compute1 (sk4-6) não ficou pronta"
  obs M9_C1_SAFEKEEPERS "$(q compute1 'SHOW neon.safekeepers')"
  obs M9_C1_LEDGER "$(q compute1 "SELECT string_agg(op_id||':'||writer||'@'||epoch, ',' ORDER BY op_id) FROM ledger")"
fi

# ---------- sessão S1 do escritor antigo, aberta ANTES do failover ----------
mkfifo "$W/s1.in"
"${DC[@]}" exec -T -e PGPASSWORD=cloud_admin compute1 psql -X -At -h localhost -p 55433 -U cloud_admin -d postgres \
  < "$W/s1.in" > "$W/s1.out" 2>&1 &
S1PID=$!
exec 7> "$W/s1.in"
echo "SELECT 'S1_OPEN pid='||pg_backend_pid()||' fence='||(SELECT epoch||'/'||owner FROM write_fence);" >&7
for i in $(seq 1 20); do grep -q S1_OPEN "$W/s1.out" && break; sleep 1; done
grep -q S1_OPEN "$W/s1.out" || infra_fail "S1 não abriu: $(head -c 200 "$W/s1.out")"
obs S1 "$(grep S1_OPEN "$W/s1.out")"

SKNET=$(docker network ls --format '{{.Name}}' | grep -E '^b07_sknet$')
if [ "$SCEN" = base_b ]; then
  docker network disconnect "$SKNET" "$(cid compute1)" || infra_fail "network disconnect"
  obs PARTITION "compute1 desconectada de $SKNET (safekeepers); pageserver segue acessível"
  sleep 3
  obs C1_REACH_SK_DURING_PARTITION "$("${DC[@]}" exec -T compute1 bash -c 'getent hosts safekeeper1 >/dev/null && echo resolve || echo nao_resolve' 2>&1)"
fi

# ---------- passo 2: failover — compute2 na mesma tenant/timeline (M8: timeline diferente) ----------
C2_TL=$TIMELINE_ID
if [ "$SCEN" = m8 ]; then
  export TIMELINE_ID2=$(openssl rand -hex 16); C2_TL=$TIMELINE_ID2
  r=$(curl -s -m 30 -w ' http=%{http_code}' -X POST -H 'Content-Type: application/json' \
      -d "{\"new_timeline_id\":\"$TIMELINE_ID2\",\"ancestor_timeline_id\":\"$TIMELINE_ID\",\"pg_version\":16}" \
      "http://localhost:9898/v1/tenant/$TENANT_ID/timeline/")
  obs M8_BRANCH "timeline2=$TIMELINE_ID2 resp=$(echo "$r" | tr -d '\n' | head -c 200)"
fi
T2_BEFORE=$(sk_terms "$C2_TL")
"${DC[@]}" up -d --no-build --no-deps compute2 >> "$W/up.log" 2>&1 || infra_fail "compute2 up"
wait_ready compute2 240 || infra_fail "compute2 não ficou pronta em 240s"
sleep 2
T2_AFTER=$(sk_terms "$C2_TL")
obs SK_TERMS_C2_TIMELINE "antes=$T2_BEFORE depois=$T2_AFTER"
b=$(maxterm "$T2_BEFORE"); a=$(maxterm "$T2_AFTER")
if [ -n "$a" ] && [ "$a" -gt "${b:-0}" ]; then obs FAILOVER_ELECTED 1; else obs FAILOVER_ELECTED 0; fi
obs C2_TIMELINE "$(q compute2 'SHOW neon.timeline_id') (compute1: $TIMELINE_ID)"
obs C2_FENCE_BEFORE "$(q compute2 "SELECT epoch||'/'||owner FROM write_fence")"
P=""
for i in $(seq 1 12); do
  P=$(q compute2 "SELECT promote_writer(1, 'W2')"); f=$(q compute2 "SELECT epoch||'/'||owner FROM write_fence")
  [ "$f" = 2/W2 ] && break; sleep 5
done
obs PROMOTE "$P"; obs C2_FENCE "$f"
[ "$f" = 2/W2 ] || infra_fail "promoção em compute2 não chegou a 2/W2 (fence=$f)"

op2w2(){
  for i in $(seq 1 12); do
    o=$(qa compute2 "$(SQL_INS op2 W2 2)"); printf '%s\n' "$o" > "$W/op2w2.out"
    [ "$(q compute2 "SELECT count(*) FROM ledger WHERE op_id='op2' AND writer='W2'")" = 1 ] && break; sleep 5
  done
  obs OP2_W2 "$(classify_out "$W/op2w2.out" 1)"; obs OP2_W2_RAW "$(tr '\n' ' ' < "$W/op2w2.out" | cut -c1-200)"
}

t2c(){ # commit local preso em SyncRep na compute1, depois pg_cancel_backend
  if [ "$(QT=15 q compute1 'SELECT 1' 2>/dev/null)" != 1 ]; then obs T2C NOT_REACHED; obs T2C_REASON "compute1 não aceita conexão"; return; fi
  ( QT=90 qa compute1 "$(SQL_INS op3 W1 1)" > "$W/op3.out" 2>&1 ) & local P3=$!
  local n=0; for i in $(seq 1 20); do n=$(QT=10 q compute1 "SELECT count(*) FROM pg_stat_activity WHERE wait_event='SyncRep'"); [ "$n" -ge 1 ] 2>/dev/null && break; sleep 1; done
  obs T2C_SYNCREP_WAITERS "$n"
  obs T2C_WAIT_EVENTS "$(QT=10 q compute1 "SELECT string_agg(coalesce(wait_event_type,'-')||':'||coalesce(wait_event,'-'),',') FROM pg_stat_activity WHERE query LIKE 'INSERT INTO ledger%'")"
  if [ "$n" -ge 1 ] 2>/dev/null; then
    obs T2C_CANCEL "$(QT=10 q compute1 "SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE wait_event='SyncRep'")"
    for i in $(seq 1 20); do kill -0 $P3 2>/dev/null || break; sleep 1; done
    kill -0 $P3 2>/dev/null && { kill $P3; obs T2C NOT_REACHED; obs T2C_REASON "INSERT não retornou após cancelamento"; return; }
    obs T2C "$(classify_out "$W/op3.out" 1)"
    obs T2C_RAW "$(tr '\n' ' ' < "$W/op3.out" | cut -c1-400)"
    obs T2C_VISIBLE_OTHER_SESSION "$(QT=15 q compute1 "SELECT count(*) FROM ledger WHERE op_id='op3'")"
  else
    kill $P3 2>/dev/null; obs T2C NOT_REACHED; obs T2C_REASON "INSERT op3 não chegou a SyncRep (n=$n) saída=$(tr '\n' ' ' < "$W/op3.out" | cut -c1-200)"
  fi
}

old_writer(){ # $1 rótulo (T2A|T2B): op2 W1@1 pela sessão S1 aberta antes do failover; timeout de cliente
  local label=$1
  if ! kill -0 $S1PID 2>/dev/null; then
    obs "$label" CONN_LOST; obs "${label}_RAW" "S1 já encerrada antes do envio: $(tr '\n' ' ' < "$W/s1.out" | cut -c1-300)"; return; fi
  : > "$W/s1.mark"; local start; start=$(wc -l < "$W/s1.out")
  { echo "$(SQL_INS op2 W1 1)"; echo '\echo S1_OP2_DONE'; } >&7 2>/dev/null
  local done=0
  for i in $(seq 1 "$CLIENT_TIMEOUT"); do
    grep -q S1_OP2_DONE "$W/s1.out" && { done=1; break; }
    kill -0 $S1PID 2>/dev/null || { done=1; break; }
    sleep 1
  done
  tail -n +"$((start+1))" "$W/s1.out" > "$W/${label}.out"
  obs "$label" "$(classify_out "$W/${label}.out" "$done")"
  obs "${label}_RAW" "$(tr '\n' ' ' < "$W/${label}.out" | cut -c1-400) [s1_alive=$(kill -0 $S1PID 2>/dev/null && echo 1 || echo 0) waited=${i}s]"
  obs "${label}_C1_STATE" "$(docker inspect -f '{{.State.Status}} exit={{.State.ExitCode}}' "$(cid compute1)")"
}

case "$SCEN" in
  base_a|m8|m9)
    old_writer T2A
    op2w2
    t2c ;;
  base_b)
    op2w2
    t2c                                   # durante a partição: commit preso em SyncRep, cancelado
    docker network connect "$SKNET" "$(cid compute1)" || infra_fail "network connect"
    obs PARTITION_HEALED "compute1 reconectada a $SKNET"
    sleep 5
    old_writer T2B ;;
esac
exec 7>&-

dump_logs
# ---------- M10 (mutante do script do oráculo, aplicado no próprio arquivo e restaurado) ----------
sha(){ sha256sum "$1" | cut -d' ' -f1; }
ORA=$HERE/oracle.sh
if [ "$SCEN" = base_b ]; then
  cp "$ORA" "$W/oracle.bak"; s0=$(sha "$ORA")
  sed -i 's/^ORACLE_TARGET=compute3$/ORACLE_TARGET=compute1/' "$ORA"; s1=$(sha "$ORA")
  DCQ="${DC[*]}" bash "$ORA" "$W" > "$W/oracle_m10.out" 2>&1
  cp "$W/oracle.bak" "$ORA"; s2=$(sha "$ORA")
  note "M10_ORACLE_OUT: $(cat "$W/oracle_m10.out")"
  echo "M10 sha_antes=$s0 sha_mutado=$s1 sha_restaurado=$s2" > "$W/m10.sha"; note "$(cat "$W/m10.sha")"
fi

# ---------- passo 6: oráculo independente ----------
"${DC[@]}" stop -t 15 compute1 compute2 >> "$W/up.log" 2>&1
sleep 2
"${DC[@]}" up -d --no-build --no-deps compute3 >> "$W/up.log" 2>&1 || infra_fail "compute3 up"
wait_ready compute3 240 || infra_fail "compute3 (oráculo) não ficou pronta em 240s"
DCQ="${DC[*]}" bash "$ORA" "$W" > "$W/oracle.out" 2>&1
while IFS= read -r l; do obs "${l%%=*}" "${l#*=}"; done < "$W/oracle.out"
if [ "$SCEN" = base_b ]; then
  # M10 completo: observação com o oráculo mutado (compute1) no lugar do verdadeiro
  { grep -v '^ORACLE_' "$OBS"; grep '^ORACLE_' "$W/oracle_m10.out"; } > "$W/obs_m10.txt"
fi

# ---------- safekeepers: term e commit_lsn iguais nos três ----------
eq=0
for i in $(seq 1 45); do
  T=$(sk_terms "$TIMELINE_ID"); C=$(sk_commits "$TIMELINE_ID")
  if [ "$(tr ',' '\n' <<< "$T" | sort -u | wc -l)" = 1 ] && [ "$(tr ',' '\n' <<< "$C" | sort -u | wc -l)" = 1 ] && ! grep -q NA <<< "$T$C"; then eq=1; break; fi
  sleep 2
done
obs SK_TERMS_FINAL "$T"; obs SK_COMMIT_FINAL "$C"; obs SK_EQUAL "$eq"; obs SK_TERM_FINAL "$(maxterm "$T")"
note "SK_RAW1: $(sk_json 7676 "$TIMELINE_ID" | head -c 600)"

# ---------- M14 (real): sem quórum, cliente não pode receber sucesso ----------
if [ "$SCEN" = base_a ]; then
  "${DC[@]}" stop -t 5 safekeeper2 safekeeper3 >> "$W/up.log" 2>&1
  obs M14_SAFEKEEPERS "$("${DC[@]}" ps -a --format '{{.Service}}:{{.State}}' safekeeper1 safekeeper2 safekeeper3 | tr '\n' ' ')"
  ( QT=$((CLIENT_TIMEOUT+30)) qa compute3 "$(SQL_INS op4 W2 2)" > "$W/op4.out" 2>&1 ) & P4=$!
  d=0; for i in $(seq 1 "$CLIENT_TIMEOUT"); do kill -0 $P4 2>/dev/null || { d=1; break; }; sleep 1; done
  obs M14_RESULT "$(classify_out "$W/op4.out" "$d")"; obs M14_RAW "$(tr '\n' ' ' < "$W/op4.out" | cut -c1-200)"
  obs M14_WAIT "$(QT=10 q compute3 "SELECT string_agg(coalesce(wait_event,'-'),',') FROM pg_stat_activity WHERE query LIKE 'INSERT INTO ledger%'")"
  kill $P4 2>/dev/null
fi
dump_logs
[ "$SCEN" = m9 ] && obs M9_SHA_RESTAURADO "original_apos=$(sha256sum "$NEON_DIR/compute_wrapper/var/db/postgres/configs/config.json" | cut -d' ' -f1)"
echo "OBS_DONE=1" >> "$OBS"
