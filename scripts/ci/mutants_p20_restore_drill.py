#!/usr/bin/env python3
"""Mutantes causais do ensaio mensal P20 (scripts/p20/*) e da sua ligação ao registro B0 (scripts/b0/*), classificados
pelo classificador COMPARTILHADO scripts/ci/mutant_classifier.py (sem modificação).

Suíte (uma execução `node --test`, TAP): tests/p20-restore-drill.test.mjs (D1-D12) e tests/b0-baseline.test.mjs (B0 e
P20 no registro). Sem rede, sem banco, sem segredos. Cada mutante altera UMA regra numa cópia mínima da árvore em
diretório temporário (o repositório nunca é alterado).
Expectativas (mutants_p20_restore_drill_allow.json, formato load_mutant_config): primary (1-3) com test_pattern E
assertion_pattern NÃO nulo (marcador [Dn.k]/[B0P20.k] da asserção que codifica a regra) e secondary com justification,
escritas por raciocínio sobre a mutação ANTES de rodá-la. Validação antes de qualquer mutante (exit 2): config inválida,
primary sem marcador, test_pattern que não casa com nenhum teste da baseline, mutante sem config ou config órfã.
INCONCLUSIVE repete 1 vez; persistindo, o job falha. Exit: 0 todos KILLED; 1 SURVIVED; 2 baseline/config; 3 INCONCLUSIVE.
Uso: python3 scripts/ci/mutants_p20_restore_drill.py [raiz-do-repo]
"""
import json, os, shutil, sys, tempfile

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import mutant_classifier as mc  # noqa: E402  (sem modificação)

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
REPO = Path(ARGS[0] if ARGS else Path(__file__).resolve().parents[2])
TESTS = ["tests/p20-restore-drill.test.mjs", "tests/b0-baseline.test.mjs"]
COPY_DIRS = ["scripts/p20", "scripts/b0", "docs/p20", "docs/b0"]
COPY_FILES = TESTS + ["tests/helpers/text.mjs", "tests/helpers/p20-backup-fixture.mjs", "scripts/audit/workers-usage.mjs",
                      ".github/workflows/p20-monthly-restore-drill.yml", ".github/workflows/b0-baseline-collector.yml",
                      ".github/workflows/p18-external-monitor.yml", ".github/workflows/b0-baseline-tests.yml", ".github/workflows/p18-monitor-watchdog.yml"]
TIMEOUT = 300
NODE = shutil.which("node") or "node"
L, D, P = "scripts/p20/restore-drill-lib.mjs", "scripts/p20/restore-drill.mjs", "scripts/p20/publish-drill.mjs"
B, C, W = "scripts/b0/b0-lib.mjs", "scripts/b0/b0-collector.mjs", ".github/workflows/p20-monthly-restore-drill.yml"

