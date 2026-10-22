# ZEVANORY | P01 Fase A: resolução portátil de ferramentas para os passos bash do CI (Linux e Windows/Git Bash).
# Uso: . scripts/fase_a/tools.sh  ->  define PY (python3 -> python -> py -3) e PSQL; falha com TOOL_MISSING.
PY=""
for c in python3 python "py -3"; do
  if $c --version 2>&1 | grep -q "^Python 3\."; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then echo "::error title=TOOL_MISSING::python (tentados: python3, python, py -3)"; echo "TOOL_MISSING: python"; exit 1; fi
PSQL=""
for c in psql "${PGBIN:-/nonexistent}/psql"; do
  if "$c" --version >/dev/null 2>&1; then PSQL="$c"; break; fi
done
export PY PSQL PYTHONDONTWRITEBYTECODE=1 PYTHONIOENCODING=utf-8 PYTHONUTF8=1
need_psql() { if [ -z "$PSQL" ]; then echo "::error title=TOOL_MISSING::psql (tentados: PATH, \$PGBIN)"; echo "TOOL_MISSING: psql"; exit 1; fi; }
