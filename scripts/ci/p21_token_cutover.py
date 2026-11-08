#!/usr/bin/env python3
"""P21 / R18: interruptor de transição para o token Cloudflare dedicado de cada serviço (ops/token-cutover.json).

Comandos:
  emit  --service S   linhas para $GITHUB_OUTPUT (cutover, token_id, secret, account) lidas do arquivo versionado.
                      Arquivo ilegível, serviço ausente ou valor inválido: ::error e saída 1 (o job dependente não
                      roda; o deploy nunca cai para outro token por erro de leitura).
  check               contrato estático de TODOS os workflows listados: cada um chama o job p21_token, cada expressão
                      que cita o token legado ou o dedicado tem a forma canônica (sem queda silenciosa), cada job com
                      credencial depende de p21_token e começa pelo passo-gate canônico (texto idêntico em todos).
  status              resumo: serviços com cutover false/true (NOT_PROVEN enquanto houver false).

Sem rede, sem segredos: só lê arquivos. Usado por .github/workflows/p21-token-cutover.yml (emit), pelo CI de PR
(check; tests/test_p21_token_cutover.py) e por scripts/ci/t1_verdict.py (condição 4c).
Doc: docs/p21/tokens-por-worker.md.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CUTOVER = "ops/token-cutover.json"
REUSABLE = ".github/workflows/p21-token-cutover.yml"
JOB_ID = "p21_token"
GATE_NAME = "P21 credencial Cloudflare dedicada (interruptor ops/token-cutover.json)"
ENVIRONMENTS = ("producao-critica", "gh-pages-automacao")
SECRET_RE = re.compile(r"^CF_TOKEN_[A-Z0-9_]+$")
TOKEN_ID_RE = re.compile(r"^[0-9a-f]{32}$")
ACCOUNT_RE = re.compile(r"^[0-9a-f]{32}$")
NEEDS = f"needs.{JOB_ID}.outputs"

# Texto canônico do passo-gate (idêntico em todo job com credencial; o check compara byte a byte e os testes o
# executam com curl falso). Nada aqui imprime o valor do token.
GATE_RUN = r"""set -euo pipefail
case "${P21_CUTOVER:-}" in
  false)
    echo "::warning title=TOKEN_LEGADO_EM_USO::serviço $P21_SERVICE com cutover=false em ops/token-cutover.json: este job usa o token legado (CLOUDFLARE_PUBLIC_OWNER_API_TOKEN/CLOUDFLARE_API_TOKEN, alcance da conta). Transição P21: docs/p21/tokens-por-worker.md"
    ;;
  true)
    # Mesmo saneamento do #851: um token salvo com quebra de linha não pode quebrar a chamada.
    CLOUDFLARE_API_TOKEN="$(printf '%s' "${CLOUDFLARE_API_TOKEN:-}" | tr -d '[:space:]')"
    if [ "${P21_SECRET_ESPERADO:-}" != "$P21_SECRET" ]; then
      echo "::error title=TOKEN_CUTOVER_DIVERGENTE::o workflow declara $P21_SECRET mas ops/token-cutover.json registra ${P21_SECRET_ESPERADO:-nada} para $P21_SERVICE"
      exit 1
    fi
    if [ "${P21_DEDICADO_PRESENTE:-}" != "true" ] || [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
      echo "::error title=TOKEN_DEDICADO_AUSENTE::serviço $P21_SERVICE com cutover=true exige o segredo $P21_SECRET no environment deste job; o token legado nunca é usado. Cadastre o segredo ou volte cutover=false por PR (docs/p21/tokens-por-worker.md)."
      exit 1
    fi
    verify="$(curl -sS --max-time 20 -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts/$P21_ACCOUNT/tokens/verify" || true)"
    got="$(printf '%s' "$verify" | python3 -c 'import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
