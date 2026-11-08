"""DEC-P20-D1-01 (contra-auditor GPT-6): credenciais dedicadas para o diário D1 no deploy central.

Regra: o token compartilhado do deploy (CLOUDFLARE_PUBLIC_OWNER_API_TOKEN || CLOUDFLARE_API_TOKEN) nunca toca o D1;
a migração usa SÓ CF_TOKEN_D1_DIARIO_MIGRATE (D1 Edit) e o readback SÓ CF_TOKEN_D1_DIARIO_READ (D1 Read), cada um
entregue no env do PRÓPRIO passo (nunca no do job). Sem o segredo dedicado: aviso e deploy sem o binding DIARIO.

Como prova: lê o workflow REAL (sem PyYAML), simula o env que o GitHub monta para cada passo (env do job sobreposto
pelo env do passo, com segredos falsos de valores distintos) e EXECUTA o texto real dos passos com curl e npx falsos
que registram o token de cada chamada. Nada sai da máquina. Mutantes no fim: cada um precisa ser pego.
Doc: docs/p20/diario-d1.md, seção "Credenciais dedicadas (DEC-P20-D1-01)". Registro: ops/publishers.json
(services.zevanory.d1_credentials). Detector T1: scripts/deploy/t1-write-scan.mjs quando existir (PR #990).
"""
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/central-production-deploy.yml"
REGISTRY = ROOT / "ops/publishers.json"
T1_SCAN = ROOT / "scripts/deploy/t1-write-scan.mjs"

ACCOUNT = "1b26415802588185a86c1d4d3ebf5bdb"
DB_ID = "1b1bfa19-ccc5-423a-bc1f-62d89020c8e2"
DIARIO = {"binding": "DIARIO", "database_name": "zevanory-diario-p20", "database_id": DB_ID, "migrations_dir": "migrations/d1"}
MIG = "P20 diário D1 - migrações"
READ = "P20 diário D1 - readback"
DEPLOY = "Deploy repaired production worker"
MIG_NAME, RD_NAME = "CF_TOKEN_D1_DIARIO_MIGRATE", "CF_TOKEN_D1_DIARIO_READ"
SHARED_NAMES = ("CLOUDFLARE_PUBLIC_OWNER_API_TOKEN", "CLOUDFLARE_API_TOKEN")
# Valores falsos, todos distintos, para saber exatamente qual credencial cada chamada recebeu.
SECRETS = {"CLOUDFLARE_PUBLIC_OWNER_API_TOKEN": "tok-shared-owner", "CLOUDFLARE_API_TOKEN": "tok-shared-legacy",
           MIG_NAME: "tok-d1-migrate", RD_NAME: "tok-d1-read"}
SHARED_VALUES = ("tok-shared-owner", "tok-shared-legacy")
# Mesmo critério do detector T1 do PR #990 (classe d1): comando D1 remoto ou REST /d1/database.
D1_CALL = re.compile(r"""d1[\s"',]+(?:execute|migrations[\s"',]+apply)\b|/d1/database\b""")

FAKE_CURL = r"""#!/usr/bin/env bash
out=""; tok=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift;;
    -H) case "$2" in "Authorization: Bearer "*) tok="${2#Authorization: Bearer }";; esac; shift;;
    http*) url="$1";;
  esac; shift
done
printf 'curl token=%s url=%s\n' "$tok" "$url" >> "$FAKE_CALL_LOG"
[ -n "$out" ] && printf '%s' "$FAKE_CURL_BODY" > "$out"
printf '%s' "$FAKE_CURL_CODE"
"""
FAKE_NPX = r"""#!/usr/bin/env bash
printf 'npx token=%s args=%s\n' "${CLOUDFLARE_API_TOKEN:-}" "$*" >> "$FAKE_CALL_LOG"
printf '%s\n' "$FAKE_NPX_OUT"
exit "${FAKE_NPX_RC:-0}"
"""


