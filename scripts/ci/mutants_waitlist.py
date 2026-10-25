#!/usr/bin/env python3
"""Mutantes causais da lista de espera (worker/waitlist.mjs) e do consentimento v2 do checklist (worker/lead-magnet.mjs),
classificados pelo classificador COMPARTILHADO scripts/ci/mutant_classifier.py (sem modificação).

Suíte (uma execução `node --test`, TAP): tests/waitlist.test.mjs (W1-W7, sem banco) e
tests/integration/waitlist-postgres.test.mjs (P1-P9, PostgreSQL REAL: exige T4_PG_HOST/T4_PG_PORT; sem eles os testes
pulam e a baseline é inválida -> exit 2). Cada mutante altera UMA regra numa cópia mínima da árvore (o repositório nunca é
alterado) e usa um banco próprio (WAITLIST_PG_DB), então os mutantes podem rodar em paralelo.
Expectativas (mutants_waitlist_allow.json, formato load_mutant_config): primary (1-3) com test_pattern E assertion_pattern
NÃO nulo (marcador [Wn.k]/[Pn.k]) e secondary com justification, escritas por raciocínio sobre a mutação ANTES de rodá-la.
INCONCLUSIVE repete 1 vez; persistindo, o job falha. Exit: 0 todos KILLED; 1 SURVIVED; 2 baseline/config; 3 INCONCLUSIVE.
Uso: T4_PG_HOST=... T4_PG_PORT=... python3 scripts/ci/mutants_waitlist.py [raiz-do-repo]
"""
import json, os, shutil, sys, tempfile

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import mutant_classifier as mc  # noqa: E402  (sem modificação)

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
REPO = Path(ARGS[0] if ARGS else Path(__file__).resolve().parents[2])
TESTS = ["tests/waitlist.test.mjs", "tests/integration/waitlist-postgres.test.mjs"]
COPY_DIRS = ["worker", "data", "content/p09", "scripts/p09", "tests/helpers"]
COPY_FILES = TESTS + ["scripts/sales_policy.py"]
TIMEOUT = 420
NODE = shutil.which("node") or "node"
W = "worker/waitlist.mjs"
L = "worker/lead-magnet.mjs"

M = {
    "MW01 rotas ignoram a flag": (W, "  if (!waitlistEnabled(env)) return notFound();\n", ""),
    "MW02 job de aviso ignora a flag": (W, "  const enabled = waitlistEnabled(env);\n", "  const enabled = true;\n"),
    "MW03 aviso com vendas fechadas": (W, "  if (salesOpen !== true) {\n", "  if (false) {\n"),
    "MW04 dados ficam depois do aviso": (W, "    const gone = await sql.query(\"delete from zevanory_waitlist where email=$1 and status='notifying' returning product, consent_version\", [email]);", "    const gone = [];"),
    "MW05 falha de envio não libera a reserva": (W, "      await sql.query(\"update zevanory_waitlist set status='confirmed', notify_claimed_at=null where email=$1 and status='notifying'\", [email]);\n", ""),
    "MW06 sem apagar 30 dias depois da abertura": (W, "\n     or exists (select 1 from zevanory_waitlist_state s where s.k='sales_open_since' and s.v < now() - ($3::int * interval '1 day'))", ""),
    "MW07 sem teto de 365 dias": (W, "\n     or (w.consent_at < now() - ($2::int * interval '1 day'))", ""),
    "MW08 saída não apaga": (W, "    const rows = await sql.query(\"delete from zevanory_waitlist where subject_ref=$1 returning product, consent_version\", [ref]);", "    const rows = [];"),
    "MW09 versão do consentimento não conferida": (W, "  if (consent !== \"sim\" || version !== WAITLIST_CONSENT_VERSION) return", "  if (consent !== \"sim\") return"),
    "MW10 sem dupla confirmação": (W, "      values ($1, $2, $3, 'pending', $4, now(), $5,", "      values ($1, $2, $3, 'confirmed', $4, now(), $5,"),
    "MW11 abertura usa contatos do checklist": (W, "  const due = await sql.query(", "  await sql.query(\"insert into zevanory_waitlist (email, product, subject_ref, status, consent_version, confirmed_at) select email, 'negocio-completo', coalesce(subject_ref, 'x'), 'confirmed', consent_version, now() from zevanory_leads where status='confirmed' on conflict do nothing\", []);\n  const due = await sql.query("),
    "MW12 trava do consentimento v2 ignorada": (L, "  return consentV2Enabled(env) && postedVersion === CONSENT_V2_VERSION ? CONSENT_V2_VERSION : CONSENT_VERSION;", "  return postedVersion === CONSENT_V2_VERSION ? CONSENT_V2_VERSION : CONSENT_VERSION;"),
    "MW13 limite do v1 aumentado (retroativo)": (L, "export const CONSENT_FOLLOWUPS = { [CONSENT_VERSION]: 2, [CONSENT_V2_VERSION]: 4 };", "export const CONSENT_FOLLOWUPS = { [CONSENT_VERSION]: 4, [CONSENT_V2_VERSION]: 4 };"),
    "MW14 reinscrição troca a versão de contato confirmado": (L, "  if (existing?.status === \"confirmed\") {", "  if (false) {"),
    "MW15 CTA vira formulário com a regra desligada": ("worker/politica-unica.mjs", "  if (WAITLIST_FORM.enabled && slug) return", "  if (slug) return"),
}

ALLOW_FILE = Path(os.environ.get("WAITLIST_MUTANTS_ALLOW_FILE") or Path(__file__).with_name("mutants_waitlist_allow.json"))


