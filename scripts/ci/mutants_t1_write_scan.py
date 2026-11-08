#!/usr/bin/env python3
"""Mutantes causais do detector ampliado de caminhos de escrita do T1 (scripts/deploy/t1-write-scan.mjs) e da
conferência do inventário ops/publishers.json -> write_paths, classificados pelo classificador COMPARTILHADO
scripts/ci/mutant_classifier.py (sem modificação).

Suíte (uma execução `node --test`, TAP): tests/t1-write-scan.test.mjs (WS1-WS6), com fixtures de workflow em
tests/t1_scan/fixtures e repositórios sintéticos em diretório temporário. Sem rede, sem Cloudflare, sem segredos.
Cada mutante altera UMA regra do detector numa cópia mínima da árvore (o repositório nunca é alterado).
Expectativas (mutants_t1_write_scan_allow.json, formato load_mutant_config): primary (1-3) com test_pattern E
assertion_pattern NÃO nulo (marcador [WSn.k] da asserção que codifica a regra) e secondary com justification,
escritas por raciocínio sobre a mutação ANTES de rodá-la. Validação antes de qualquer mutante (exit 2): config
inválida, primary sem marcador, test_pattern que não casa com nenhum teste da baseline, mutante sem config ou
config órfã. INCONCLUSIVE repete 1 vez; persistindo, o job falha.
Exit: 0 todos KILLED; 1 SURVIVED; 2 baseline/config; 3 INCONCLUSIVE.
Uso: python3 scripts/ci/mutants_t1_write_scan.py [raiz-do-repo]
"""
import json, os, shutil, sys, tempfile

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import mutant_classifier as mc  # noqa: E402  (sem modificação)

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
REPO = Path(ARGS[0] if ARGS else Path(__file__).resolve().parents[2])
TESTS = ["tests/t1-write-scan.test.mjs"]
# O teste WS4/WS5 varre a árvore real: workflows, scripts/, sandbox/ (scripts chamados) e o registro.
COPY_DIRS = [".github/workflows", "scripts", "sandbox", "tests/t1_scan"]
COPY_FILES = TESTS + ["tests/helpers/text.mjs", "tests/publisher-inventory.test.mjs", "ops/publishers.json"]
TIMEOUT = 300
NODE = shutil.which("node") or "node"
S = "scripts/deploy/t1-write-scan.mjs"

M = {
    "M01 continuação de linha não é juntada": (S, '    if (/\\\\\\s*$/.test(ln)) { buf.text += ln.replace(/\\\\\\s*$/, " "); continue; }\n', ""),
    "M02 --dry-run não exclui mais": (S, "      if (w.dry && /--dry-run\\b/.test(flat)) continue;\n", ""),
    "M03 --local não exclui mais": (S, "      if (w.local && /--local\\b/.test(flat) && !/--remote\\b/.test(flat)) continue;\n", ""),
    "M04 versions secret não detectado": (S, 'String.raw`(?:versions[\\s"\',]+)?secret[\\s"\',]+(?:put|delete|bulk)\\b`', 'String.raw`secret[\\s"\',]+(?:put|delete|bulk)\\b`'),
    "M05 wrangler kv key/bulk não detectado": (S, '  { cls: "config-kv", re: new RegExp(W + String.raw`kv(?::|[\\s"\',]+)(?:key|bulk)[\\s"\',]+(?:put|delete)\\b`), local: true },\n', ""),
    "M06 curl com corpo sem -X não conta como escrita": (S, "|\\bcurl\\b[^\\n]*\\s(?:-d|--data(?:-binary|-raw|-urlencode)?|-F|--form|-T|--upload-file|--json)(?=[\\s=])/;", "/;"),
    "M07 URL de outro host não encerra a busca do endereço": (S, "        else if (other) break;\n", ""),
    "M08 função auxiliar de escrita ignorada": (S, "      if (hit) { helpers.set(name, hit.cls); break; }\n", "      if (hit) break;\n"),
    "M09 variável com caminho de escrita ignorada": (S, "    for (const p of PATHS) if (p.re.test(m[2])) { pathVars.set(m[1], p.cls); break; }\n", ""),
    "M10 item de filtro paths conta como chamada": (S, "    if (/^\\s*-\\s*[\"']?[\\w./*-]+[\"']?\\s*$/.test(l.text)) continue;\n", ""),
    "M11 guard depois da escrita aceito": (S, "        else if (firstWrite !== null && at > firstWrite) err(", "        else if (false) err("),
    "M12 troca de alvo do isolado aceita": (S, '.test(f.snippet)) err("ISOLATED_TARGET_SWAP"', '.test(f.snippet) && false) err("ISOLATED_TARGET_SWAP"'),
    "M13 token de outro Worker aceito": (S, '      if (owner.get(f) !== svc) err("TOKEN_CROSS_WORKER"', '      if (false) err("TOKEN_CROSS_WORKER"'),
    "M14 credencial em no-credential aceita": (S, '      if (hasCred) err("CREDENTIAL_IN_NO_CREDENTIAL"', '      if (false) err("CREDENTIAL_IN_NO_CREDENTIAL"'),
    "M15 caminho não registrado aceito": (S, '    if (!e) { err("UNREGISTERED_WRITE_PATH",', '    if (!e) { void ("UNREGISTERED_WRITE_PATH",'),
    "M16 contagem fixa do não escritor ignorada": (S, '      if (e.findings !== found.findings.length) err("NOT_A_WRITER_CHANGED"', '      if (false) err("NOT_A_WRITER_CHANGED"'),
    "M17 via sem recursão": (S, "      for (const x of writersVia(r, seen)) out.add(x);\n", ""),
    "M18 crase em Python não é prosa": (S, 'opts.python ? String(text).replace(/`[^`\\n]*`/g, "``") : text', "text"),
    "M19 intérprete fora de scripts/ ignorado": (S, "    for (const m of l.text.matchAll(INTERP_REF)) if (!/^(?:\\/|tests\\/)/.test(m[1])) refs.add(m[1].replace(/^\\.\\//, \"\"));\n", ""),
    "M20 token de sonda não conta como credencial": (S, "secrets\\.(?:CLOUDFLARE_[A-Z0-9_]*TOKEN[A-Z0-9_]*|CF_[A-Z0-9_]*TOKEN[A-Z0-9_]*)\\b", "secrets\\.(?:CLOUDFLARE_API_TOKEN|CLOUDFLARE_PUBLIC_OWNER_API_TOKEN|CF_TOKEN_[A-Z0-9_]+)\\b"),
}

ALLOW_FILE = Path(os.environ.get("T1_WRITE_SCAN_MUTANTS_ALLOW_FILE") or Path(__file__).with_name("mutants_t1_write_scan_allow.json"))


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
