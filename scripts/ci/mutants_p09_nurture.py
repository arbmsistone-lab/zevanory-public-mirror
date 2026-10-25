#!/usr/bin/env python3
"""Mutantes causais do P09 Nutrição: gate scripts/p09/nurture_gate.mjs e política scripts/p09/nurture-sequence.mjs,
classificados pelo classificador COMPARTILHADO scripts/ci/mutant_classifier.py (sem modificação).

Suíte (uma execução `node --test`, TAP): tests/p09-nurture-sequence.test.mjs (N1-N26). Os casos do gate montam uma
cópia mínima da árvore em diretório temporário e rodam o gate real; os casos da política importam o módulo. Cada
mutante altera UMA regra numa cópia mínima da árvore (o repositório nunca é alterado).
Expectativas (mutants_p09_nurture_allow.json, formato load_mutant_config): primary (1-3) com test_pattern E
assertion_pattern NÃO nulo (marcador [Nn.k]) e secondary com justification, escritas por raciocínio sobre a mutação
ANTES de rodá-la. Validação antes de qualquer mutante (exit 2): config inválida, primary sem marcador, test_pattern
que não casa com nenhum teste da baseline, mutante sem config ou config órfã.
INCONCLUSIVE repete 1 vez; persistindo, o job falha. Exit: 0 todos KILLED; 1 SURVIVED; 2 baseline/config; 3 INCONCLUSIVE.
Uso: python3 scripts/ci/mutants_p09_nurture.py [raiz-do-repo]
"""
import json, os, shutil, sys, tempfile

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import mutant_classifier as mc  # noqa: E402  (sem modificação)

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
REPO = Path(ARGS[0] if ARGS else Path(__file__).resolve().parents[2])
TESTS = ["tests/p09-nurture-sequence.test.mjs"]
COPY_DIRS = ["content/p09", "scripts/p09"]
COPY_FILES = TESTS + ["tests/helpers/text.mjs", "worker/lead-magnet.mjs", "worker/brand-email.mjs", "worker/activity-ledger.mjs",
                      "worker/politica-unica.mjs", "data/politica-unica.json", "data/products.json", "checklist-15-minutos/index.html",
                      "material-gratuito/index.html"] + \
    [f"sales-public/{s}.html" for s in ("lucro-e-caixa", "vendas-na-pratica", "ia-na-pratica", "negocio-completo", "checklist-15-minutos", "material-gratuito")]
TIMEOUT = 300
NODE = shutil.which("node") or "node"
S = "scripts/p09/nurture-sequence.mjs"
G = "scripts/p09/nurture_gate.mjs"

