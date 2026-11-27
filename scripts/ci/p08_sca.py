#!/usr/bin/env python3
"""ZEVANORY | P08 SCA por ecossistema, sobre a árvore EXATA da release (fail-closed).

Regra anterior (mantida): qualquer manifesto de dependências sem SCA do seu ecossistema = FAIL. Este módulo faz a
SCA real do único ecossistema presente hoje (PyPI, arquivos requirements*.txt):
  - cada linha útil precisa ser um pin EXATO `nome==versão` (sem faixa, extra, marcador, URL, VCS, -r/-e/-c, opções);
  - cada pacote é consultado na base pública de vulnerabilidades OSV (api.osv.dev, ecossistema PyPI);
  - vulnerabilidade conhecida, resposta ilegível, rede fora do ar ou contagem divergente = FAIL (fail-closed).
Qualquer outro ecossistema (package.json, lockfiles, go.mod, Cargo, composer, Gemfile, pyproject, Pipfile, poetry)
continua FAIL `fail_closed_manifest_requires_ecosystem_sca` até ganhar a sua SCA.

Uso: python3 scripts/ci/p08_sca.py <raiz-da-arvore-alvo> <saida.json>
Saída: JSON com status NOT_APPLICABLE_NO_PACKAGE_MANAGER | PYPI_PINNED_OSV_CLEAN; exit 0 só nesses casos.
"""
import json
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

SCHEMA = "zevanory.p08.ecosystem-sca.v1"
OSV_BATCH = "https://api.osv.dev/v1/querybatch"
MANIFEST_PATTERNS = [
    r"(^|/)package\.json$", r"(^|/)package-lock\.json$", r"(^|/)pnpm-lock\.yaml$", r"(^|/)yarn\.lock$",
    r"(^|/)requirements[^/]*\.txt$", r"(^|/)pyproject\.toml$", r"(^|/)poetry\.lock$", r"(^|/)Pipfile(\.lock)?$",
    r"(^|/)go\.mod$", r"(^|/)go\.sum$", r"(^|/)Cargo\.toml$", r"(^|/)Cargo\.lock$",
    r"(^|/)composer\.json$", r"(^|/)composer\.lock$", r"(^|/)Gemfile(\.lock)?$",
]
PYPI_MANIFEST = re.compile(r"(^|/)requirements[^/]*\.txt$", re.I)
# PEP 508 nome normalizável + versão PEP 440 simples (sem curingas, sem local, sem faixa).
EXACT_PIN = re.compile(r"^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)==([0-9]+(?:\.[0-9]+)*(?:(?:a|b|rc)[0-9]+)?(?:\.post[0-9]+)?)$")


class ScaError(Exception):
    pass


def discover(files):
    return sorted(p for p in files if any(re.search(rx, p, re.I) for rx in MANIFEST_PATTERNS))


def normalize(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def parse_requirements(path, text):
    pkgs = []
    for n, raw in enumerate(text.splitlines(), 1):
        line = raw.split(" #", 1)[0].strip() if not raw.lstrip().startswith("#") else ""
        if not line:
            continue
        m = EXACT_PIN.match(line)
        if not m:
            raise ScaError(f"requirements_not_exact_pin:{path}:{n}")
        pkgs.append({"ecosystem": "PyPI", "name": normalize(m.group(1)), "version": m.group(2), "manifest": path,
                     "purl": f"pkg:pypi/{normalize(m.group(1))}@{m.group(2)}"})
    return pkgs


def osv_post(payload, timeout=30):
    req = urllib.request.Request(OSV_BATCH, data=json.dumps(payload).encode(), method="POST",
                                 headers={"content-type": "application/json", "user-agent": "zevanory-p08-sca/1"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        if r.status != 200:
            raise ScaError(f"osv_http_{r.status}")
        return json.loads(r.read().decode())


def osv_check(pkgs, post=osv_post):
    if not pkgs:
        return []
    try:
        res = post({"queries": [{"package": {"name": p["name"], "ecosystem": p["ecosystem"]}, "version": p["version"]} for p in pkgs]})
    except ScaError:
        raise
    except Exception as e:  # rede, TLS, JSON: nunca vira "limpo"
        raise ScaError("osv_unreachable:" + type(e).__name__)
    results = res.get("results") if isinstance(res, dict) else None
    if not isinstance(results, list) or len(results) != len(pkgs) or not all(isinstance(r, dict) for r in results):
        raise ScaError("osv_response_invalid")
    found = []
    for p, r in zip(pkgs, results):
        vulns = r.get("vulns") or []
        if not isinstance(vulns, list):
            raise ScaError("osv_response_invalid")
        if r.get("next_page_token"):
            raise ScaError("osv_paginated_result_unsupported:" + p["name"])
        for v in vulns:
            found.append({"package": p["purl"], "id": str((v or {}).get("id", "?"))})
    if found:
        raise ScaError("known_vulnerability:" + ",".join(sorted(f"{x['package']}={x['id']}" for x in found))[:400])
    return [{"package": p["purl"], "vulns": 0} for p in pkgs]


def run(root, files, post=osv_post):
    manifests = discover(files)
    if not manifests:
        return {"schema": SCHEMA, "status": "NOT_APPLICABLE_NO_PACKAGE_MANAGER", "manifests": [], "packages": [], "osv": [], "verdict": "PASS"}
    other = [m for m in manifests if not PYPI_MANIFEST.search(m)]
    if other:
        raise ScaError("fail_closed_manifest_requires_ecosystem_sca:" + ",".join(other))
    pkgs = []
    for m in manifests:
        pkgs += parse_requirements(m, (Path(root) / m).read_text("utf-8"))
    if not pkgs:
        raise ScaError("requirements_without_packages")
    seen = {}
    for p in pkgs:
        if p["name"] in seen and seen[p["name"]] != p["version"]:
            raise ScaError("conflicting_pins:" + p["name"])
        seen[p["name"]] = p["version"]
    osv = osv_check(pkgs, post)
    return {"schema": SCHEMA, "status": "PYPI_PINNED_OSV_CLEAN", "manifests": manifests, "packages": pkgs, "osv": osv,
            "osv_endpoint": OSV_BATCH, "verdict": "PASS"}


def main(argv):
    root, out = argv[1], argv[2]
    raw = subprocess.check_output(["git", "-C", root, "ls-files", "-z"])
    files = sorted(x.decode() for x in raw.split(b"\0") if x)
    try:
        rep = run(root, files)
    except ScaError as e:
        print("P08_SCA=FAIL " + str(e))
        Path(out).write_text(json.dumps({"schema": SCHEMA, "verdict": "FAIL", "reason": str(e)}, sort_keys=True, indent=2) + "\n")
        return 1
    Path(out).write_text(json.dumps(rep, sort_keys=True, indent=2) + "\n")
    print(f"P08_SCA=PASS status={rep['status']} manifests={len(rep['manifests'])} packages={len(rep['packages'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