# ---------------------------------------------------------------------------------------------------------------
# Leitor mínimo do workflow (indentação fixa do arquivo: jobs a 2, env do job a 6, passos a 6, campos do passo a 8).
def parse(text):
    lines = text.split("\n")
    jobs, i = {}, lines.index("jobs:") + 1
    starts = [k for k in range(i, len(lines)) if re.match(r"^  [A-Za-z0-9_-]+:\s*$", lines[k])]
    for n, s in enumerate(starts):
        e = starts[n + 1] if n + 1 < len(starts) else len(lines)
        jobs[lines[s].strip()[:-1]] = _job(lines[s + 1:e])
    return jobs


def _kv(block, indent):
    out = {}
    for l in block:
        m = re.match(r"^" + " " * indent + r"([A-Za-z0-9_]+): ?(.*)$", l)
        if m:
            out[m.group(1)] = m.group(2).strip()
    return out


def _section(block, header, indent):
    """Linhas filhas de `header:` (na indentação dada) até a próxima chave do mesmo nível."""
    pad = " " * indent
    for k, l in enumerate(block):
        if l == pad + header + ":":
            end = next((j for j in range(k + 1, len(block)) if block[j].strip() and not block[j].startswith(pad + "  ")), len(block))
            return block[k + 1:end]
    return []


def _job(block):
    steps_at = next((k for k, l in enumerate(block) if l == "    steps:"), len(block))
    env = _kv(_section(block[:steps_at], "env", 4), 6)
    names = [k for k in range(steps_at, len(block)) if block[k].startswith("      - ")]
    steps = []
    for n, s in enumerate(names):
        e = names[n + 1] if n + 1 < len(names) else len(block)
        sb = ["        " + block[s][8:]] + block[s + 1:e]
        fields = _kv(sb, 8)
        run = []
        r = next((k for k, l in enumerate(sb) if l.startswith("        run: ")), None)
        if r is not None:
            if sb[r].strip() == "run: |":
                run = [l[10:] if l.startswith(" " * 10) else l.strip() for l in sb[r + 1:]]
            else:
                run = [sb[r].split("run: ", 1)[1]]
        steps.append({"name": fields.get("name", fields.get("uses", "")), "id": fields.get("id"),
                      "env": _kv(_section(sb, "env", 8), 10), "run": "\n".join(run), "block": "\n".join(sb)})
    return {"env": env, "steps": steps}


def evaluate(value, secrets, outputs):
    """Avalia o pouco de expressão do GitHub que o arquivo usa: secrets.A || secrets.B || 'lit', steps.*, aspas."""
    m = re.fullmatch(r"\$\{\{\s*(.+?)\s*\}\}", value)
    if not m:
        return value[1:-1] if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'" else value
    for alt in [a.strip() for a in m.group(1).split("||")]:
        if alt.startswith("secrets."):
            v = secrets.get(alt[len("secrets."):], "")
        elif alt.startswith("steps."):
            v = outputs.get(alt, "")
        elif alt.startswith("vars."):  # variáveis de configuração do repositório: não são credenciais
            v = "fake-" + alt
        elif alt in ("github.sha", "github.token"):
            v = "fake-" + alt
        elif alt[:1] == alt[-1:] == "'":
            v = alt[1:-1]
        else:
            raise AssertionError("expressão não suportada pelo simulador: " + alt)
        if v:
            return v
    return ""


def effective_env(job, step, secrets, outputs=None):
    outputs = outputs or {}
    env = {k: evaluate(v, secrets, outputs) for k, v in job["env"].items()}
    env.update({k: evaluate(v, secrets, outputs) for k, v in step["env"].items()})
    return env


def find_step(jobs, prefix, job="deploy"):
    hit = [s for s in jobs[job]["steps"] if s["name"].startswith(prefix)]
    assert len(hit) == 1, (prefix, [s["name"] for s in hit])
    return hit[0]


