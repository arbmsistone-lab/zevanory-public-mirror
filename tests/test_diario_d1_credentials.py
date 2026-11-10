"""DEC-P20-D1-01 (contra-auditor GPT-6): credenciais dedicadas para o diário D1 no deploy central, e o NO-GO do GPT-6
sobre o primeiro deploy com D1 (NC-P2b-DEP-01/02): modos off, certificar e rollback (input diario_d1).

Regra: o token compartilhado do deploy (CLOUDFLARE_PUBLIC_OWNER_API_TOKEN || CLOUDFLARE_API_TOKEN) nunca toca o D1;
a migração usa SÓ CF_TOKEN_D1_DIARIO_MIGRATE (D1 Edit) e o readback SÓ CF_TOKEN_D1_DIARIO_READ (D1 Read), cada um
entregue no env do PRÓPRIO passo (nunca no do job) e SÓ em diario_d1=certificar (em off/rollback o valor é vazio).
off (padrão) e rollback: nenhuma chamada D1 e candidato sem o binding DIARIO, mesmo com os segredos cadastrados.
certificar é fail-closed: segredo ausente, banco inacessível, migração que falha ou esquema que não confere tiram o
binding e reprovam o job ANTES da promoção; o readback depois do deploy é obrigatório e reprova o job.

Como prova: lê o workflow REAL (sem PyYAML), simula o env que o GitHub monta para cada passo (env do job sobreposto
pelo env do passo, com segredos falsos de valores distintos) e EXECUTA o texto real dos passos com curl e npx falsos
que registram o token de cada chamada. Nada sai da máquina. Mutantes no fim: cada um precisa ser pego.
Doc: docs/p20/diario-d1.md, seções "Credenciais dedicadas (DEC-P20-D1-01)" e "Primeiro deploy com D1". Registro:
ops/publishers.json (services.zevanory.d1_credentials). Detector T1: scripts/deploy/t1-write-scan.mjs (PR #990).
"""
import importlib.util
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import gh_actions_sim  # noqa: E402

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/central-production-deploy.yml"
REGISTRY = ROOT / "ops/publishers.json"
T1_SCAN = ROOT / "scripts/deploy/t1-write-scan.mjs"
_spec = importlib.util.spec_from_file_location("diario_d1_certify", ROOT / "scripts/deploy/diario_d1_certify.py")
CERT = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(CERT)

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
MODOS = ("certificar", "off", "rollback", "")
# Mesmo critério do detector T1 do PR #990 (classe d1): comando D1 remoto ou REST /d1/database.
D1_CALL = re.compile(r"""d1[\s"',]+(?:execute|migrations[\s"',]+apply)\b|/d1/database\b""")
SQL_WRITE = re.compile(r"(?i)\b(insert|update|delete|drop|create|alter|replace|pragma|attach|vacuum)\b")

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
# `d1 execute` (SELECT de certificação) e `d1 migrations apply` respondem separadamente.
FAKE_NPX = r"""#!/usr/bin/env bash
printf 'npx token=%s args=%s\n' "${CLOUDFLARE_API_TOKEN:-}" "$*" >> "$FAKE_CALL_LOG"
case " $* " in
  *" d1 execute "*) printf '%s\n' "${FAKE_EXEC_OUT-}"; exit "${FAKE_EXEC_RC:-0}";;
esac
printf '%s\n' "$FAKE_NPX_OUT"
exit "${FAKE_NPX_RC:-0}"
"""


def exec_out(head=1, migs=None, objs=None, abandono=0):
    """Saída de `wrangler d1 execute --json` para o SELECT de certificação (por padrão: o banco certificado)."""
    row = {"diario_head": head,
           "migracoes": ",".join(CERT.MIGRACOES_ESPERADAS if migs is None else migs),
           "objetos": ",".join(sorted(f"{t}:{n}" for t, n in CERT.objetos_esperados()) if objs is None else objs)}
    row.update({t: abandono for t in CERT.tabelas_abandono()})
    return json.dumps([{"results": [row], "success": True, "meta": {}}])


