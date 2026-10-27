#!/usr/bin/env python3
"""Mutantes do estado de desempenho do P18 (ORDEM 295, aval do Sol). Cada mutante altera UMA CÓPIA temporária de
scripts/b0, roda tests/p18-latency.test.mjs (TAP) contra a cópia e classifica com o classificador compartilhado
(scripts/ci/mutant_classifier.py, regra R5): KILLED só quando falha uma asserção PRIMÁRIA declarada, com o rótulo
dentro do bloco `not ok`; secundárias têm justificativa causal; todo o resto é INCONCLUSIVE.

As expectativas foram escritas pelo raciocínio sobre cada mutação (qual regra ela quebra e qual asserção é a PRIMEIRA
a falhar em cada teste, já que o node:test para no primeiro assert que falha), antes de rodar.
Uso: python3 scripts/ci/mutants_p18_latency.py [raiz-do-repo]. Exit 0 = todos KILLED; 1 = sobrevivente;
2 = baseline; 3 = inconclusivo.
"""
import json, shutil, sys, tempfile
from pathlib import Path

sys.dont_write_bytecode = True  # nunca deixar __pycache__ no checkout
REPO = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[2]).resolve()
sys.path.insert(0, str(REPO / "scripts" / "ci"))
import mutant_classifier as mc  # noqa: E402

TEST = "tests/p18-latency.test.mjs"
COPY = ["scripts/b0", "scripts/p20", "tests/helpers/text.mjs", TEST]
LAT, MON, COL = "scripts/b0/p18-latency.mjs", "scripts/b0/p18-monitor.mjs", "scripts/b0/b0-collector.mjs"
BASELINE_TOTAL = 12  # = linha de tests/p18-latency.test.mjs em tests/node-suite.manifest

def P(test, label):
    return {"test_pattern": test, "assertion_pattern": label}
def S(test, label, why):
    return {"test_pattern": test, "assertion_pattern": label, "justification": why}

BUD, SM1, SM2, FLAP, REC, MISS, CRIT, DEDUP, R27, DER = ("[BUD]", "[SM] uma janela", "[SM] consecutivas", "[FLAP]", "[REC]", "[MISS]", "[CRIT]",
                                                       "[DEDUP]", "[27/10]", "[DERIVE]")
