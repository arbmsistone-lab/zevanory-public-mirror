#!/usr/bin/env python3
"""Mutantes causais da RECONCILIAÇÃO DIÁRIA Neon × diário P20 (worker/diario-reconcilia.mjs, o campo diario de
finalizeBackup e os dois ganchos que a tornam derivável: instante do Neon no consentimento e estorno confirmado por
consulta ao provedor), classificados pelo classificador COMPARTILHADO scripts/ci/mutant_classifier.py (sem modificação).

Suíte (uma execução `node --test`, TAP): tests/p20-diario-reconcilia.test.mjs (RC1-RC10), D1 falso com SQL de verdade
(node:sqlite, migrações reais 0001 e 0002) e Neon falso; integração com lead-magnet e reconcileRefund reais. Sem rede,
sem Cloudflare, sem segredos. Cada mutante altera UMA regra numa cópia da árvore em diretório temporário (o repositório
nunca é alterado). Regras cobertas: mesma normalização dos ganchos, margem nas duas bordas, cadeia revalidada com
âncora, sombra = alerta e ativo = falha, fase desconhecida estrita, paginação, fonte com erro = incompleto, Hotmart fora
do escopo, estorno aprovado por prefixo, núcleo da janela, índice de ts_ms e os dois ganchos.
Expectativas (mutants_p20_diario_reconcilia_allow.json, formato load_mutant_config), validação e códigos de saída iguais
aos de scripts/ci/mutants_p20_diario.py.
Uso: python3 scripts/ci/mutants_p20_diario_reconcilia.py [raiz-do-repo]
"""
import json, os, shutil, sys, tempfile

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import mutant_classifier as mc  # noqa: E402  (sem modificação)

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
REPO = Path(ARGS[0] if ARGS else Path(__file__).resolve().parents[2])
TESTS = ["tests/p20-diario-reconcilia.test.mjs"]
# worker/ e data/ inteiros: lead-magnet, reconcileRefund e data-backup reais importam vários módulos e dados.
COPY_DIRS = ["migrations/d1", "worker", "data", "tests/helpers"]
COPY_FILES = TESTS
TIMEOUT = 300
NODE = shutil.which("node") or "node"
RC, DB, LM, RP, MG = ("worker/diario-reconcilia.mjs", "worker/data-backup.mjs", "worker/lead-magnet.mjs",
                      "worker/refund-provider-claims.mjs", "migrations/d1/0002_diario_v1_ts.sql")

M = {
    "R01 normalização diferente da do gancho (pedido)": (RC, 'add(eventoPedidoCriado({ orderId: r.order_id,', 'add(eventoPedidoCriado({ orderId: String(r.order_id).toUpperCase(),'),
    "R02 Neon lido sem margem": (RC, "esperadosDoNeon(sqlFactory(String(env.DATABASE_URL)), de - MARGEM_MS, ate + MARGEM_MS)", "esperadosDoNeon(sqlFactory(String(env.DATABASE_URL)), de, ate)"),
    "R03 diário lido sem margem": (RC, "lido = await linhasDoDiario(db, de - MARGEM_MS, ate + MARGEM_MS);", "lido = await linhasDoDiario(db, de, ate);"),
    "R04 cadeia quebrada não é divergência": (RC, " || cadeia.ok !== true;", ";"),
    "R05 trecho verificado sem a âncora": (RC, "await verifyChain(trecho, from ? { from } : {});", "await verifyChain(trecho, {});"),
    "R06 sombra vira falha": (RC, '? { falha: null, alerta: code + ":sombra" } : { falha: code, alerta: null };', '? { falha: code, alerta: null } : { falha: code, alerta: null };'),
    "R07 ativo não falha": (RC, '? { falha: null, alerta: code + ":sombra" } : { falha: code, alerta: null };', '? { falha: null, alerta: code + ":sombra" } : { falha: null, alerta: code };'),
    "R08 fase desconhecida cai na sombra": (RC, 'const faseDe = (f) => (FASES.includes(f) ? f : "ativo");', 'const faseDe = (f) => (FASES.includes(f) ? f : "sombra");'),
    "R09 sem binding consulta o Neon": (RC, 'if (!db || typeof db.prepare !== "function") return { ...base, estado: "nao_configurado", cadeia_ok: null };', 'if (!db || typeof db.prepare !== "function") { await esperadosDoNeon(sqlFactory(String(env.DATABASE_URL)), de, ate); return { ...base, estado: "nao_configurado", cadeia_ok: null }; }'),
    "R10 só a primeira página": (RC, "if (page.length < pagina) { completo = true; break; }", "completo = true; break;"),
    "R11 fonte com erro tratada como vazia": (RC, 'fontes[fonte] = tabelaAusente(e) ? "ausente" : "erro";', 'fontes[fonte] = "ausente";'),
    "R12 Hotmart contado como sobra": (RC, '  if ((r.tipo === "delivery_sent" || r.tipo === "refund") && hotmart(r)) return "hotmart_fora_do_neon";\n', ""),
    "R13 estorno aprovado exige chave exata": (RC, "tsNum(r.ts_rec), true);", "tsNum(r.ts_rec));"),
    "R14 núcleo ignora a janela": (RC, "const esperadosNucleo = esperados.filter((e) => dentro(e.ts));", "const esperadosNucleo = esperados;"),
    "R15 finalize não registra o alerta": (DB, "  if (efeito.alerta) report.warnings.push(efeito.alerta);\n", ""),
    "R16 consentimento sem o instante do Neon": (LM, "consentVersion, ts: Number.isSafeInteger(at) ? at : undefined }));", "consentVersion }));"),
    "R17 reconcileRefund sem gancho": (RP, '      diarioSombra(env, null, () => eventoReembolso({ orderId: oid, provider: "mercadopago", stage: "approved", refundId: refunds[0].id, amount: rec.amount, certification: rec.test === true }));\n', ""),
    "R18 sem índice de ts_ms": (MG, "CREATE INDEX IF NOT EXISTS diario_v1_ts ON diario_v1 (ts_ms);", "SELECT 1;"),
    "R19 nao_configurado não falha em ativo": (RC, '  if (diario.estado === "nao_configurado" && faseDe(diario.fase) === "sombra") return { falha: null, alerta: null };', '  if (diario.estado === "nao_configurado") return { falha: null, alerta: null };'),
    "R20 linha inválida do Neon ignorada": (RC, '.filter(([k, v]) => v === "erro" || (k.endsWith(":linha_invalida") && v > 0))', '.filter(([, v]) => v === "erro")'),
}

ALLOW_FILE = Path(os.environ.get("P20_DIARIO_RECONCILIA_MUTANTS_ALLOW_FILE") or Path(__file__).with_name("mutants_p20_diario_reconcilia_allow.json"))


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