def antes_ok(**kw):
    return json.dumps(CERT.resumo(json.loads(exec_out(**kw))), sort_keys=True, separators=(",", ":"))


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
    """Avalia a expressão do GitHub (tests/gh_actions_sim.py: ||, &&, ==, !=, secrets.*, steps.*, needs.*, aspas).
    P21 (ops/token-cutover.json): sem saída explícita, o interruptor do job p21_token vale 'false' (estado de hoje)."""
    outs = {"needs.p21_token.outputs.cutover": "false", **(outputs or {})}
    return gh_actions_sim.evaluate_value(value, gh_actions_sim.resolver(secrets, outs))


def effective_env(job, step, secrets, outputs=None):
    outputs = outputs or {}
    env = {k: evaluate(v, secrets, outputs) for k, v in job["env"].items()}
    env.update({k: evaluate(v, secrets, outputs) for k, v in step["env"].items()})
    return env


def find_step(jobs, prefix, job="deploy"):
    hit = [s for s in jobs[job]["steps"] if s["name"].startswith(prefix)]
    assert len(hit) == 1, (prefix, [s["name"] for s in hit])
    return hit[0]



def run_step(text, prefix, secrets, modo="certificar", cfg=None, outputs=None, curl_code="200", curl_body=None, npx_rc=0,
             npx_out="", exec_rc=0, exec_stdout=None, extra=None):
    """Executa o texto real do passo com o env que o GitHub montaria (modo = needs.guard.outputs.diario_d1).
    Devolve (proc, saídas do passo, cfg final, chamadas, env)."""
    jobs = parse(text)
    job = jobs["deploy"]
    step = find_step(jobs, prefix)
    d = pathlib.Path(tempfile.mkdtemp())
    try:
        (d / "bin").mkdir()
        for n, body in (("curl", FAKE_CURL), ("npx", FAKE_NPX)):
            (d / "bin" / n).write_text(body, encoding="utf-8")
            (d / "bin" / n).chmod(0o755)
        for rel in ("scripts", "migrations"):
            (d / rel).symlink_to(ROOT / rel)
        if cfg is None:
            cfg = {"name": "zevanory", "d1_databases": [dict(DIARIO)]} if modo == "certificar" else {"name": "zevanory"}
        (d / "wrangler.central-fix.jsonc").write_text(json.dumps(cfg), encoding="utf-8")
        (d / "out").write_text("", encoding="utf-8")
        outs = {"needs.guard.outputs.diario_d1": modo, **(outputs or {})}
        senv = effective_env(job, step, secrets, outs)
        body = curl_body if curl_body is not None else json.dumps({"success": True, "result": {"name": "zevanory-diario-p20"}})
        base = {k: v for k, v in os.environ.items() if not k.startswith(("CLOUDFLARE_", "CF_TOKEN_", "DIARIO_"))}
        env = dict(base, **senv, PATH=f"{d / 'bin'}:{os.environ['PATH']}", GITHUB_OUTPUT=str(d / "out"),
                   FAKE_CALL_LOG=str(d / "calls"), FAKE_CURL_CODE=curl_code, FAKE_CURL_BODY=body,
                   FAKE_NPX_RC=str(npx_rc), FAKE_NPX_OUT=npx_out, FAKE_EXEC_RC=str(exec_rc),
                   FAKE_EXEC_OUT=exec_out() if exec_stdout is None else exec_stdout, PYTHONDONTWRITEBYTECODE="1")
        env.update(extra or {})  # simula um valor que vazasse para o processo (o env efetivo devolvido segue o do GitHub)
        p = subprocess.run(["bash", "-c", step["run"]], cwd=d, env=env, capture_output=True, text=True, timeout=60)
        so = {}
        for line in (d / "out").read_text(encoding="utf-8").split("\n"):
            if "=" in line:
                k, v = line.split("=", 1)
                so[k] = v
        calls = (d / "calls").read_text(encoding="utf-8").splitlines() if (d / "calls").exists() else []
        final = json.loads((d / "wrangler.central-fix.jsonc").read_text(encoding="utf-8"))
        return p, so, final, calls, senv
    finally:
        shutil.rmtree(d, True)


def without(*names):
    return {k: v for k, v in SECRETS.items() if k not in names}


