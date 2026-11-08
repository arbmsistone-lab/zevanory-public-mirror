"""P21 / R18 (condição C do pedido): credential-scope lê as POLÍTICAS de cada token dedicado e, com cutover=true,
reprova token ausente, inativo, sem TTL, com escrita na conta inteira, em mais de um Worker (vendas: 2, com o candidato
fixo) ou em zona não declarada; com cutover=false o resultado é NOT_PROVEN e nunca reprova (transição segura).

Lógica: scripts/ci/p21_credential_scope.py com respostas falsas de GET /accounts/<conta>/tokens. Passo real: o texto
do passo "P21 effective scope..." do job credential-scope (t1-publisher-guard.yml) é EXECUTADO com curl falso.
Mutantes no fim. Sem rede, sem segredos reais.
"""
import copy
import datetime as dt
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "ci"))
import p21_credential_scope as CS  # noqa: E402
import p21_token_cutover as P  # noqa: E402

ACC = "1b26415802588185a86c1d4d3ebf5bdb"
ZONE = "d8a21b6cfd37843e34f38c3e4ad4030a"
NOW = dt.datetime(2026, 11, 8, tzinfo=dt.timezone.utc)
IDS = {"zevanory": "a" * 32, "zevanory-sales-public": "b" * 32, "zevanory-public-router": "c" * 32, "zevanory-product-control-portable": "d" * 32}
EDITOR = [{"id": "e1", "name": "Workers Editor"}]
ACCOUNT_READ = [{"id": "r1", "name": "Account Settings Read"}]


def wk(name):
    return f"com.cloudflare.edge.worker.script.{ACC}.{name}"


def token(tid, workers, zones_write=(), extra=(), status="active", expires="2027-05-01T00:00:00Z"):
    pols = [{"effect": "allow", "permission_groups": EDITOR, "resources": {wk(w): "*" for w in workers}}] if workers else []
    pols.append({"effect": "allow", "permission_groups": ACCOUNT_READ, "resources": {f"com.cloudflare.api.account.{ACC}": "*"}})
    if zones_write:
        pols.append({"effect": "allow", "permission_groups": [{"id": "z1", "name": "Workers Routes Write"}],
                     "resources": {f"com.cloudflare.api.account.zone.{z}": "*" for z in zones_write}})
        pols.append({"effect": "allow", "permission_groups": [{"id": "z2", "name": "Zone Read"}],
                     "resources": {f"com.cloudflare.api.account.zone.{z}": "*" for z in zones_write}})
    pols += list(extra)
    t = {"id": tid, "name": "p21-" + tid[:4], "status": status, "policies": pols}
    if expires:
        t["expires_on"] = expires
    return t


def good_tokens():
    return [token(IDS["zevanory"], ["zevanory"]),
            token(IDS["zevanory-sales-public"], ["zevanory-sales-public", "zevanory-sales-candidate"]),
            token(IDS["zevanory-public-router"], ["zevanory-public-router"], zones_write=[ZONE]),
            token(IDS["zevanory-product-control-portable"], ["zevanory-product-control-portable"]),
            {"id": "e" * 32, "name": "legado", "status": "active", "policies": [{"effect": "allow", "permission_groups": [{"name": "Workers Scripts Write"}], "resources": {f"com.cloudflare.api.account.{ACC}": "*"}}]}]


def cutover(all_true=True, only=None):
    c = json.loads((ROOT / "ops/token-cutover.json").read_text(encoding="utf-8"))
    for name, s in c["services"].items():
        if all_true or name == only:
            s["cutover"], s["token_id"] = True, IDS[name]
    return c


def states(v):
    return {k: r["state"] for k, r in v["services"].items()}


def codes(v, svc):
    return sorted({f.split(":", 1)[0] for f in v["services"][svc]["fails"]})


def with_token(svc, **kw):
    toks = [t for t in good_tokens() if t["id"] != IDS[svc]]
    return toks + [token(IDS[svc], **kw)]


# ---------------------------------------------------------------------------------------------------------------
def check_today_is_not_proven_and_never_fails():
    real = json.loads((ROOT / "ops/token-cutover.json").read_text(encoding="utf-8"))
    for toks in (None, [], good_tokens()):
        v = CS.evaluate(real, toks, NOW)
        assert v["verdict"] == "NOT_PROVEN" and set(states(v).values()) == {"NOT_PROVEN"}, v


