"""P21 / R18: interruptor de transição para o token Cloudflare dedicado por serviço (ops/token-cutover.json).

O que este teste prova, lendo os workflows REAIS (sem PyYAML) e EXECUTANDO os passos reais com curl/npx falsos que
registram o token de cada chamada (nada sai da máquina):
  A. hoje (cutover=false) nada muda: cada variável de token de cada passo dos 4 deploys canônicos tem exatamente o
     valor de antes para TODA combinação de segredos cadastrados/ausentes; nome, run, if e env de todo passo que já
     existia batem com a impressão digital do gh-pages anterior (#996); os passos novos não rodam; o gate só avisa;
  B. com cutover=true só o token dedicado chega a qualquer passo (o legado nunca, nem com o dedicado ausente: aí o
     token fica vazio e o gate falha com TOKEN_DEDICADO_AUSENTE); id divergente ou token inativo = TOKEN_ID_DIVERGENTE;
  C. interruptor ilegível (job p21_token falhou) = nenhum token e o gate falha;
  D. contrato estático (scripts/ci/p21_token_cutover.py check), emit, materialização do candidato fixo de vendas;
  E. mutantes: cada um precisa ser pego por pelo menos uma verificação.
Doc: docs/p21/tokens-por-worker.md. Registro: ops/token-cutover.json, ops/publishers.json (credentials).
"""
import hashlib
import itertools
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
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "scripts" / "ci"))
import gh_actions_sim as sim  # noqa: E402
import p21_token_cutover as P  # noqa: E402

ACCOUNT = "1b26415802588185a86c1d4d3ebf5bdb"
OWNER, API = "CLOUDFLARE_PUBLIC_OWNER_API_TOKEN", "CLOUDFLARE_API_TOKEN"
VAL = {OWNER: "tok-legacy-owner", API: "tok-legacy-api"}
LEGACY_VALUES = set(VAL.values())
TOKEN_ID = "1" * 32  # id falso (não secreto), baixa entropia
CANONICAL = {  # serviço -> (segredo dedicado, workflow, valor falso do dedicado)
    "zevanory": ("CF_TOKEN_ZEVANORY", "central-production-deploy.yml", "tok-ded-zevanory"),
    "zevanory-sales-public": ("CF_TOKEN_SALES", "zevanory-sales-public-release.yml", "tok-ded-sales"),
    "zevanory-public-router": ("CF_TOKEN_ROUTER", "public-router-deploy.yml", "tok-ded-router"),
    "zevanory-product-control-portable": ("CF_TOKEN_PANEL", "zpc-control-worker-deploy.yml", "tok-ded-panel"),
}
# Entradas de token do gh-pages ANTES deste PR (6686ad24, #996): (workflow, job, passo|'*', variável, expressão).
BASE_TOKEN_ENV = [
    ("central-production-deploy.yml", "guard", "*", API, "${{ secrets.CLOUDFLARE_PUBLIC_OWNER_API_TOKEN || secrets.CLOUDFLARE_API_TOKEN }}"),
    ("central-production-deploy.yml", "deploy", "*", OWNER, "${{ secrets.CLOUDFLARE_PUBLIC_OWNER_API_TOKEN }}"),
    ("central-production-deploy.yml", "deploy", "*", API, "${{ secrets.CLOUDFLARE_PUBLIC_OWNER_API_TOKEN || secrets.CLOUDFLARE_API_TOKEN }}"),
    ("zevanory-sales-public-release.yml", "deploy", "*", OWNER, "${{ secrets.CLOUDFLARE_PUBLIC_OWNER_API_TOKEN }}"),
    ("zevanory-sales-public-release.yml", "deploy", "*", API, "${{ secrets.CLOUDFLARE_PUBLIC_OWNER_API_TOKEN || secrets.CLOUDFLARE_API_TOKEN }}"),
    ("public-router-deploy.yml", "deploy", "*", API, "${{ secrets.CLOUDFLARE_API_TOKEN }}"),
    ("zpc-control-worker-deploy.yml", "deploy", "Validate exact source SHA", API, "${{ secrets.CLOUDFLARE_PUBLIC_OWNER_API_TOKEN || secrets.CLOUDFLARE_API_TOKEN }}"),
    ("zpc-control-worker-deploy.yml", "deploy", "R111 fail closed on passphrase secret names before Wrangler deploy", API, "${{ secrets.CLOUDFLARE_PUBLIC_OWNER_API_TOKEN || secrets.CLOUDFLARE_API_TOKEN }}"),
    ("zpc-control-worker-deploy.yml", "deploy", "Promote exact main SHA and verify production", API, "${{ secrets.CLOUDFLARE_PUBLIC_OWNER_API_TOKEN || secrets.CLOUDFLARE_API_TOKEN }}"),
    ("zpc-control-worker-deploy.yml", "deploy", "R111 verify secret names survived Wrangler deploy", API, "${{ secrets.CLOUDFLARE_PUBLIC_OWNER_API_TOKEN || secrets.CLOUDFLARE_API_TOKEN }}"),
    ("zpc-control-worker-deploy.yml", "deploy", "Verify exact trust and artifact readback", API, "${{ secrets.CLOUDFLARE_PUBLIC_OWNER_API_TOKEN || secrets.CLOUDFLARE_API_TOKEN }}"),
]
# Passos NOVOS deste PR (além do gate em cada job com credencial): só podem rodar com cutover=true.
ADDED_STEPS = {
    "central-production-deploy.yml": ["P21 token dedicado - descoberta sem permissão extra"],
    "zevanory-sales-public-release.yml": ["Park fixed candidate (P21 token dedicado, sem permissão de apagar Worker)"],
}
# Impressão digital (sha256) de cada job no gh-pages anterior: nome, if, run e env de cada passo, na ordem, e as
# chaves do job sem needs. Calculada por fingerprint() sobre `git show 6686ad24:<workflow>`.
BASE_FINGERPRINT = {}  # preenchido no fim do arquivo (dados)