r = d.get("result") if isinstance(d, dict) else None
ok = isinstance(d, dict) and d.get("success") is True and isinstance(r, dict) and r.get("status") == "active"
print(r.get("id", "") if ok else "")' || true)"
    if [ -z "$got" ] || [ "$got" != "${P21_TOKEN_ID:-}" ]; then
      echo "::error title=TOKEN_ID_DIVERGENTE::o segredo $P21_SECRET não é o token ativo ${P21_TOKEN_ID:-sem-id} registrado em ops/token-cutover.json para $P21_SERVICE (verify na conta $P21_ACCOUNT: ${got:-falhou})"
      exit 1
    fi
    echo "::notice title=TOKEN_DEDICADO_EM_USO::serviço $P21_SERVICE usa $P21_SECRET (token $got, conta $P21_ACCOUNT); o legado está vazio neste job"
    ;;
  *)
    echo "::error title=TOKEN_CUTOVER_ILEGIVEL::interruptor de $P21_SERVICE ilegível (${P21_CUTOVER:-vazio}); nenhum token é entregue"
    exit 1
    ;;
esac"""


def gate_env(service: str, secret: str) -> dict:
    return {
        "P21_SERVICE": service,
        "P21_SECRET": secret,
        "P21_SECRET_ESPERADO": "${{ %s.secret }}" % NEEDS,
        "P21_CUTOVER": "${{ %s.cutover }}" % NEEDS,
        "P21_TOKEN_ID": "${{ %s.token_id }}" % NEEDS,
        "P21_ACCOUNT": "${{ %s.account }}" % NEEDS,
        "P21_DEDICADO_PRESENTE": "${{ secrets.%s != '' }}" % secret,
    }


def token_expr(secret: str, legacy: str) -> str:
    """Forma canônica: com true só o dedicado; com false só a expressão legada de antes; senão vazio."""
    return ("${{ %s.cutover == 'true' && secrets.%s || %s.cutover == 'false' && (%s) || '' }}"
            % (NEEDS, secret, NEEDS, legacy))


def legacy_only_expr(name: str) -> str:
    return "${{ %s.cutover == 'false' && secrets.%s || '' }}" % (NEEDS, name)


# ---------------------------------------------------------------------------------------------------------------
# Leitor mínimo de workflow (sem PyYAML): jobs a 2, chaves do job a 4, env do job a 6, passos "      - ", campos
# do passo a 8, env do passo a 10. É o formato de todos os workflows deste repositório.
def _children(lines, k, indent):
    pad = " " * indent
    out = []
    for l in lines[k + 1:]:
        if l.strip() == "" or l.startswith(pad + " ") or l.startswith(pad + "-"):
            out.append(l)
        else:
            break
    return out


def _kv(block, indent):
    out = {}
    for l in block:
        m = re.match(r"^" + " " * indent + r"([A-Za-z0-9_-]+): ?(.*)$", l)
        if m:
            v = m.group(2).strip()
            v = re.sub(r"\s+#.*$", "", v) if not v.startswith(("'", '"', "${{")) else v
            out[m.group(1)] = v
    return out


def _section(block, header, indent):
    pad = " " * indent
    for k, l in enumerate(block):
        if re.match("^" + pad + re.escape(header) + r":\s*(#.*)?$", l):
            return _children(block, k, indent)
    return []


def parse_workflow(text: str) -> dict:
    lines = text.replace("\r\n", "\n").split("\n")
    if "jobs:" not in lines:
        return {}
    i = lines.index("jobs:") + 1
    starts = [k for k in range(i, len(lines)) if re.match(r"^  [A-Za-z0-9_-]+:\s*$", lines[k])]
    jobs = {}
    for n, s in enumerate(starts):
        e = starts[n + 1] if n + 1 < len(starts) else len(lines)
        jobs[lines[s].strip()[:-1]] = _job(lines[s + 1:e], s + 2)
    return jobs


def _needs(block):
    for k, l in enumerate(block):
        m = re.match(r"^    needs:\s*(.*)$", l)
        if not m:
            continue
        v = re.sub(r"\s+#.*$", "", m.group(1)).strip()
        if v.startswith("["):
            return [x.strip().strip("'\"") for x in v.strip("[]").split(",") if x.strip()]
        if v:
            return [v.strip("'\"")]
        return [re.sub(r"^\s*-\s*", "", x).strip() for x in _children(block, k, 4) if x.strip().startswith("-")]
    return []


def _job(block, first_line_no):
    steps_at = next((k for k, l in enumerate(block) if re.match(r"^    steps:\s*$", l)), len(block))
    head = block[:steps_at]
    job = {"keys": _kv(head, 4), "env": _kv(_section(head, "env", 4), 6), "with": _kv(_section(head, "with", 4), 6),
           "needs": _needs(head), "steps": [], "text": "\n".join(block)}
    names = [k for k in range(steps_at, len(block)) if block[k].startswith("      - ")]
    for n, s in enumerate(names):
        e = names[n + 1] if n + 1 < len(names) else len(block)
        sb = ["        " + block[s][8:]] + block[s + 1:e]
        fields = _kv(sb, 8)
        run = []
        r = next((k for k, l in enumerate(sb) if l.startswith("        run: ")), None)
        if r is not None:
            if sb[r].strip() in ("run: |", "run: |-"):
                body = sb[r + 1:]
                while body and body[-1].strip() == "":
                    body.pop()
                run = [l[10:] if l.startswith(" " * 10) else l.strip() for l in body]
            else:
                run = [sb[r].split("run: ", 1)[1]]
        job["steps"].append({"name": fields.get("name", fields.get("uses", "")), "id": fields.get("id"),
                             "if": fields.get("if"), "uses": fields.get("uses"),
                             "env": _kv(_section(sb, "env", 8), 10), "run": "\n".join(run),
                             "block": "\n".join(sb), "line": first_line_no + s})
    return job


# ---------------------------------------------------------------------------------------------------------------
def load(root: Path = ROOT) -> dict:
    return json.loads((root / CUTOVER).read_text(encoding="utf-8"))


def validate_file(cfg) -> list[str]:
    errs = []
    if not isinstance(cfg, dict) or cfg.get("schema") != "p21-token-cutover/v1":
        return ["CUTOVER_SCHEMA: ops/token-cutover.json ausente ou com schema diferente de p21-token-cutover/v1"]
    if not ACCOUNT_RE.fullmatch(str(cfg.get("account", ""))):
        errs.append("CUTOVER_ACCOUNT: conta inválida")
    legacy = cfg.get("legacy_secrets")
    if legacy != ["CLOUDFLARE_PUBLIC_OWNER_API_TOKEN", "CLOUDFLARE_API_TOKEN"]:
        errs.append("CUTOVER_LEGACY: legacy_secrets precisa ser exatamente os dois tokens compartilhados")
    services = cfg.get("services")
    if not isinstance(services, dict) or not services:
        return errs + ["CUTOVER_SERVICES: nenhum serviço"]
    seen_wf, seen_secret = {}, {}
    for name, s in services.items():
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", name):
            errs.append(f"CUTOVER_SERVICE_NAME: {name}")
        if not isinstance(s, dict):
            errs.append(f"CUTOVER_SERVICE: {name} não é objeto")
            continue
        if not SECRET_RE.fullmatch(str(s.get("secret", ""))):
            errs.append(f"CUTOVER_SECRET: {name}: {s.get('secret')}")
        if s.get("secret") in seen_secret:
            errs.append(f"CUTOVER_SECRET_SHARED: {s.get('secret')} em {seen_secret[s.get('secret')]} e {name}")
        seen_secret[s.get("secret")] = name
        if s.get("cutover") not in (True, False):
            errs.append(f"CUTOVER_VALUE: {name}: cutover precisa ser true ou false (JSON), não {s.get('cutover')!r}")
        if s.get("cutover") is True and not TOKEN_ID_RE.fullmatch(str(s.get("token_id") or "")):
            errs.append(f"CUTOVER_TOKEN_ID: {name}: cutover=true exige token_id (32 hex) do token criado no painel")
        if s.get("token_id") is not None and not TOKEN_ID_RE.fullmatch(str(s.get("token_id"))):
            errs.append(f"CUTOVER_TOKEN_ID: {name}: token_id inválido")
        if s.get("environment") not in ENVIRONMENTS:
            errs.append(f"CUTOVER_ENVIRONMENT: {name}: {s.get('environment')}")
        ew = s.get("edit_workers")
        if not isinstance(ew, list) or not all(isinstance(x, str) and x for x in ew):
            errs.append(f"CUTOVER_EDIT_WORKERS: {name}")
        if not isinstance(s.get("edit_zones"), list):
            errs.append(f"CUTOVER_EDIT_ZONES: {name}")
        wfs = s.get("workflows")
        if not isinstance(wfs, list) or not wfs:
            errs.append(f"CUTOVER_WORKFLOWS: {name} sem workflows")
            continue
        for w in wfs:
            if w in seen_wf:
                errs.append(f"CUTOVER_WORKFLOW_TWICE: {w} em {seen_wf[w]} e {name}")
            seen_wf[w] = name
    return errs


def classify_expr(expr: str, secret: str, legacy: list[str]) -> str | None:
    """Devolve a forma canônica reconhecida para uma expressão ${{ ... }} ou None (forma proibida)."""
    e = expr.strip()
    legs = [f"secrets.{a}" for a in legacy]
    leg_forms = set(legs) | {f"{a} || {b}" for a in legs for b in legs if a != b}
    for lf in leg_forms:
        if e == token_expr(secret, lf):
            return "token"
    for a in legacy:
        if e == legacy_only_expr(a):
            return "legacy-only"
    if e == "${{ secrets.%s != '' }}" % secret:
        return "presence"
    return None


EXPR = re.compile(r"\$\{\{.*?\}\}")


def check_workflow(rel: str, text: str, service: str, s: dict, cfg: dict, all_secrets: dict) -> list[str]:
    errs = []
    err = lambda code, msg: errs.append(f"{code}: {rel}: {msg}")  # noqa: E731
    secret, legacy = s["secret"], cfg["legacy_secrets"]
    jobs = parse_workflow(text)
    p = jobs.get(JOB_ID)
    if not p or p["keys"].get("uses") != "./" + REUSABLE or p["with"].get("service") != service:
        err("P21_JOB_MISSING", f"job {JOB_ID} com uses ./{REUSABLE} e with.service {service} ausente")
    if p and p["keys"].get("if"):
        err("P21_JOB_CONDITIONAL", f"o job {JOB_ID} não pode ter if (sem ele os jobs com credencial não rodam)")
    for ln, line in enumerate(text.split("\n"), 1):
        for m in EXPR.finditer(line):
            ex = m.group(0)
            names = re.findall(r"secrets\.([A-Z0-9_]+)", ex)
            others = [n for n in names if n in all_secrets and all_secrets[n] != service]
            if others:
                err("P21_TOKEN_OTHER_SERVICE", f"l.{ln} usa {others} de outro serviço")
            if not any(n in legacy or n == secret for n in names):
                continue
            if re.search(r"secrets\[|toJSON\(\s*secrets", ex):
                err("P21_SECRETS_INDEX", f"l.{ln}")
            if classify_expr(ex, secret, legacy) is None:
                err("P21_EXPR_FORBIDDEN", f"l.{ln} expressão com token legado/dedicado fora da forma canônica: {ex[:160]}")
        if re.search(r"secrets\[|toJSON\(\s*secrets\s*\)", line):
            err("P21_SECRETS_INDEX", f"l.{ln} acesso indireto a segredos")
    for jn, job in jobs.items():
        if jn == JOB_ID:
            continue
        uses_cred = any(classify_expr(m.group(0), secret, legacy) for m in EXPR.finditer(job["text"]))
        if not uses_cred:
            continue
        if JOB_ID not in job["needs"]:
            err("P21_NEEDS_MISSING", f"job {jn} usa credencial e não depende de {JOB_ID}")
        steps = job["steps"]
        if not steps or steps[0]["name"] != GATE_NAME:
            err("P21_GATE_NOT_FIRST", f"job {jn}: o primeiro passo tem de ser '{GATE_NAME}'")
            continue
        g = steps[0]
        if g["run"] != GATE_RUN:
            err("P21_GATE_TEXT", f"job {jn}: texto do passo-gate diferente do canônico (scripts/ci/p21_token_cutover.py GATE_RUN)")
        want = gate_env(service, secret)
        got = {k: v for k, v in g["env"].items() if k.startswith("P21_")}
        if got != want:
            err("P21_GATE_ENV", f"job {jn}: env do gate {got} != {want}")
        if g.get("if"):
            err("P21_GATE_CONDITIONAL", f"job {jn}: o gate não pode ter if")
        tok = g["env"].get("CLOUDFLARE_API_TOKEN", job["env"].get("CLOUDFLARE_API_TOKEN"))
        if tok is None or classify_expr(tok, secret, legacy) != "token":
            err("P21_GATE_WITHOUT_TOKEN", f"job {jn}: o gate precisa ver CLOUDFLARE_API_TOKEN na forma canônica (env do job ou do passo)")
    return errs


def check_repo(root: Path = ROOT) -> list[str]:
    try:
        cfg = load(root)
    except (OSError, ValueError) as e:
        return [f"CUTOVER_UNREADABLE: {e}"]
    errs = validate_file(cfg)
    if errs:
        return errs
    rtext = (root / REUSABLE).read_text(encoding="utf-8") if (root / REUSABLE).is_file() else ""
    for need in ("workflow_call:", "python3 scripts/ci/p21_token_cutover.py emit --service", "contents: read"):
        if need not in rtext:
            errs.append(f"P21_REUSABLE: {REUSABLE} sem '{need}'")
    if "secrets." in rtext:
        errs.append(f"P21_REUSABLE: {REUSABLE} não pode ler segredos")
    all_secrets = {s["secret"]: name for name, s in cfg["services"].items()}
    for name, s in cfg["services"].items():
        for w in s["workflows"]:
            rel = f".github/workflows/{w}"
            if not (root / rel).is_file():
                errs.append(f"CUTOVER_WORKFLOW_MISSING: {w} ({name})")
                continue
            errs += check_workflow(rel, (root / rel).read_text(encoding="utf-8"), name, s, cfg, all_secrets)
    # Segredo dedicado citado em workflow não registrado para o serviço: troca de token = escrita em outro Worker.
    listed = {w: n for n, s in cfg["services"].items() for w in s["workflows"]}
    for f in sorted((root / ".github/workflows").glob("*.y*ml")):
        t = f.read_text(encoding="utf-8")
        for sec, svc in all_secrets.items():
            if re.search(r"secrets\.%s\b" % sec, t) and listed.get(f.name) != svc and f.name != "t1-publisher-guard.yml":
                errs.append(f"P21_TOKEN_UNLISTED_WORKFLOW: {f.name} usa {sec} e não está em services.{svc}.workflows")
    return errs


def status(cfg) -> dict:
    sv = cfg.get("services") or {}
    false = sorted(n for n, s in sv.items() if s.get("cutover") is not True)
    return {"services": len(sv), "cutover_true": sorted(n for n, s in sv.items() if s.get("cutover") is True),
            "cutover_false": false, "state": "NOT_PROVEN" if false or not sv else "ALL_CUTOVER"}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("emit")
    e.add_argument("--service", required=True)
    e.add_argument("--root", default=str(ROOT))
    c = sub.add_parser("check")
    c.add_argument("--root", default=str(ROOT))
    st = sub.add_parser("status")
    st.add_argument("--root", default=str(ROOT))
    a = ap.parse_args(argv)
    root = Path(a.root)
    if a.cmd == "emit":
        try:
            cfg = load(root)
        except (OSError, ValueError) as ex:
            print(f"::error title=TOKEN_CUTOVER_ILEGIVEL::{CUTOVER}: {type(ex).__name__}", file=sys.stderr)
            return 1
        errs = validate_file(cfg)
        s = (cfg.get("services") or {}).get(a.service) if isinstance(cfg, dict) else None
        if errs or not s:
            for x in errs or [f"serviço {a.service} ausente"]:
                print(f"::error title=TOKEN_CUTOVER_ILEGIVEL::{x}", file=sys.stderr)
            return 1
        print(f"cutover={'true' if s['cutover'] is True else 'false'}")
        print(f"token_id={s.get('token_id') or ''}")
        print(f"secret={s['secret']}")
        print(f"account={cfg['account']}")
        print(f"::notice title=TOKEN_CUTOVER::{a.service} cutover={'true' if s['cutover'] is True else 'false'} secret={s['secret']}", file=sys.stderr)
        return 0
    if a.cmd == "check":
        errs = check_repo(root)
        for x in errs:
            print("::error title=P21_TOKEN_CUTOVER::" + x)
        print("P21_TOKEN_CUTOVER_CHECK=" + ("FAIL" if errs else "PASS") + f" errors={len(errs)}")
        return 1 if errs else 0
    st_ = status(load(root))
    print(json.dumps(st_, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