def tokens(calls):
    return [re.search(r"token=(\S*)", c).group(1) for c in calls]


def has_diario(cfg):
    return any(r.get("binding") == "DIARIO" for r in cfg.get("d1_databases") or [])


READ_OK = {"steps.diariomig.outputs.state": "certificado_pre", "steps.diariobinding.outputs.state": "PASS"}


def read_outputs(**kw):
    o = dict(READ_OK, **{"steps.diariomig.outputs.antes": antes_ok()})
    o.update(kw)
    return o


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
        want = "${{ needs.guard.outputs.diario_d1 == 'certificar' && secrets.%s || '' }}" % secret
        assert find_step(jobs, prefix)["env"][secret] == want, f"{secret}: só em certificar e sem queda para outro segredo"


def check_effective_env_isolation(text):
    """Para TODO passo de TODO job e TODO modo: a credencial dedicada só existe no env do seu passo e só em certificar;
    nos dois passos D1 nenhum valor do token compartilhado chega ao processo, com e sem os segredos dedicados."""
    jobs = parse(text)
    for modo in MODOS:
        for secrets in (SECRETS, without(MIG_NAME), without(RD_NAME), without(MIG_NAME, RD_NAME)):
            for jn, job in jobs.items():
                for s in job["steps"]:
                    env = effective_env(job, s, secrets, {"steps.diariomig.outputs.state": "certificado_pre",
                                                          "needs.guard.outputs.diario_d1": modo})
                    vals = set(env.values())
                    is_mig, is_read = jn == "deploy" and s["name"].startswith(MIG), jn == "deploy" and s["name"].startswith(READ)
                    cert = modo == "certificar"
                    assert ("tok-d1-migrate" in vals) == (cert and is_mig and MIG_NAME in secrets), f"token de migração em {jn}/{s['name']} (modo {modo!r})"
                    assert ("tok-d1-read" in vals) == (cert and is_read and RD_NAME in secrets), f"token de leitura em {jn}/{s['name']} (modo {modo!r})"
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
    reads = [l for l in rb.split("\n") if D1_CALL.search(l)]
    assert len(reads) == 1, reads
    assert "CF_TOKEN_D1_DIARIO_READ" in reads[0], "chamada D1 do readback sem o token de leitura explícito"
    assert re.search(r'd1 execute zevanory-diario-p20 --remote .*--command "\$SQL"', reads[0]), "readback só com o SELECT fixo"
    for t in (mig, rb):
        assert 'SQL="$(python3 scripts/deploy/diario_d1_certify.py sql)"' in t, "a SQL vem só do script de certificação"
    sql = CERT.sql_certificacao()
    assert sql.lower().startswith("select ") and ";" not in sql and not SQL_WRITE.search(sql), "SELECT único e só de leitura"
    assert not re.search(r"(?i)\b(insert|update|delete|drop|create|alter)\b", rb), "readback somente leitura"
    assert "CF_TOKEN_D1_DIARIO_MIGRATE" not in rb, "readback nunca cai para o token de migração"
    # NC-P2b-DEP-01: nenhum caminho do workflow apaga tabela ou banco D1.
    assert not re.search(r"(?i)\bdrop\s+(table|index|trigger)\b|\bdelete\s+from\b|d1 delete\b", text), "as tabelas nunca são apagadas"


def check_runtime_certificar_ok(text):
    p, so, cfg, calls, _ = run_step(text, MIG, SECRETS, npx_out="✅ 0001_diario_v1.sql")
    assert p.returncode == 0, p.stdout + p.stderr
    assert so.get("state") == "certificado_pre", so
    assert cfg["d1_databases"] == [DIARIO]
    assert len(calls) == 3 and calls[0].startswith("curl ") and calls[1].startswith("npx ") and calls[2].startswith("npx "), calls
    assert f"/accounts/{ACCOUNT}/d1/database/{DB_ID}" in calls[0], calls[0]
    assert "d1 migrations apply zevanory-diario-p20 --remote" in calls[1], calls[1]
    assert "d1 execute zevanory-diario-p20 --remote" in calls[2] and "select (select count(*) from diario_head)" in calls[2], calls[2]
    assert tokens(calls) == ["tok-d1-migrate"] * 3, calls
    assert json.loads(so["antes"]) == json.loads(antes_ok()), so.get("antes")
    assert "::notice title=DIARIO_D1_PRE_PROMOCAO::PASS" in p.stdout, p.stdout