FAKE_CURL = r"""#!/usr/bin/env bash
out=""; tok=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift;;
    -H) case "$2" in "Authorization: Bearer "*) tok="${2#Authorization: Bearer }";; esac; shift;;
    -w|-X|--max-time|--data|--data-binary|-d) shift;;
    http*) url="$1";;
  esac; shift
done
printf 'curl token=%s url=%s\n' "$tok" "$url" >> "$FAKE_CALL_LOG"
if [ -n "$out" ]; then printf '%s' "$FAKE_CURL_BODY" > "$out"; printf '%s' "${FAKE_CURL_CODE:-200}"; else printf '%s' "$FAKE_CURL_BODY"; fi
"""
FAKE_NPX = r"""#!/usr/bin/env bash
printf 'npx token=%s args=%s\n' "${CLOUDFLARE_API_TOKEN:-}" "$*" >> "$FAKE_CALL_LOG"
printf '%s\n' "${FAKE_NPX_OUT:-}"
exit "${FAKE_NPX_RC:-0}"
"""


def wf_text(root, name):
    return (root / ".github/workflows" / name).read_text(encoding="utf-8")


def secrets_for(svc, combo):
    """combo: subconjunto de {'owner','api','ded'} cadastrado."""
    sec, _, dval = CANONICAL[svc]
    s = {}
    if "owner" in combo:
        s[OWNER] = VAL[OWNER]
    if "api" in combo:
        s[API] = VAL[API]
    if "ded" in combo:
        s[sec] = dval
    return s


COMBOS = [set(c) for n in range(4) for c in itertools.combinations(("owner", "api", "ded"), n)]


def outs(cutover, svc, token_id=TOKEN_ID, extra=None):
    sec = CANONICAL[svc][0]
    o = {"needs.p21_token.outputs.cutover": cutover, "needs.p21_token.outputs.token_id": token_id if cutover == "true" else "",
         "needs.p21_token.outputs.secret": sec if cutover in ("true", "false") else "",
         "needs.p21_token.outputs.account": ACCOUNT if cutover in ("true", "false") else "",
         "steps.auth.outputs.available": "true"}
    o.update(extra or {})
    return o


def ev(value, secrets, outputs):
    return sim.evaluate_value(value, sim.resolver(secrets, outputs))


def eff_env(job, step, secrets, outputs):
    env = {k: ev(v, secrets, outputs) for k, v in job["env"].items()}
    env.update({k: ev(v, secrets, outputs) for k, v in step["env"].items()})
    return env


def eval_if(cond, secrets, outputs):
    if not cond:
        return True
    c = cond.strip()
    m = re.fullmatch(r"\$\{\{\s*(.+?)\s*\}\}", c)
    c = m.group(1) if m else c
    c = c.replace("always()", "true").replace("success()", "true").replace("failure()", "false")
    return sim.truthy(sim.evaluate_expr(c, sim.resolver(secrets, outputs)))


def unwrap(value):
    """Forma canônica -> expressão legada de antes (prova de equivalência textual)."""
    m = re.fullmatch(r"\$\{\{ needs\.p21_token\.outputs\.cutover == 'true' && secrets\.CF_TOKEN_[A-Z0-9_]+ \|\| "
                     r"needs\.p21_token\.outputs\.cutover == 'false' && \((.+)\) \|\| '' \}\}", value)
    if m:
        return "${{ %s }}" % m.group(1)
    m = re.fullmatch(r"\$\{\{ needs\.p21_token\.outputs\.cutover == 'false' && (secrets\.[A-Z0-9_]+) \|\| '' \}\}", value)
    if m:
        return "${{ %s }}" % m.group(1)
    return value


P21_IF = " && needs.p21_token.outputs.cutover != 'true'"
# Passos que já existiam e NÃO podem rodar com cutover=true (o token dedicado não tem a permissão de conta).
MUST_SKIP_WHEN_TRUE = {
    "central-production-deploy.yml": ["Authenticate Cloudflare", "Discover production KV namespaces", "Discover Worker service bindings"],
    "zevanory-sales-public-release.yml": ["Delete isolated candidate"],
}


