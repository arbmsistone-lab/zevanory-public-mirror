#!/usr/bin/env python3
"""Mutantes causais dos vetores da x-signature Mercado Pago (Roteiro v4.4, seção 7), classificados pelo classificador
COMPARTILHADO scripts/ci/mutant_classifier.py (sem modificação).

Cada mutante altera UMA CÓPIA temporária de worker/cloudflare-worker.recovered.mjs (o original nunca é tocado), roda
tests/mercadopago-signature-vectors.test.mjs contra a cópia e chama mc.classify_run. A suíte extrai a função real
verifyMercadoPagoSignature do texto do Worker, então a mutação é exercitada pelos vetores de
data/test-vectors/mercadopago-signature-v1.json.

Expectativas (regra do docstring do classificador, audit 128): por mutante, 1-3 PRIMÁRIAS = a asserção [Vnn.verdict] do
vetor que codifica DIRETAMENTE a regra mutada, conferida dentro do bloco `not ok` daquele teste; SECUNDÁRIAS só com
justificativa causal; broad_reason quando mais de 4 testes. Escritas por raciocínio sobre a mutação ANTES de rodá-la
(ver "why" de cada mutante), nunca copiadas das falhas observadas.

Limite declarado: trocar timingSafeEqual por "===" sobre o hexadecimal COMPLETO é comportamentalmente equivalente
(mesmo aceita/recusa para toda entrada); nenhum vetor pode matá-lo. Essa regra continua coberta só pela verificação
estática S11 de tests/mercadopago-webhook-signature.test.mjs. Aqui entra a variante PARCIAL (prefixo), que os vetores
detectam. A ausência de proteção contra replay (GAP-MP-SIG-REPLAY, vetor V15) não tem mutante: não há código a mutar.

Saída: "BASELINE PASS tests=16", uma linha "MUTANT <id> KILLED|SURVIVED|INCONCLUSIVE" e uma "RESULT {json}" por
mutante, e "MUTANTS total=N killed=K survived=S inconclusive=I". INCONCLUSIVE repete 1 vez; persistindo, conta como tal.
Exit (mc.aggregate): 0 todos KILLED; 1 algum SURVIVED; 2 baseline/config inválidos; 3 algum INCONCLUSIVE.
Uso: python3 scripts/ci/mutants_mp_signature_vectors.py [raiz-do-repo]
"""
import json, os, shutil, sys, tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mutant_classifier as mc  # noqa: E402

REPO = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[2])
W = "worker/cloudflare-worker.recovered.mjs"
TEST = "tests/mercadopago-signature-vectors.test.mjs"
COPY = [W, TEST, "tests/helpers/text.mjs", "data/test-vectors/mercadopago-signature-v1.json"]
BASELINE_TOTAL = 16  # igual à linha do arquivo em tests/node-suite.manifest
NODE = shutil.which("node") or "node"
TIMEOUT = 300


def P(vid, label="verdict"):
    return {"test_pattern": vid, "assertion_pattern": f"[{vid}.{label}]"}


def S(vid, label, why):
    return {"test_pattern": vid, "assertion_pattern": f"[{vid}.{label}]", "justification": why}


WINDOW = "if (!Number.isFinite(tsMs) || Math.abs(now - tsMs) > 10 * 60 * 1e3) return false;"
COMPARE = "return a2.length === b2.length && crypto5.timingSafeEqual(a2, b2);"
MANIFEST = "const manifest = `id:${dataId};request-id:${requestId};ts:${ts2};`;"
PARSE = '.map((x2) => x2.trim().split("="))'
REQ_ID = "!/^[a-f0-9]{64}$/i.test(v1) || !safeText2(requestId, 1, 160) ||"

# id -> (arquivo, trecho original (ocorre 1 vez), substituto, expectativas, porquê)
MUTANTS = {
    "MV1 ts window skipped": (W, WINDOW, "if (!Number.isFinite(tsMs)) return false;",
        {"primary": [P("V07"), P("V08")]},
        "sem janela, V07/V08 (HMAC correto, ts a 601 s) passam a ser aceitos; nenhum outro vetor depende da janela "
        "para recusar (V09 já é aceito, V15 está a 0/60 s)."),
    "MV2 future ts accepted (one-sided window)": (W, WINDOW, WINDOW.replace("Math.abs(now - tsMs)", "now - tsMs"),
        {"primary": [P("V08")]},
        "janela só para o passado: V08 (601 s no futuro) é aceito; V07 (601 s no passado) continua recusado."),
    "MV3 window boundary exclusive": (W, WINDOW, WINDOW.replace("> 10 * 60 * 1e3", ">= 10 * 60 * 1e3"),
        {"primary": [P("V09")]},
        "borda exclusiva: V09 (exatamente 600 s) passa a ser recusado; V07/V08 continuam recusados."),
    "MV4 v1 compared partially and non-constant (first 32 hex)": (W, COMPARE,
        "return expected.slice(0, 32) === v1.toLowerCase().slice(0, 32);",
        {"primary": [P("V02")]},
        "V02 difere só no último caractere: o prefixo de 32 coincide e é aceito; V03/V04/V06/V14 têm HMAC "
        "totalmente diferente e continuam recusados."),
    "MV5 manifest omits request-id": (W, MANIFEST, "const manifest = `id:${dataId};ts:${ts2};`;",
        {"primary": [P("V14"), P("V01")],
         "secondary": [
             S("V09", "verdict", "assinatura válida de V09 cobre request-id; o manifesto mutado difere e V09 é recusado"),
             S("V11", "verdict", "V11 carrega o mesmo v1 de V01 (cobre request-id); o manifesto mutado difere"),
             S("V15", "first", "V15 carrega o mesmo v1 de V01; a 1ª entrega já é recusada (a 2ª não é alcançada)"),
         ],
         "broad_reason": "o mutante muda o manifesto de TODA verificação: todo vetor aceito (V01, V09, V11, V15) tem "
                         "v1 sobre o manifesto oficial com request-id e passa a ser recusado; V14 é o vetor que "
                         "codifica a regra (assinatura que não cobre request-id passa a ser aceita)."},
        "V14 (v1 sobre 'id;ts' com x-request-id presente) é aceito; os vetores aceitos (V01/V09/V11/V15) passam a "
        "ser recusados porque seus v1 cobrem request-id. V05/V06 continuam recusados pelo safeText2."),
    "MV6 x-request-id not required": (W, REQ_ID, "!/^[a-f0-9]{64}$/i.test(v1) ||",
        {"primary": [P("V06")]},
        "sem exigir x-request-id, V06 (HMAC de 'request-id:;') confere e é aceito; V05 continua recusado porque o "
        "Worker monta 'request-id:;' e o v1 de V05 foi calculado sem a parte request-id."),
    "MV7 lenient '=' parsing (trim key and value)": (W, PARSE, '.map((x2) => x2.split("=").map((s) => s.trim()))',
        {"primary": [P("V12")]},
        "com trim em chave e valor, V12 ('ts = .., v1 = ..') vira ts/v1 válidos e é aceito; V11 já era aceito; V13 "
        "(';') continua sem ts/v1."),
}