def check_all_good_is_pass():
    v = CS.evaluate(cutover(), good_tokens(), NOW)
    assert v["verdict"] == "PASS", json.dumps(v, ensure_ascii=False)[:600]
    assert v["services"]["zevanory-sales-public"]["edit_workers_effective"] == ["zevanory-sales-candidate", "zevanory-sales-public"]


def check_partial_cutover_not_proven():
    v = CS.evaluate(cutover(False, only="zevanory-public-router"), good_tokens(), NOW)
    assert v["verdict"] == "NOT_PROVEN" and states(v)["zevanory-public-router"] == "PROVEN", states(v)


def check_rejections():
    cases = {
        "TOKEN_DEDICADO_AUSENTE": ("zevanory", [t for t in good_tokens() if t["id"] != IDS["zevanory"]]),
        "TOKEN_INATIVO": ("zevanory", with_token("zevanory", workers=["zevanory"], status="disabled")),
        "TOKEN_SEM_VALIDADE": ("zevanory", with_token("zevanory", workers=["zevanory"], expires=None)),
        "TOKEN_VENCIDO": ("zevanory", with_token("zevanory", workers=["zevanory"], expires="2026-11-01T00:00:00Z")),
        "TOKEN_ALCANCE_CONTA": ("zevanory", with_token("zevanory", workers=["zevanory"], extra=[{"effect": "allow", "permission_groups": [{"name": "Workers Scripts Write"}], "resources": {f"com.cloudflare.api.account.{ACC}": "*"}}])),
        "TOKEN_ALCANCE_CONTA ": ("zevanory-public-router", with_token("zevanory-public-router", workers=["zevanory-public-router"], extra=[{"effect": "allow", "permission_groups": [{"name": "Workers Routes Write"}], "resources": {f"com.cloudflare.api.account.{ACC}": {"com.cloudflare.api.account.zone.*": "*"}}}])),
        "TOKEN_WORKER_NAO_DECLARADO": ("zevanory", with_token("zevanory", workers=["zevanory", "zevanory-sales-public"])),
        "TOKEN_ALCANCE_MAIS_DE_UM_WORKER": ("zevanory-product-control-portable", with_token("zevanory-product-control-portable", workers=["zevanory-product-control-portable", "zevanory"])),
        "TOKEN_ZONA_NAO_DECLARADA": ("zevanory", with_token("zevanory", workers=["zevanory"], zones_write=["f" * 32])),
        "TOKEN_RECURSO_DESCONHECIDO": ("zevanory", with_token("zevanory", workers=["zevanory"], extra=[{"effect": "allow", "permission_groups": EDITOR, "resources": {"com.cloudflare.edge.worker.script.*": "*"}}])),
        "TOKEN_SEM_EDITOR_NO_WORKER": ("zevanory-sales-public", with_token("zevanory-sales-public", workers=["zevanory-sales-public"])),
    }
    for code, (svc, toks) in cases.items():
        v = CS.evaluate(cutover(), toks, NOW)
        assert v["verdict"] == "FAIL" and states(v)[svc] == "FAIL" and code.strip() in codes(v, svc), (code, codes(v, svc))
        others = {k: s for k, s in states(v).items() if k != svc}
        assert set(others.values()) == {"PROVEN"}, (code, others)
    # Um Worker de outro serviço com nome que contém o do serviço não passa como o do serviço.
    v = CS.evaluate(cutover(), with_token("zevanory", workers=["evil-zevanory"]), NOW)
    assert "TOKEN_WORKER_NAO_DECLARADO" in codes(v, "zevanory"), codes(v, "zevanory")
    # Nome do serviço no meio da chave (outro recurso) também não passa.
    v = CS.evaluate(cutover(), with_token("zevanory", workers=["zevanory.extra"]), NOW)
    assert states(v)["zevanory"] == "FAIL" and "TOKEN_SEM_EDITOR_NO_WORKER" in codes(v, "zevanory"), codes(v, "zevanory")
    # Política de leitura na conta inteira não reprova (Account Settings Read); deny é ignorado.
    deny = {"effect": "deny", "permission_groups": [{"name": "Workers Scripts Write"}], "resources": {f"com.cloudflare.api.account.{ACC}": "*"}}
    v = CS.evaluate(cutover(), with_token("zevanory", workers=["zevanory"], extra=[deny]), NOW)
    assert states(v)["zevanory"] == "PROVEN", codes(v, "zevanory")


