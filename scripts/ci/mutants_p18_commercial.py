#!/usr/bin/env python3
"""Mutantes causais da verificação comercial P18 (scripts/b0/p18-commercial.mjs; Roteiro v4.9, seção 5/P18, R15),
classificados pelo classificador COMPARTILHADO scripts/ci/mutant_classifier.py (sem modificação, regra R5).

Suíte (uma execução `node --test`, TAP): tests/p18-commercial.test.mjs (fixtures sintéticas, rede falsa). Sem rede,
sem segredos. Cada mutante altera UMA regra numa cópia mínima da árvore num diretório temporário (o repositório nunca
é alterado). Expectativas em mutants_p18_commercial_allow.json (formato load_mutant_config): primary com test_pattern
E assertion_pattern não nulo (marcador [P18C.n] da asserção que codifica a regra) e secondary com justification,
escritas por raciocínio sobre a mutação ANTES de rodá-la. Validação antes de qualquer mutante (exit 2): config
inválida, primary sem marcador, test_pattern que não casa com nenhum teste da baseline, mutante sem config ou config
órfã. INCONCLUSIVE repete 1 vez. Exit: 0 todos KILLED; 1 SURVIVED; 2 baseline/config; 3 INCONCLUSIVE.
Uso: python3 scripts/ci/mutants_p18_commercial.py [raiz-do-repo]
"""
import json, os, shutil, sys, tempfile

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import mutant_classifier as mc  # noqa: E402  (sem modificação)

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
REPO = Path(ARGS[0] if ARGS else Path(__file__).resolve().parents[2])
TESTS = ["tests/p18-commercial.test.mjs"]
COPY_DIRS = ["tests/fixtures/p18-commercial", "sales-public"]
COPY_FILES = TESTS + ["tests/helpers/text.mjs", "scripts/b0/p18-commercial.mjs", "data/p18-commercial-allowlist.json", "data/products.json", "worker/sales-public-worker.mjs"]
TIMEOUT = 300
NODE = shutil.which("node") or "node"
C = "scripts/b0/p18-commercial.mjs"

