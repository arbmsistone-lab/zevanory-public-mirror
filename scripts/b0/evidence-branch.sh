#!/usr/bin/env bash
# ZEVANORY | B0/P18: prepara e publica o ramo de evidência (append-only). Recusa qualquer ramo fora de evidence/*;
# nunca toca gh-pages. Uso:
#   EVIDENCE_BRANCH=evidence/b0-baseline EVIDENCE_DIR=... GH_TOKEN=... bash scripts/b0/evidence-branch.sh prepare
#   EVIDENCE_BRANCH=evidence/b0-baseline EVIDENCE_DIR=... GH_TOKEN=... bash scripts/b0/evidence-branch.sh publish "<mensagem>"
set -euo pipefail
: "${EVIDENCE_BRANCH:?}" "${EVIDENCE_DIR:?}" "${GH_TOKEN:?}" "${GITHUB_REPOSITORY:?}"
case "$EVIDENCE_BRANCH" in
  evidence/b0-baseline) ;;
  *) echo "::error title=EVIDENCE_BRANCH::ramo recusado: $EVIDENCE_BRANCH"; exit 1 ;;
esac
REMOTE="https://github.com/${GITHUB_REPOSITORY}.git"
AUTH="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)"
g() { git -c "http.https://github.com/.extraheader=$AUTH" "$@"; }

case "${1:-}" in
  prepare)
    rc=0; g ls-remote --exit-code --heads "$REMOTE" "$EVIDENCE_BRANCH" >/dev/null || rc=$?
    if [ "$rc" -eq 0 ]; then
      g clone --quiet --depth 50 --branch "$EVIDENCE_BRANCH" "$REMOTE" "$EVIDENCE_DIR"
    elif [ "$rc" -eq 2 ]; then
      # Primeira execução: ramo órfão, sem nada de gh-pages.
      git init -q "$EVIDENCE_DIR"
      git -C "$EVIDENCE_DIR" checkout -q --orphan "$EVIDENCE_BRANCH"
      git -C "$EVIDENCE_DIR" remote add origin "$REMOTE"
    else
      echo "::error title=EVIDENCE_BRANCH::ls-remote falhou (rc=$rc)"; exit 1
    fi
    echo "EVIDENCE_BRANCH_READY=$EVIDENCE_BRANCH"
    ;;
  publish)
    msg="${2:?mensagem}"
    cd "$EVIDENCE_DIR"
    git config user.name "github-actions[bot]"
    git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
    git add -A
    if git diff --cached --quiet; then echo "EVIDENCE_NOTHING_TO_COMMIT"; exit 0; fi
    git commit -qm "$msg"
    for i in 1 2 3 4 5; do
      if g push -q origin "HEAD:refs/heads/$EVIDENCE_BRANCH"; then echo "EVIDENCE_PUSHED=$(git rev-parse HEAD)"; exit 0; fi
      sleep $((i * 3))
      # Coletor grava só b0/, monitor só p18/ e ensaio P20 só p20/: o rebase não conflita; conflito real derruba (sem forçar push).
      g fetch -q origin "$EVIDENCE_BRANCH" && git rebase -q "origin/$EVIDENCE_BRANCH" || { git rebase --abort 2>/dev/null || true; echo "::error title=EVIDENCE_BRANCH::rebase falhou"; exit 1; }
    done
    echo "::error title=EVIDENCE_BRANCH::push falhou após 5 tentativas"; exit 1
    ;;
  *) echo "uso: prepare | publish <mensagem>"; exit 2 ;;
esac