def load_config(titles):
    cfg = mc.load_mutant_config({k: v[3] for k, v in MUTANTS.items()})
    for mid, spec in cfg.items():
        for e in spec["primary"]:
            if not (isinstance(e.get("assertion_pattern"), str) and e["assertion_pattern"].strip()):
                raise mc.ConfigError(f"{mid}: primary sem assertion_pattern")
        for e in spec["primary"] + spec["secondary"]:
            if not any(mc._test_matches(e["test_pattern"], t) for t in titles):
                raise mc.ConfigError(f"{mid}: test_pattern não casa com nenhum teste da baseline: {e['test_pattern']}")
    return cfg


def build(tmp, mutation=None):
    for rel in COPY:
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
    env = {**os.environ, "NODE_NO_WARNINGS": "1", "NO_COLOR": "1", "FORCE_COLOR": "0", "NODE_OPTIONS": ""}
    return mc.run_command([NODE, "--test", "--test-reporter=tap", "--test-reporter-destination=stdout", TEST],
                          cwd=root, timeout=TIMEOUT, env=env)


def run_mutant(name, total, spec):
    rel, old, new = MUTANTS[name][:3]
    with tempfile.TemporaryDirectory() as tmp:
        ok = build(tmp, (rel, old, new))
        run = run_suite(tmp) if ok else {"return_code": 1, "stdout": "", "stderr": "", "timed_out": False, "signal": None}
    return mc.classify_run(total, run, expected=spec, allowlist=spec.get("allowlist") or [], anchor_ok=ok, mutant_id=name)


def main():
    before = Path(REPO, W).read_bytes()
    with tempfile.TemporaryDirectory() as tmp:
        build(tmp)
        base = run_suite(tmp)
    parsed = mc.parse_tap(base.get("stdout", ""), stderr=base.get("stderr", ""))
    vb = mc.validate_baseline(BASELINE_TOTAL, base.get("return_code"), parsed["summary"], parsed["failures"],
                              timed_out=base.get("timed_out", False), signal=base.get("signal"))
    if not vb["ok"]:
        print("BASELINE FAILED", vb["reason"])
        return mc.EXIT_BAD_BASELINE
    titles = [p.get("test_id") for p in parsed["summary"].get("points") or []]
    print(f"BASELINE PASS tests={BASELINE_TOTAL}")
    try:
        cfg = load_config(titles)
    except mc.ConfigError as e:
        print("CONFIG_INVALID", e)
        return mc.EXIT_BAD_BASELINE

    def judge(name):
        res = run_mutant(name, BASELINE_TOTAL, cfg[name])
        if res["verdict"] == mc.INCONCLUSIVE:
            first = res["reason"]
            res = run_mutant(name, BASELINE_TOTAL, cfg[name])
            if res["verdict"] == mc.INCONCLUSIVE:
                res["reason"] = f"{first} | repetição: {res['reason']}"
        return res

    with ThreadPoolExecutor(max_workers=min(4, os.cpu_count() or 2)) as ex:
        results = list(ex.map(judge, MUTANTS))
    for r in results:
        print(f"MUTANT {r['mutant_id']} {r['verdict']}" + ("" if r["verdict"] == mc.KILLED else f" ({r['reason'][:300]})"))
        print("RESULT " + json.dumps({k: r.get(k) for k in ("mutant_id", "verdict", "reason", "killing_tests", "assertion_ids",
                                                             "secondary_tests", "unexpected_failures")}, ensure_ascii=False))
    if Path(REPO, W).read_bytes() != before:
        print("ERROR worker original alterado durante os mutantes")
        return mc.EXIT_BAD_BASELINE
    code, summary = mc.aggregate(results, baseline_valid=True)
    print(f"MUTANTS total={len(results)} killed={summary['KILLED']} survived={summary['SURVIVED']} "
          f"inconclusive={summary['INCONCLUSIVE']}")
    return code


if __name__ == "__main__":
    sys.exit(main())
