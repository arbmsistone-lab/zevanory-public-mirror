#!/usr/bin/env python3
"""Mutantes causais da amarração região de assinatura <-> build publicado (roteiro seção 7), classificados pelo
classificador COMPARTILHADO scripts/ci/mutant_classifier.py (load_mutant_config, classify_run, aggregate; sem cópia da
lógica de veredito).

Suíte: tests/mp-signature-binding.test.mjs + tests/mercadopago-webhook-signature.test.mjs (uma execução TAP).
Config: scripts/ci/mutants_mp_signature_binding.json ("mutants" no formato de load_mutant_config). Regras deste runner
(além das do classificador): todo primary tem assertion_pattern NÃO nulo (marcador [Bn.k]/[Sn.k] da asserção que
codifica a regra mutada) e todo test_pattern casa com um teste da baseline. As expectativas foram escritas por
raciocínio sobre cada mutação ANTES de rodá-la (a justificativa de cada secondary diz o mecanismo).
Cada mutante altera UMA cópia temporária da árvore mínima; o repositório nunca é tocado. INCONCLUSIVE repete 1 vez;
persistindo, o job falha. Exit: 0 todos KILLED; 1 SURVIVED; 2 baseline/config; 3 INCONCLUSIVE.
Uso: python3 scripts/ci/mutants_mp_signature_binding.py [raiz-do-repo]
"""
import json, os, shutil, sys, tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import mutant_classifier as mc  # noqa: E402

REPO = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[2])
TESTS = ["tests/mp-signature-binding.test.mjs", "tests/mercadopago-webhook-signature.test.mjs"]
D = "scripts/deploy/"
SPEC, P, WBI, G, RB, PCC, PREP = (D + "mp-signature-region.json", D + "build_provenance.py", D + "write-build-info.py",
                                   D + "verify-signature-region-binding.py", D + "verify-live-build-info.py",
                                   D + "prepare-certification-config.py", D + "prepare-central-candidate.py")
CW, CB = "certification-worker.mjs", "scripts/ci/cloudflare-build.sh"
PROD, DRY, CERT = (".github/workflows/central-production-deploy.yml", ".github/workflows/central-candidate-dryrun.yml",
                   ".github/workflows/certification-isolated-deploy.yml")
COPY = [*TESTS, "tests/helpers/text.mjs", "tests/helpers/toolchain.mjs", "tests/helpers/mp-signature-region.mjs",
        "worker/cloudflare-worker.recovered.mjs", "worker/binding-aliases.mjs", SPEC, P, WBI, G, RB, PCC, PREP,
        D + "public_whatsapp_scan.py", CW, CB,
        PROD, DRY, CERT]
NODE = shutil.which("node") or "node"
TIMEOUT = 300
CONFIG = Path(__file__).with_name("mutants_mp_signature_binding.json")
ANCHOR_WRITE = 'recovered.write_text(recovered_src,encoding="utf-8")'