def fingerprint(text, strip_p21=True):
    """sha256 por job dos passos que já existiam (sem o gate e os passos novos), com as formas P21 desfeitas."""
    jobs = P.parse_workflow(text)
    out = {}
    for jn, j in jobs.items():
        if jn == "p21_token":
            continue
        items = []
        for s in j["steps"]:
            if s["name"] == P.GATE_NAME or any(s["name"] in v for v in ADDED_STEPS.values()):
                continue
            env = {k: unwrap(v) for k, v in s["env"].items() if not (strip_p21 and k in ("P21_CUTOVER", "P21_SALES_FIXED_CANDIDATE"))}
            run = s["run"]
            if strip_p21:
                run = run.replace('if [ "${P21_CUTOVER:-}" = "true" ]; then\n  echo "CLOUDFLARE_AUTH_SOURCE=P21_DEDICATED_TOKEN_CF_TOKEN_ZEVANORY"\nelif [ -n "${CLOUDFLARE_PUBLIC_OWNER_API_TOKEN:-}" ]; then',
                                  'if [ -n "${CLOUDFLARE_PUBLIC_OWNER_API_TOKEN:-}" ]; then')
            cond = (s["if"] or "").replace(P21_IF, "") if strip_p21 else (s["if"] or "")
            items.append([s["name"], cond, run, sorted(env.items())])
        keys = {k: v for k, v in j["keys"].items() if k != "needs"}
        jenv = sorted((k, unwrap(v)) for k, v in j["env"].items())
        out[jn] = hashlib.sha256(json.dumps([items, sorted(keys.items()), jenv], ensure_ascii=False).encode()).hexdigest()
    return out


def run_bash(script, env_add, cwd, curl_body="{}", curl_code="200"):
    d = pathlib.Path(tempfile.mkdtemp(prefix="p21-"))
    try:
        (d / "bin").mkdir()
        for n, body in (("curl", FAKE_CURL), ("npx", FAKE_NPX)):
            (d / "bin" / n).write_text(body, encoding="utf-8")
            (d / "bin" / n).chmod(0o755)
        (d / "out").write_text("", encoding="utf-8")
        base = {k: v for k, v in os.environ.items() if not k.startswith(("CLOUDFLARE_", "CF_TOKEN_", "P21_"))}
        env = dict(base, **env_add, PATH=f"{d / 'bin'}:{os.environ['PATH']}", GITHUB_OUTPUT=str(d / "out"), GITHUB_ENV=str(d / "out"),
                   RUNNER_TEMP=str(d), FAKE_CALL_LOG=str(d / "calls"), FAKE_CURL_BODY=curl_body, FAKE_CURL_CODE=curl_code)
        p = subprocess.run(["bash", "-c", script], cwd=str(cwd or d), env=env, capture_output=True, text=True, timeout=120)
        calls = (d / "calls").read_text(encoding="utf-8").splitlines() if (d / "calls").exists() else []
        return p, calls
    finally:
        shutil.rmtree(d, True)


def tokens_of(calls):
    return [re.search(r"token=(\S*)", c).group(1) for c in calls]


def verify_body(tid=TOKEN_ID, status="active", ok=True):
    return json.dumps({"success": ok, "result": {"id": tid, "status": status}})


# ---------------------------------------------------------------------------------------------------------------
# Verificações (recebem a raiz para que os mutantes passem pelo mesmo crivo).
def check_static(root):
    errs = P.check_repo(root)
    assert errs == [], errs[:5]


def check_base_equivalence(root):
    seen = []
    for svc, (_, w, _) in CANONICAL.items():
        jobs = P.parse_workflow(wf_text(root, w))
        for jn, j in jobs.items():
            for k, v in j["env"].items():
                if "secrets.CLOUDFLARE_" in v and "TOKEN" in v:
                    seen.append((w, jn, "*", k, unwrap(v)))
            for s in j["steps"]:
                if s["name"] == P.GATE_NAME:
                    continue
                for k, v in s["env"].items():
                    if "secrets.CLOUDFLARE_" in v and "TOKEN" in v:
                        seen.append((w, jn, s["name"], k, unwrap(v)))
    assert sorted(seen) == sorted(BASE_TOKEN_ENV), {"novo": sorted(set(seen) - set(BASE_TOKEN_ENV)), "faltando": sorted(set(BASE_TOKEN_ENV) - set(seen))}
    for svc, (_, w, _) in CANONICAL.items():
        fp = fingerprint(wf_text(root, w))
        assert fp == BASE_FINGERPRINT[w], f"{w}: passos já existentes mudaram (nome/if/run/env): {fp} != {BASE_FINGERPRINT[w]}"


