#!/usr/bin/env python3
"""ZEVANORY | Guarda das âncoras de confiança da revisão jurídica (M-A, reauditoria do PR #946, rodadas 3 e 4).

Roda no check protegido .github/workflows/legal-trust-anchors-protected.yml (pull_request_target): este código vem
da BASE; o PR é só dado (um repositório git separado, nunca executado). Reprova (TRUST_ANCHORS=CHANGED) todo PR que:

  * altere uma âncora: data/p23/legal-reviewers.json, data/p23/legal-published-baseline.json, docs/legal/reviews/**,
    data/politica-unica.json, scripts/p23/**, este workflow protegido e os DOIS workflows de deploy que publicam o
    texto jurídico (.github/workflows/zevanory-sales-public-release.yml e central-production-deploy.yml);
  * altere ou crie QUALQUER outro workflow que publique (wrangler deploy/publish sem --dry-run, versions/pages deploy,
    cloudflare/wrangler-action, cloudflare/pages-action, actions/deploy-pages, Environment producao-critica).

E reprova (TRUST_ANCHORS=GATE_INVALID) quando a ESTRUTURA dos dois workflows de deploy no head não garante o portão
(validação feita sempre, com ou sem mudança; ver validate_deploy_workflow):

  * o passo do portão existe no job deploy, é o PRIMEIRO passo que executa comando (antes dele só actions/checkout,
    actions/setup-python e actions/setup-node), roda exatamente as três linhas esperadas e não tem if,
    continue-on-error, shell, env nem working-directory;
  * cada passo que publica é precedido imediatamente do passo de integridade (o texto jurídico na árvore é o que o
    portão conferiu: git diff --exit-code HEAD nos arquivos da impressão digital), sem if nem continue-on-error;
  * passo que publica não usa always()/failure()/cancelled() no if; o job deploy também não;
  * nenhum outro job desses workflows publica;
  * sem defaults (shell trocado) no workflow nem no job, e sem BASH_ENV/ENV/PATH/LD_*/PYTHON*/NODE_OPTIONS/GIT_* no
    env do workflow ou do job.

Um PR que mexa nas âncoras só entra com decisão explícita e deliberada do proprietário, registrada no PR (o check
precisa estar entre os obrigatórios do gh-pages para bloquear; ver docs/legal/legal-review-procedure.md).

Se o PR mudar a linha de base, também informa se o novo valor é o texto pré-Release 2 ou o reviewed_sha256 de um
registro de aprovação válido JÁ na base.

Uso: trust_anchor_guard.py --pr-repo <git dir do PR> --base-sha <sha> --head-sha <sha> [--base-repo <checkout da base>]
     trust_anchor_guard.py --validate-workflows --root <checkout>    (só a validação estrutural, na árvore)
Saída: TRUST_ANCHORS=UNCHANGED (rc 0) | CHANGED ou GATE_INVALID (rc 1, com a lista e o motivo).
"""
from __future__ import annotations

import argparse, fnmatch, json, re, subprocess, sys
from pathlib import Path

DEPLOY_WORKFLOWS = (".github/workflows/zevanory-sales-public-release.yml", ".github/workflows/central-production-deploy.yml")
ANCHORS = ("data/p23/legal-reviewers.json", "data/p23/legal-published-baseline.json", "docs/legal/reviews/*",
           "data/politica-unica.json", "scripts/p23/*", ".github/workflows/legal-trust-anchors-protected.yml",
           *DEPLOY_WORKFLOWS)

GATE_FETCH = "git fetch --no-tags --quiet origin +refs/heads/gh-pages:refs/remotes/origin/gh-pages"
GATE_LINE = "python3 -I scripts/p23/legal_review.py --root . --publish-gate --anchors-ref refs/remotes/origin/gh-pages"
GATE_BODY = ("set -euo pipefail", GATE_FETCH, GATE_LINE)
# Arquivos da impressão digital (scripts/p23/legal_review.py LEGAL_PAGES + a política); o teste confere a igualdade.
LEGAL_FILES = ("sales-public/termos.html", "sales-public/reembolso.html", "termos/index.html", "reembolso/index.html",
               "sales-public/privacidade.html", "sales-public/afiliados.html", "privacidade/index.html",
               "afiliados/index.html", "data/politica-unica.json")
INTEGRITY_LINE = "git diff --exit-code HEAD -- " + " ".join(LEGAL_FILES)
INTEGRITY_BODY = ("set -euo pipefail", INTEGRITY_LINE)
SETUP_USES = re.compile(r"^actions/(checkout|setup-python|setup-node)@[\w.-]+$")
STATUS_FN = re.compile(r"\b(always|failure|cancelled)\s*\(")
FORBIDDEN_ENV = re.compile(r"^(BASH_ENV|ENV|PATH|LD_\w+|PYTHON\w*|NODE_OPTIONS|NODE_PATH|GIT_\w+|SHELLOPTS|BASHOPTS|PS4)$")
DEPLOY_LINE = re.compile(r"wrangler(?:@[\w.^~-]+)?\s+(?:versions\s+|pages\s+)?(?:deploy|publish)\b"
                         r"|cloudflare/wrangler-action|cloudflare/pages-action|actions/deploy-pages")
