#!/usr/bin/env bash
# Contestação Sol 028.6: execução ÚNICA global, não só "primeira tentativa do run".
# Recusa se existir QUALQUER outro run deste workflow (em andamento ou concluído), além do atual.
# Nova execução exige PR que aumente ALLOWED_PRIOR_RUNS, e o merge dessa PR exige a frase literal
# do proprietário. Assim, a autorização é consumida por execução.
set -Eeuo pipefail
readonly ALLOWED_PRIOR_RUNS=0
readonly CURL_BIN="${CURL_BIN:-curl}"
readonly PYTHON_BIN="${PYTHON_BIN:-python3}"
: "${GITHUB_TOKEN:?SINGLE_RUN_GUARD_TOKEN_MISSING}"
: "${GITHUB_REPOSITORY:?SINGLE_RUN_GUARD_REPO_MISSING}"
: "${GITHUB_RUN_ID:?SINGLE_RUN_GUARD_RUN_ID_MISSING}"
out="$(mktemp)"
trap 'rm -f "$out"' EXIT
code="$("$CURL_BIN" --silent --show-error --output "$out" --write-out '%{http_code}' \
  --connect-timeout 10 --max-time 30 \
  --header "Authorization: Bearer ${GITHUB_TOKEN}" --header "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/workflows/b01-rollback-secret-probe.yml/runs?per_page=100")"
[[ "$code" == "200" ]] || { echo "SINGLE_RUN_GUARD_HTTP_${code}" >&2; exit 1; }
prior="$("$PYTHON_BIN" - "$out" "$GITHUB_RUN_ID" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
runs = data.get("workflow_runs")
if not isinstance(runs, list) or not isinstance(data.get("total_count"), int):
    raise SystemExit("SINGLE_RUN_GUARD_BAD_RESPONSE")
if data["total_count"] > len(runs):
    raise SystemExit("SINGLE_RUN_GUARD_TRUNCATED")
current = sys.argv[2]
print(sum(1 for r in runs if str(r.get("id")) != current))
PY
)"
if (( prior > ALLOWED_PRIOR_RUNS )); then
  echo "SINGLE_RUN_GUARD_REFUSED prior_runs=${prior} allowed=${ALLOWED_PRIOR_RUNS}" >&2
  exit 1
fi
echo "SINGLE_RUN_GUARD=PASS prior_runs=${prior}"
