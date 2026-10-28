#!/usr/bin/env python3
"""ZEVANORY | Guarda das âncoras de confiança da revisão jurídica (M-A, reauditoria do PR #946, rodadas 3 a 5).

Roda no check protegido .github/workflows/legal-trust-anchors-protected.yml (pull_request_target): este código vem
da BASE; o PR é só dado (um repositório git separado, nunca executado). É o ÚNICO lugar onde esta guarda é imposta
(o check precisa estar entre os obrigatórios do gh-pages; ver docs/legal/legal-review-procedure.md).

Reprova (TRUST_ANCHORS=CHANGED) todo PR que altere uma âncora:
  * data/p23/legal-reviewers.json, data/p23/legal-published-baseline.json, docs/legal/reviews/**,
    data/politica-unica.json, scripts/p23/**;
  * QUALQUER arquivo em .github/workflows/ ou .github/actions/ (rodada 5: conservador; a detecção de "workflow que
    publica" só gera aviso informativo);
  * o que serve as rotas jurídicas em tempo de execução: sales-worker.mjs, worker/sales-public-worker.mjs,
    worker/politica-unica.mjs, wrangler.sales.toml e scripts/ci/materialize_sales_configs.py.

Reprova (TRUST_ANCHORS=GATE_INVALID) quando a ESTRUTURA dos dois workflows de deploy no head não garante o portão
(sempre validada, com ou sem mudança). Rodada 6 (H-1): build sem segredo e deploy sem código de build do repositório.
  * só os jobs listados em SPECS recebem segredo (vendas: deploy; central: guard e deploy); nenhum segredo no env do
    workflow nem no env de job (só no passo que precisa); os jobs de build têm permissions: contents: read e nada mais;
  * todo `uses:` é fixado por SHA; no job deploy só checkout (path: base, ref: github.sha, persist-credentials: false)
    e download-artifact;
  * os jobs com segredo (e o worker-bundle do vendas) só executam arquivos do repositório que são âncora e nunca
    executam código de worker/; no job deploy não há npx, npm só instala wrangler/playwright fixados em $RUNNER_TEMP,
    wrangler só pelo binário fixado, todo deploy usa --no-bundle (sem rebuild) e não há --dry-run/--outdir nem
    scripts de build;
  * o manifesto do artefato é conferido antes do portão; o portão (gate_body: código do gh-pages pelo checkout
    confiável, /usr/bin/python3 -I, sobre o artefato baixado) roda antes de qualquer passo com segredo e logo antes de
    cada passo que publica, sem if, continue-on-error, shell ou env;
  * passo que publica não usa always()/failure()/cancelled(); o job deploy também não; nenhum outro job publica;
  * sem defaults; sem BASH_ENV/ENV/PATH/LD_*/PYTHON*/NODE_OPTIONS/GIT_* no env; YAML válido (com PyYAML).

Se o PR mudar a linha de base, também informa se o novo valor é o texto pré-Release 2 ou o reviewed_sha256 de um
registro de aprovação válido JÁ na base.

Uso: trust_anchor_guard.py --pr-repo <git dir do PR> --base-sha <sha> --head-sha <sha> [--base-repo <checkout da base>]
     trust_anchor_guard.py --validate-workflows --root <checkout>    (só a validação estrutural, na árvore; testes)
Saída: TRUST_ANCHORS=UNCHANGED (rc 0) | CHANGED ou GATE_INVALID (rc 1, com a lista e o motivo).
"""
from __future__ import annotations

import argparse, fnmatch, json, re, subprocess, sys
from pathlib import Path