M = {
    "M01 hash por tabela não conferido": (L, "      if (h !== m.sha) { fail(`hash_mismatch:${t}`); partOk = false; continue; }\n", ""),
    "M02 restaura cópia com falha de integridade": (D, "  if (assessment?.readable && assessment.failures.length === 0) {", "  if (assessment?.readable) {"),
    "M03 rótulo de produção sem leitura real": (L, "  if (mode === \"producao\" && sourceRead === true) return \"ENSAIO_EM_PRODUCAO\";", "  if (mode === \"producao\") return \"ENSAIO_EM_PRODUCAO\";"),
    "M04 alvo com host não local aceito": (L, "  if (!EPHEMERAL_HOSTS.includes(host)) throw new Error(\"TARGET_NOT_EPHEMERAL host\");\n", ""),
    "M05 DATABASE_URL no ambiente aceito": (L, "  for (const k of [\"DATABASE_URL\", \"RESTORE_TARGET_DATABASE_URL\",", "  for (const k of [\"RESTORE_TARGET_DATABASE_URL\","),
    "M06 leitor do KV grava (PUT)": (D, "    const r = await fetchImpl(url, { method: \"GET\",", "    const r = await fetchImpl(url, { method: \"PUT\","),
    "M07 leitor de produção lê fora do namespace do backup": (D, "  return async (key) => {\n    if (!BACKUP_KEY.test(key)) throw new Error(\"key_outside_backup_namespace\");\n    const url", "  return async (key) => {\n    const url"),
    "M08 RPO pela parte mais nova": (L, "  const oldest = Math.min(...partStartedAts.map((t) => Date.parse(t)));", "  const oldest = Math.max(...partStartedAts.map((t) => Date.parse(t)));"),
    "M09 tolerância de idade 72 h em vez de 26 h": (L, "export const MAX_AGE_H = 26;", "export const MAX_AGE_H = 72;"),
    "M10 RTO publicado com ensaio reprovado": (L, "    rto_seconds: verdict === \"APROVADO\" && isNum(rtoSeconds) ?", "    rto_seconds: verdict !== \"NOT_AVAILABLE\" && isNum(rtoSeconds) ?"),
    "M11 aprovado com falhas aceito na releitura": (L, "    if (r.failures.length || i.tables_hash_ok !== i.tables_checked", "    if (i.tables_hash_ok !== i.tables_checked"),
    "M12 rótulo ENSAIO_EM_PRODUCAO em modo sintético aceito": (L, "  if (r.label === \"ENSAIO_EM_PRODUCAO\" && r.mode !== \"producao\") throw new Error(\"label_mode_mismatch\");\n", ""),
    "M13 restauração parcial aprovada": (L, " || r.restore.tables !== i.tables_checked) throw new Error(\"approved_without_full_restore\");", ") throw new Error(\"approved_without_full_restore\");"),
    "M14 NOT_AVAILABLE com RPO aceito": (L, "    if (r.rpo_hours !== null || r.rto_seconds !== null || typeof r.reason !== \"string\")", "    if (typeof r.reason !== \"string\")"),
    "M15 publicação aceita registro de outro modo": (P, "  if (r.mode !== mode) return na(\"record_mode_mismatch\");\n", ""),
    "M16 relatório consolidado não ok ignorado": (L, "  if (R.ok !== true) fail(\"combined_report_not_ok\");\n", ""),
    "M17 parte de outro dia aceita": (L, "    if (P.day !== R.day) fail(`part_day_mismatch:${p}`);\n", ""),
    "M18 parte com falha aceita": (L, "    if (P.ok !== true || (Array.isArray(P.failures) && P.failures.length)) fail(`part_not_ok:${p}`);\n", ""),
    "M19 bundle ausente sem falha própria": (L, "    if (raw == null) { fail(`bundle_missing:${p}`); continue; }", "    if (raw == null) { continue; }"),
    "M20 resumo do manifesto não conferido": (L, " && manifestHash(shaOf).slice(0, 16) === P.neon.manifest;", ";"),
    "M21 tabela do manifesto ausente no bundle ignorada": (L, "    for (const t of mnames) if (!(t in bundle)) fail(`table_in_manifest_missing_from_bundle:${t}`);\n", ""),
    "M22 publicação do workflow sem Environment protegido": (W, "    environment: producao-critica  # aprovação do proprietário obrigatória; somente leitura (GET) no KV\n", ""),
    "M23 job de publicação com segredo": (W, "    env:\n      EVIDENCE_BRANCH: evidence/b0-baseline\n", "    env:\n      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n      EVIDENCE_BRANCH: evidence/b0-baseline\n"),
    "M24 B0 conta ensaio SINTETICA": (B, "  const r = win.find((x) => x.label === \"ENSAIO_EM_PRODUCAO\" && [\"APROVADO\", \"REPROVADO\"].includes(x.verdict));", "  const r = win.find((x) => [\"APROVADO\", \"REPROVADO\"].includes(x.verdict));"),
    "M25 B0 janela de 400 dias": (B, "export const P20_DRILL_WINDOW_DAYS = 31;", "export const P20_DRILL_WINDOW_DAYS = 400;"),
    "M26 B0 conta ensaio posterior ao dia": (B, " && Date.parse(r.finished_at) >= start && Date.parse(r.finished_at) <= end)", " && Date.parse(r.finished_at) >= start)"),
    "M27 B0 histórico P20 malformado tratado como vazio": (C, "    try { drills = readDrills(evidenceDir); } catch { drills = null; }", "    try { drills = readDrills(evidenceDir); } catch { drills = []; }"),
    "M28 B0 aprovado com restauração parcial aceito": (B, "    && (v.verdict === \"REPROVADO\" || (v.tables_hash_ok === v.tables_checked && v.tables_restored === v.tables_checked && isNum(v.rpo_hours) && isNum(v.rto_seconds)))", "    && (v.verdict === \"REPROVADO\" || (v.tables_hash_ok === v.tables_checked && isNum(v.rpo_hours) && isNum(v.rto_seconds)))"),
    "M29 B0 flag complete forjada aceita": (B, "    if (e.complete === true && !presentOk) throw new Error(\"complete_flag_mismatch \" + pid);", "    if (false) throw new Error(\"complete_flag_mismatch \" + pid);"),
}

ALLOW_FILE = Path(os.environ.get("P20_MUTANTS_ALLOW_FILE") or Path(__file__).with_name("mutants_p20_restore_drill_allow.json"))


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