def load_config(path=None, titles=None, mutants=None):
    raw = json.loads(Path(path or ALLOW_FILE).read_text(encoding="utf-8"))
    specs = raw.get("mutants") if isinstance(raw, dict) else None
    if not isinstance(specs, dict):
        raise mc.ConfigError("config sem a seção 'mutants'")
    cfg = mc.load_mutant_config(specs)
    mutants = M if mutants is None else mutants
    missing, orphan = sorted(set(mutants) - set(cfg)), sorted(set(cfg) - set(mutants))
    if missing or orphan:
        raise mc.ConfigError(f"mutantes sem config {missing} / config órfã {orphan}")
    for mid, spec in cfg.items():
        for e in spec["primary"]:
            if not (isinstance(e.get("assertion_pattern"), str) and e["assertion_pattern"].strip()):
                raise mc.ConfigError(f"{mid}: primary sem assertion_pattern")
        if titles is not None:
            for e in spec["primary"] + spec["secondary"]:
                if not any(mc._test_matches(e["test_pattern"], t) for t in titles):
                    raise mc.ConfigError(f"{mid}: test_pattern não casa com nenhum teste: {e['test_pattern'][:60]}")
    return cfg


def build(tmp, mutation=None):
    for rel in COPY_DIRS:
        shutil.copytree(Path(REPO, *rel.split("/")), Path(tmp, *rel.split("/")), dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "node_modules"))
    for rel in COPY_FILES:
        dst = Path(tmp, *rel.split("/"))
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(Path(REPO, *rel.split("/")), dst)
    if mutation:
        rel, old, new = mutation
        f = Path(tmp, *rel.split("/"))
        text = f.read_bytes().decode("utf-8").replace("\r\n", "\n")
        if text.count(old) != 1:
            return False
        with open(f, "w", encoding="utf-8", newline="\n") as h:
            h.write(text.replace(old, new, 1))
    return True


def run_suite(root, db):
    env = {**os.environ, "NODE_NO_WARNINGS": "1", "NO_COLOR": "1", "FORCE_COLOR": "0", "NODE_OPTIONS": "", "PYTHONDONTWRITEBYTECODE": "1", "WAITLIST_PG_DB": db}
    return mc.run_command([NODE, "--test", "--test-concurrency=1", "--test-reporter=tap", "--test-reporter-destination=stdout", *TESTS],
                          cwd=root, timeout=TIMEOUT, env=env)


def db_name(name):
    return "ci_wl_" + "".join(c for c in name.split(" ")[0].lower() if c.isalnum())


def run_mutant(name, mutation, total, spec):
    with tempfile.TemporaryDirectory() as tmp:
        ok = build(tmp, mutation)
        run = run_suite(tmp, db_name(name)) if ok else {"return_code": 1, "stdout": "", "stderr": "", "timed_out": False, "signal": None}
    return mc.classify_run(total, run, expected=spec, allowlist=spec.get("allowlist") or [], anchor_ok=ok, mutant_id=name)


def main():
    if not os.environ.get("T4_PG_HOST"):
        print("BASELINE FAILED T4_PG_HOST ausente (os testes P1-P9 precisam de PostgreSQL real)")
        return mc.EXIT_BAD_BASELINE
    with tempfile.TemporaryDirectory() as tmp:
        build(tmp)
        base = run_suite(tmp, "ci_wl_baseline")
    parsed = mc.parse_tap(base.get("stdout", ""), stderr=base.get("stderr", ""))
    total = parsed["summary"].get("tests")
    vb = mc.validate_baseline(total if isinstance(total, int) else -1, base.get("return_code"), parsed["summary"], parsed["failures"],
                              timed_out=base.get("timed_out", False), signal=base.get("signal"))
    if not vb["ok"]:
        print("BASELINE FAILED", vb["reason"])
        print(base.get("stdout", "")[-3000:])
        return mc.EXIT_BAD_BASELINE
    titles = [p.get("test_id") for p in parsed["summary"].get("points") or []]
    print(f"BASELINE PASS tests={total}")
    try:
        cfg = load_config(titles=titles)
    except mc.ConfigError as e:
        print("CONFIG_INVALID", e)
        return mc.EXIT_BAD_BASELINE

    def judge(item):
        name, mutation = item
        res = run_mutant(name, mutation, total, cfg[name])
        if res["verdict"] == mc.INCONCLUSIVE:
            first = res["reason"]
            res = run_mutant(name, mutation, total, cfg[name])
            if res["verdict"] == mc.INCONCLUSIVE:
                res["reason"] = f"{first} | repetição: {res['reason']}"
        return res

    with ThreadPoolExecutor(max_workers=min(4, os.cpu_count() or 2)) as ex:
        results = list(ex.map(judge, M.items()))
    for r in results:
        print(f"MUTANT {r['mutant_id']} {r['verdict']}" + ("" if r["verdict"] == mc.KILLED else f" ({r['reason'][:400]})"))
        print("RESULT " + json.dumps({k: r.get(k) for k in ("mutant_id", "verdict", "reason", "killing_tests", "assertion_ids", "secondary_tests", "unexpected_failures")}, ensure_ascii=False))
    code, summary = mc.aggregate(results, baseline_valid=True)
    print(f"MUTANTS total={len(results)} killed={summary['KILLED']} survived={summary['SURVIVED']} inconclusive={summary['INCONCLUSIVE']}")
    return code


if __name__ == "__main__":
    sys.exit(main())