def check_false_keeps_legacy(root):
    """cutover=false: todo valor de token de todo passo = expressão legada de antes, em todas as combinações."""
    for svc, (sec, w, dval) in CANONICAL.items():
        jobs = P.parse_workflow(wf_text(root, w))
        for combo in COMBOS:
            secrets = secrets_for(svc, combo)
            o = outs("false", svc)
            for jn, j in jobs.items():
                for s in j["steps"]:
                    env = eff_env(j, s, secrets, o)
                    old = {k: ev(unwrap(v), secrets, o) for k, v in {**j["env"], **s["env"]}.items() if "secrets.CLOUDFLARE_" in v}
                    for k, v in old.items():
                        assert env[k] == v, f"{w}/{jn}/{s['name']} {k}: {env[k]!r} != legado {v!r} ({sorted(combo)})"
                    assert dval not in env.values(), f"{w}/{jn}/{s['name']}: dedicado com cutover=false"
                    if s["name"] in ADDED_STEPS.get(w, []):
                        assert not eval_if(s["if"], secrets, o), f"{w}: passo novo {s['name']} roda com cutover=false"
                    if s["if"] and P21_IF in s["if"]:
                        for av in ("true", "false"):
                            o2 = dict(o, **{"steps.auth.outputs.available": av})
                            assert eval_if(s["if"], secrets, o2) == eval_if(s["if"].replace(P21_IF, ""), secrets, o2), s["name"]


def check_true_only_dedicated(root):
    """cutover=true: nenhum valor legado chega a passo algum; o token é o dedicado ou vazio (nunca queda)."""
    for svc, (sec, w, dval) in CANONICAL.items():
        jobs = P.parse_workflow(wf_text(root, w))
        for combo in COMBOS:
            secrets = secrets_for(svc, combo)
            for cut in ("true", "", "TRUE ", "1"):
                o = outs(cut, svc)
                for jn, j in jobs.items():
                    for s in j["steps"]:
                        if cut == "true" and s["name"] in MUST_SKIP_WHEN_TRUE.get(w, []):
                            assert not eval_if(s["if"], secrets, o), f"{w}: {s['name']} roda com cutover=true"
                        env = eff_env(j, s, secrets, o)
                        leak = [k for k, v in env.items() if v in LEGACY_VALUES]
                        assert not leak, f"{w}/{jn}/{s['name']}: legado visível com cutover={cut!r} ({sorted(combo)}): {leak}"
                        if "CLOUDFLARE_API_TOKEN" in env:
                            want = dval if cut == "true" and "ded" in combo else ""
                            if "secrets." in (s["env"].get(API) or j["env"].get(API) or ""):
                                assert env[API] == want, f"{w}/{jn}/{s['name']}: token {env[API]!r} != {want!r} (cutover={cut!r})"


def gate_cases(root):
    """Executa o passo-gate real de cada job com credencial dos 4 workflows."""
    res = []
    for svc, (sec, w, dval) in CANONICAL.items():
        for jn, j in P.parse_workflow(wf_text(root, w)).items():
            if not j["steps"] or j["steps"][0]["name"] != P.GATE_NAME:
                continue
            g = j["steps"][0]
            res.append((svc, w, jn, j, g))
    assert len(res) == 5, [(r[1], r[2]) for r in res]
    return res


def check_gate_runtime(root):
    for svc, w, jn, j, g in gate_cases(root):
        sec, _, dval = CANONICAL[svc]
        where = f"{w}/{jn}"
        # false: só aviso, nenhuma chamada.
        p, calls = run_bash(g["run"], eff_env(j, g, secrets_for(svc, {"owner", "api", "ded"}), outs("false", svc)), None)
        assert p.returncode == 0 and "::warning title=TOKEN_LEGADO_EM_USO::" in p.stdout and calls == [], (where, p.stdout, p.stderr, calls)
        # true + dedicado + verify do id registrado: passa, uma chamada com o dedicado.
        p, calls = run_bash(g["run"], eff_env(j, g, secrets_for(svc, {"owner", "api", "ded"}), outs("true", svc)), None, curl_body=verify_body())
        assert p.returncode == 0 and "::notice title=TOKEN_DEDICADO_EM_USO::" in p.stdout, (where, p.stdout, p.stderr)
        assert tokens_of(calls) == [dval] and f"/accounts/{ACCOUNT}/tokens/verify" in calls[0], (where, calls)
        assert dval not in p.stdout + p.stderr, "o gate nunca imprime o token"
        # true sem o dedicado: falha clara, nenhuma chamada, nunca usa o legado.
        p, calls = run_bash(g["run"], eff_env(j, g, secrets_for(svc, {"owner", "api"}), outs("true", svc)), None, curl_body=verify_body())
        assert p.returncode == 1 and "::error title=TOKEN_DEDICADO_AUSENTE::" in p.stdout and calls == [], (where, p.stdout, calls)
        # true com outro token cadastrado (id diferente), inativo, ou verify falho.
        for body in (verify_body(tid="f" * 32), verify_body(status="disabled"), verify_body(ok=False), "nao-json"):
            p, calls = run_bash(g["run"], eff_env(j, g, secrets_for(svc, {"ded"}), outs("true", svc)), None, curl_body=body)
            assert p.returncode == 1 and "::error title=TOKEN_ID_DIVERGENTE::" in p.stdout, (where, body, p.stdout)
        # true com o arquivo registrando outro segredo para o serviço.
        p, _ = run_bash(g["run"], eff_env(j, g, secrets_for(svc, {"ded"}), outs("true", svc, extra={"needs.p21_token.outputs.secret": "CF_TOKEN_OUTRO"})), None, curl_body=verify_body())
        assert p.returncode == 1 and "TOKEN_CUTOVER_DIVERGENTE" in p.stdout, (where, p.stdout)
        # interruptor ilegível (job p21_token falhou/pulado): falha, sem chamada.
        for cut in ("", "TRUE", "yes"):
            p, calls = run_bash(g["run"], eff_env(j, g, secrets_for(svc, {"owner", "api", "ded"}), outs(cut, svc)), None)
            assert p.returncode == 1 and "TOKEN_CUTOVER_ILEGIVEL" in p.stdout and calls == [], (where, cut, p.stdout)