def run_step(text, prefix, secrets, cfg=None, outputs=None, curl_code="200", curl_body=None, npx_rc=0, npx_out="", extra=None):
    """Executa o texto real do passo com o env que o GitHub montaria. Devolve (proc, state, cfg final, chamadas, env)."""
    jobs = parse(text)
    job = jobs["deploy"]
    step = find_step(jobs, prefix)
    d = pathlib.Path(tempfile.mkdtemp())
    try:
        (d / "bin").mkdir()
        for n, body in (("curl", FAKE_CURL), ("npx", FAKE_NPX)):
            (d / "bin" / n).write_text(body, encoding="utf-8")
            (d / "bin" / n).chmod(0o755)
        cfg = cfg if cfg is not None else {"name": "zevanory", "d1_databases": [dict(DIARIO)]}
        (d / "wrangler.central-fix.jsonc").write_text(json.dumps(cfg), encoding="utf-8")
        (d / "out").write_text("", encoding="utf-8")
        senv = effective_env(job, step, secrets, outputs)
        body = curl_body if curl_body is not None else json.dumps({"success": True, "result": {"name": "zevanory-diario-p20"}})
        base = {k: v for k, v in os.environ.items() if not k.startswith(("CLOUDFLARE_", "CF_TOKEN_"))}
        env = dict(base, **senv, PATH=f"{d / 'bin'}:{os.environ['PATH']}", GITHUB_OUTPUT=str(d / "out"),
                   FAKE_CALL_LOG=str(d / "calls"), FAKE_CURL_CODE=curl_code, FAKE_CURL_BODY=body,
                   FAKE_NPX_RC=str(npx_rc), FAKE_NPX_OUT=npx_out, **(extra or {}))
        p = subprocess.run(["bash", "-c", step["run"]], cwd=d, env=env, capture_output=True, text=True, timeout=60)
        st = [l.split("=", 1)[1] for l in (d / "out").read_text(encoding="utf-8").split("\n") if l.startswith("state=")]
        calls = (d / "calls").read_text(encoding="utf-8").splitlines() if (d / "calls").exists() else []
        final = json.loads((d / "wrangler.central-fix.jsonc").read_text(encoding="utf-8"))
        return p, (st[-1] if st else None), final, calls, senv
    finally:
        shutil.rmtree(d, True)


def without(*names):
    return {k: v for k, v in SECRETS.items() if k not in names}


def tokens(calls):
    return [re.search(r"token=(\S*)", c).group(1) for c in calls]


# ---------------------------------------------------------------------------------------------------------------
# Verificações (recebem o TEXTO do workflow para que os mutantes passem pelo mesmo crivo).
def check_secret_only_in_its_step(text):
    jobs = parse(text)
    for secret, prefix in ((MIG_NAME, MIG), (RD_NAME, READ)):
        refs = re.findall(r"secrets\." + secret + r"\b", text)
        assert len(refs) == 1, f"{secret}: exatamente uma referência no workflow (achadas {len(refs)})"
        for jn, job in jobs.items():
            assert not any(secret in v for v in job["env"].values()), f"{secret} no env do job {jn}"
            for s in job["steps"]:
                has = any("secrets." + secret in v for v in s["env"].values())
                assert has == (jn == "deploy" and s["name"].startswith(prefix)), f"{secret} no passo errado: {jn}/{s['name']}"
        assert find_step(jobs, prefix)["env"][secret] == "${{ secrets.%s }}" % secret, f"{secret}: sem fallback para outro segredo"


def check_effective_env_isolation(text):
    """Para TODO passo de TODO job: a credencial dedicada só existe no env do seu passo; nos dois passos D1 nenhum
    valor do token compartilhado chega ao processo, com e sem os segredos dedicados cadastrados."""
    jobs = parse(text)
    for secrets in (SECRETS, without(MIG_NAME), without(RD_NAME), without(MIG_NAME, RD_NAME)):
        for jn, job in jobs.items():
            for s in job["steps"]:
                env = effective_env(job, s, secrets, {"steps.diariomig.outputs.state": "aplicada"})
                vals = set(env.values())
                is_mig, is_read = jn == "deploy" and s["name"].startswith(MIG), jn == "deploy" and s["name"].startswith(READ)
                assert ("tok-d1-migrate" in vals) == (is_mig and MIG_NAME in secrets), f"token de migração em {jn}/{s['name']}"
                assert ("tok-d1-read" in vals) == (is_read and RD_NAME in secrets), f"token de leitura em {jn}/{s['name']}"
                if is_mig or is_read:
                    leak = [k for k, v in env.items() if v in SHARED_VALUES]
                    assert not leak, f"token compartilhado visível no passo D1 {s['name']}: {leak}"
                    for n in SHARED_NAMES:
                        assert env.get(n) == "", f"{s['name']}: {n} precisa ser sobrescrito com vazio no env do passo"