DEPLOY_WORKFLOWS = (".github/workflows/zevanory-sales-public-release.yml", ".github/workflows/central-production-deploy.yml")
# Rodada 5: âncoras conservadoras. Qualquer mudança em .github/workflows/ ou .github/actions/ é CHANGED (a detecção de
# "workflow que publica" virou só informativa). Também são âncoras os arquivos que SERVEM as rotas jurídicas em tempo
# de execução (o portão confere os bytes do artefato; o código do Worker de vendas e a configuração dele decidem o que
# é servido): o ponto de entrada, o Worker, o módulo que ele importa, a configuração wrangler e o script que a reescreve
# no deploy.
ANCHORS = ("data/p23/legal-reviewers.json", "data/p23/legal-published-baseline.json", "docs/legal/reviews/*",
           "data/politica-unica.json", "scripts/p23/*", ".github/workflows/*", ".github/actions/*",
           "sales-worker.mjs", "worker/sales-public-worker.mjs", "worker/politica-unica.mjs", "wrangler.sales.toml",
           "scripts/ci/materialize_sales_configs.py",
           # Rodada 6: tudo o que os jobs com segredo executam (lido do checkout confiável base/) também é âncora.
           "scripts/deploy/*", "scripts/ci/verify-founder-and-products.sh", "scripts/verify-production-surfaces.py",
           "scripts/verify-live-headers.py", "scripts/financial_proof_renewal.py", "scripts/ci/credential_identity_readback.py")

# Rodada 6: o build roda SEM segredos e o deploy NÃO roda código de build do repositório.
SPECS = {
    ".github/workflows/zevanory-sales-public-release.yml": {
        "secret_jobs": {"deploy"}, "build_jobs": {"worker-bundle", "site-build"}, "anchored_jobs": {"worker-bundle"},
        "artifact_copy": "rm -rf base/sales-public && cp -a art/site/sales-public base/sales-public"},
    ".github/workflows/central-production-deploy.yml": {
        "secret_jobs": {"guard", "deploy"}, "build_jobs": {"build"}, "anchored_jobs": set(), "artifact_copy": None},
}
DEPLOY_WORKFLOWS = tuple(SPECS)


def gate_body(artifact_copy):
    """Passo do portão no job deploy: código do portão lido do gh-pages (ref do checkout confiável base/, feito neste
    job, sem credenciais guardadas e sem nenhum código do repositório antes), executado com /usr/bin/python3 -I sobre
    o artefato baixado (no vendas, sales-public/ do artefato substitui o da árvore antes da impressão digital)."""
    body = ["set -euo pipefail",
            'test "$(/usr/bin/git -C base rev-parse HEAD)" = "$GITHUB_SHA"',
            '/usr/bin/git -C base show refs/remotes/origin/gh-pages:scripts/p23/legal_review.py > "$RUNNER_TEMP/legal_gate.py"']
    if artifact_copy:
        body.append(artifact_copy)
    body.append('/usr/bin/python3 -I "$RUNNER_TEMP/legal_gate.py" --root base --publish-gate --anchors-ref refs/remotes/origin/gh-pages')
    return body


PINNED_USES = re.compile(r"^(actions/checkout|actions/download-artifact|actions/upload-artifact|actions/setup-node|actions/setup-python)@[0-9a-f]{40}$")
DEPLOY_JOB_USES = re.compile(r"^(actions/checkout|actions/download-artifact)@[0-9a-f]{40}$")
NPM_ALLOWED = re.compile(r'^npm install --no-save --no-audit --no-fund --prefix "\$RUNNER_TEMP/pw" playwright@1\.55\.0(\s|$)')
REPO_SCRIPT = re.compile(r"(?<![\w.-])((?:scripts|tests)/[\w./-]+\.(?:py|mjs|js|cjs|sh))\b")
STATUS_FN = re.compile(r"\b(always|failure|cancelled)\s*\(")
FORBIDDEN_ENV = re.compile(r"^(BASH_ENV|ENV|PATH|LD_\w+|PYTHON\w*|NODE_OPTIONS|NODE_PATH|GIT_\w+|SHELLOPTS|BASHOPTS|PS4)$")
DEPLOY_ACTION = re.compile(r"cloudflare/wrangler-action|cloudflare/pages-action|actions/deploy-pages")
CF_API_WRITE = re.compile(r"api\.cloudflare\.com", re.I)


def is_anchor(path: str) -> bool:
    return any(fnmatch.fnmatchcase(path, pat) if "*" in pat else path == pat for pat in ANCHORS)