def _assert_fail_closed(p, so, cfg, title):
    assert p.returncode == 1, (title, p.stdout, p.stderr)
    assert f"::error title={title}::" in p.stdout, (title, p.stdout)
    assert so.get("state") == "falhou" and not has_diario(cfg), (title, so, cfg)


def check_runtime_missing_migrate_secret(text):
    # curl falso responderia 200: quem reprova é a ausência do segredo, não a API.
    p, so, cfg, calls, env = run_step(text, MIG, without(MIG_NAME))
    _assert_fail_closed(p, so, cfg, "DIARIO_D1_TOKEN_DEDICADO_AUSENTE")
    assert calls == [], f"sem o segredo dedicado nenhuma chamada D1 sai: {calls}"
    assert not [k for k, v in env.items() if v in SHARED_VALUES], "o compartilhado não pode substituir o dedicado"


def check_runtime_dedicated_without_access(text):
    p, so, cfg, calls, _ = run_step(text, MIG, SECRETS, curl_code="403", curl_body='{"success":false}')
    _assert_fail_closed(p, so, cfg, "DIARIO_D1_BANCO_INACESSIVEL")
    assert "D1 > Editar" in p.stdout
    assert tokens(calls) == ["tok-d1-migrate"], calls
    p, so, cfg, calls, _ = run_step(text, MIG, SECRETS, curl_body='{"success":true,"result":{"name":"outro"}}')
    _assert_fail_closed(p, so, cfg, "DIARIO_D1_BANCO_DIVERGENTE")
    assert len(calls) == 1, calls


def check_runtime_migration_failure_no_binding(text):
    for out in ("Authentication error [code: 10000]", "SQLITE_ERROR: near x: syntax error"):
        p, so, cfg, calls, _ = run_step(text, MIG, SECRETS, npx_rc=1, npx_out=out)
        _assert_fail_closed(p, so, cfg, "DIARIO_D1_MIGRACAO_FALHOU")
        assert "token do deploy" not in p.stdout, "a mensagem não pode mandar ampliar o token compartilhado"
        assert set(tokens(calls)) == {"tok-d1-migrate"} and not any(" d1 execute " in c for c in calls), calls


def check_runtime_schema_mismatch_no_binding(text):
    objs = sorted(f"{t}:{n}" for t, n in CERT.objetos_esperados())
    for name, kw in (("head 0", dict(exec_stdout=exec_out(head=0))),
                     ("só 2 migrações", dict(exec_stdout=exec_out(migs=CERT.MIGRACOES_ESPERADAS[:2]))),
                     ("gatilho ausente", dict(exec_stdout=exec_out(objs=[o for o in objs if o != "trigger:abandono_supressao_v1_sem_delete"]))),
                     ("objeto a mais", dict(exec_stdout=exec_out(objs=objs + ["table:intrusa"]))),
                     ("abandono com linha", dict(exec_stdout=exec_out(abandono=1))),
                     ("SELECT falha", dict(exec_rc=1, exec_stdout="no such table: abandono_envio_v1"))):
        p, so, cfg, calls, _ = run_step(text, MIG, SECRETS, npx_out="✅", **kw)
        title = "DIARIO_D1_VERIFICACAO_FALHOU" if name == "SELECT falha" else "DIARIO_D1_ESQUEMA_INESPERADO"
        _assert_fail_closed(p, so, cfg, title)
        assert "antes" not in so, name