def check_d1_calls_only_in_authorized_steps(text):
    jobs = parse(text)
    for jn, job in jobs.items():
        for s in job["steps"]:
            if D1_CALL.search(s["run"]):
                assert jn == "deploy" and s["name"].startswith((MIG, READ)), f"chamada D1 fora dos passos autorizados: {jn}/{s['name']}"
    mig, rb = find_step(jobs, MIG)["run"], find_step(jobs, READ)["run"]
    for line in mig.split("\n"):
        if D1_CALL.search(line):
            assert "CF_TOKEN_D1_DIARIO_MIGRATE" in line, "chamada D1 da migração sem o token dedicado explícito: " + line.strip()
    for line in rb.split("\n"):
        if D1_CALL.search(line):
            assert "CF_TOKEN_D1_DIARIO_READ" in line, "chamada D1 do readback sem o token de leitura explícito: " + line.strip()
            assert re.search(r'--command "select count\(\*\) as n from diario_head"', line), "readback só com o SELECT fixo"
    assert not re.search(r"(?i)\b(insert|update|delete|drop|create|alter)\b", rb), "readback somente leitura"
    assert "CF_TOKEN_D1_DIARIO_MIGRATE" not in rb, "readback nunca cai para o token de migração"


def check_runtime_migration_with_dedicated_token(text):
    p, state, cfg, calls, _ = run_step(text, MIG, SECRETS, npx_out="✅ 0001_diario_v1.sql")
    assert p.returncode == 0, p.stdout + p.stderr
    assert state == "aplicada", state
    assert cfg["d1_databases"] == [DIARIO]
    assert len(calls) == 2 and calls[0].startswith("curl ") and calls[1].startswith("npx "), calls
    assert f"/accounts/{ACCOUNT}/d1/database/{DB_ID}" in calls[0], calls[0]
    assert "d1 migrations apply zevanory-diario-p20 --remote" in calls[1], calls[1]
    assert tokens(calls) == ["tok-d1-migrate", "tok-d1-migrate"], calls


def check_runtime_missing_migrate_secret(text):
    # curl falso responderia 200: quem tira o binding é a ausência do segredo, não a API.
    p, state, cfg, calls, env = run_step(text, MIG, without(MIG_NAME))
    assert p.returncode == 0, p.stdout + p.stderr
    assert "::warning title=DIARIO_D1_TOKEN_DEDICADO_AUSENTE::" in p.stdout, p.stdout
    assert state == "binding_removido", state
    assert "d1_databases" not in cfg
    assert calls == [], f"sem o segredo dedicado nenhuma chamada D1 sai: {calls}"
    assert not [k for k, v in env.items() if v in SHARED_VALUES], "o compartilhado não pode substituir o dedicado"


def check_runtime_dedicated_without_access(text):
    p, state, cfg, calls, _ = run_step(text, MIG, SECRETS, curl_code="403", curl_body='{"success":false}')
    assert p.returncode == 0
    assert "::warning title=DIARIO_D1_MIGRACAO_PENDENTE::" in p.stdout and "CF_TOKEN_D1_DIARIO_MIGRATE" in p.stdout, p.stdout
    assert state == "binding_removido" and "d1_databases" not in cfg
    assert tokens(calls) == ["tok-d1-migrate"], calls


def check_runtime_migration_unauthorized(text):
    p, state, cfg, calls, _ = run_step(text, MIG, SECRETS, npx_rc=1, npx_out="Authentication error [code: 10000]")
    assert p.returncode == 0 and state == "pendente" and cfg["d1_databases"] == [DIARIO]
    assert "::warning title=DIARIO_D1_MIGRACAO_PENDENTE::" in p.stdout and "D1 > Editar" in p.stdout, p.stdout
    assert "token do deploy" not in p.stdout, "o aviso não pode mandar ampliar o token compartilhado"
    assert set(tokens(calls)) == {"tok-d1-migrate"}, calls


