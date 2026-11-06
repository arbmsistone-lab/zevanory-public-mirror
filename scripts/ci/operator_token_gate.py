#!/usr/bin/env python3
"""ZEVANORY | Gate estático da migração da credencial de operador (R9, roteiro v4.7; auditoria Sol 164 §4).

CERTIFICATION_E2E_TOKEN era, apesar do nome, a credencial de OPERADOR da produção. O nome novo é ZEVANORY_OPERATOR_TOKEN.
Este gate lê os workflows como DADO (yaml.safe_load) e o código como texto; nada é executado, nenhum segredo é lido.

Job "ativo" = job cujo `if:` não é literalmente falso (`false`, `${{ false }}`, `false && ...`). Job "sandbox" = Environment
`sandbox-financial-approved` (lá CERTIFICATION_E2E_TOKEN é a credencial legítima do Worker de certificação). Job
"consumidor" = job ativo fora da sandbox que lê `secrets.ZEVANORY_OPERATOR_TOKEN` ou `secrets.CERTIFICATION_E2E_TOKEN`;
O1-O4 valem para ele (um job sem acesso a nenhum dos dois segredos não recebe a credencial).

  O1 LEGACY_SECRET_NOT_FALLBACK     em job ativo fora da sandbox, `secrets.CERTIFICATION_E2E_TOKEN` só pode aparecer como
                                    queda imediatamente depois de `secrets.ZEVANORY_OPERATOR_TOKEN ||` (transição).
                                    Exceção: os workflows de readback em READBACK_WORKFLOWS, que leem os dois nomes para
                                    provar presença/igualdade (só categorias).
  O2 LEGACY_ENV_NAME_IN_PRODUCTION  em job ativo fora da sandbox, nenhuma chave de env (workflow, job ou passo) se chama
                                    CERTIFICATION_E2E_TOKEN: o consumidor recebe a credencial sob o nome novo.
  O3 LEGACY_READ_IN_PRODUCTION_RUN  em job ativo fora da sandbox, nenhum `run` lê a variável antiga
                                    ($CERTIFICATION_E2E_TOKEN, os.environ[...], process.env....).
  O4 PRODUCTION_SCRIPT_READS_LEGACY todo script de scripts/ chamado por um job ativo fora da sandbox não pode LER a
                                    variável de ambiente CERTIFICATION_E2E_TOKEN (descoberta automática a partir dos `run`,
                                    sem lista manual; citar o nome como dado, como fazem os gates e readbacks, não conta).
  O5 OPERATOR_TOKEN_IN_SANDBOX      ZEVANORY_OPERATOR_TOKEN (segredo ou chave de env) nunca em job sandbox: a credencial
                                    de produção não chega ao Worker de certificação.
  O6 WORKER_READS_LEGACY            nenhum módulo de worker/ cita CERTIFICATION_E2E_TOKEN, exceto o resolvedor único
                                    worker/operator-credential.mjs (certification-worker.mjs é o perímetro de certificação).
  O7 FALLBACK_STILL_ENABLED         só com --strict (PR de seguimento, depois do readback): a queda está desligada em
                                    worker/operator-credential.mjs, O1 não tem exceção e nenhum job ativo fora da sandbox
                                    cita o nome antigo, nem mesmo como queda.

Uso:  python3 scripts/ci/operator_token_gate.py [--root DIR] [--strict] [--inventory] [--json]
Saída: uma linha por violação e OPERATOR_TOKEN_GATE=PASS|FAIL violations=N errors=M; --inventory imprime o inventário JSON
dos consumidores (workflow, job, Environment, forma). Código: 0 sem violação; 1 com violação; 2 entrada ilegível.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

import yaml

NEW = "ZEVANORY_OPERATOR_TOKEN"
LEGACY = "CERTIFICATION_E2E_TOKEN"
SANDBOX_ENVIRONMENT = "sandbox-financial-approved"
READBACK_WORKFLOWS = frozenset({"production-credential-identity.yml", "production-secret-readiness.yml"})
# Dispensa nominal e temporária, impressa a cada execução: depois do #910 o job só fala com o Worker de certificação, onde
# CERTIFICATION_E2E_TOKEN é a credencial de certificação; falta movê-lo para sandbox-financial-approved (R9-D6).
PENDING_ELSEWHERE = {"financial-e2e-stripe.yml": "#910 (4b73b1ee) aponta o job para o Worker de certificação; mover o job para sandbox-financial-approved é o item R9-D6 de ops/r9-debt.json"}
RESOLVER = "worker/operator-credential.mjs"

LEGACY_SECRET = re.compile(r"\bsecrets\s*(?:\.\s*" + LEGACY + r"\b|\[\s*['\"]" + LEGACY + r"['\"]\s*\])")
FALLBACK_FORM = re.compile(r"\bsecrets\s*\.\s*" + NEW + r"\s*\|\|\s*secrets\s*\.\s*" + LEGACY + r"\b")
NEW_SECRET = re.compile(r"\bsecrets\s*(?:\.\s*" + NEW + r"\b|\[\s*['\"]" + NEW + r"['\"]\s*\])")
LEGACY_RUN_READ = re.compile(r"\$\{?" + LEGACY + r"\b|environ(?:\.get)?\s*[\[(]\s*['\"]" + LEGACY + r"['\"]|getenv\(\s*['\"]" + LEGACY
                             + r"['\"]|process\.env(?:\.|\[\s*['\"])" + LEGACY + r"\b")
SCRIPT_PATH = re.compile(r"(?<![\w/.-])(scripts/[A-Za-z0-9_./-]+\.(?:py|mjs|js|sh))\b")
DISABLED_IF = re.compile(r"^\s*(?:\$\{\{\s*)?false\b")


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


def job_environment(job):
    env = job.get("environment")
    if isinstance(env, dict):
        env = env.get("name")
    return env if isinstance(env, str) else None


def job_disabled(job) -> bool:
    cond = job.get("if")
    return cond is False or (isinstance(cond, str) and bool(DISABLED_IF.match(cond)))


def env_blocks(doc, job):
    blocks = []
    if isinstance(doc.get("env"), dict):
        blocks.append(doc["env"])
    if isinstance(job.get("env"), dict):
        blocks.append(job["env"])
    for step in job.get("steps") or []:
        if isinstance(step, dict) and isinstance(step.get("env"), dict):
            blocks.append(step["env"])
    return blocks


def legacy_not_fallback(text: str) -> int:
    """Quantas leituras de secrets.CERTIFICATION_E2E_TOKEN NÃO estão na forma de queda depois do nome novo."""
    total = len(LEGACY_SECRET.findall(text))
    return total - len(FALLBACK_FORM.findall(text))


def check_workflow(fname: str, doc, root: pathlib.Path, strict: bool, inventory: list, waived: list) -> list[dict]:
    out = []
    if not isinstance(doc, dict):
        return out
    wf_env = doc.get("env") if isinstance(doc.get("env"), dict) else {}
    for jname, job in (doc.get("jobs") or {}).items():
        if not isinstance(job, dict):
            continue
        environment = job_environment(job)
        base = {"workflow": fname, "job": str(jname), "environment": environment}
        texts = list(_strings(wf_env)) + list(_strings(job))
        joined = "\n".join(texts)
        sandbox = environment == SANDBOX_ENVIRONMENT
        disabled = job_disabled(job)
        uses_legacy = bool(LEGACY_SECRET.search(joined)) or LEGACY in joined
        uses_new = bool(NEW_SECRET.search(joined)) or NEW in joined
        if uses_legacy or uses_new:
            form = ("retired" if disabled else "certification" if sandbox else
                    "readback" if fname in READBACK_WORKFLOWS else
                    "new+fallback" if FALLBACK_FORM.search(joined) else "new" if uses_new else "legacy")
            inventory.append({**base, "form": form})
        if sandbox:
            if NEW_SECRET.search(joined) or any(NEW in b for b in env_blocks(doc, job)):
                out.append({**base, "rule": "OPERATOR_TOKEN_IN_SANDBOX", "name": NEW,
                            "detail": "credencial de operador da produção em job sandbox-financial-approved"})
            continue
        if disabled:
            continue
        if not (LEGACY_SECRET.search(joined) or NEW_SECRET.search(joined)):
            continue  # job sem acesso a nenhum dos dois segredos não é consumidor (ex.: jobs de CI sem Environment)
        if fname in PENDING_ELSEWHERE:
            waived.append(f"{fname}#{jname}: {PENDING_ELSEWHERE[fname]}")
            continue
        if strict:
            if LEGACY_SECRET.search(joined):
                out.append({**base, "rule": "FALLBACK_STILL_ENABLED", "name": LEGACY,
                            "detail": "modo estrito: nome antigo ainda lido fora da sandbox"})
        elif fname not in READBACK_WORKFLOWS and legacy_not_fallback(joined) > 0:
            out.append({**base, "rule": "LEGACY_SECRET_NOT_FALLBACK", "name": LEGACY,
                        "detail": "secrets.CERTIFICATION_E2E_TOKEN fora da forma 'secrets.ZEVANORY_OPERATOR_TOKEN || secrets.CERTIFICATION_E2E_TOKEN'"})
        for block in env_blocks(doc, job):
            if LEGACY in block:
                out.append({**base, "rule": "LEGACY_ENV_NAME_IN_PRODUCTION", "name": LEGACY,
                            "detail": "chave de env com o nome antigo em job de produção"})
                break
        scripts = set()
        for step in job.get("steps") or []:
            run = step.get("run") if isinstance(step, dict) else None
            if not isinstance(run, str):
                continue
            if LEGACY_RUN_READ.search(run):
                out.append({**base, "rule": "LEGACY_READ_IN_PRODUCTION_RUN", "name": LEGACY,
                            "detail": "run lê a variável antiga"})
            scripts.update(SCRIPT_PATH.findall(run))
        for rel in sorted(scripts):
            f = root / rel
            if f.is_file() and LEGACY_RUN_READ.search(f.read_text(encoding="utf-8", errors="replace")):
                out.append({**base, "rule": "PRODUCTION_SCRIPT_READS_LEGACY", "name": LEGACY,
                            "detail": f"{rel} cita o nome antigo"})
    return out


def check_worker(root: pathlib.Path, strict: bool) -> list[dict]:
    out = []
    for f in sorted((root / "worker").rglob("*")):
        if not f.is_file() or f.suffix not in (".mjs", ".js"):
            continue
        rel = f.relative_to(root).as_posix()
        text = f.read_text(encoding="utf-8", errors="replace")
        if rel == RESOLVER:
            if strict and not re.search(r"export const OPERATOR_TOKEN_LEGACY_FALLBACK = false;", text):
                out.append({"workflow": rel, "job": "-", "environment": "worker", "rule": "FALLBACK_STILL_ENABLED",
                            "name": LEGACY, "detail": "modo estrito: OPERATOR_TOKEN_LEGACY_FALLBACK precisa ser false"})
            continue
        if LEGACY in text:
            out.append({"workflow": rel, "job": "-", "environment": "worker", "rule": "WORKER_READS_LEGACY",
                        "name": LEGACY, "detail": "módulo do Worker lê o nome antigo fora do resolvedor único"})
    if not (root / RESOLVER).is_file():
        out.append({"workflow": RESOLVER, "job": "-", "environment": "worker", "rule": "WORKER_READS_LEGACY",
                    "name": NEW, "detail": "resolvedor único ausente"})
    return out


def run(root: pathlib.Path, strict: bool = False):
    violations, errors, inventory, waived = [], [], [], []
    files = sorted(list((root / ".github" / "workflows").glob("*.yml")) + list((root / ".github" / "workflows").glob("*.yaml")))
    if not files:
        errors.append("nenhum workflow")
    for f in files:
        try:
            doc = yaml.safe_load(f.read_text(encoding="utf-8"))
        except (yaml.YAMLError, UnicodeDecodeError) as e:
            errors.append(f"{f.name}: ilegível ({type(e).__name__})")
            continue
        violations.extend(check_workflow(f.name, doc, root, strict, inventory, waived))
    violations.extend(check_worker(root, strict))
    return violations, errors, inventory, waived


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=str(pathlib.Path(__file__).resolve().parents[2]))
    ap.add_argument("--strict", action="store_true")
    ap.add_argument("--inventory", action="store_true")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    violations, errors, inventory, waived = run(pathlib.Path(a.root), a.strict)
    for w in waived:
        print("WAIVED " + w)
    for e in errors:
        print("OPERATOR_TOKEN_GATE_ERROR " + e)
    for v in violations:
        print(f"VIOLATION {v['rule']} {v['workflow']}#{v['job']} env={v['environment']} name={v['name']} :: {v['detail']}")
    if a.inventory:
        print("INVENTORY " + json.dumps(inventory, ensure_ascii=False))
    code = 2 if errors else (1 if violations else 0)
    if a.json:
        print(json.dumps({"violations": violations, "errors": errors, "waived": waived, "inventory": inventory, "exit": code}, ensure_ascii=False))
    print("OPERATOR_TOKEN_GATE=" + ("PASS" if code == 0 else "FAIL") + f" violations={len(violations)} errors={len(errors)}"
          + (" mode=strict" if a.strict else " mode=transition"))
    return code


if __name__ == "__main__":
    sys.exit(main())