def check_runtime_off_and_rollback_never_touch_d1(text):
    """off (padrão) e rollback: nenhuma chamada D1 e candidato sem DIARIO, MESMO com os segredos cadastrados (e mesmo se
    um segredo vazasse para o env do passo)."""
    for modo in ("off", "rollback", ""):
        for extra in (None, {MIG_NAME: "tok-d1-migrate"}):
            p, so, cfg, calls, env = run_step(text, MIG, SECRETS, modo=modo, npx_out="✅", extra=extra)
            assert p.returncode == 0 and so.get("state") == "desligado" and calls == [] and not has_diario(cfg), (modo, p.stdout, calls)
            assert env.get(MIG_NAME) == "", f"segredo de migração entregue em modo {modo!r}"
        p, so, cfg, calls, _ = run_step(text, MIG, SECRETS, modo=modo, cfg={"name": "zevanory", "d1_databases": [dict(DIARIO)]})
        assert p.returncode == 1 and "::error title=DIARIO_D1_BINDING::" in p.stdout and calls == [] and not has_diario(cfg), (modo, p.stdout)
        p, _, _, calls, env = run_step(text, READ, SECRETS, modo=modo, outputs=read_outputs())
        assert p.returncode == 0 and calls == [] and env.get(RD_NAME) == "", (modo, p.stdout, calls)


def check_runtime_readback_certifies(text):
    p, _, _, calls, _ = run_step(text, READ, SECRETS, outputs=read_outputs())
    assert p.returncode == 0, p.stdout + p.stderr
    assert "::notice title=DIARIO_D1_CERTIFICACAO::PASS" in p.stdout, p.stdout
    assert len(calls) == 1 and "d1 execute zevanory-diario-p20 --remote" in calls[0], calls
    assert tokens(calls) == ["tok-d1-read"], calls


def check_runtime_readback_fails_job(text):
    """O readback é obrigatório: toda falha reprova (exit 1), nunca vira aviso, e não há continue-on-error."""
    block = find_step(parse(text), READ)["block"]
    assert "continue-on-error" not in block, "readback da certificação nunca é continue-on-error"
    cases = {
        "SELECT falha": dict(exec_rc=1, exec_stdout="no such table: diario_head"),
        "diario_head 0": dict(exec_stdout=exec_out(head=0)),
        "abandono com linha depois": dict(exec_stdout=exec_out(abandono=1)),
        "antes diferente": dict(outputs=read_outputs(**{"steps.diariomig.outputs.antes": antes_ok(abandono=2)})),
        "antes ausente": dict(outputs=read_outputs(**{"steps.diariomig.outputs.antes": ""})),
        "binding não comprovado": dict(outputs=read_outputs(**{"steps.diariobinding.outputs.state": "NAO_COMPROVADO"})),
        "pré-promoção não certificada": dict(outputs=read_outputs(**{"steps.diariomig.outputs.state": "pendente"})),
        "segredo de leitura ausente": dict(secrets=without(RD_NAME)),
    }
    for name, kw in cases.items():
        secrets = kw.pop("secrets", SECRETS)
        kw.setdefault("outputs", read_outputs())
        p, _, _, calls, _ = run_step(text, READ, secrets, **kw)
        assert p.returncode == 1 and "::error title=DIARIO_D1_READBACK::" in p.stdout, (name, p.stdout, p.stderr)
        assert "DIARIO_D1_CERTIFICACAO::PASS" not in p.stdout, name
        if name in ("binding não comprovado", "pré-promoção não certificada", "segredo de leitura ausente"):
            assert calls == [], (name, calls)


def check_runtime_deploy_keeps_shared_token_and_no_d1(text):
    p, _, _, calls, _ = run_step(text, DEPLOY, SECRETS, npx_out="Uploaded zevanory")
    assert p.returncode == 0, p.stdout + p.stderr
    assert len(calls) == 1 and " deploy --strict " in calls[0], calls
    assert tokens(calls) == ["tok-shared-owner"], "o deploy continua com o token atual"
    assert not D1_CALL.search(calls[0])