STEP_CASES = [  # (serviço, job, passo, corpo do curl falso)
    ("zevanory", "deploy", "Determine authenticated public-owner deployment authority", '{"success": true}'),
    ("zevanory-sales-public", "deploy", "Require authenticated deployment authority", '{"success": true}'),
    ("zevanory-public-router", "deploy", "Account guard (fail closed before any deploy)", json.dumps({"success": True, "result": {"id": ACCOUNT}})),
    ("zevanory-product-control-portable", "deploy", "R111 verify secret names survived Wrangler deploy", json.dumps({"success": True, "result": []})),
    ("zevanory-public-router", "deploy", "Record the active router version before deploy (rollback point)", json.dumps({"success": True, "result": {"deployments": []}})),
]


def check_real_steps_tokens(root):
    for svc, jn, name, body in STEP_CASES:
        sec, w, dval = CANONICAL[svc]
        j = P.parse_workflow(wf_text(root, w))[jn]
        s = [x for x in j["steps"] if x["name"] == name]
        assert len(s) == 1, (w, name)
        s = s[0]
        for cut, combo, want in (("false", {"owner", "api", "ded"}, VAL[OWNER] if "OWNER" in (j["env"].get(API, "") + s["env"].get(API, "")) else VAL[API]),
                                 ("false", {"api", "ded"}, VAL[API]),
                                 ("true", {"owner", "api", "ded"}, dval)):
            env = eff_env(j, s, secrets_for(svc, combo), outs(cut, svc))
            p, calls = run_bash(s["run"], env, root, curl_body=body)
            assert calls, (w, name, cut, p.stdout[-400:], p.stderr[-400:])
            assert set(tokens_of(calls)) == {want}, (w, name, cut, sorted(combo), tokens_of(calls))
            if svc == "zevanory" and cut == "true":
                assert "CLOUDFLARE_AUTH_SOURCE=P21_DEDICATED_TOKEN_CF_TOKEN_ZEVANORY" in p.stdout, p.stdout
            if svc == "zevanory" and cut == "false":
                assert "CLOUDFLARE_AUTH_SOURCE=PUBLIC_OWNER_DEDICATED_TOKEN" in p.stdout or "LEGACY_FALLBACK_TOKEN" in p.stdout, p.stdout


def check_sales_candidate(root):
    w = CANONICAL["zevanory-sales-public"][1]
    j = P.parse_workflow(wf_text(root, w))["deploy"]
    mat = [s for s in j["steps"] if s["name"] == "Materialize release configs"][0]
    park = [s for s in j["steps"] if s["name"].startswith("Park fixed candidate")][0]
    dele = [s for s in j["steps"] if s["name"] == "Delete isolated candidate"][0]
    sec = secrets_for("zevanory-sales-public", {"owner", "api", "ded"})
    for cut, want in (("false", "zevanory-sales-candidate-4242"), ("true", "zevanory-sales-candidate")):
        o = outs(cut, "zevanory-sales-public")
        assert eval_if(park["if"], sec, o) == (cut == "true") and eval_if(dele["if"], sec, o) == (cut == "false"), cut
        env = eff_env(j, mat, sec, o)
        d = pathlib.Path(tempfile.mkdtemp(prefix="p21s-"))
        try:
            shutil.copyfile(root / "wrangler.sales.toml", d / "wrangler.sales.toml")
            p = subprocess.run([sys.executable, str(root / "scripts/ci/materialize_sales_configs.py")], cwd=d,
                               env=dict(os.environ, GITHUB_SHA="a" * 40, GITHUB_RUN_ID="4242", P21_SALES_FIXED_CANDIDATE=env.get("P21_SALES_FIXED_CANDIDATE", "")),
                               capture_output=True, text=True, timeout=60)
            assert p.returncode == 0, p.stderr
            prev = (d / "wrangler.sales.preview.toml").read_text(encoding="utf-8")
            assert f'name = "{want}"' in prev and "routes" not in prev, (cut, prev[:200])
            assert f"CANDIDATE={want}" in p.stdout
            p = subprocess.run([sys.executable, str(root / "scripts/ci/materialize_sales_configs.py")], cwd=d,
                               env=dict(os.environ, GITHUB_SHA="a" * 40, GITHUB_RUN_ID="4242", P21_SALES_FIXED_CANDIDATE="zevanory-sales-public"),
                               capture_output=True, text=True, timeout=60)
            assert p.returncode != 0, "nome de candidato arbitrário precisa ser recusado"
        finally:
            shutil.rmtree(d, True)
    # O estacionamento só sobe o Worker inerte, com o token dedicado, no candidato fixo.
    cwd = pathlib.Path(tempfile.mkdtemp(prefix="p21p-"))
    try:
        p, calls = run_bash("printf zevanory-sales-candidate > /tmp/candidate-name\n" + park["run"],
                            eff_env(j, park, sec, outs("true", "zevanory-sales-public")), cwd)
        assert p.returncode == 0 and len(calls) == 1 and "deploy --config wrangler.sales.parked.toml" in calls[0], (p.stdout, calls)
        assert tokens_of(calls) == ["tok-ded-sales"], calls
        cfg = (cwd / "wrangler.sales.parked.toml").read_text(encoding="utf-8").split("\n")
        assert cfg[:2] == ['name = "zevanory-sales-candidate"', 'main = "scripts/deploy/sales-candidate-parked.mjs"'], cfg
        assert not [l for l in cfg if re.match(r"^\s*(routes?|\[\[|\[assets)", l)], cfg
    finally:
        shutil.rmtree(cwd, True)
    assert "export default" in (root / "scripts/deploy/sales-candidate-parked.mjs").read_text(encoding="utf-8")


