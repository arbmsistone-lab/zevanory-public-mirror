#!/usr/bin/env python3
"""ZEVANORY | Guarda das âncoras de confiança da revisão jurídica (M-A, reauditoria do PR #946, rodada 3).

Roda no check protegido .github/workflows/legal-trust-anchors-protected.yml (pull_request_target): este código vem
da BASE; o PR é só dado (um repositório git separado, nunca executado). Reprova todo PR que altere uma âncora:

  data/p23/legal-reviewers.json, data/p23/legal-published-baseline.json, docs/legal/reviews/**,
  data/politica-unica.json, scripts/p23/**, .github/workflows/legal-trust-anchors-protected.yml

Um PR assim só entra com decisão explícita e deliberada do proprietário (bypass da proteção), registrada no PR.
O proprietário é a única conta, então revisão obrigatória/CODEOWNERS não funcionam (ele não aprova o próprio PR).

Além disso, se o PR mudar a linha de base, informa se o novo valor é o texto pré-Release 2 ou o reviewed_sha256 de
um registro de aprovação válido JÁ na base (a mesma regra que o portão de publicação aplica no deploy). A linha de
base nunca é aceita por ter sido escrita no próprio PR.

Uso: trust_anchor_guard.py --pr-repo <git dir do PR> --base-sha <sha> --head-sha <sha> [--base-repo <checkout da base>]
Também reprova (TRUST_ANCHORS=GATE_REMOVED) o PR que tire dos dois workflows de publicação o passo do portão ancorado.
Saída: TRUST_ANCHORS=UNCHANGED (rc 0) | TRUST_ANCHORS=CHANGED ou GATE_REMOVED (rc 1, com a lista e o motivo).
"""
from __future__ import annotations

import argparse, fnmatch, json, re, subprocess, sys
from pathlib import Path

ANCHORS = ("data/p23/legal-reviewers.json", "data/p23/legal-published-baseline.json", "docs/legal/reviews/*",
           "data/politica-unica.json", "scripts/p23/*", ".github/workflows/legal-trust-anchors-protected.yml")


# Workflows que publicam /termos e /reembolso: podem mudar em PR comum, mas o passo do portão ancorado tem de continuar
# lá, literal (um PR que o remove ou troca por outro comando reprova aqui, antes do merge).
DEPLOY_WORKFLOWS = (".github/workflows/zevanory-sales-public-release.yml", ".github/workflows/central-production-deploy.yml")
GATE_LINE = "python3 -I scripts/p23/legal_review.py --root . --publish-gate --anchors-ref refs/remotes/origin/gh-pages"
GATE_FETCH = "git fetch --no-tags --quiet origin +refs/heads/gh-pages:refs/remotes/origin/gh-pages"


def gate_removed(repo, head: str, paths: list[str]) -> list[str]:
    out = []
    for wf in DEPLOY_WORKFLOWS:
        if wf not in paths:
            continue
        r = subprocess.run(["git", "-C", str(repo), "show", f"{head}:{wf}"], capture_output=True, text=True, encoding="utf-8")
        body = r.stdout if r.returncode == 0 else ""
        live = [l for l in body.splitlines() if not l.lstrip().startswith("#")]
        if not any(GATE_LINE in l for l in live) or not any(GATE_FETCH in l for l in live):
            out.append(wf)
    return out


def is_anchor(path: str) -> bool:
    return any(fnmatch.fnmatchcase(path, pat) if "*" in pat else path == pat for pat in ANCHORS)


def git(repo, *args) -> str:
    r = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        raise SystemExit(f"TRUST_ANCHORS=ERROR git {' '.join(args)}: {r.stderr.strip()[:300]}")
    return r.stdout


def changed_paths(repo, base: str, head: str) -> list[str]:
    for sha in (base, head):
        if not re.fullmatch(r"[0-9a-f]{40}", sha):
            raise SystemExit(f"TRUST_ANCHORS=ERROR sha inválido {sha!r}")
    mb = git(repo, "merge-base", base, head).strip()
    out = git(repo, "diff", "--name-only", "--no-renames", mb, head)
    return sorted(p for p in out.splitlines() if p)


def main(argv=None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--pr-repo", required=True)
    ap.add_argument("--base-sha", required=True)
    ap.add_argument("--head-sha", required=True)
    ap.add_argument("--base-repo", default=None, help="checkout da base (para conferir a linha de base proposta)")
    a = ap.parse_args(argv)
    paths = changed_paths(a.pr_repo, a.base_sha, a.head_sha)
    hit = [p for p in paths if is_anchor(p)]
    removed = gate_removed(a.pr_repo, a.head_sha, paths)
    for wf in removed:
        print(f"::error title=LEGAL_GATE_REMOVED::{wf}: o passo do portão jurídico ancorado no gh-pages sumiu ou mudou ({GATE_LINE})")
    if not hit and not removed:
        print(f"TRUST_ANCHORS=UNCHANGED files={len(paths)}")
        return 0
    if not hit:
        print(f"TRUST_ANCHORS=GATE_REMOVED workflows={len(removed)} files={len(paths)}")
        return 1
    for p in hit:
        print(f"::error title=TRUST_ANCHOR_CHANGED::{p}: âncora de confiança da revisão jurídica; só entra com decisão explícita e deliberada do proprietário (bypass)")
    if "data/p23/legal-published-baseline.json" in hit and a.base_repo:
        sys.path.insert(0, str(Path(a.base_repo, "scripts", "p23")))
        try:
            import legal_review as lr  # código da BASE
            raw = git(a.pr_repo, "show", f"{a.head_sha}:data/p23/legal-published-baseline.json")
            proposed = str((json.loads(raw) or {}).get("fingerprint", ""))
            anchors = lr.GitRef(a.base_repo, a.base_sha)
            ok = proposed == lr.GENESIS_BASELINE or proposed in lr.approved_hashes(anchors, anchors)
            print(f"::{'notice' if ok else 'error'} title=TRUST_ANCHOR_BASELINE::linha de base proposta {proposed[:12]}… "
                  + ("é o texto pré-Release 2 ou de um registro de aprovação válido na base" if ok else "NÃO corresponde a nenhum registro de aprovação válido na base"))
        except (ImportError, ValueError, AttributeError, SystemExit) as e:
            print(f"::error title=TRUST_ANCHOR_BASELINE::não foi possível conferir a linha de base proposta: {e}")
    print(f"TRUST_ANCHORS=CHANGED anchors={len(hit)} files={len(paths)}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