def check_audit_unavailable():
    v = CS.evaluate(cutover(False, only="zevanory"), None, NOW)
    assert v["verdict"] == "FAIL" and "TOKEN_DEDICADO_AUSENTE" in codes(v, "zevanory"), v


def scope_step():
    jobs = P.parse_workflow((ROOT / ".github/workflows/t1-publisher-guard.yml").read_text(encoding="utf-8"))
    j = jobs["credential-scope"]
    s = [x for x in j["steps"] if x["name"].startswith("P21 effective scope")]
    assert len(s) == 1 and s[0]["env"] == {"CF_TOKEN_AUDIT": "${{ secrets.CF_TOKEN_AUDIT }}"}, s
    assert "secrets.CF_TOKEN_ZEVANORY" not in j["text"], "os tokens dedicados não ficam no environment gh-pages-automacao"
    return j, s[0]


FAKE_CURL = r"""#!/usr/bin/env bash
out=""; tok=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2"; shift;; -H) case "$2" in "Authorization: Bearer "*) tok="${2#Authorization: Bearer }";; esac; shift;; -w) shift;; http*) url="$1";; esac; shift
done
printf 'curl token=%s url=%s\n' "$tok" "$url" >> "$FAKE_CALL_LOG"
printf '%s' "$FAKE_CURL_BODY" > "$out"; printf '%s' "${FAKE_CURL_CODE:-200}"
"""


SCOPE_SRC = [ROOT / "scripts/ci/p21_credential_scope.py"]  # trocado pelos mutantes (cópia temporária)


def run_scope(cut, body, audit="tok-audit", code="200"):
    j, s = scope_step()
    d = pathlib.Path(tempfile.mkdtemp(prefix="p21cs-"))
    try:
        (d / "bin").mkdir()
        (d / "bin/curl").write_text(FAKE_CURL, encoding="utf-8")
        (d / "bin/curl").chmod(0o755)
        (d / "ops").mkdir()
        (d / "scripts/ci").mkdir(parents=True)
        shutil.copyfile(SCOPE_SRC[0], d / "scripts/ci/p21_credential_scope.py")
        (d / "ops/token-cutover.json").write_text(json.dumps(cut), encoding="utf-8")
        env = {k: v for k, v in os.environ.items() if not k.startswith(("CF_", "CLOUDFLARE_"))}
        env.update(PATH=f"{d / 'bin'}:{os.environ['PATH']}", RUNNER_TEMP=str(d), ACCOUNT=ACC, FAKE_CALL_LOG=str(d / "calls"),
                   FAKE_CURL_BODY=body, FAKE_CURL_CODE=code, CF_TOKEN_AUDIT=audit)
        p = subprocess.run(["bash", "-c", s["run"]], cwd=d, env=env, capture_output=True, text=True, timeout=60)
        calls = (d / "calls").read_text(encoding="utf-8").splitlines() if (d / "calls").exists() else []
        return p, calls
    finally:
        shutil.rmtree(d, True)


def check_real_step():
    real = json.loads((ROOT / "ops/token-cutover.json").read_text(encoding="utf-8"))
    ok_body = json.dumps({"success": True, "result": good_tokens()})
    p, calls = run_scope(real, ok_body, audit="")
    assert p.returncode == 0 and "P21_CREDENTIAL_SCOPE=NOT_PROVEN" in p.stdout and calls == [], (p.stdout, calls)
    p, calls = run_scope(real, ok_body)
    assert p.returncode == 0 and "P21_CREDENTIAL_SCOPE=NOT_PROVEN" in p.stdout, p.stdout
    assert len(calls) == 1 and calls[0].startswith("curl token=tok-audit ") and f"/accounts/{ACC}/tokens?per_page=50&page=1" in calls[0], calls
    p, _ = run_scope(cutover(), ok_body)
    assert p.returncode == 0 and "P21_CREDENTIAL_SCOPE=PASS" in p.stdout, p.stdout + p.stderr
    bad = json.dumps({"success": True, "result": with_token("zevanory", workers=["zevanory", "zevanory-public-router"])})
    p, _ = run_scope(cutover(), bad)
    assert p.returncode == 1 and "P21_CREDENTIAL_SCOPE=FAIL" in p.stdout and "::error title=CRED_P21_CF_TOKEN_ZEVANORY::" in p.stdout, p.stdout
    p, _ = run_scope(cutover(), ok_body, code="403")
    assert p.returncode == 1 and "P21_CREDENTIAL_SCOPE=FAIL" in p.stdout, p.stdout
    p, _ = run_scope(cutover(), ok_body, audit="")
    assert p.returncode == 1 and "TOKEN_DEDICADO_AUSENTE" in p.stdout, p.stdout
    assert "tok-audit" not in p.stdout