def check_emit(root):
    def emit(cfg, svc="zevanory"):
        d = pathlib.Path(tempfile.mkdtemp(prefix="p21e-"))
        try:
            (d / "ops").mkdir()
            if cfg is not None:
                (d / "ops/token-cutover.json").write_text(cfg if isinstance(cfg, str) else json.dumps(cfg), encoding="utf-8")
            return subprocess.run([sys.executable, str(root / "scripts/ci/p21_token_cutover.py"), "emit", "--service", svc, "--root", str(d)],
                                  capture_output=True, text=True, timeout=60)
        finally:
            shutil.rmtree(d, True)
    good = json.loads((root / "ops/token-cutover.json").read_text(encoding="utf-8"))
    p = emit(good)
    assert p.returncode == 0 and p.stdout.splitlines() == ["cutover=false", "token_id=", "secret=CF_TOKEN_ZEVANORY", f"account={ACCOUNT}"], p.stdout
    t = json.loads(json.dumps(good))
    t["services"]["zevanory"].update(cutover=True, token_id=TOKEN_ID)
    p = emit(t)
    assert p.returncode == 0 and p.stdout.splitlines()[:2] == ["cutover=true", f"token_id={TOKEN_ID}"], p.stdout
    bad = []
    for mut in (lambda c: c["services"]["zevanory"].update(cutover="true"),
                lambda c: c["services"]["zevanory"].update(cutover=True, token_id=None),
                lambda c: c["services"]["zevanory"].update(cutover=True, token_id="xyz"),
                lambda c: c.update(schema="outro"),
                lambda c: c.update(legacy_secrets=[API]),
                lambda c: c["services"]["zevanory"].update(secret="CLOUDFLARE_API_TOKEN")):
        c = json.loads(json.dumps(good))
        mut(c)
        bad.append(emit(c))
    bad += [emit(None), emit("{nao json"), emit(good, svc="inexistente")]
    for p in bad:
        assert p.returncode == 1 and "cutover=" not in p.stdout and "TOKEN_CUTOVER_ILEGIVEL" in p.stderr, (p.stdout, p.stderr)


def check_reusable(root):
    t = (root / P.REUSABLE).read_text(encoding="utf-8")
    assert "workflow_call:" in t and "secrets." not in t and "environment:" not in t, "o leitor do interruptor não recebe segredo nem environment"
    for o in ("cutover", "token_id", "secret", "account"):
        assert f"value: ${{{{ jobs.read.outputs.{o} }}}}" in t and f"{o}: ${{{{ steps.c.outputs.{o} }}}}" in t, o
    assert "python3 scripts/ci/p21_token_cutover.py emit --service \"$SERVICE\" >> \"$GITHUB_OUTPUT\"" in t


def check_registry(root):
    cfg = json.loads((root / "ops/token-cutover.json").read_text(encoding="utf-8"))
    assert {k: (v["secret"], v["workflows"]) for k, v in cfg["services"].items()} == {k: (s, [w]) for k, (s, w, _) in CANONICAL.items()}
    assert all(v["cutover"] is False and v["token_id"] is None for v in cfg["services"].values()), "este PR não vira nenhum interruptor"
    reg = json.loads((root / "ops/publishers.json").read_text(encoding="utf-8"))
    p21 = reg["credentials_p21"] if "credentials_p21" in reg else None
    assert p21 and p21.get("cutover_file") == "ops/token-cutover.json" and p21.get("tests") == "tests/test_p21_token_cutover.py", p21


CHECKS = [check_static, check_base_equivalence, check_false_keeps_legacy, check_true_only_dedicated, check_gate_runtime,
          check_real_steps_tokens, check_sales_candidate, check_emit, check_reusable, check_registry]


# ---------------------------------------------------------------------------------------------------------------
# Mutantes: aplicados numa cópia da árvore (workflows, ops e scripts envolvidos).
def copy_tree():
    d = pathlib.Path(tempfile.mkdtemp(prefix="p21m-"))
    for rel in (".github/workflows", "ops", "scripts/ci", "scripts/deploy", "tests"):
        shutil.copytree(ROOT / rel, d / rel, ignore=shutil.ignore_patterns("__pycache__"))
    for f in ("wrangler.sales.toml", "wrangler.public-router.toml"):
        shutil.copyfile(ROOT / f, d / f)
    return d