# Workflow novo/alterado que usa o Environment de produção também conta como "publica" (detecção conservadora).
PROD_ENV = re.compile(r"^\s*environment:\s*['\"]?producao-critica")


def is_anchor(path: str) -> bool:
    return any(fnmatch.fnmatchcase(path, pat) if "*" in pat else path == pat for pat in ANCHORS)


def deploys(text: str, prod_env: bool = False) -> bool:
    """Linha que publica de verdade (dry-run não conta); com prod_env, usar o Environment de produção também conta."""
    return any((DEPLOY_LINE.search(l) and "--dry-run" not in l) or (prod_env and PROD_ENV.search(l))
               for l in text.splitlines() if not l.lstrip().startswith("#"))


# ---------- leitura estrutural mínima do YAML dos workflows (sem dependência externa; indentação do repositório) ----------
def _key(line: str, indent: int):
    m = re.match(r"^" + " " * indent + r"([A-Za-z0-9_-]+):(.*)$", line)
    return (m.group(1), m.group(2).split(" #")[0].strip()) if m else None


def _children(lines: list[str], start: int, end: int, indent: int) -> list[tuple[str, str, int, int]]:
    """Chaves em exatamente `indent` espaços entre start e end: (chave, valor, início, fim)."""
    out = []
    for i in range(start, end):
        k = _key(lines[i], indent)
        if k:
            if out:
                out[-1] = (*out[-1][:3], i)
            out.append((k[0], k[1], i, end))
    return out


def _steps(lines: list[str], start: int, end: int) -> list[dict]:
    idx = [i for i in range(start, end) if re.match(r"^      - ", lines[i])]
    steps = []
    for n, i in enumerate(idx):
        j = idx[n + 1] if n + 1 < len(idx) else end
        block = ["        " + lines[i][8:]] + lines[i + 1:j]
        keys = {}
        for k, v, s, e in _children(block, 0, len(block), 8):
            if k == "run" and v in ("|", "|-", ">", ">-"):
                body = [l.strip() for l in block[s + 1:e] if l.strip() and not l.strip().startswith("#")]
            elif k == "run":
                body = [v]
            else:
                body = None
            keys[k] = {"value": v, "body": body, "text": "\n".join(block[s:e])}
        steps.append({"line": i + 1, "keys": keys, "text": "\n".join(lines[i:j])})
    return steps


def validate_deploy_workflow(name: str, text: str) -> list[str]:
    lines = text.splitlines()
    errs: list[str] = []
    try:  # YAML inválido não roda (o deploy nem dispara); com PyYAML disponível, isso também reprova aqui.
        import yaml  # type: ignore
    except ImportError:
        yaml = None
    if yaml is not None:
        try:
            yaml.safe_load(text)
        except yaml.YAMLError as e:
            errs.append(f"{name}: YAML inválido ({type(e).__name__})")
    top = _children(lines, 0, len(lines), 0)
    for k, v, s, e in top:
        if k == "defaults":
            errs.append(f"{name}: 'defaults' no workflow pode trocar o shell do portão")
        if k == "env":
            errs += [f"{name}: env do workflow define {ek}" for ek, *_ in _children(lines, s + 1, e, 2) if FORBIDDEN_ENV.match(ek)]
    jobs = next(((s, e) for k, v, s, e in top if k == "jobs"), None)
    if not jobs:
        return errs + [f"{name}: sem 'jobs'"]
    job_list = _children(lines, jobs[0] + 1, jobs[1], 2)
    deploy = next((j for j in job_list if j[0] == "deploy"), None)
    if not deploy:
        return errs + [f"{name}: sem o job 'deploy'"]
    for jk, _, js, je in job_list:
        if jk != "deploy" and deploys("\n".join(lines[js:je])):
            errs.append(f"{name}: o job '{jk}' publica fora do job 'deploy' (sem o portão)")
    _, _, s, e = deploy
    jkeys = {k: (v, ks, ke) for k, v, ks, ke in _children(lines, s + 1, e, 4)}
    for bad in ("defaults", "continue-on-error"):
        if bad in jkeys:
            errs.append(f"{name}: job deploy com '{bad}'")
    if "if" in jkeys and STATUS_FN.search(jkeys["if"][0]):
        errs.append(f"{name}: job deploy com always()/failure()/cancelled() no if")
    if "env" in jkeys:
        _, ks, ke = jkeys["env"]
        errs += [f"{name}: env do job deploy define {ek}" for ek, *_ in _children(lines, ks + 1, ke, 6) if FORBIDDEN_ENV.match(ek)]
    if "steps" not in jkeys:
        return errs + [f"{name}: job deploy sem steps"]
    _, ks, ke = jkeys["steps"]
    steps = _steps(lines, ks + 1, ke)
    gates = [n for n, st in enumerate(steps) if (st["keys"].get("run") or {}).get("body") == list(GATE_BODY)]
    if len(gates) != 1:
        return errs + [f"{name}: o job deploy precisa de exatamente um passo do portão com: {' / '.join(GATE_BODY)} (achados {len(gates)})"]
    g = gates[0]
    extra = set(steps[g]["keys"]) - {"name", "run", "id"}
    if extra:
        errs.append(f"{name}: passo do portão (linha {steps[g]['line']}) com {sorted(extra)}; só name, id e run são aceitos")
    for st in steps[:g]:
        uses = (st["keys"].get("uses") or {}).get("value", "")
        if set(st["keys"]) - {"uses", "with", "name", "id"} or not SETUP_USES.match(uses):
            errs.append(f"{name}: passo da linha {st['line']} roda antes do portão; antes dele só actions/checkout, setup-python e setup-node")
    for n, st in enumerate(steps):
        if not deploys(st["text"]):
            continue
        if n < g:
            errs.append(f"{name}: passo da linha {st['line']} publica antes do portão")
        cond = (st["keys"].get("if") or {}).get("value", "")
        if STATUS_FN.search(cond):
            errs.append(f"{name}: passo que publica (linha {st['line']}) usa always()/failure()/cancelled() no if")
        prev = steps[n - 1] if n else None
        ok = prev is not None and (prev["keys"].get("run") or {}).get("body") == list(INTEGRITY_BODY) \
            and not set(prev["keys"]) - {"name", "run", "id"}
        if not ok:
            errs.append(f"{name}: passo que publica (linha {st['line']}) não vem logo depois do passo de integridade ({INTEGRITY_LINE})")
    return errs