CHECKS = [check_today_is_not_proven_and_never_fails, check_all_good_is_pass, check_partial_cutover_not_proven,
          check_rejections, check_audit_unavailable, check_real_step]


def mutate_src(old, new):
    def f():
        src = (ROOT / "scripts/ci/p21_credential_scope.py").read_text(encoding="utf-8")
        assert old in src, "mutante não aplicável: " + old[:80]
        return src.replace(old, new, 1)
    return f


MUTANTS = {
    "S1 cutover=false reprova": mutate_src('r["state"] = "NOT_PROVEN"\n', 'r["state"] = "FAIL"\n'),
    "S2 sem checar conta inteira": mutate_src('if kind in ("account", "all-zones"):', 'if False:'),
    "S3 limite de Workers maior": mutate_src("limit = max(1, len(edit_workers))", "limit = 99"),
    "S4 Worker não declarado aceito": mutate_src("if det not in edit_workers:", "if False:"),
    "S5 recurso desconhecido aceito": mutate_src('fail("TOKEN_RECURSO_DESCONHECIDO", f"escrita {groups} em recurso {det}")', "pass"),
    "S6 sem TTL aceito": mutate_src('fail("TOKEN_SEM_VALIDADE", "sem expires_on (TTL obrigatório no roteiro)")', "pass"),
    "S7 token ausente vira NOT_PROVEN": mutate_src('fail("TOKEN_DEDICADO_AUSENTE", f"token_id {tid} não existe na conta {account}")\n            r["state"] = "FAIL"', 'r["state"] = "NOT_PROVEN"'),
    "S8 status ignorado": mutate_src('if t.get("status") != "active":', 'if False:'),
    "S9 zona não declarada aceita": mutate_src("if det not in edit_zones:", "if False:"),
    "S10 veredito PASS com serviço false": mutate_src('("NOT_PROVEN" if "NOT_PROVEN" in states or not states else "PASS")', '"PASS"'),
    "S11 FAIL não muda o exit": mutate_src('return 1 if v["verdict"] == "FAIL" else 0', "return 0"),
    "S12 sufixo frouxo do Worker": mutate_src('(tail == w or tail.endswith("." + w) or tail.endswith("_" + w))', "w in tail"),
}


def violations():
    out = []
    for c in CHECKS:
        try:
            c()
        except Exception as e:  # noqa: BLE001
            out.append(f"{c.__name__}: {e}"[:300])
    return out


class P21CredentialScopeTest(unittest.TestCase):
    def test_s1_hoje_not_proven_sem_reprovar(self):
        check_today_is_not_proven_and_never_fails()

    def test_s2_tokens_corretos_passam(self):
        check_all_good_is_pass()

    def test_s3_cutover_parcial_not_proven(self):
        check_partial_cutover_not_proven()

    def test_s4_reprovacoes(self):
        check_rejections()

    def test_s5_auditoria_indisponivel_com_cutover_true(self):
        check_audit_unavailable()

    def test_s6_passo_real_do_credential_scope(self):
        check_real_step()

    def test_s7_mutantes_morrem(self):
        global CS
        self.assertEqual(violations(), [])
        import importlib.util
        survived, orig = {}, CS
        try:
            for name, mut in MUTANTS.items():
                d = pathlib.Path(tempfile.mkdtemp(prefix="p21csm-"))
                try:
                    f = d / "p21_credential_scope.py"
                    f.write_text(mut(), encoding="utf-8")
                    spec = importlib.util.spec_from_file_location("p21cs_mut", f)
                    m = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(m)
                    CS, SCOPE_SRC[0] = m, f
                    if not violations():
                        survived[name] = "sobreviveu"
                finally:
                    CS, SCOPE_SRC[0] = orig, ROOT / "scripts/ci/p21_credential_scope.py"
                    shutil.rmtree(d, True)
        finally:
            CS = orig
        self.assertEqual(survived, {}, survived)
        print(f"\nMUTANTS total={len(MUTANTS)} killed={len(MUTANTS) - len(survived)} survived={len(survived)}")


if __name__ == "__main__":
    unittest.main()