def edit(rel, old, new, count=1):
    def f(d):
        p = d / rel
        t = p.read_text(encoding="utf-8")
        assert old in t, "mutante não aplicável: " + rel + " " + old[:90]
        p.write_text(t.replace(old, new, count), encoding="utf-8")
    return f


def edit_json(fn):
    def f(d):
        p = d / "ops/token-cutover.json"
        c = json.loads(p.read_text(encoding="utf-8"))
        fn(c)
        p.write_text(json.dumps(c), encoding="utf-8")
    return f


C = ".github/workflows/central-production-deploy.yml"
S = ".github/workflows/zevanory-sales-public-release.yml"
R = ".github/workflows/public-router-deploy.yml"
Z = ".github/workflows/zpc-control-worker-deploy.yml"
TOKC = P.token_expr("CF_TOKEN_ZEVANORY", "secrets.CLOUDFLARE_PUBLIC_OWNER_API_TOKEN || secrets.CLOUDFLARE_API_TOKEN")
TOKR = P.token_expr("CF_TOKEN_ROUTER", "secrets.CLOUDFLARE_API_TOKEN")
TOKZ = P.token_expr("CF_TOKEN_PANEL", "secrets.CLOUDFLARE_PUBLIC_OWNER_API_TOKEN || secrets.CLOUDFLARE_API_TOKEN")
GATE_HEAD = "      - name: " + P.GATE_NAME + "\n"


def drop_first_gate(rel):
    def f(d):
        p = d / rel
        t = p.read_text(encoding="utf-8")
        s = t.index(GATE_HEAD)
        e = t.index("\n      - ", s + 1) + 1
        p.write_text(t[:s] + t[e:], encoding="utf-8")
    return f


def move_gate_after_checkout(rel):
    def f(d):
        p = d / rel
        t = p.read_text(encoding="utf-8")
        s = t.index(GATE_HEAD)
        e = t.index("\n      - ", s + 1) + 1
        gate = t[s:e]
        t = t[:s] + t[e:]
        k = t.index("\n      - ", s) + 1
        p.write_text(t[:k] + gate + t[k:], encoding="utf-8")
    return f


MUTANTS = {
    "M1 queda silenciosa do dedicado para o legado (central)": edit(C, TOKC, "${{ secrets.CF_TOKEN_ZEVANORY || secrets.CLOUDFLARE_PUBLIC_OWNER_API_TOKEN || secrets.CLOUDFLARE_API_TOKEN }}"),
    "M2 roteador volta a usar só o legado": edit(R, TOKR, "${{ secrets.CLOUDFLARE_API_TOKEN }}"),
    "M3 painel sem o gate": drop_first_gate(Z),
    "M4 gate depois do checkout (vendas)": move_gate_after_checkout(S),
    "M5 gate sem exit no token ausente": edit(C, 'por PR (docs/p21/tokens-por-worker.md)."\n                exit 1', 'por PR (docs/p21/tokens-por-worker.md)."\n                true'),
    "M6 vendas sem o job p21_token": edit(S, "    uses: ./.github/workflows/p21-token-cutover.yml\n", "    uses: ./.github/workflows/p21-token-cutover-x.yml\n"),
    "M7 guard do central sem needs p21_token": edit(C, "    needs: p21_token\n    timeout-minutes: 5\n", "    timeout-minutes: 5\n"),
    "M8 cutover=true sem token_id": edit_json(lambda c: c["services"]["zevanory"].update(cutover=True)),
    "M9 cutover como texto": edit_json(lambda c: c["services"]["zevanory-public-router"].update(cutover="false")),
    "M10 central com o token de outro serviço": edit(C, TOKC, TOKC.replace("CF_TOKEN_ZEVANORY", "CF_TOKEN_SALES")),
    "M11 ramos invertidos (false entrega o dedicado)": edit(R, TOKR, TOKR.replace("cutover == 'true' && secrets.CF_TOKEN_ROUTER", "cutover == 'false' && secrets.CF_TOKEN_ROUTER").replace("cutover == 'false' && (secrets", "cutover == 'true' && (secrets")),
    "M12 sem o vazio final (|| legado)": edit(Z, TOKZ, TOKZ.replace("|| '' }}", "|| secrets.CLOUDFLARE_API_TOKEN }}"), 5),
    "M13 dedicado usado em workflow não listado": edit(".github/workflows/market-weekly.yml", "${{ secrets.CLOUDFLARE_PUBLIC_OWNER_API_TOKEN || secrets.CLOUDFLARE_API_TOKEN }}", "${{ secrets.CF_TOKEN_PANEL }}"),
    "M14 candidato de vendas aceita qualquer nome": edit("scripts/ci/materialize_sales_configs.py", 'if fixed not in ("","zevanory-sales-candidate"):', "if False:"),
    "M15 candidato apagado também com cutover=true": edit(S, "        if: always() && needs.p21_token.outputs.cutover != 'true'\n", "        if: always()\n"),
    "M16 descoberta KV roda com cutover=true": edit(C, "      - name: Discover production KV namespaces\n        if: steps.auth.outputs.available == 'true' && needs.p21_token.outputs.cutover != 'true'\n", "      - name: Discover production KV namespaces\n        if: steps.auth.outputs.available == 'true'\n"),
    "M17 gate não confere o id do token": lambda d: [edit(rel, '[ "$got" != "${P21_TOKEN_ID:-}" ]', '[ "$got" = "nunca" ]', 9)(d) for rel in (C, S, R, Z)] and None,
    "M18 legado entregue com cutover=false trocado (só OWNER, sem API)": edit(C, TOKC, TOKC.replace("(secrets.CLOUDFLARE_PUBLIC_OWNER_API_TOKEN || secrets.CLOUDFLARE_API_TOKEN)", "(secrets.CLOUDFLARE_PUBLIC_OWNER_API_TOKEN)")),
    "M19 passo antigo alterado em silêncio (rollback do roteador)": edit(R, 'if ! npx --yes wrangler@4.135.0 rollback "$PREV_VERSION_ID"', 'if ! npx --yes wrangler@4.135.0 rollback'),
    "M20 interruptor virado neste PR": edit_json(lambda c: c["services"]["zevanory-product-control-portable"].update(cutover=True, token_id=TOKEN_ID)),
    "M21 rótulo P21 removido do passo de autoridade": edit(C, 'echo "CLOUDFLARE_AUTH_SOURCE=P21_DEDICATED_TOKEN_CF_TOKEN_ZEVANORY"', 'echo "CLOUDFLARE_AUTH_SOURCE=LEGACY_FALLBACK_TOKEN"'),
    "M22 estacionamento com nome arbitrário": edit(S, '\'name = "zevanory-sales-candidate"\' \'main', '\'name = "zevanory-sales-public"\' \'main'),
}