def validate_tree(read) -> list[str]:
    errs = []
    for wf in DEPLOY_WORKFLOWS:
        text = read(wf)
        errs += [f"{wf}: ausente"] if text is None else validate_deploy_workflow(wf, text)
    return errs


# ---------- PR ----------
def git(repo, *args) -> str:
    r = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        raise SystemExit(f"TRUST_ANCHORS=ERROR git {' '.join(args)}: {r.stderr.strip()[:300]}")
    return r.stdout


def show(repo, sha, path):
    r = subprocess.run(["git", "-C", str(repo), "show", f"{sha}:{path}"], capture_output=True, text=True, encoding="utf-8")
    return r.stdout if r.returncode == 0 else None


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
    ap.add_argument("--pr-repo")
    ap.add_argument("--base-sha")
    ap.add_argument("--head-sha")
    ap.add_argument("--base-repo", default=None, help="checkout da base (para conferir a linha de base proposta)")
    ap.add_argument("--validate-workflows", action="store_true")
    ap.add_argument("--root", default=".")
    a = ap.parse_args(argv)
    if a.validate_workflows:
        def read(p):
            try:
                return Path(a.root, p).read_text(encoding="utf-8")
            except OSError:
                return None
        errs = validate_tree(read)
        for e in errs:
            print(f"::error title=LEGAL_GATE_INVALID::{e}")
        print(f"LEGAL_GATE_WORKFLOWS={'INVALID' if errs else 'VALID'} problems={len(errs)}")
        return 1 if errs else 0
    if not (a.pr_repo and a.base_sha and a.head_sha):
        ap.error("--pr-repo, --base-sha e --head-sha são obrigatórios (ou use --validate-workflows)")
    paths = changed_paths(a.pr_repo, a.base_sha, a.head_sha)
    hit = [p for p in paths if is_anchor(p)]
    new_deploy = [p for p in paths if p.startswith(".github/workflows/") and p not in hit
                  and deploys(show(a.pr_repo, a.head_sha, p) or "", prod_env=True)]
    invalid = validate_tree(lambda p: show(a.pr_repo, a.head_sha, p))
    for p in hit:
        print(f"::error title=TRUST_ANCHOR_CHANGED::{p}: âncora de confiança da revisão jurídica; só entra com decisão explícita e deliberada do proprietário")
    for p in new_deploy:
        print(f"::error title=TRUST_ANCHOR_DEPLOY_WORKFLOW::{p}: workflow que publica; só entra com decisão explícita e deliberada do proprietário")
    for e in invalid:
        print(f"::error title=LEGAL_GATE_INVALID::{e}")
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
    if hit or new_deploy:
        print(f"TRUST_ANCHORS=CHANGED anchors={len(hit) + len(new_deploy)} gate_problems={len(invalid)} files={len(paths)}")
        return 1
    if invalid:
        print(f"TRUST_ANCHORS=GATE_INVALID problems={len(invalid)} files={len(paths)}")
        return 1
    print(f"TRUST_ANCHORS=UNCHANGED files={len(paths)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