M = {
    "M01 interruptor ignorado": (S, '  if (String(env?.[sw.env] ?? "") !== sequence.id) return', "  if (false) return"),
    "M02 limite do consentimento ignorado": (S, "  if (step > cap) return", "  if (false) return"),
    "M03 lead não confirmado aceito": (S, 'if (!lead || lead.status !== "confirmed" || ', "if (!lead || "),
    "M04 comercial com vendas fechadas": (S, "  if (email.commercial === true && salesOpen !== true) return", "  if (false) return"),
    "M05 versão de consentimento não aceita passa": (S, "  if (!(sequence.consent?.accepted_versions || []).includes(lead.consent_version)) return", "  if (false) return"),
    "M06 versão desconhecida do P08 passa": (S, '  if (!Number.isInteger(cap) || cap < 0) return { ok: false, reason: "consent_version_unknown" };\n', ""),
    "M07 assinatura sem link de descadastro": (S, "Descadastre-se em 1 clique: ${optOutUrl}`", "Descadastre-se em 1 clique.`"),
    "M08 sem List-Unsubscribe-Post": (S, '"List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }', '"List-Unsubscribe-Post": "" }'),
    "M09 léxico de promessa de ganho vazio": (G, "export const INCOME = [", "export const INCOME = [/(?!)/] || ["),
    "M10 léxico de urgência vazio": (G, "export const URGENCY = [", "export const URGENCY = [/(?!)/] || ["),
    "M11 léxico de prova social vazio": (G, "export const TESTIMONIAL = [", "export const TESTIMONIAL = [/(?!)/] || ["),
    "M12 promessas do #927 não conferidas": (G, "export const PROMISE_927 = [", "export const PROMISE_927 = [/(?!)/] || ["),
    "M13 assinatura não exigida": (G, '    if (ph.filter((p) => p.name === "assinatura").length !== 1) err(', "    if (false) err("),
    "M14 métrica por e-mail não conferida": (G, '    if (!["clicks", "actions"].includes(e.metric)) err(', "    if (false) err("),
    "M15 abertura não proibida": (G, '  if (!Array.isArray(met.never) || !met.never.includes("opens")) err(', "  if (false) err("),
    "M16 número sem fonte aceito": (G, "    for (const n of found) if (!declared.has(n)) err(", "    for (const n of found) if (false) err("),
    "M17 fonte do número não conferida": (G, '!readFileSync(f, "utf8").includes(src.contains)) {', "false) {"),
    "M18 afirmação fora da página aceita": (G, "      if (!strip(car).includes(strip(c.text))) err(", "      if (false) err("),
    "M19 comercial sem arrependimento": (G, '      if (!ph.some((p) => p.name === "regra_7d")) err(', "      if (false) err("),
    "M20 comercial sem identificação": (G, '      if (!ph.some((p) => p.name === "identificacao")) err(', "      if (false) err("),
    "M21 preço sem flag comercial": (G, "    if ((priced.length || productLink) && e.commercial !== true) err(", "    if (false) err("),
    "M22 link de checkout aceito": (G, "      if (hasCheckoutCta(url) || /\\/comprar\\b|\\/checkout\\b|\\/assinar\\b/.test(u.pathname)) err(", "      if (false) err("),
    "M23 link cru ou pixel aceito": (G, "    if (/<img|<script|<iframe|pixel|https?:\\/\\//i.test(all)) err(", "    if (false) err("),
    "M24 consentimento publicado não conferido": (G, "  for (const n of counts) if (n !== CONSENT_FOLLOWUPS[currentConsent]) err(", "  for (const n of counts) if (false) err("),
    "M25 versão fora do modelo do P08 aceita": (G, "  else for (const v of accepted) if (!Number.isInteger(CONSENT_FOLLOWUPS[v])) err(", "  else for (const v of accepted) if (false) err("),
    "M26 interruptor ligado por padrão aceito": (G, '  if (sw.default !== "off" || sw.on_value !== seq.id || sw.env !== "P09_NURTURE_SEND") err(', "  if (false) err("),
    "M27 workflow que liga o envio aceito": (G, '/P09_NURTURE_SEND\\s*[:=]/.test(readFileSync(join(wfDir, f), "utf8"))', "false"),
    "M28 rede no módulo do P09 aceita": (G, "  if (/\\bfetch\\s*\\(|api", "  if (false && /\\bfetch\\s*\\(|api"),
    "M29 léxico não aplicado ao Worker": (G, '  for (const h of lexiconHits(mail.subject + "\\n" + mail.text)) err(`${L}: ${h}`);\n', ""),
    "M30 salvaguardas do Worker não conferidas": (G, "for (const [a, what] of LIVE_ANCHORS) if (!leadSrc.includes(a)) err(", "for (const [a, what] of LIVE_ANCHORS) if (false) err("),
    "M31 prepareEmail ignora a decisão": (S, "  if (!decision.ok) return { send: false, reason: decision.reason };\n", ""),
}

ALLOW_FILE = Path(os.environ.get("P09_MUTANTS_ALLOW_FILE") or Path(__file__).with_name("mutants_p09_nurture_allow.json"))


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
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
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


def run_suite(root):
    env = {**os.environ, "NODE_NO_WARNINGS": "1", "NO_COLOR": "1", "FORCE_COLOR": "0", "NODE_OPTIONS": "", "PYTHONDONTWRITEBYTECODE": "1"}
    return mc.run_command([NODE, "--test", "--test-reporter=tap", "--test-reporter-destination=stdout", *TESTS],
                          cwd=root, timeout=TIMEOUT, env=env)


def run_mutant(name, mutation, total, spec):
    with tempfile.TemporaryDirectory() as tmp:
        ok = build(tmp, mutation)
        run = run_suite(tmp) if ok else {"return_code": 1, "stdout": "", "stderr": "", "timed_out": False, "signal": None}
    return mc.classify_run(total, run, expected=spec, allowlist=spec.get("allowlist") or [], anchor_ok=ok, mutant_id=name)


def main():
    with tempfile.TemporaryDirectory() as tmp:
        build(tmp)
        base = run_suite(tmp)
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
        print(f"MUTANT {r['mutant_id']} {r['verdict']}" + ("" if r["verdict"] == mc.KILLED else f" ({r['reason'][:300]})"))
        print("RESULT " + json.dumps({k: r.get(k) for k in ("mutant_id", "verdict", "reason", "killing_tests", "assertion_ids", "secondary_tests", "unexpected_failures")}, ensure_ascii=False))
    code, summary = mc.aggregate(results, baseline_valid=True)
    print(f"MUTANTS total={len(results)} killed={summary['KILLED']} survived={summary['SURVIVED']} inconclusive={summary['INCONCLUSIVE']}")
    return code


if __name__ == "__main__":
    sys.exit(main())