def violations(root):
    out = []
    for c in CHECKS:
        try:
            c(root)
        except Exception as e:  # noqa: BLE001 - mutante que quebra o simulador também morre
            out.append(f"{c.__name__}: {e}"[:300])
    return out


class P21TokenCutoverTest(unittest.TestCase):
    def test_p1_contrato_estatico(self):
        check_static(ROOT)

    def test_p2_tokens_e_passos_identicos_ao_gh_pages_anterior(self):
        check_base_equivalence(ROOT)

    def test_p3_cutover_false_entrega_exatamente_o_legado(self):
        check_false_keeps_legacy(ROOT)

    def test_p4_cutover_true_so_o_dedicado_e_nunca_queda(self):
        check_true_only_dedicated(ROOT)

    def test_p5_gate_real_nos_cinco_jobs(self):
        check_gate_runtime(ROOT)

    def test_p6_passos_reais_com_curl_falso(self):
        check_real_steps_tokens(ROOT)

    def test_p7_candidato_fixo_de_vendas(self):
        check_sales_candidate(ROOT)

    def test_p8_emit_falha_fechado(self):
        check_emit(ROOT)

    def test_p9_leitor_reutilizavel_sem_segredo(self):
        check_reusable(ROOT)

    def test_p10_registro(self):
        check_registry(ROOT)

    def test_p11_mutantes_morrem(self):
        self.assertEqual(violations(ROOT), [], "a árvore real passa em todas as verificações")
        survived = {}
        for name, mutate in MUTANTS.items():
            d = copy_tree()
            try:
                mutate(d)
                if not violations(d):
                    survived[name] = "sobreviveu"
            finally:
                shutil.rmtree(d, True)
        self.assertEqual(survived, {}, survived)
        print(f"\nMUTANTS total={len(MUTANTS)} killed={len(MUTANTS) - len(survived)} survived={len(survived)}")


BASE_FINGERPRINT.update(json.loads(r'''{
 "central-production-deploy.yml": {
  "guard": "d04d0473a1b9533b07a59b55afaee04ffa5483ce94d13088aa8d668bb3887716",
  "deploy": "34087023b0690cca9b0e1c0f2d2e9fb2c2c8607b02043bf5ccbfc06cd3fc4d9c"
 },
 "zevanory-sales-public-release.yml": {
  "verify": "68088b29097abe4c20476c2c60c6e8db4ebb51bf97a7ba8eb125f74638e324b3",
  "deploy": "a2984fbd23478325c1413673ee34521c9d93238ed321c3a1819484539486fa74"
 },
 "public-router-deploy.yml": {
  "validate": "5d6d5e2e6a771b45f463bc895d8f58a998b93cb5b0cbbe72b0c0a1a112029e83",
  "deploy": "bd9c714b269a6c7b81e478c01cb2fd994fa243375323f364d5e6dde3a3c7e4e3"
 },
 "zpc-control-worker-deploy.yml": {
  "deploy": "186d85fa95dfce3542a2c907c27f33508e74268675ff5a4955ea529db1ddc7fd"
 }
}'''))

if __name__ == "__main__":
    unittest.main()
