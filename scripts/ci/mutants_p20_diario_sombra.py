#!/usr/bin/env python3
"""Mutantes causais da gravação em MODO SOMBRA do diário P20 (worker/diario-sombra.mjs e os ganchos nos eventos
críticos), classificados pelo classificador COMPARTILHADO scripts/ci/mutant_classifier.py (sem modificação).

Suíte (uma execução `node --test`, TAP): tests/p20-diario-sombra.test.mjs (DS1-DS11), D1 falso com SQL de verdade
(node:sqlite) e migração real; integração com as funções reais do Hotmart, do lead-magnet e do reembolso; estático no
bundle legado. Sem rede, sem Cloudflare, sem segredos. Cada mutante altera UMA regra numa cópia da árvore em diretório
temporário (o repositório nunca é alterado). Regras cobertas: nunca bloquear a resposta (await sem waitUntil), nunca
lançar, nunca gravar nem registrar PII, um gancho por tipo de evento, contexto da requisição no compat, waitUntil e a
fila por isolate.
Expectativas (mutants_p20_diario_sombra_allow.json, formato load_mutant_config), validação e códigos de saída iguais
aos de scripts/ci/mutants_p20_diario.py.
Uso: python3 scripts/ci/mutants_p20_diario_sombra.py [raiz-do-repo]
"""
import json, os, shutil, sys, tempfile

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import mutant_classifier as mc  # noqa: E402  (sem modificação)

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
REPO = Path(ARGS[0] if ARGS else Path(__file__).resolve().parents[2])
TESTS = ["tests/p20-diario-sombra.test.mjs"]
# worker/ e data/ inteiros: os handlers reais (Hotmart, lead-magnet, reembolso) importam vários módulos e dados.
COPY_DIRS = ["migrations/d1", "worker", "data", "tests/helpers"]
COPY_FILES = TESTS
TIMEOUT = 300
NODE = shutil.which("node") or "node"
SB, RF, LM, HM, CP, RC = ("worker/diario-sombra.mjs", "worker/refund-flow.mjs", "worker/lead-magnet.mjs",
                          "worker/cp-nc012-digital-hotmart.mjs", "worker/cloudflare-worker.compat.mjs", "worker/cloudflare-worker.recovered.mjs")
REFUND_OK = '  diarioSombra(env, ctx, () => eventoReembolso({ orderId: oid, provider: "mercadopago", stage: "approved", refundId: body.id, amount: record.amount, certification: record.test === true }));\n'
HOT_OK = ' if(ACTIVE.has(event))diarioSombra(env,null,()=>eventoEntrega({provider:"hotmart",transaction:txn,channel:"store",status:"hotmart_approved"}));\n'

M = {
    "S01 gancho do reembolso espera a gravação (bloqueia a resposta)": (RF, REFUND_OK, REFUND_OK.replace("  diarioSombra(", "  await diarioSombra(").replace("}));\n", "})).task;\n")),
    "S02 tarefa rejeita em erro (lança)": (SB, "    const task = fila.then(gravar).catch((error) => {\n", "    const task = fila.then(gravar).then((r) => r, (error) => { throw error;\n"),
    "S03 catch externo relança": (SB, "  } catch {\n    return { queued: false, reason: \"diario_sombra_erro\" };\n  }\n", "  } catch (error) {\n    throw error;\n  }\n"),
    "S04 evento inteiro no log (vaza PII)": (SB, "      registrar(tipo, r);\n      return r;\n    };\n", "      registrar(tipo, r);\n      console.log(JSON.stringify(evt));\n      return r;\n    };\n"),
    "S05 gancho Hotmart tenta gravar o comprador": (HM, HOT_OK, ' if(ACTIVE.has(event))diarioSombra(env,null,()=>{const e=eventoEntrega({provider:"hotmart",transaction:txn,channel:"store",status:"hotmart_approved"});return {...e,payload:{...e.payload,buyer:data?.buyer}};});\n'),
    "S06 sem gancho order_created no checkout Mercado Pago": (RC, '    if (inserted.length) diarioSombra(null, null, () => eventoPedidoCriado({ orderId, provider: "mercadopago",', '    if (false) diarioSombra(null, null, () => eventoPedidoCriado({ orderId, provider: "mercadopago",'),
    "S07 sem gancho payment_status no webhook Mercado Pago": (RC, '    if (Number(outcome.inserted_count) === 1) diarioSombra(null, null, () => eventoPagamento({ orderId: String(orders[0].order_id), provider: "mercadopago"', '    if (Number(outcome.inserted_count) === 1) void (null, null, () => eventoPagamento({ orderId: String(orders[0].order_id), provider: "mercadopago"'),
    "S08 sem gancho delivery_sent no Hotmart": (HM, HOT_OK, ""),
    "S09 sem gancho de consentimento": (LM, "  diarioSombra(null, null, () => eventoConsentimento({ event, subjectRef: ref, consentVersion, ts: Number.isSafeInteger(at) ? at : undefined }));\n", ""),
    "S10 sem gancho refund na aprovação": (RF, REFUND_OK, ""),
    "S11 compat sem o contexto do diário": (CP, "    const response=await comDiario(env, ctx, () => wrapped.processFetch(request, meteredEnv, ctx));\n", "    const response=await wrapped.processFetch(request, meteredEnv, ctx);\n"),
    "S12 sem waitUntil": (SB, "    if (host) { try { host.waitUntil(task); } catch {} }\n", ""),
    "S13 sem fila por isolate (corrida no CAS)": (SB, "    const task = fila.then(gravar).catch((error) => {\n", "    const task = gravar().catch((error) => {\n"),
}

ALLOW_FILE = Path(os.environ.get("P20_DIARIO_SOMBRA_MUTANTS_ALLOW_FILE") or Path(__file__).with_name("mutants_p20_diario_sombra_allow.json"))


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
