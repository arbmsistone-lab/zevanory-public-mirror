#!/usr/bin/env python3
"""ZEVANORY | Gate estático de separação de credenciais sandbox x produção (F2 item 9; Roteiro 3.1 seção 7).

Lê .github/workflows/*.yml como DADO (yaml.safe_load; nada é executado, nenhum segredo é lido) e aplica, job a job:

  R1 SANDBOX_SECRET_OUTSIDE_SANDBOX   segredo de sandbox (MERCADOPAGO_TEST_*, CERTIFICATION_*, SANDBOX_*, e por extensão
                                      qualquer *_TEST_* / *_SANDBOX_* / TEST_*) só em job cujo Environment é
                                      `sandbox-financial-approved`.
  R2 PRODUCTION_SECRET_IN_SANDBOX     segredo de pagamento/produção (MERCADOPAGO_ACCESS_TOKEN, MERCADOPAGO_WEBHOOK_SECRET,
                                      MERCADOPAGO_PUBLIC_KEY, MERCADOPAGO_PROD_ACCESS_TOKEN, ASAAS_*, STRIPE_*, HOTMART_*,
                                      DATABASE_URL, OPERATOR_TOKEN, RESEND_API_KEY ...) nunca em job `sandbox-financial-approved`
                                      (espelha a lista de recusa de certification-worker.mjs).
  R3 TEST_SECRET_PUT_TO_PRODUCTION    nenhum `wrangler [versions] secret put|bulk` (nem PUT direto na API de secrets) grava
                                      nome *_TEST_* / CERTIFICATION* / SANDBOX* num Worker de produção. Produção = qualquer
                                      alvo cujo --name/--config NÃO contém "certification", inclusive sem --name/--config
                                      (o wrangler usa o arquivo de configuração padrão, que é o de produção). Nome dinâmico
                                      ("$name") é resolvido pelo `for name in ...` do mesmo script; sem resolução, falha.
  R5 PRODUCTION_CONFIG_TEST_BINDING   a configuração de deploy do Worker de produção (scripts/deploy/prepare-central-candidate.py
                                      e wrangler*.toml/jsonc da raiz sem "certification" no nome) não pode definir var com
                                      nome *_TEST_* / CERTIFICATION* / SANDBOX* além da dívida conhecida e congelada
                                      KNOWN_PRODUCTION_CONFIG_DEBT; `wrangler deploy --var NOME:...` para produção idem (R3).
  R4 ENVIRONMENT_NOT_LITERAL          job com nome sensível e Environment dado por expressão (${{ }}) é recusado: o gate não
                                      consegue provar em qual Environment ele roda (fail-closed).

"Referência a segredo" = `secrets.NOME`, `secrets['NOME']`/`secrets["NOME"]` em qualquer valor do job (env, with, run,
if ...) e no env do workflow (vale para todos os jobs). Para R1 contam também as chaves de `env:` cujo valor lê `secrets`
(MERCADOPAGO_TEST_ACCESS_TOKEN: ${{ secrets.X }} carrega credencial sob nome de sandbox); R2 olha só o segredo lido
(MP_TOKEN: ${{ secrets.MERCADOPAGO_TEST_ACCESS_TOKEN }} num job sandbox é o segredo de teste, não o de produção).

Exceção nominal única (LEGACY_PRODUCTION_OPERATOR_NAMES): CERTIFICATION_E2E_TOKEN. Apesar do nome, é o token de operador
que o Worker de PRODUÇÃO `zevanory` exige (central-production-deploy.yml recusa o deploy sem ele; backup, voz, WhatsApp,
auditoria financeira autenticam com ele). Renomeá-lo é operação de segredo reservada ao proprietário. A exceção vale só
para R1 (uso em Environment de produção); R3 continua proibindo gravá-lo num Worker de produção por estes jobs.

Uso:  python3 scripts/ci/credential_separation_gate.py [--workflows DIR] [--config-root DIR] [--json]
Saída: uma linha por violação (ou CREDENTIAL_SEPARATION_GATE=PASS); --json imprime o resumo JSON.
Código: 0 sem violação; 1 com violação; 2 workflow ilegível (fail-closed).
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import shlex
import sys

import yaml

SANDBOX_ENVIRONMENT = "sandbox-financial-approved"
SANDBOX_NAME = re.compile(r"^(?:MERCADOPAGO_TEST_|CERTIFICATION_|SANDBOX_|TEST_)|_TEST_|_SANDBOX_|_TEST$|_SANDBOX$")
# Gravação em Worker de produção: qualquer nome com TEST/CERTIFICATION/SANDBOX como palavra.
PUT_FORBIDDEN_NAME = re.compile(r"(?:^|_)(?:TEST|CERTIFICATION|SANDBOX)(?:_|$)")
LEGACY_PRODUCTION_OPERATOR_NAMES = frozenset({"CERTIFICATION_E2E_TOKEN"})
# Vars CERTIFICATION_PILOT_* que o deploy de produção grava hoje e que verify-financial-boundary.py EXIGE
# (CERTIFICATION_PILOT_ENV=sandbox, CERTIFICATION_PILOT_PRODUCTION_ALLOWED=false). Congeladas: nenhuma nova entra; sair
# exige mudar o contrato de deploy (decisão do proprietário, classe B).
KNOWN_PRODUCTION_CONFIG_DEBT = frozenset({"CERTIFICATION_PILOT_ENV", "CERTIFICATION_PILOT_APPROVER", "CERTIFICATION_PILOT_PRODUCTION_ALLOWED"})
PRODUCTION_NAMES = frozenset({
    "MERCADOPAGO_ACCESS_TOKEN", "MERCADOPAGO_WEBHOOK_SECRET", "MERCADOPAGO_PUBLIC_KEY", "MERCADOPAGO_PROD_ACCESS_TOKEN",
    "ASAAS_API_KEY", "ASAAS_WEBHOOK_TOKEN", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET",
    "DATABASE_URL", "OPERATOR_TOKEN", "RESEND_API_KEY",
})
PRODUCTION_PREFIX = re.compile(r"^(?:MERCADOPAGO|MP|ASAAS|STRIPE|HOTMART|PAGARME|PAGSEGURO)_")

SECRET_DOT = re.compile(r"\bsecrets\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)")
SECRET_INDEX = re.compile(r"\bsecrets\s*\[\s*['\"]([^'\"]+)['\"]\s*\]")
WRANGLER_DEPLOY_VAR = re.compile(r"\bwrangler(?:@[\w.\-]+)?\s+(?:deploy|versions\s+upload)\b([^\n;|&<>]*)")
WRANGLER_SECRET = re.compile(r"\bwrangler(?:@[\w.\-]+)?\s+(?:versions\s+)?secret\s+(put|bulk)\b([^\n;|&<>]*)")
API_SECRET_WRITE = re.compile(r"workers/scripts/([^/\s\"']+)/secrets")
FLAGS_WITH_VALUE = {"--name", "--config", "-c", "--env", "-e", "--cwd", "--script-name"}


def is_sandbox_name(name: str) -> bool:
    return bool(SANDBOX_NAME.search(name))


def is_production_name(name: str) -> bool:
    return not is_sandbox_name(name) and (name in PRODUCTION_NAMES or bool(PRODUCTION_PREFIX.match(name)))


def _strings(node):
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for k, v in node.items():
            if isinstance(k, str):
                yield k
            yield from _strings(v)
    elif isinstance(node, list):
        for v in node:
            yield from _strings(v)


def secret_refs(node) -> set[str]:
    refs = set()
    for s in _strings(node):
        if "secrets" in s:
            refs.update(SECRET_DOT.findall(s))
            refs.update(SECRET_INDEX.findall(s))
    return refs


def env_bound_names(env) -> set[str]:
    """Chaves de um bloco env: cujo valor lê secrets."""
    out = set()
    if isinstance(env, dict):
        for k, v in env.items():
            if isinstance(k, str) and isinstance(v, str) and (SECRET_DOT.search(v) or SECRET_INDEX.search(v)):
                out.add(k)
    return out


def job_environment(job):
    env = job.get("environment")
    if isinstance(env, dict):
        env = env.get("name")
    return env if isinstance(env, str) else None


def production_target(tokens: list[str]) -> tuple[bool, str]:
    """(é produção?, descrição do alvo). Sem --name/--config o wrangler usa o arquivo padrão (produção)."""
    target = []
    i = 0
    while i < len(tokens):
        t = tokens[i]
        for flag in ("--name", "--config", "-c"):
            if t == flag and i + 1 < len(tokens):
                target.append(tokens[i + 1])
            elif t.startswith(flag + "="):
                target.append(t.split("=", 1)[1])
        i += 1
    if not target:
        return True, "(configuração padrão do wrangler)"
    return (not all("certification" in x.lower() for x in target)), " ".join(target)


def _positional(tokens: list[str]) -> str | None:
    i = 0
    while i < len(tokens):
        t = tokens[i]
        if t in FLAGS_WITH_VALUE:
            i += 2
            continue
        if t.startswith("-"):
            i += 1
            continue
        return t
    return None


def _resolve_dynamic(name: str, script: str) -> list[str] | None:
    m = re.fullmatch(r"\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?", name)
    if not m:
        return [name]
    var = m.group(1)
    loop = re.search(r"\bfor\s+" + re.escape(var) + r"\s+in\s+([^;\n]+?)\s*;\s*do\b", script)
    if not loop:
        return None
    words = loop.group(1).split()
    return words if words and all(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", w) for w in words) else None


def scan_puts(script: str):
    """Violações R3 num texto de `run`. Devolve [(nome, alvo, detalhe)]."""
    found = []
    joined = re.sub(r"\\\n", " ", script)
    for m in WRANGLER_SECRET.finditer(joined):
        kind, rest = m.group(1), m.group(2)
        try:
            tokens = shlex.split(rest, posix=True)
        except ValueError:
            tokens = rest.split()
        prod, target = production_target(tokens)
        if not prod:
            continue
        if kind == "put":
            raw = _positional(tokens)
            if raw is None:
                found.append(("?", target, "secret put sem nome legível"))
                continue
            names = _resolve_dynamic(raw, joined)
            if names is None:
                found.append((raw, target, "nome dinâmico não resolvido em secret put para produção"))
                continue
            for n in names:
                if PUT_FORBIDDEN_NAME.search(n):
                    found.append((n, target, "secret put de nome de teste/certificação em Worker de produção"))
        else:  # bulk: o arquivo é montado no próprio script; qualquer nome proibido no texto do passo conta
            for n in sorted(set(re.findall(r"\b[A-Z][A-Z0-9_]{2,}\b", joined))):
                if PUT_FORBIDDEN_NAME.search(n):
                    if re.search(r"['\"]" + re.escape(n) + r"['\"]", joined):
                        found.append((n, target, "secret bulk com nome de teste/certificação em Worker de produção"))
    for m in WRANGLER_DEPLOY_VAR.finditer(joined):
        try:
            tokens = shlex.split(m.group(1), posix=True)
        except ValueError:
            tokens = m.group(1).split()
        prod, target = production_target(tokens)
        if not prod:
            continue
        for i, t in enumerate(tokens):
            val = tokens[i + 1] if t == "--var" and i + 1 < len(tokens) else (t[6:] if t.startswith("--var=") else None)
            n = (val or "").split(":", 1)[0]
            if n and PUT_FORBIDDEN_NAME.search(n):
                found.append((n, target, "wrangler deploy --var de nome de teste/certificação em Worker de produção"))
    for line in joined.split("\n"):
        for m in API_SECRET_WRITE.finditer(line):
            script_name = m.group(1)
            if "certification" in script_name.lower():
                continue
            for n in sorted(set(re.findall(r"\b[A-Z][A-Z0-9_]{2,}\b", line))):
                if PUT_FORBIDDEN_NAME.search(n):
                    found.append((n, script_name, "API de secrets do Worker de produção com nome de teste/certificação"))
    return found


def check_workflow(fname: str, doc) -> list[dict]:
    out = []
    if not isinstance(doc, dict):
        return out
    wf_env = doc.get("env") if isinstance(doc.get("env"), dict) else {}
    wf_refs, wf_bound = secret_refs(wf_env), env_bound_names(wf_env)
    for jname, job in (doc.get("jobs") or {}).items():
        if not isinstance(job, dict):
            continue
        environment = job_environment(job)
        refs = set(wf_refs) | secret_refs(job)
        bound = set(wf_bound) | env_bound_names(job.get("env"))
        for step in job.get("steps") or []:
            if isinstance(step, dict):
                bound |= env_bound_names(step.get("env"))
        names = refs | bound
        base = {"workflow": fname, "job": str(jname), "environment": environment}
        sensitive = sorted(n for n in names if is_sandbox_name(n) or is_production_name(n))
        if environment and "${{" in environment and sensitive:
            out.append({**base, "rule": "ENVIRONMENT_NOT_LITERAL", "name": ",".join(sensitive),
                        "detail": "Environment por expressão com segredo sensível"})
            continue
        for n in sorted(names):
            if is_sandbox_name(n) and environment != SANDBOX_ENVIRONMENT and n not in LEGACY_PRODUCTION_OPERATOR_NAMES:
                out.append({**base, "rule": "SANDBOX_SECRET_OUTSIDE_SANDBOX", "name": n,
                            "detail": f"segredo de sandbox fora de {SANDBOX_ENVIRONMENT}"})
            if n in refs and is_production_name(n) and environment == SANDBOX_ENVIRONMENT:
                out.append({**base, "rule": "PRODUCTION_SECRET_IN_SANDBOX", "name": n,
                            "detail": "segredo de produção em job sandbox-financial-approved"})
        for step in job.get("steps") or []:
            run = step.get("run") if isinstance(step, dict) else None
            if isinstance(run, str):
                for n, target, detail in scan_puts(run):
                    out.append({**base, "rule": "TEST_SECRET_PUT_TO_PRODUCTION", "name": n, "detail": f"{detail} (alvo: {target})"})
    return out


CONFIG_VAR_PATTERNS = [
    re.compile(r"\[\s*['\"]vars['\"]\s*\]\s*\[\s*['\"]([A-Za-z_][A-Za-z0-9_]*)['\"]\s*\]\s*="),
    re.compile(r"setdefault\(\s*['\"]vars['\"]\s*,\s*\{\s*\}\s*\)\s*\[\s*['\"]([A-Za-z_][A-Za-z0-9_]*)['\"]\s*\]\s*="),
    re.compile(r"\bruntime\s*\[\s*['\"]([A-Za-z_][A-Za-z0-9_]*)['\"]\s*\]\s*="),
]


def production_config_files(root):
    root = pathlib.Path(root)
    files = [root / "scripts" / "deploy" / "prepare-central-candidate.py"]
    files += [f for f in sorted(root.glob("wrangler*.toml")) + sorted(root.glob("wrangler*.json")) + sorted(root.glob("wrangler*.jsonc"))
              if "certification" not in f.name.lower()]
    return [f for f in files if f.is_file()]


def config_var_names(path) -> set[str]:
    text = pathlib.Path(path).read_text(encoding="utf-8", errors="replace")
    names = set()
    if path.suffix == ".py":
        for rx in CONFIG_VAR_PATTERNS:
            names.update(rx.findall(text))
    elif path.suffix == ".toml":
        section = None
        for line in text.splitlines():
            st = line.strip()
            if st.startswith("["):
                section = st.strip("[]").strip()
                continue
            m = re.match(r"([A-Za-z_][A-Za-z0-9_]*)\s*=", st)
            if m and section is not None and (section == "vars" or section.endswith(".vars")):
                names.add(m.group(1))
    else:
        for block in re.finditer(r"['\"]vars['\"]\s*:\s*\{([^{}]*)\}", text):
            names.update(re.findall(r"['\"]([A-Za-z_][A-Za-z0-9_]*)['\"]\s*:", block.group(1)))
    return names


def check_production_config(root) -> list[dict]:
    out = []
    for f in production_config_files(root):
        for n in sorted(config_var_names(f)):
            if PUT_FORBIDDEN_NAME.search(n) and n not in KNOWN_PRODUCTION_CONFIG_DEBT:
                out.append({"workflow": str(f.relative_to(root)).replace("\\", "/"), "job": "-", "environment": "production-config",
                            "rule": "PRODUCTION_CONFIG_TEST_BINDING", "name": n,
                            "detail": "var de teste/certificação na configuração do Worker de produção"})
    return out


def check_dir(directory) -> tuple[list[dict], list[str]]:
    violations, errors = [], []
    files = sorted(list(pathlib.Path(directory).glob("*.yml")) + list(pathlib.Path(directory).glob("*.yaml")))
    if not files:
        errors.append(f"nenhum workflow em {directory}")
    for f in files:
        try:
            doc = yaml.safe_load(f.read_text(encoding="utf-8"))
        except (yaml.YAMLError, UnicodeDecodeError) as e:
            errors.append(f"{f.name}: ilegível ({type(e).__name__})")
            continue
        violations.extend(check_workflow(f.name, doc))
    return violations, errors


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workflows", default=str(pathlib.Path(__file__).resolve().parents[2] / ".github" / "workflows"))
    ap.add_argument("--config-root", default=None, help="raiz para R5 (padrão: o repositório; exige prepare-central-candidate.py)")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    violations, errors = check_dir(a.workflows)
    root = pathlib.Path(a.config_root) if a.config_root else pathlib.Path(__file__).resolve().parents[2]
    if not a.config_root and not (root / "scripts" / "deploy" / "prepare-central-candidate.py").is_file():
        errors.append("prepare-central-candidate.py ausente (R5 não verificável)")
    violations.extend(check_production_config(root))
    for e in errors:
        print("CREDENTIAL_SEPARATION_GATE_ERROR " + e)
    for v in violations:
        print(f"VIOLATION {v['rule']} {v['workflow']}#{v['job']} env={v['environment']} name={v['name']} :: {v['detail']}")
    code = 2 if errors else (1 if violations else 0)
    if a.json:
        print(json.dumps({"violations": violations, "errors": errors, "count": len(violations), "exit": code}, ensure_ascii=False))
    print("CREDENTIAL_SEPARATION_GATE=" + ("PASS" if code == 0 else "FAIL") + f" violations={len(violations)} errors={len(errors)}")
    return code


if __name__ == "__main__":
    sys.exit(main())