def check_pipeline_shared_token_never_reaches_d1(text):
    seen = []
    for modo in MODOS:
        for secrets in (SECRETS, without(MIG_NAME), without(RD_NAME)):
            _, so, _, calls, _ = run_step(text, MIG, secrets, modo=modo, npx_out="✅")
            seen += calls
            _, _, _, calls, _ = run_step(text, READ, secrets, modo=modo, outputs=read_outputs(**{"steps.diariomig.outputs.state": so.get("state", "")}))
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
    assert "certificar" in reg["modes"]["only_in"] and reg["modes"]["default"] == "off"
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
          check_runtime_certificar_ok, check_runtime_missing_migrate_secret, check_runtime_dedicated_without_access,
          check_runtime_migration_failure_no_binding, check_runtime_schema_mismatch_no_binding,
          check_runtime_off_and_rollback_never_touch_d1, check_runtime_readback_certifies, check_runtime_readback_fails_job,
          check_runtime_deploy_keeps_shared_token_and_no_d1, check_pipeline_shared_token_never_reaches_d1,
          check_registry_matches_workflow, check_t1_detector]


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


GATE = "needs.guard.outputs.diario_d1 == 'certificar' && "
MIG_ENV_MIG = "          CF_TOKEN_D1_DIARIO_MIGRATE: ${{ " + GATE + "secrets.CF_TOKEN_D1_DIARIO_MIGRATE || '' }}\n"
FALHA_EXIT = "este deploy NÃO é promovido (a produção fica como estava).\"\n            exit 1"
MUTANTS = {
    "M1 migração herda CLOUDFLARE_API_TOKEN do job": _in_step(MIG, '          CLOUDFLARE_API_TOKEN: ""\n', ""),
    "M2 readback herda CLOUDFLARE_PUBLIC_OWNER_API_TOKEN do job": _in_step(READ, '          CLOUDFLARE_PUBLIC_OWNER_API_TOKEN: ""\n', ""),
    "M3 queda do dedicado para o compartilhado": _sub("secrets.CF_TOKEN_D1_DIARIO_MIGRATE || ''", "secrets.CF_TOKEN_D1_DIARIO_MIGRATE || secrets.CLOUDFLARE_PUBLIC_OWNER_API_TOKEN"),
    "M4 token de migração no env do job": lambda t: _sub(MIG_ENV_MIG, "")(t).replace(
        "    env:\n      CLOUDFLARE_PUBLIC_OWNER_API_TOKEN:", "    env:\n" + MIG_ENV_MIG[4:] + "      CLOUDFLARE_PUBLIC_OWNER_API_TOKEN:", 1),
    "M5 readback com o token de migração": _sub("secrets.CF_TOKEN_D1_DIARIO_READ ||", "secrets.CF_TOKEN_D1_DIARIO_MIGRATE ||"),
    "M6 pré-checagem com o token do job": _sub('-H "Authorization: Bearer $CF_TOKEN_D1_DIARIO_MIGRATE"', '-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"'),
    "M7 migração sem o token dedicado no wrangler": _sub('if ! CLOUDFLARE_API_TOKEN="$CF_TOKEN_D1_DIARIO_MIGRATE" npx --yes wrangler@4.143.0 d1 migrations', "if ! npx --yes wrangler@4.143.0 d1 migrations"),
    "M8 sem a guarda do segredo de migração ausente": _sub('[ -n "${CF_TOKEN_D1_DIARIO_MIGRATE:-}" ] || falha', "true || falha"),
    "M9 sem a guarda do segredo de leitura ausente": _sub('[ -n "${CF_TOKEN_D1_DIARIO_READ:-}" ] || reprova', "true || reprova"),
    "M10 chamada D1 com o token compartilhado em outro passo": _sub(
        "          python3 scripts/deploy/verify-exact-release-final.py\n",
        '          npx --yes wrangler@4.143.0 d1 execute zevanory-diario-p20 --remote --command "select 1"\n          python3 scripts/deploy/verify-exact-release-final.py\n'),
    "M11 readback cai para o token de migração": _sub('CLOUDFLARE_API_TOKEN="$CF_TOKEN_D1_DIARIO_READ" npx',
                                                      'CLOUDFLARE_API_TOKEN="${CF_TOKEN_D1_DIARIO_READ:-$CF_TOKEN_D1_DIARIO_MIGRATE}" npx'),
    "M12 falha da certificação mantém o binding": _in_step(MIG, "falha() {\n            drop_binding\n", "falha() {\n            true\n"),
    # NO-GO do GPT-6 (NC-P2b-DEP-02): modos e fail-closed.
    "M13 segredo de migração entregue também em off/rollback": _sub(GATE + "secrets.CF_TOKEN_D1_DIARIO_MIGRATE", "secrets.CF_TOKEN_D1_DIARIO_MIGRATE"),
    "M14 segredo de leitura entregue também em off/rollback": _sub(GATE + "secrets.CF_TOKEN_D1_DIARIO_READ", "secrets.CF_TOKEN_D1_DIARIO_READ"),
    "M15 off migra (sem a guarda do modo no passo)": _in_step(MIG, 'if [ "$modo" != "certificar" ]; then', "if false; then"),
    "M16 falha da certificação não reprova (vira best-effort)": _in_step(MIG, FALHA_EXIT, FALHA_EXIT[:-1] + "0"),
    "M17 migração ignora o resultado da conferência do esquema": _in_step(MIG, '[ "$rc" = "0" ] || falha', "true || falha"),
    "M18 off segue com DIARIO no candidato": _in_step(MIG, "Deploy reprovado antes da promoção.\"\n              exit 1", "Deploy reprovado antes da promoção.\"\n              exit 0"),
    "M19 readback com continue-on-error": _in_step(READ, "        shell: bash\n", "        continue-on-error: true\n        shell: bash\n"),
    "M20 readback que falha vira aviso": _in_step(READ, "volta à versão sem DIARIO.\"; exit 1; }", "volta à versão sem DIARIO.\"; exit 0; }"),
    "M21 readback não exige o binding efetivo PASS": _in_step(READ, '[ "${DIARIO_BINDING_STATE:-}" = "PASS" ] || reprova', "true || reprova"),
    "M22 readback ignora o resultado da conferência (antes x depois)": _in_step(READ, '[ "$rc" = "0" ] || reprova', "true || reprova"),
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

    def test_c1_cada_segredo_dedicado_so_no_seu_passo_e_so_em_certificar(self):
        check_secret_only_in_its_step(self.TEXT)

    def test_c2_env_efetivo_de_todos_os_passos_em_todos_os_modos(self):
        check_effective_env_isolation(self.TEXT)

    def test_c3_chamadas_d1_so_nos_passos_autorizados_e_sem_apagar_tabela(self):
        check_d1_calls_only_in_authorized_steps(self.TEXT)

    def test_c4_certificar_migra_e_confere_com_o_token_dedicado(self):
        check_runtime_certificar_ok(self.TEXT)

    def test_c5_sem_segredo_dedicado_reprova_e_sem_binding(self):
        check_runtime_missing_migrate_secret(self.TEXT)

    def test_c6_banco_inacessivel_ou_divergente_reprova_e_sem_binding(self):
        check_runtime_dedicated_without_access(self.TEXT)

    def test_c7_migracao_falha_reprova_e_sem_binding(self):
        check_runtime_migration_failure_no_binding(self.TEXT)

    def test_c8_esquema_inesperado_reprova_e_sem_binding(self):
        check_runtime_schema_mismatch_no_binding(self.TEXT)

    def test_c9_off_e_rollback_nunca_tocam_o_d1_mesmo_com_segredos(self):
        check_runtime_off_and_rollback_never_touch_d1(self.TEXT)

    def test_c10_readback_certifica_com_o_token_de_leitura(self):
        check_runtime_readback_certifies(self.TEXT)

    def test_c11_readback_que_falha_reprova_o_job(self):
        check_runtime_readback_fails_job(self.TEXT)

    def test_c12_deploy_continua_com_o_token_atual_e_sem_d1(self):
        check_runtime_deploy_keeps_shared_token_and_no_d1(self.TEXT)

    def test_c13_compartilhado_nunca_recebe_chamada_d1(self):
        check_pipeline_shared_token_never_reaches_d1(self.TEXT)

    def test_c14_registro_em_ops_publishers(self):
        check_registry_matches_workflow(self.TEXT)

    def test_c15_detector_t1_registra_a_escrita_d1_com_a_credencial_dedicada(self):
        check_t1_detector(self.TEXT)

    def test_c16_mutantes_morrem(self):
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