def check_runtime_readback_with_read_token(text):
    ok = json.dumps([{"results": [{"n": 1}], "success": True}])
    p, _, _, calls, _ = run_step(text, READ, SECRETS, npx_out=ok, outputs={"steps.diariomig.outputs.state": "aplicada"})
    assert p.returncode == 0 and "::notice title=DIARIO_D1_READBACK::diario_head presente (linhas=1)" in p.stdout, p.stdout
    assert len(calls) == 1 and "d1 execute zevanory-diario-p20 --remote" in calls[0], calls
    assert tokens(calls) == ["tok-d1-read"], calls
    # Só o token de migração cadastrado: o readback NÃO roda (sem queda para outra credencial).
    p, _, _, calls, _ = run_step(text, READ, without(RD_NAME), npx_out=ok, outputs={"steps.diariomig.outputs.state": "aplicada"})
    assert p.returncode == 0 and calls == [], calls
    assert "CF_TOKEN_D1_DIARIO_READ ausente" in p.stdout, p.stdout
    p, _, _, calls, _ = run_step(text, READ, SECRETS, outputs={"steps.diariomig.outputs.state": "binding_removido"})
    assert p.returncode == 0 and calls == [], calls


def check_runtime_deploy_keeps_shared_token_and_no_d1(text):
    p, _, _, calls, _ = run_step(text, DEPLOY, SECRETS, npx_out="Uploaded zevanory")
    assert p.returncode == 0, p.stdout + p.stderr
    assert len(calls) == 1 and " deploy --strict " in calls[0], calls
    assert tokens(calls) == ["tok-shared-owner"], "o deploy continua com o token atual"
    assert not D1_CALL.search(calls[0])


def check_pipeline_shared_token_never_reaches_d1(text):
    seen = []
    for secrets in (SECRETS, without(MIG_NAME), without(RD_NAME)):
        _, state, _, calls, _ = run_step(text, MIG, secrets, npx_out="✅")
        seen += calls
        _, _, _, calls, _ = run_step(text, READ, secrets, npx_out='[{"results":[{"n":1}]}]', outputs={"steps.diariomig.outputs.state": state or ""})
        seen += calls
    d1 = [c for c in seen if D1_CALL.search(c)]
    assert d1 and len(d1) == len(seen), seen
    assert not [c for c in d1 if tokens([c])[0] in SHARED_VALUES or tokens([c])[0] == ""], d1


def check_registry_matches_workflow(text):
    reg = json.loads(REGISTRY.read_text(encoding="utf-8"))["services"]["zevanory"]["d1_credentials"]
    assert reg["workflow"] == WORKFLOW.name and reg["environment"] == "producao-critica"
    assert reg["database"] == {"name": "zevanory-diario-p20", "id": DB_ID, "account": ACCOUNT}
    roles = reg["roles"]
    assert roles["migrate"]["secret"] == MIG_NAME and roles["migrate"]["step"] == MIG
    assert roles["read"]["secret"] == RD_NAME and roles["read"]["step"] == READ and roles["read"]["writes"] == []
    assert "D1 > Editar" in roles["migrate"]["permission"] and "D1 > Ler" in roles["read"]["permission"]
    assert roles["deploy"]["d1"].startswith("nenhuma")
    jobs = parse(text)
    assert "environment: producao-critica" in "\n".join(l for l in text.split("\n") if l.startswith("    environment:"))
    for role in ("migrate", "read"):
        s = find_step(jobs, roles[role]["step"])
        assert roles[role]["secret"] in s["env"], role