M = {
    # definição da região
    "R1 spec joiner changed": (SPEC, '"joiner": "\\n",', '"joiner": "\\n\\n",'),
    "R2 python skips CRLF normalization": (P, "    src = normalize_eol(src)\n    out = []", "    out = []"),
    "R3 python joins parts without separator": (P, 'return spec["joiner"].join(out)', 'return "".join(out)'),
    "R4 python accepts duplicated anchors": (P, '        n = src.count(start)\n        if n != 1:\n            raise RegionError(f"REGION_ANCHOR_NOT_UNIQUE: {start!r} occurs {n} times")\n', ""),
    # build-info
    "W1 build-info omits the region": (WBI, ',\n            "mp_signature_region_sha256": bp.region_sha256_file()}', "}"),
    "W2 build-info hashes the whole worker": (WBI, '"mp_signature_region_sha256": bp.region_sha256_file()}', '"mp_signature_region_sha256": bp.hashlib.sha256(Path(bp.load_spec()["source"]).read_bytes()).hexdigest()}'),
    "W3 bundle hash takes the largest output file": (P, '    modules = sorted(p for p in d.iterdir() if p.is_file() and p.suffix in (".js", ".mjs"))', '    modules = sorted((p for p in d.iterdir() if p.is_file()), key=lambda p: -p.stat().st_size)[:1]'),
    "W4 bundle with two modules accepted": (P, "    if len(modules) != 1:", "    if not modules:"),
    "W5 bundle-dir drops the other fields": (WBI, '    info["bundle_sha256"], _module = bp.bundle_sha256(sys.argv[2])', '    info = {"bundle_sha256": bp.bundle_sha256(sys.argv[2])[0]}'),
    # guarda contra os patches de deploy
    "G1 guard compares tested with itself": (G, '"region_after_patch": bp.region_sha256_text(after.decode("utf-8")),', '"region_after_patch": tested,'),
    "G2 guard hashes the pre-patch worker": (G, '"region_after_patch": bp.region_sha256_text(after.decode("utf-8")),', '"region_after_patch": bp.region_sha256_text(before.decode("utf-8")),'),
    "G3 guard drops the free-identifier check": (G, '        if res["free_identifiers_changed"]:', "        if False:"),
    "G4 guard drops the vacuous-comparison check": (G, '        if not res["worker_patched"]:', "        if False:"),
    "G5 guard ignores the recorded build-info": (G, "        if recorded != tested:", "        if False:"),
    "G6 deploy patch edits the signature region": (PREP, ANCHOR_WRITE, 'recovered_src = recovered_src.replace("Math.abs(now - tsMs) > 10 * 60 * 1e3", "Math.abs(now - tsMs) > 60 * 60 * 1e3", 1)\n' + ANCHOR_WRITE),
    "G7 deploy patch rebinds crypto5": (PREP, ANCHOR_WRITE, "recovered_src = recovered_src.replace('import crypto5 from \"node:crypto\";', 'import crypto5 from \"./crypto-shim.mjs\";', 1)\n" + ANCHOR_WRITE),
    # readback pós-deploy
    "K1 readback ignores the region": (RB, '    if live.get("mp_signature_region_sha256") != tested_region:', "    if False:"),
    "K2 readback treats a missing region as match": (RB, 'live.get("mp_signature_region_sha256") != tested_region', 'live.get("mp_signature_region_sha256", tested_region) != tested_region'),
    "K3 readback ignores the sha": (RB, '    if live.get("sha") != expected_sha:', "    if False:"),
    "K4 readback ignores the bundle": (RB, '    if local_bundle is not None and live.get("bundle_sha256") != local_bundle:', "    if False:"),
    "K5 readback uses POST": (RB, 'method="GET"', 'method="POST"'),
    # fiação dos workflows
    "F1 production bundle step removed": (PROD, "          python3 scripts/deploy/write-build-info.py --bundle-dir /tmp/central-final\n", ""),
    "F2 production readback never fails": (PROD, "        if: steps.auth.outputs.available == 'true' && steps.deployworker.outcome == 'success'\n        run: |\n          set -euo pipefail\n          python3 scripts/deploy/verify-live-build-info.py", "        if: steps.auth.outputs.available == 'true' && steps.deployworker.outcome == 'success'\n        continue-on-error: true\n        run: |\n          set -euo pipefail\n          python3 scripts/deploy/verify-live-build-info.py"),
    "F3 production readback runs after failures": (PROD, "        if: steps.auth.outputs.available == 'true' && steps.deployworker.outcome == 'success'\n        run: |\n          set -euo pipefail\n          python3 scripts/deploy/verify-live-build-info.py", "        if: always() && steps.auth.outputs.available == 'true' && steps.deployworker.outcome == 'success'\n        run: |\n          set -euo pipefail\n          python3 scripts/deploy/verify-live-build-info.py"),
    "F4 dry-run guard removed": (DRY, "          python3 scripts/deploy/verify-signature-region-binding.py --base 83620c680958d726fc4b0fd16e2574cdcc362a6d | tee", "          true | tee"),
    "F5 dry-run determinism check removed": (DRY, '          test "$a" = "$b" || {', "          true || {"),
    "F6 reserve build bundle step removed": (CB, "python3 scripts/deploy/write-build-info.py --bundle-dir /tmp/central-final\n", ""),
    # certificação
    "C1 certification worker does not echo the region": (CW, ",\n       mp_signature_region_sha256:env.CERTIFICATION_MP_SIGNATURE_REGION_SHA256}", "}"),
    "C2 certification config skips the build-info check": (PCC, "    if info.exists() and json.loads(", "    if False and json.loads("),
    "C3 certification config omits the region var": (PCC, '        config["vars"]["CERTIFICATION_MP_SIGNATURE_REGION_SHA256"]=mp_signature_region()\n', ""),
    "C4 certification workflow does not check the echo": (CERT, "assert j.get('mp_signature_region_sha256')==sys.argv[1],", "assert True,"),
}