E1, E2 = "[E2E-PERF] monitor:", "[E2E-PERF] falha"
# id -> (arquivo, trecho original (1 ocorrência), substituto, spec)
M = {
    "L01_single_window_degrades": (LAT, "export const DEGRADE_WINDOWS = 2;", "export const DEGRADE_WINDOWS = 1;",
        {"primary": [P(SM1, "SM-single")], "secondary": [
            S(SM2, "SM-gap", "com 1 janela bastando, a 1ª janela lenta já degrada antes da lacuna"),
            S(FLAP, "FLAP-never", "cada janela lenta da oscilação já degrada"),
            S(REC, "REC-two", "a sequência começa DEGRADADO já na 1ª janela"),
            S(MISS, "MISS-break-slow", "a 1ª janela lenta degrada antes da janela sem latência"),
            S(CRIT, "CRIT-break", "a 1ª janela lenta degrada e a 3ª continua DEGRADADO"),
            S(R27, "27/10-proposed", "negocio-completo degrada já em 17:05 (9,1 s), não em 17:10"),
            S(E1, "E2E-single", "a 1ª execução lenta já entra em DEGRADADO"),
            S(E2, "E2E-fail-recorded", "a 1ª execução já avisa com sucesso; na 2ª (criação falhando) não há aviso pendente")],
         "broad_reason": "o limiar de 2 janelas é a regra central: todo teste que tem janela lenta lê o mesmo contador"}),
    "L02_single_fast_recovers": (LAT, "export const RECOVER_WINDOWS = 2;", "export const RECOVER_WINDOWS = 1;",
        {"primary": [P(REC, "REC-two"), P(E1, "E2E-one-fast-not-enough")], "secondary": [
            S(FLAP, "FLAP-stays-degraded", "a 1ª janela rápida da oscilação já recupera"),
            S(MISS, "MISS-break-fast", "a janela rápida antes da lacuna de dado já recupera"),
            S(R27, "27/10-proposed", "a recuperação sai em 17:15 em vez de 17:20")],
         "broad_reason": "o limiar de recuperação é lido por toda sequência que sai de DEGRADADO"}),
    "L03_gap_kept_consecutive": (LAT, "const consecutive = st.last_window !== null && w - st.last_window === WINDOW_MS;",
        "const consecutive = st.last_window !== null;", {"primary": [P(SM2, "SM-gap"), P(REC, "REC-gap")]}),
    "L04_missing_latency_keeps_streak": (LAT, 'if (c.verdict === "unknown") { r.slow = 0; r.fast = 0; }', 'if (c.verdict === "unknown") { }',
        {"primary": [P(MISS, "MISS-break-slow")], "secondary": [
            S(CRIT, "CRIT-break", "a rota fora do ar é 'unknown'; sem zerar, as duas janelas lentas em volta somam e degradam")]}),
    "L05_budget_edge_inclusive": (LAT, 'return { verdict: latency > budget ? "slow" : "fast"', 'return { verdict: latency >= budget ? "slow" : "fast"',
        {"primary": [P(SM1, "SM-edge-equal")]}),
    "L06_down_route_is_latency_sample": (LAT, "if (!t.ok || latency === null) return", "if (latency === null) return",
        {"primary": [P(CRIT, "CRIT-timeout-is-availability")]}),
    "L07_no_dedup_on_enter": (LAT, 'return notified(events, perf.incident.incident_id, "degraded") ?', 'return false ?',
        {"primary": [P(DEDUP, "DEDUP-once"), P(E1, "E2E-dedup")], "secondary": [
            S(E2, "E2E-retry-ledger", "a 4ª execução avisa de novo e o registro ganha uma 3ª linha")]}),
    "L08_critical_not_suppressing": (LAT, 'if (!view || view.state === "CRITICO") return { action: "none", reason: view ? "critical_owns_alert" : "no_window" };',
        'if (!view) return { action: "none", reason: "no_window" };', {"primary": [P(DEDUP, "DEDUP-critical-suppresses")]}),
    "L09_retry_masks_latency": (LAT, "  if (isMs(t?.elapsed_ms)) return t.elapsed_ms;\n", "",
        {"primary": [P(MISS, "MISS-retry")]}),
    "L10_budget_equal_timeout_allowed": (LAT, "if (b >= timeoutMs) throw", "if (b > timeoutMs) throw",
        {"primary": [P(BUD, "BUD-igual-ao-timeout")]}),
    "L11_perf_failure_escalated": (MON, '    if (perfAlert.error) log("::warning',
        '    if (perfAlert.error) throw new Error("P18_PERF_ALERT_FAILED " + perfAlert.error);\n    if (perfAlert.error) log("::warning',
        {"primary": [P(E2, "E2E-not-escalated")]}),
    "L12_same_channel_as_down": (LAT, 'export const PERF_TITLE = "[P18-DESEMPENHO] Latência acima do orçamento — aviso (não é queda)";',
        'export const PERF_TITLE = "[P18] Vendas fora do ar — monitor externo";', {"primary": [P(E1, "E2E-channel-distinct")]}),
    "L13_confirm_counts_as_window": (LAT, '  if (probe.kind === "confirm") return st;\n', "",
        {"primary": [P(SM2, "SM-confirm-not-window")]}),
    "L14_probe_id_missing": (MON, "event: run.event, probe_id: probeIdOf(env, 0), runner });", "event: run.event, runner });",
        {"primary": [P(E1, "E2E-probe-id")]}),
    "L15_critical_precedence_lost": (LAT, 'const state = !probe.up ? "CRITICO" :', 'const state = false ? "CRITICO" :',
        {"primary": [P(CRIT, "CRIT-break")], "secondary": [
            S(DEDUP, "DEDUP-critical-suppresses", "sem o estado CRITICO na janela com queda, a supressão do aviso não se aplica")]}),
    "L16_timeout_not_explicit": (MON, "timeoutMs: REQUEST_TIMEOUT_MS })", "timeoutMs: 4000 })",
        {"primary": [P(BUD, "BUD-monitor")]}),
    "L17_recovery_never_notified": (LAT, 'if (last && notified(events, last.incident_id, "degraded") && !notified(events, last.incident_id, "recovered")) return',
        "if (false) return", {"primary": [P(DEDUP, "DEDUP-recover"), P(E1, "E2E-recover-action")]}),
    "L18_recovery_notified_twice": (LAT, ' && !notified(events, last.incident_id, "recovered")) return', ") return",
        {"primary": [P(DEDUP, "DEDUP-recover-once"), P(E1, "E2E-healthy-action")]}),
    "L19_flat_budget": (LAT, "export const budgetFor = (id, budgets = ROUTE_BUDGETS_MS) => (Object.hasOwn(budgets, id) ? budgets[id] : DEFAULT_BUDGET_MS);",
        "export const budgetFor = (id, budgets = ROUTE_BUDGETS_MS) => DEFAULT_BUDGET_MS;",
        {"primary": [P(BUD, "BUD-per-route")], "secondary": [
            S(SM1, "SM-two", "4,1 s fica abaixo de 5 s fixo e a 2ª janela deixa de ser lenta"),
            S(MISS, "MISS-retry-slow", "3,4 s fica abaixo de 5 s fixo na home"),
            S(R27, "27/10-proposed", "com 5 s fixo o replay de 27/10 não degrada (é o próprio achado do teste)"),
            S(E1, "E2E-two", "o orçamento de 150 ms injetado é ignorado e nada degrada"),
            S(E2, "E2E-fail-recorded", "nada degrada, então não há aviso nem falha de aviso")],
         "broad_reason": "o orçamento por rota é lido por toda classificação de janela"}),
    "L20_elapsed_not_recorded": (COL, "body, attempts: i + 1, elapsed_ms: Date.now() - start };", "body };",
        {"primary": [P(E1, "E2E-attempts")]}),
    "L21_budget_from_p50": (LAT, "Math.ceil((factor * p95) / step)", "Math.ceil((factor * p50) / step)",
        {"primary": [P(DER, "DERIVE-factor")]}),
    "L22_derive_counts_confirm": (LAT, '    if (p.kind === "confirm") continue;\n', "",
        {"primary": [P(DER, "DERIVE-sample")]}),
    "L23_monitor_ignores_ledger": (MON, 'const perfEvents = readRecent(dir, "perf", startedIso, validatePerfEvent);', "const perfEvents = [];",
        {"primary": [P(E1, "E2E-dedup")], "secondary": [
            S(E2, "E2E-retry-ledger", "sem ler o registro, a 4ª execução avisa de novo e grava uma 3ª linha")]}),
}