WRANGLER_PUBLISH = re.compile(r"\bwrangler(?:@\S+)?\s+(?:--?\S+\s+)*(?:deploy|publish|versions\s+(?:upload|deploy)|pages\s+(?:deploy|publish))\b", re.I)
VAR_WRANGLER = re.compile(r"(\w+)=\S*wrangler\S*")
CF_CODE_WRITE = re.compile(r"(-X|--request)\s*(PUT|PATCH)\b|\s(-F|--form)\s|/versions\b|/content\b", re.I)


def deploys(text: str, prod_env: bool = False) -> bool:
    """Texto (passo ou workflow) que publica código ou conteúdo novo. Conservador: aspas removidas e linhas de
    continuação juntadas; conta wrangler como comando de publicação (deploy, publish, versions upload/deploy, pages
    deploy), também via variável (W=wrangler; npx $W deploy), sem --dry-run; envio de código pela API da Cloudflare
    (PUT/PATCH, multipart, /versions, /content); e as actions de deploy. Rollback para a implantação anterior e exclusão
    do candidato não publicam nada novo. Nos workflows de deploy decide onde o portão é exigido; fora deles é só
    informativo (todo workflow já é âncora)."""
    t = re.sub(r"[\"']", "", re.sub(r"\\\n", " ", text))
    t = re.sub(r"\bwrangler[\w.-]*\.(?:toml|jsonc?|json)\b", "CFG", t)
    for l in (x for x in t.splitlines() if not x.lstrip().startswith("#")):
        if "--dry-run" in l:
            continue
        if DEPLOY_ACTION.search(l) or WRANGLER_PUBLISH.search(l):
            return True
        for var in VAR_WRANGLER.findall(l):
            if re.search(r"\$\{?" + re.escape(var) + r"\}?\s+(?:\S+\s+)*?(deploy|publish|versions\s+upload)\b", l):
                return True
        if CF_API_WRITE.search(l) and CF_CODE_WRITE.search(l):
            return True
        if prod_env and re.search(r"producao-critica", l):
            return True
    return False


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


def _job_permissions(lines, ks, ke):
    out = {}
    for k, v, s2, e2 in _children(lines, ks + 1, ke, 6):
        out[k] = v
    return out


def _with(st) -> dict:
    text = (st["keys"].get("with") or {}).get("text", "")
    return {m.group(1): m.group(2).strip() for m in re.finditer(r"^ {10}([\w-]+):\s*(.*)$", text, re.M)}