def load_config(titles=None):
    raw = json.loads(CONFIG.read_text(encoding="utf-8"))
    specs = raw.get("mutants") if isinstance(raw, dict) else None
    if not isinstance(specs, dict):
        raise mc.ConfigError("config sem a seção 'mutants'")
    cfg = mc.load_mutant_config(specs)
    missing, orphan = sorted(set(M) - set(cfg)), sorted(set(cfg) - set(M))
    if missing or orphan:
        raise mc.ConfigError(f"mutantes sem config {missing} / config órfã {orphan}")
    for mid, spec in cfg.items():
        for e in spec["primary"]:
            if not (isinstance(e.get("assertion_pattern"), str) and e["assertion_pattern"].strip()):
                raise mc.ConfigError(f"{mid}: primary sem assertion_pattern")
        if titles is not None:
            for e in spec["primary"] + spec["secondary"]:
                if not any(mc._test_matches(e["test_pattern"], t) for t in titles):
                    raise mc.ConfigError(f"{mid}: test_pattern não casa com nenhum teste: {e['test_pattern']}")
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
    env = {**os.environ, "NODE_NO_WARNINGS": "1", "NO_COLOR": "1", "FORCE_COLOR": "0", "NODE_OPTIONS": "",
           "PYTHONDONTWRITEBYTECODE": "1"}
    return mc.run_command([NODE, "--test", "--test-reporter=tap", "--test-reporter-destination=stdout", *TESTS],
                          cwd=root, timeout=TIMEOUT, env=env)


def run_mutant(name, mutation, total, spec):
    with tempfile.TemporaryDirectory(prefix="zev-mut-sig-") as tmp:
        ok = build(tmp, mutation)
        run = run_suite(tmp) if ok else {"return_code": 1, "stdout": "", "stderr": "", "timed_out": False, "signal": None}
    return mc.classify_run(total, run, expected=spec, allowlist=spec.get("allowlist") or [], anchor_ok=ok, mutant_id=name)


def main():
    with tempfile.TemporaryDirectory(prefix="zev-mut-sig-") as tmp:
        build(tmp)
        base = run_suite(tmp)
    parsed = mc.parse_tap(base.get("stdout", ""), stderr=base.get("stderr", ""))
    total = parsed["summary"].get("tests")
    vb = mc.validate_baseline(total if isinstance(total, int) else -1, base.get("return_code"), parsed["summary"],
                              parsed["failures"], timed_out=base.get("timed_out", False), signal=base.get("signal"))
    if not vb["ok"]:
        print("BASELINE FAILED", vb["reason"])
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

    with ThreadPoolExecutor(max_workers=min(6, os.cpu_count() or 2)) as ex:
        results = list(ex.map(judge, M.items()))
    for r in results:
        print(f"MUTANT {r['mutant_id']} {r['verdict']}" + ("" if r["verdict"] == mc.KILLED else f" ({r['reason'][:300]})"))
        print("RESULT " + json.dumps({k: r.get(k) for k in ("mutant_id", "verdict", "reason", "killing_tests", "assertion_ids",
                                                           "secondary_tests", "unexpected_failures")}, ensure_ascii=False))
    code, summary = mc.aggregate(results, baseline_valid=True)
    print(f"MUTANTS total={len(results)} killed={summary['KILLED']} survived={summary['SURVIVED']} "
          f"inconclusive={summary['INCONCLUSIVE']}")
    return code


if __name__ == "__main__":
    sys.exit(main())