def stage(d):
    for rel in COPY:
        src, dst = REPO / rel, d / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        (shutil.copytree if src.is_dir() else shutil.copy2)(src, dst)


def run_suite(d):
    return mc.run_command(["node", "--test", "--test-reporter=tap", "--test-reporter-destination=stdout", TEST], cwd=str(d), timeout=300)


def main():
    config = mc.load_mutant_config({mid: spec for mid, (_, _, _, spec) in M.items()})
    with tempfile.TemporaryDirectory(prefix="zev-p18lat-mut-") as tmp:
        base = Path(tmp) / "base"
        stage(base)
        r = run_suite(base)
        parsed = mc.parse_tap(r["stdout"], stderr=r["stderr"])
        b = mc.validate_baseline(BASELINE_TOTAL, r["return_code"], parsed["summary"], parsed["failures"], r["timed_out"], r["signal"])
        print(json.dumps({"mutant_id": "BASELINE", **{k: b[k] for k in ("verdict", "reason", "ok")}}))
        if not b["ok"]:
            sys.exit(mc.EXIT_BAD_BASELINE)
        results = []
        for i, (mid, (rel, old, new, _)) in enumerate(M.items()):
            d = Path(tmp) / f"m{i}"
            stage(d)
            f = d / rel
            text = f.read_bytes().decode("utf-8").replace("\r\n", "\n")
            ok = text.count(old) == 1
            if ok:
                with open(f, "w", encoding="utf-8", newline="\n") as h:
                    h.write(text.replace(old, new))
            run = run_suite(d) if ok else {"return_code": None, "stdout": "", "stderr": "", "timed_out": False, "signal": None}
            res = mc.classify_run(BASELINE_TOTAL, run, expected=config[mid], allowlist=config[mid]["allowlist"], anchor_ok=ok, mutant_id=mid)
            results.append(res)
            print(json.dumps({"mutant_id": mid, "verdict": res["verdict"], "reason": res.get("reason", "")}, ensure_ascii=False))
            shutil.rmtree(d, ignore_errors=True)
        code, summary = mc.aggregate(results, baseline_valid=True)
        print(json.dumps(summary, ensure_ascii=False))
        sys.exit(code)


if __name__ == "__main__":
    main()