def validate_deploy_workflow(name: str, text: str, spec: dict | None = None) -> list[str]:
    spec = spec or SPECS[name]
    lines = text.splitlines()
    errs: list[str] = []
    try:  # YAML inválido não roda; com PyYAML disponível, isso também reprova aqui.
        import yaml  # type: ignore
    except ImportError:
        yaml = None
    if yaml is not None:
        try:
            yaml.safe_load(text)
        except yaml.YAMLError as e:
            errs.append(f"{name}: YAML inválido ({type(e).__name__})")
    top = _children(lines, 0, len(lines), 0)
    for k, v, s0, e0 in top:
        if k == "defaults":
            errs.append(f"{name}: 'defaults' no workflow pode trocar o shell")
        if k == "env":
            errs += [f"{name}: env do workflow define {ek}" for ek, *_ in _children(lines, s0 + 1, e0, 2) if FORBIDDEN_ENV.match(ek)]
            if "secrets." in "\n".join(lines[s0:e0]):
                errs.append(f"{name}: segredo no env do workflow (chega a todos os jobs)")
    jobs = next(((s0, e0) for k, v, s0, e0 in top if k == "jobs"), None)
    if not jobs:
        return errs + [f"{name}: sem 'jobs'"]
    job_list = {k: (s0, e0) for k, v, s0, e0 in _children(lines, jobs[0] + 1, jobs[1], 2)}
    for need in ("deploy", *spec["build_jobs"]):
        if need not in job_list:
            errs.append(f"{name}: falta o job '{need}'")
    if errs and "deploy" not in job_list:
        return errs
    for jk, (s0, e0) in job_list.items():
        jtext = "\n".join(lines[s0:e0])
        jkeys = {k: (v, ks, ke) for k, v, ks, ke in _children(lines, s0 + 1, e0, 4)}
        if "secrets." in jtext and jk not in spec["secret_jobs"]:
            errs.append(f"{name}: o job '{jk}' recebe segredo; só {sorted(spec['secret_jobs'])} podem")
        if "environment" in jkeys and jk not in spec["secret_jobs"]:
            errs.append(f"{name}: o job '{jk}' usa o Environment de produção")
        for bad in ("defaults",):
            if bad in jkeys:
                errs.append(f"{name}: job '{jk}' com '{bad}'")
        if "env" in jkeys:
            _, ks, ke = jkeys["env"]
            errs += [f"{name}: env do job '{jk}' define {ek}" for ek, *_ in _children(lines, ks + 1, ke, 6) if FORBIDDEN_ENV.match(ek)]
            if "secrets." in "\n".join(lines[ks:ke]):
                errs.append(f"{name}: segredo no env do job '{jk}' (só no passo que precisa)")
        steps = _steps(lines, jkeys["steps"][1] + 1, jkeys["steps"][2]) if "steps" in jkeys else []
        for st in steps:
            uses = (st["keys"].get("uses") or {}).get("value", "")
            if uses and not PINNED_USES.match(uses):
                errs.append(f"{name}: job '{jk}' usa action sem SHA fixado: {uses}")
        if jk != "deploy" and deploys(jtext):
            errs.append(f"{name}: o job '{jk}' publica fora do job 'deploy'")
        if jk in spec["build_jobs"]:
            perms = _job_permissions(lines, *jkeys["permissions"][1:]) if "permissions" in jkeys else None
            if perms != {"contents": "read"}:
                errs.append(f"{name}: o job de build '{jk}' precisa de permissions: contents: read (e nada mais)")
        if jk in spec["anchored_jobs"] or jk in spec["secret_jobs"]:
            for path in sorted(set(REPO_SCRIPT.findall(jtext))):
                if not is_anchor(path):
                    errs.append(f"{name}: o job '{jk}' executa {path}, que não é âncora")
            if re.search(r"\b(node|python3?|bash|sh)\b[^\n]*(?<![\w-])worker/", jtext):
                errs.append(f"{name}: o job '{jk}' executa código de worker/")
    if "deploy" not in job_list:
        return errs
    s0, e0 = job_list["deploy"]
    jkeys = {k: (v, ks, ke) for k, v, ks, ke in _children(lines, s0 + 1, e0, 4)}
    needs = jkeys.get("needs", ("", 0, 0))[0]
    for b in spec["build_jobs"]:
        if not re.search(r"(^|[\s\[,])" + re.escape(b) + r"([\s\],]|$)", needs):
            errs.append(f"{name}: o job deploy precisa de needs: {b}")
    if "if" in jkeys and STATUS_FN.search(jkeys["if"][0]):
        errs.append(f"{name}: job deploy com always()/failure()/cancelled() no if")
    if "continue-on-error" in jkeys:
        errs.append(f"{name}: job deploy com continue-on-error")
    if "steps" not in jkeys:
        return errs + [f"{name}: job deploy sem steps"]
    steps = _steps(lines, jkeys["steps"][1] + 1, jkeys["steps"][2])
    body = gate_body(spec["artifact_copy"])
    is_gate = lambda st: (st["keys"].get("run") or {}).get("body") == body
    gates = [n for n, st in enumerate(steps) if is_gate(st)]
    if not gates:
        return errs + [f"{name}: o job deploy não tem o passo do portão ({' / '.join(body)})"]
    first_secret = next((n for n, st in enumerate(steps) if "secrets." in st["text"]), len(steps))
    if gates[0] > first_secret:
        errs.append(f"{name}: um passo com segredo roda antes do primeiro portão")
    if not any("sha256sum --strict -c" in st["text"] for st in steps[:gates[0]]):
        errs.append(f"{name}: o manifesto do artefato não é conferido antes do portão")
    for n in gates:
        extra = set(steps[n]["keys"]) - {"name", "run", "id"}
        if extra:
            errs.append(f"{name}: passo do portão (linha {steps[n]['line']}) com {sorted(extra)}; só name, id e run são aceitos")
    for n, st in enumerate(steps):
        uses = (st["keys"].get("uses") or {}).get("value", "")
        if uses:
            if not DEPLOY_JOB_USES.match(uses):
                errs.append(f"{name}: o job deploy só pode usar checkout e download-artifact fixados; achou {uses}")
            if uses.startswith("actions/checkout"):
                w = _with(st)
                if w.get("path") != "base" or w.get("ref") != "${{ github.sha }}" or w.get("persist-credentials") != "false":
                    errs.append(f"{name}: checkout do job deploy tem de ser path: base, ref: ${{{{ github.sha }}}}, persist-credentials: false")
            continue
        run = (st["keys"].get("run") or {}).get("body") or []
        joined = "\n".join(run)
        in_release = False
        for l in run:
            if re.search(r'cd "\$RUNNER_TEMP/release"', l):
                in_release = True
            if re.search(r"(^|[\s;&|(])npx\b", l):
                if not re.search(r"(^|[\s;&|(])npx --yes wrangler@4\.143\.0 ", l) or re.findall(r"npx\b", l).__len__() != 1:
                    errs.append(f"{name}: no job deploy só npx --yes wrangler@4.143.0 (linha {st['line']})")
                elif not (in_release or re.search(r'\(cd "\$RUNNER_TEMP/release" && npx ', l)):
                    errs.append(f"{name}: wrangler no job deploy só a partir do diretório limpo $RUNNER_TEMP/release (linha {st['line']})")
            if re.search(r"(^|[\s;&|(])npm\b", l) and not NPM_ALLOWED.match(l.strip()):
                errs.append(f"{name}: npm no job deploy só para instalar playwright fixado fora do repositório (linha {st['line']})")
            if re.search(r"\bwrangler\b", re.sub(r"npx --yes wrangler@4\.143\.0|wrangler\.[\w.-]+\.(?:toml|jsonc?)", "", l)):
                errs.append(f"{name}: wrangler fora de npx --yes wrangler@4.143.0 (linha {st['line']})")
            if re.search(r"npx --yes wrangler@4\.143\.0", l):
                if re.search(r"\bdeploy\b", l) and "--no-bundle" not in l:
                    errs.append(f"{name}: deploy sem --no-bundle no job deploy (rebuild) (linha {st['line']})")
                if "--dry-run" in l or "--outdir" in l:
                    errs.append(f"{name}: empacotamento (--dry-run/--outdir) no job deploy (linha {st['line']})")
            if re.search(r"\b(build_sales_public|materialize|prepare-central-candidate|write-build-info|copy-brand-export)\b", l):
                errs.append(f"{name}: código de build no job deploy (linha {st['line']})")
        if not deploys(st["text"]):
            continue
        if STATUS_FN.search((st["keys"].get("if") or {}).get("value", "")):
            errs.append(f"{name}: passo que publica (linha {st['line']}) usa always()/failure()/cancelled() no if")
        if n == 0 or not is_gate(steps[n - 1]):
            errs.append(f"{name}: passo que publica (linha {st['line']}) não vem logo depois do passo do portão")
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
    new_deploy = [p for p in paths if p.startswith(".github/") and deploys(show(a.pr_repo, a.head_sha, p) or "", prod_env=True)]
    invalid = validate_tree(lambda p: show(a.pr_repo, a.head_sha, p))
    for p in hit:
        print(f"::error title=TRUST_ANCHOR_CHANGED::{p}: âncora de confiança da revisão jurídica; só entra com decisão explícita e deliberada do proprietário")
    for p in new_deploy:
        print(f"::notice title=TRUST_ANCHOR_DEPLOY_WORKFLOW::{p}: além de âncora, parece publicar (informativo)")
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
    if hit:
        print(f"TRUST_ANCHORS=CHANGED anchors={len(hit)} gate_problems={len(invalid)} files={len(paths)}")
        return 1
    if invalid:
        print(f"TRUST_ANCHORS=GATE_INVALID problems={len(invalid)} files={len(paths)}")
        return 1
    print(f"TRUST_ANCHORS=UNCHANGED files={len(paths)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