def check_t1_detector(text):
    """Com o detector T1 (PR #990) na árvore: ele precisa ver a escrita D1 da migração e o inventário precisa
    registrá-la com a credencial dedicada. Sem ele: o detector local (mesmo critério da classe d1) acha UMA rota
    de escrita D1 remota (migrations apply), no passo de migração, com a credencial dedicada registrada."""
    jobs = parse(text)
    mig = find_step(jobs, MIG)
    if T1_SCAN.exists():
        js = ("import { scanText, TOKEN_OWNER } from %s;\n" % json.dumps(T1_SCAN.as_uri()) +
              "const t = await import('node:fs').then((f) => f.readFileSync(process.argv[1], 'utf8'));\n"
              "console.log(JSON.stringify({ cls: [...new Set(scanText(t).map((f) => f.cls))], owner: TOKEN_OWNER }));")
        with tempfile.NamedTemporaryFile("w", suffix=".yml", delete=False, encoding="utf-8") as fh:
            fh.write(mig["block"])
        try:
            out = subprocess.run(["node", "--input-type=module", "-e", js, fh.name], capture_output=True, text=True, timeout=60)
        finally:
            os.unlink(fh.name)
        assert out.returncode == 0, out.stderr
        got = json.loads(out.stdout)
        assert "d1" in got["cls"], got
        assert got["owner"].get(MIG_NAME) == "zevanory" and got["owner"].get(RD_NAME) == "zevanory", \
            "TOKEN_OWNER do detector precisa listar os tokens D1 dedicados como do serviço zevanory"
        wp = json.loads(REGISTRY.read_text(encoding="utf-8"))["write_paths"]["workflows"][WORKFLOW.name]
        assert "d1" in wp["classes"] and MIG_NAME in json.dumps(wp, ensure_ascii=False), wp
    else:
        writes = [l for s in jobs["deploy"]["steps"] for l in s["run"].split("\n")
                  if re.search(r"""d1[\s"',]+migrations[\s"',]+apply\b""", l) and "--local" not in l]
        assert len(writes) == 1 and writes[0] in mig["run"].split("\n"), writes
        assert "$CF_TOKEN_D1_DIARIO_MIGRATE" in writes[0]
        reg = json.loads(REGISTRY.read_text(encoding="utf-8"))["services"]["zevanory"]["d1_credentials"]["roles"]["migrate"]
        assert any("migrations apply zevanory-diario-p20 --remote" in w for w in reg["writes"]), reg


CHECKS = [check_secret_only_in_its_step, check_effective_env_isolation, check_d1_calls_only_in_authorized_steps,
          check_runtime_migration_with_dedicated_token, check_runtime_missing_migrate_secret,
          check_runtime_dedicated_without_access, check_runtime_migration_unauthorized,
          check_runtime_readback_with_read_token, check_runtime_deploy_keeps_shared_token_and_no_d1,
          check_pipeline_shared_token_never_reaches_d1, check_registry_matches_workflow, check_t1_detector]


def _sub(old, new, count=1):
    def f(t):
        assert t.count(old) >= 1, "mutante não aplicável: " + old[:80]
        return t.replace(old, new, count)
    return f


def _in_step(prefix, old, new):
    """Troca só dentro do bloco do passo (o mesmo texto aparece nos dois passos D1)."""
    def f(t):
        s = t.index("      - name: " + prefix)
        e = t.index("\n      - name: ", s + 1)
        assert old in t[s:e], "mutante não aplicável: " + old[:80]
        return t[:s] + t[s:e].replace(old, new, 1) + t[e:]
    return f


MIG_ENV_MIG = "          CF_TOKEN_D1_DIARIO_MIGRATE: ${{ secrets.CF_TOKEN_D1_DIARIO_MIGRATE }}\n"
MUTANTS = {
    "M1 migração herda CLOUDFLARE_API_TOKEN do job": _in_step(MIG, '          CLOUDFLARE_API_TOKEN: ""\n', ""),
    "M2 readback herda CLOUDFLARE_PUBLIC_OWNER_API_TOKEN do job": _in_step(READ, '          CLOUDFLARE_PUBLIC_OWNER_API_TOKEN: ""\n', ""),
    "M3 queda do dedicado para o compartilhado": _sub("${{ secrets.CF_TOKEN_D1_DIARIO_MIGRATE }}", "${{ secrets.CF_TOKEN_D1_DIARIO_MIGRATE || secrets.CLOUDFLARE_PUBLIC_OWNER_API_TOKEN }}"),
    "M4 token de migração no env do job": lambda t: _sub(MIG_ENV_MIG, "")(t).replace(
        "    env:\n      CLOUDFLARE_PUBLIC_OWNER_API_TOKEN:", "    env:\n" + MIG_ENV_MIG[4:] + "      CLOUDFLARE_PUBLIC_OWNER_API_TOKEN:", 1),
    "M5 readback com o token de migração": _sub("${{ secrets.CF_TOKEN_D1_DIARIO_READ }}", "${{ secrets.CF_TOKEN_D1_DIARIO_MIGRATE }}"),
    "M6 pré-checagem com o token do job": _sub('-H "Authorization: Bearer $CF_TOKEN_D1_DIARIO_MIGRATE"', '-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"'),
    "M7 migração sem o token dedicado no wrangler": _sub('if CLOUDFLARE_API_TOKEN="$CF_TOKEN_D1_DIARIO_MIGRATE" npx', "if npx"),
    "M8 sem a guarda do segredo de migração ausente": _sub('if [ -z "${CF_TOKEN_D1_DIARIO_MIGRATE:-}" ]; then', "if false; then"),
    "M9 sem a guarda do segredo de leitura ausente": _sub('if [ -z "${CF_TOKEN_D1_DIARIO_READ:-}" ]; then', "if false; then"),
    "M10 chamada D1 com o token compartilhado em outro passo": _sub(
        "          python3 scripts/deploy/verify-exact-release-final.py\n",
        '          npx --yes wrangler@4.143.0 d1 execute zevanory-diario-p20 --remote --command "select 1"\n          python3 scripts/deploy/verify-exact-release-final.py\n'),
    "M11 readback cai para o token de migração": _sub('if CLOUDFLARE_API_TOKEN="$CF_TOKEN_D1_DIARIO_READ" npx',
                                                      'if CLOUDFLARE_API_TOKEN="${CF_TOKEN_D1_DIARIO_READ:-$CF_TOKEN_D1_DIARIO_MIGRATE}" npx'),
    "M12 sem segredo dedicado o deploy mantém o binding": _in_step(
        MIG, 'seção Credenciais dedicadas."\n            drop_binding', 'seção Credenciais dedicadas."\n            true'),
}