M = {
    "K01 host do checkout fora da lista aceito": (C, '  if (!allow.checkout_hosts.includes(u.hostname.toLowerCase())) return { ok: false, reason: "host_not_allowed:" + u.hostname.slice(0, 60) };\n', ""),
    "K02 oferta não conferida": (C, '  if (u.searchParams.get("off") !== product.offer) return', '  if (false) return'),
    "K03 parâmetro extra aceito": (C, '  for (const k of keys) if (k !== "off" && !allow.allowed_extra_params.includes(k)) return { ok: false, reason: "unexpected_param:" + k.slice(0, 30), product };\n', ""),
    "K04 produto da página ignorado": (C, '  if (pageSlug && pageSlug !== product.slug && !(pageSlug === "solucoes")) return', '  if (false) return'),
    "K05 HTTP 200 sem evidência vira aberto": (C, '  if (!productOk && !producerOk) return { state: "unverifiable", reason: "http_200_without_commercial_evidence", identity };',
                                              '  if (!productOk && !producerOk) return { state: "open", reason: "http_200_without_commercial_evidence", identity };'),
    "K06 produtor não exigido no checkout aberto": (C, "  if (productOk && producerOk) return", "  if (productOk) return"),
    "K07 CNPJ divergente ignorado": (C, '  if (otherCnpj.length) return { state: "mismatch", reason: "producer_cnpj_mismatch", identity };\n', ""),
    "K08 nome de produtor proibido ignorado": (C, '  for (const bad of prod.forbidden_names || []) if (text.includes(norm(bad))) return { state: "mismatch", reason: "producer_name_forbidden", identity };\n', ""),
    "K09 ID de produto divergente ignorado": (C, '  if (otherIds.length) return { state: "mismatch", reason: "product_id_mismatch:" + otherIds[0], identity };\n', ""),
    "K10 checkout aberto com a trava fechada passa": (C, '  if (mode === "globally-blocked") return cls.state === "closed" ? { verdict: PASS, reason: "closed_as_expected" } : { verdict: FAIL, reason: "hotmart_open_while_locked" };',
                                                     '  if (mode === "globally-blocked") return { verdict: PASS, reason: "closed_as_expected" };'),
    "K11 checkout fechado com a trava aberta passa": (C, '  return cls.state === "open" ? { verdict: PASS, reason: "open_identity_verified" } : { verdict: FAIL, reason: "hotmart_closed_while_enabled" };',
                                                     '  return { verdict: PASS, reason: "open_identity_verified" };'),
    "K12 trava lida sem HTTP 200": (C, '  if (status !== 200) return { mode: null, reason: "release_http_" + status };\n', ""),
    "K13 trava com caixa e campo alternativos": (C, "  const m = isObj(j) ? j.sales_mode : undefined;", '  const m = isObj(j) ? String(j.sales_mode ?? j.salesMode).toLowerCase() : undefined;'),
    "K14 trava desconhecida não reprova o checkout": (C, '  if (mode !== "globally-blocked" && mode !== "enabled") return { verdict: FAIL, reason: "release_unknown" };\n  if (cls.state', "  if (cls.state"),
    "K15 POST aceito pela guarda": (C, '  if (!isObj(init) || init.method !== "GET") throw', "  if (!isObj(init)) throw"),
    "K16 credentials include aceito": (C, '  if (init.credentials !== "omit") throw new Error("P18C_UNSAFE_REQUEST credentials");\n', ""),
    "K17 cabeçalho cookie aceito": (C, '  for (const k of Object.keys(init.headers || {})) if (!ALLOWED_HEADER_NAMES.has(k.toLowerCase())) throw new Error("P18C_UNSAFE_REQUEST header " + k);\n', ""),
    "K18 redirecionamento para fora da lista seguido": (C, '    if (!host || !allowHosts.includes(host)) return { status: 0, error: "redirect_host_not_allowed:"', '    if (!host) return { status: 0, error: "redirect_host_not_allowed:"'),
    "K19 rota do site com checkout e trava fechada": (C, '    if (links.length) return { verdict: FAIL, reason: "site_route_checkout_while_locked" };\n', ""),
    "K20 Location do 302 ignorado": (C, "  if (loc && /^https?:/i.test(loc)) links.push(loc);\n", ""),
    "K21 link da lista em página estática aceito": (C, 'verdict: FAIL, reason: "static_page_buy_link:"', 'verdict: s.ok ? PASS : FAIL, reason: "static_page_buy_link:"'),
    "K22 URL solta no Worker ignorada": (C, '  for (const href of w.all) if (!w.pairs.some((x) => x.href === href))\n', '  for (const href of []) if (!w.pairs.some((x) => x.href === href))\n'),
    "K23 catálogo divergente aceito": (C, "    const ok = !!p && p.name === c.name && (p.sku ?? null) === c.sku;", "    const ok = !!p;"),
    "K24 número de 14 dígitos vira CNPJ": (C, "/\\b(\\d{2}\\.\\d{3}\\.\\d{3}\\/\\d{4}-\\d{2})\\b|", "/\\b(\\d{2}\\.?\\d{3}\\.?\\d{3}\\/?\\d{4}-?\\d{2})\\b|"),
    "K25 código 049 solto vira aviso": (C, '"(?:erro|error|c[oó]digo|code)\\\\W{0,12}" + c + "\\\\b"', "c"),
    "K26 rota do site não conferida no live": (C, '    results.push({ link: routeUrl, source: "live:site_route"', '    if (false) results.push({ link: routeUrl, source: "live:site_route"'),
    "K27 relatório vazio passa": (C, "  const verdict = results.length > 0 && fail === 0 ? PASS : FAIL;", "  const verdict = fail === 0 ? PASS : FAIL;"),
    "K28 404 da assinatura aceito para kit": (C, '    if (status === 404 && product.kind === "subscription" && !loc)', '    if (status === 404 && !loc)'),
}

ALLOW_FILE = Path(os.environ.get("P18C_MUTANTS_ALLOW_FILE") or Path(__file__).with_name("mutants_p18_commercial_allow.json"))


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
    return mc.run_command([NODE, "--test", "--test-concurrency=1", "--test-reporter=tap", "--test-reporter-destination=stdout", *TESTS],
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
