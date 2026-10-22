#!/usr/bin/env python3
"""B07 T4 (preparo): inventário SÓ LEITURA de quem consome DATABASE_URL e para qual banco aponta, sem expor o segredo.
Usado por .github/workflows/database-url-consumer-inventory.yml (workflow_dispatch).

Para cada consumidor (Environment -> segredo -> workflows que o usam; tabela CONSUMERS, conferida contra os workflows
por tests/test_database_url_inventory.py) imprime SÓ:
  host_sha256      sha256 do HOST normalizado (minúsculas, sem ponto final, sem o sufixo "-pooler" do 1º rótulo — o
                   host direto e o do pooler do MESMO endpoint Neon dão o mesmo hash). Nunca usuário, senha, banco,
                   porta ou parâmetros.
  endpoint_sha256  sha256 do id de endpoint Neon (ep-…) quando o host o tiver; o id é tratado como sensível -> só hash.
  pooled           yes/no (se o host era o do pooler)
  status           MATCH | MISMATCH | ABSENT | UNPARSEABLE (contra EXPECTED_HOST_SHA256 = host do zevanory-db-2)
Qualquer status diferente de MATCH (ou, para o banco de certificação isolado, qualquer MATCH) -> FAIL com o nome do
consumidor. O Worker não devolve segredos (são só escrita na Cloudflare): o subcomando `worker` lê o campo público
`database_host_sha256` de /api/health (mudança de Worker em commit separado, classe B) e compara do mesmo jeito.

Uso:  database_url_inventory.py consumers ENVIRONMENT      (segredos chegam como DBINV_<NOME_DO_SEGREDO>)
      database_url_inventory.py worker                      (GET público https://zevanory.api.br/api/health)
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit

# Environment -> segredo -> (workflows consumidores, expectativa). "same" = tem de ser o zevanory-db-2;
# "isolated" = banco de certificação isolado: tem de ser DIFERENTE do de produção.
CONSUMERS = {
    "producao-critica": {
        "DATABASE_URL": (("central-production-deploy.yml", "financial-ddl-readonly-check.yml",
                          "production-secret-readiness.yml"), "same"),
        "RESTORE_TARGET_DATABASE_URL": (("restore-new-database.yml",), "same"),
    },
    "gh-pages-automacao": {
        "DATABASE_URL": (("plan-probe.yml",), "same"),
    },
    "sandbox-financial-approved": {
        "CERTIFICATION_DATABASE_URL": (("certification-isolated-deploy.yml",), "isolated"),
    },
}
HEALTH_URL = "https://zevanory.api.br/api/health"
HEX64 = re.compile(r"[0-9a-f]{64}")
GHA = os.environ.get("GITHUB_ACTIONS") == "true"


def say(line):
    print(line, flush=True)


def err(title, msg):
    say(f"::error title={title}::{msg}" if GHA else f"ERROR {title}: {msg}")


def mask(value):
    if GHA and value:
        say(f"::add-mask::{value}")


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def identity(url):
    """(host_sha256, endpoint_sha256|None, pooled) ou None se não for uma URL postgres com host."""
    try:
        parts = urlsplit(str(url).strip())
        host = (parts.hostname or "").lower().rstrip(".")
    except ValueError:
        return None
    if parts.scheme not in ("postgres", "postgresql") or not host or not re.fullmatch(r"[a-z0-9.-]+", host):
        return None
    first, _, rest = host.partition(".")
    pooled = first.endswith("-pooler")
    first = first[: -len("-pooler")] if pooled else first
    norm = f"{first}.{rest}" if rest else first
    endpoint = first if re.fullmatch(r"ep-[a-z0-9-]+", first) else None
    for v in (host, norm, endpoint, parts.username, parts.password):
        mask(v)
    return sha(norm), (sha(endpoint) if endpoint else None), pooled


def expected():
    exp = os.environ.get("EXPECTED_HOST_SHA256", "").strip().lower()
    if not HEX64.fullmatch(exp):
        raise SystemExit(fail("DBURL_INVENTORY_INPUT", "EXPECTED_HOST_SHA256 tem de ser 64 hex (sha256 do host do zevanory-db-2)"))
    return exp


def fail(title, msg):
    err(title, msg)
    return 1


def cmd_consumers(env_name):
    if env_name not in CONSUMERS:
        return fail("DBURL_INVENTORY_INPUT", "environment fora da tabela")
    exp = expected()
    bad = []
    for secret, (workflows, rule) in sorted(CONSUMERS[env_name].items()):
        raw = os.environ.get(f"DBINV_{secret}", "")
        ident = identity(raw) if raw.strip() else None
        if not raw.strip():
            status, h, e, pooled = "ABSENT", "none", "none", "-"
        elif ident is None:
            status, h, e, pooled = "UNPARSEABLE", "none", "none", "-"
        else:
            h, e, pooled = ident[0], ident[1] or "none", "yes" if ident[2] else "no"
            same = h == exp
            status = ("MATCH" if same else "MISMATCH") if rule == "same" else ("ISOLATED" if not same else "NOT_ISOLATED")
        say(f"DBURL_CONSUMER env={env_name} secret={secret} workflows={','.join(workflows)} rule={rule} "
            f"host_sha256={h} endpoint_sha256={e} pooled={pooled} status={status}")
        if status not in ("MATCH", "ISOLATED"):
            bad.append(f"{secret}[{','.join(workflows)}]={status}")
    if bad:
        return fail("DBURL_INVENTORY_FAIL", f"env={env_name} " + " ".join(bad))
    say(f"DBURL_INVENTORY=PASS env={env_name} consumers={len(CONSUMERS[env_name])}")
    return 0


def cmd_worker():
    exp = expected()
    fd, out = tempfile.mkstemp(prefix="health-", dir=os.environ.get("RUNNER_TEMP") or None)
    os.close(fd)
    try:
        p = subprocess.run(["curl", "-sS", "--max-time", "20", "-o", out, "-w", "%{http_code}",
                            "-A", "ZEVANORY-Monitor/1.0 (+database-url-consumer-inventory)", HEALTH_URL],
                           capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=40)
        code = p.stdout.strip()[-3:] if p.returncode == 0 else "000"
        try:
            data = json.load(open(out))
        except Exception:
            data = None
    finally:
        os.remove(out)
    got = data.get("database_host_sha256") if isinstance(data, dict) else None
    if code not in ("200", "503") or not isinstance(data, dict):
        status = f"HTTP_{code}"
    elif got is None:
        status = "MISSING_FIELD"  # o commit classe B (campo no /api/health) ainda não está no ar
    elif not (isinstance(got, str) and HEX64.fullmatch(got)):
        status = "INVALID_FIELD"
    else:
        status = "MATCH" if got == exp else "MISMATCH"
    shown = got if isinstance(got, str) and HEX64.fullmatch(got) else "none"
    say(f"DBURL_CONSUMER env=cloudflare-worker secret=DATABASE_URL workflows=worker:zevanory rule=same "
        f"host_sha256={shown} endpoint_sha256=n/a pooled=n/a status={status}")
    if status != "MATCH":
        return fail("DBURL_INVENTORY_FAIL", f"env=cloudflare-worker DATABASE_URL[worker:zevanory]={status}")
    say("DBURL_INVENTORY=PASS env=cloudflare-worker consumers=1")
    return 0


def main(argv):
    if len(argv) == 3 and argv[1] == "consumers":
        return cmd_consumers(argv[2])
    if len(argv) == 2 and argv[1] == "worker":
        return cmd_worker()
    return fail("DBURL_INVENTORY_USAGE", "uso: database_url_inventory.py consumers ENVIRONMENT | worker")


if __name__ == "__main__":
    sys.exit(main(sys.argv))