def violations(text):
    out = []
    for c in CHECKS:
        try:
            c(text)
        except Exception as e:  # noqa: BLE001 - mutante que quebra o simulador também morre
            out.append(f"{c.__name__}: {e}"[:300])
    return out


class DiarioD1DedicatedCredentialsTest(unittest.TestCase):
    TEXT = WORKFLOW.read_text(encoding="utf-8")

    def test_c1_cada_segredo_dedicado_so_no_seu_passo(self):
        check_secret_only_in_its_step(self.TEXT)

    def test_c2_env_efetivo_de_todos_os_passos(self):
        check_effective_env_isolation(self.TEXT)

    def test_c3_chamadas_d1_so_nos_passos_autorizados(self):
        check_d1_calls_only_in_authorized_steps(self.TEXT)

    def test_c4_migracao_com_o_token_dedicado(self):
        check_runtime_migration_with_dedicated_token(self.TEXT)

    def test_c5_sem_segredo_dedicado_aviso_e_sem_binding(self):
        check_runtime_missing_migrate_secret(self.TEXT)

    def test_c6_dedicado_sem_acesso_tira_o_binding(self):
        check_runtime_dedicated_without_access(self.TEXT)

    def test_c7_dedicado_sem_d1_edit_avisa_sem_mandar_ampliar_o_compartilhado(self):
        check_runtime_migration_unauthorized(self.TEXT)

    def test_c8_readback_com_o_token_de_leitura(self):
        check_runtime_readback_with_read_token(self.TEXT)

    def test_c9_deploy_continua_com_o_token_atual_e_sem_d1(self):
        check_runtime_deploy_keeps_shared_token_and_no_d1(self.TEXT)

    def test_c10_compartilhado_nunca_recebe_chamada_d1(self):
        check_pipeline_shared_token_never_reaches_d1(self.TEXT)

    def test_c11_registro_em_ops_publishers(self):
        check_registry_matches_workflow(self.TEXT)

    def test_c12_detector_t1_registra_a_escrita_d1_com_a_credencial_dedicada(self):
        check_t1_detector(self.TEXT)

    def test_c13_mutantes_morrem(self):
        self.assertEqual(violations(self.TEXT), [], "o workflow real passa em todas as verificações")
        survived = {}
        for name, mutate in MUTANTS.items():
            v = violations(mutate(self.TEXT))
            if not v:
                survived[name] = "sobreviveu"
        self.assertEqual(survived, {}, survived)
        print(f"\nMUTANTS total={len(MUTANTS)} killed={len(MUTANTS) - len(survived)} survived={len(survived)}")


if __name__ == "__main__":
    unittest.main()
