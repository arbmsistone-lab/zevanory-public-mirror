#!/usr/bin/env python3
"""Mutantes do P18 (auditoria Sol 246.09/246.14): latência por incidente, confirmação na mesma execução, vigia do
batimento e NOT_PROVEN em lacunas. Cada mutante altera UMA CÓPIA temporária de scripts/b0, roda
tests/b0-baseline.test.mjs (TAP) contra a cópia e classifica com o classificador compartilhado
(scripts/ci/mutant_classifier.py, regra R5 do Roteiro v4.7): KILLED só quando falha uma asserção PRIMÁRIA declarada,
com o rótulo dentro do bloco `not ok`; secundárias têm justificativa causal; todo o resto é INCONCLUSIVE.

As expectativas abaixo foram escritas pelo raciocínio sobre cada mutação (qual regra ela quebra e qual asserção é a
PRIMEIRA a falhar em cada teste, já que o node:test para no primeiro assert que falha), antes de rodar.
Uso: python3 scripts/ci/mutants_p18.py [raiz-do-repo]. Exit 0 = todos KILLED; 1 = sobrevivente; 2 = baseline; 3 = inconclusivo.
"""
import json, shutil, sys, tempfile
from pathlib import Path

sys.dont_write_bytecode = True  # nunca deixar __pycache__ no checkout
REPO = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[2]).resolve()
sys.path.insert(0, str(REPO / "scripts" / "ci"))
import mutant_classifier as mc  # noqa: E402

TEST = "tests/b0-baseline.test.mjs"
COPY = ["scripts/b0", "docs/b0", "tests/helpers/text.mjs", TEST, "scripts/p20", "docs/p20", "tests/helpers/p20-backup-fixture.mjs", "scripts/audit/workers-usage.mjs", ".github/workflows/b0-baseline-collector.yml",
        ".github/workflows/p18-external-monitor.yml", ".github/workflows/b0-baseline-tests.yml", ".github/workflows/p18-monitor-watchdog.yml"]
LIB, MON, WDG = "scripts/b0/b0-lib.mjs", "scripts/b0/p18-monitor.mjs", "scripts/b0/p18-watchdog.mjs"
WFM = ".github/workflows/p18-external-monitor.yml"
WF = "workflows B0/P18"
BASELINE_TOTAL = 36  # = linha de tests/b0-baseline.test.mjs em tests/node-suite.manifest

def P(test, label):
    return {"test_pattern": test, "assertion_pattern": label}
def S(test, label, why):
    return {"test_pattern": test, "assertion_pattern": label, "justification": why}

E2E1, E2E2 = "[E2E] monitor: confirma", "[E2E] monitor: falha"
# id -> (arquivo, trecho original (1 ocorrência), substituto, spec)
M = {
    "M01_latency_from_confirmation": (LIB, "const latency = emitted ? secsBetween(inc.first_failure_observed_at, emitted) : null;",
        "const latency = emitted ? secsBetween(inc.confirmed_at, emitted) : null;",
        {"primary": [P("[LAT]", "LAT-latency")], "secondary": [
            S(E2E1, "E2E-latency", "a latência do incidente da execução 1 passa a contar da confirmação (0 s em vez de 60 s)"),
            S(E2E2, "E2E-retry", "a latência da reemissão passa a contar da confirmação (240 s em vez de 300 s)"),
            S("[GAP]", "GAP-maxlat", "o máximo diário de latência herda o valor errado do incidente (820 s em vez de 890 s)"),
            S("[COL]", "COL-maxlat", "o campo diário do coletor herda a latência errada (10 s em vez de 80 s)")],
         "broad_reason": "latency_seconds alimenta o incidente, a reemissão, o agregado diário e o coletor: cinco testes leem o mesmo valor"}),
    "M02_upper_bound_from_first_failure": (LIB, "const upper = emitted && lastOk ? secsBetween(lastOk, emitted) : null;",
        "const upper = emitted && lastOk ? secsBetween(inc.first_failure_observed_at, emitted) : null;",
        {"primary": [P("[LAT]", "LAT-upper")], "secondary": [
            S(E2E2, "E2E-retry-upper", "o limite superior da reemissão passa a ignorar a última sondagem boa (300 s em vez de 600 s)"),
            S("[GAP]", "GAP-maxupper", "o máximo diário do limite superior herda o valor errado (80 s em vez de 270 s)")]}),
    "M03_latency_edge_600": (LIB, 'if (latency === null || latency > S9_ALERT_LIMIT_S) s9 = "NOT_MET";',
        'if (latency === null || latency >= S9_ALERT_LIMIT_S) s9 = "NOT_MET";', {"primary": [P("[LAT]", "LAT-edge-600")]}),
    "M04_upper_edge_600": (LIB, 'else if (upper === null || upper > S9_ALERT_LIMIT_S) s9 = "NOT_PROVEN";',
        'else if (upper === null || upper >= S9_ALERT_LIMIT_S) s9 = "NOT_PROVEN";',
        {"primary": [P("[LAT]", "LAT-upper-edge-600")], "secondary": [
            S(E2E2, "E2E-retry-s9", "a reemissão tem limite superior de exatamente 600 s e deixa de ser MET")]}),
    "M05_missing_alert_not_failure": (LIB, 'if (latency === null || latency > S9_ALERT_LIMIT_S) s9 = "NOT_MET";',
        'if (latency !== null && latency > S9_ALERT_LIMIT_S) s9 = "NOT_MET";',
        {"primary": [P("[LAT]", "LAT-no-alert")], "secondary": [
            S(E2E2, "E2E-nometric", "o incidente gravado sem alerta deixa de ser NOT_MET"),
            S("[GAP]", "GAP-alert-missing", "o dia com alerta faltando deixa de ser NOT_MET")]}),
    "M06_no_in_run_confirmation": (MON, 'if (d.action === "pending") {', "if (false) {",
        {"primary": [P(E2E1, "E2E-inrun")], "secondary": [
            S(E2E2, "E2E-incfile", "sem re-sondagem a 1ª falha fica pendente e nenhum incidente é gravado na execução que falha ao alertar")]}),
    "M07_confirm_spacing_strict": (LIB, "if (streak.length >= 2 && secsBetween(first.at, cur.at) >= MIN_CONFIRM_SPACING_S) {",
        "if (streak.length >= 2 && secsBetween(first.at, cur.at) > MIN_CONFIRM_SPACING_S) {",
        {"primary": [P("[CONF]", "CONF-spacing-60s")], "secondary": [
            S(E2E1, "E2E-inrun", "a re-sondagem ponta a ponta fica a exatamente 60 s da 1ª e deixa de confirmar"),
            S(E2E2, "E2E-incfile", "a confirmação a exatamente 60 s não acontece, então nenhum incidente é gravado")]}),
    "M08_single_failure_confirms": (LIB, "if (streak.length >= 2 && secsBetween(first.at, cur.at) >= MIN_CONFIRM_SPACING_S) {",
        "if (streak.length >= 1) {",
        {"primary": [P("[CONF]", "CONF-pending")], "secondary": [
            S(E2E1, "E2E-reprobe", "a 1ª falha já confirma, então a execução não re-sonda (1 sondagem em vez de 2)")]}),
    "M11_gap_edge_600": (LIB, "if (maxGap > S9_ALERT_LIMIT_S) reasons.push(", "if (maxGap >= S9_ALERT_LIMIT_S) reasons.push(",
        {"primary": [P("[GAP]", "GAP-10min-reason")]}),
    "M12_no_confirmation_budget": (LIB, "else if (capability > S9_ALERT_LIMIT_S) reasons.push(", "else if (false) reasons.push(",
        {"primary": [P("[GAP]", "GAP-10min")]}),
    "M13_gap_presumed_by_cron": (LIB, "const maxGap = checkGaps(probes, day).max_gap_s;", "const maxGap = 0;",
        {"primary": [P("[GAP]", "GAP-gapvalue")], "secondary": [
            S("[COL]", "COL-gap", "o campo diário do coletor passa a gravar lacuna 0 em vez de 300 s")]}),
    "M14_midnight_neighbor_ignored": (LIB, "const before = all.filter((p) => msOf(p.at) < from).at(-1);", "const before = undefined;",
        {"primary": [P("[GAP]", "GAP-midnight-gap")]}),
    "M15_p95_is_max": (LIB, "return v[Math.min(v.length - 1, Math.max(0, Math.ceil(q * v.length) - 1))];", "return v[v.length - 1];",
        {"primary": [P("[GAP]", "GAP-p95")]}),
    "M16_slot_offset_ignored": (LIB, "const period = PROBE_CADENCE_MIN * 60000, off = CRON_OFFSET_MIN * 60000;",
        "const period = PROBE_CADENCE_MIN * 60000, off = 0;", {"primary": [P(E2E1, "E2E-delay")]}),
    "M17_watchdog_edge_900": (LIB, "if (age > staleMin * 60) return { state: \"STALE\", alert: true, age_s: age, last_success_at", "if (age >= staleMin * 60) return { state: \"STALE\", alert: true, age_s: age, last_success_at",
        {"primary": [P("[WD]", "WD-900")]}),
    "M18_watchdog_30min": (LIB, "export const HEARTBEAT_STALE_MIN = 15;", "export const HEARTBEAT_STALE_MIN = 30;",
        {"primary": [P("[WD]", "WD-901")]}),
    "M19_missing_heartbeat_silent": (LIB, 'if (hb === null || hb === undefined) return { state: "MISSING", alert: true,',
        'if (hb === null || hb === undefined) return { state: "MISSING", alert: false,', {"primary": [P("[WD]", "WD-missing-alert")]}),
    "M20_watchdog_same_channel": (LIB, 'export const WATCHDOG_TITLE = "[P18-VIGIA] Monitor externo parado — sem batimento";',
        "export const WATCHDOG_TITLE = ALERT_TITLE;", {"primary": [P("[WD]", "WD-distinct")]}),
    "M21_heartbeat_despite_alert_failure": (MON, 'if (alert.error) throw new Error("P18_ALERT_FAILED " + alert.error);',
        'if (alert.error) { writeFileSync(join(dir, "p18", "heartbeat.json"), "{}\\n"); throw new Error("P18_ALERT_FAILED " + alert.error); }',
        {"primary": [P(E2E2, "E2E-nohb")]}),
    "M23_unknown_last_ok_met": (LIB, 'else if (upper === null || upper > S9_ALERT_LIMIT_S) s9 = "NOT_PROVEN";',
        'else if (upper !== null && upper > S9_ALERT_LIMIT_S) s9 = "NOT_PROVEN";',
        {"primary": [P("[LAT]", "LAT-unknown-lastok")], "secondary": [
            S(E2E1, "E2E-s9-unknown", "o incidente sem sondagem boa anterior passa a MET")]}),
    "M24_recovery_keeps_issue_open": (MON, "} else if (cur.up && open) {", "} else if (false) {",
        {"primary": [P(E2E1, "E2E-close")]}),
    # ---- gatilho externo (AVAL Sol 253/254): janela, idempotência, metadados do pedido, vigia do caminho Cloudflare ----
    "M25_no_idempotency": (MON, "if (isDuplicateWindow(runs, dispatch)) {", "if (false) {",
        {"primary": [P("[IDEM]", "IDEM-sched-skip")], "secondary": [
            S("[IDEM-HB]", "IDEMHB-skip-sched", "sem idempotência a duplicada do agendador sonda em vez de pular")]}),
    "M26_requested_window_ignored": (LIB, "return (dispatch.window_id !== null && c.has(dispatch.window_id)) || c.has(dispatch.start_window_id);",
        "return c.has(dispatch.start_window_id);", {"primary": [P("[IDEM]", "IDEM-repeat-skip")], "secondary": [
            S("[IDEM-HB]", "IDEMHB-skip-late-repeat", "o pedido repetido que inicia na janela seguinte deixa de ser reconhecido pelo id pedido")]}),
    "M27_future_bound_open": (LIB, 'if (w > startedMs + DISPATCH_MAX_FUTURE_S * 1000) return { ...out, window_rejected: "window_in_future" };', "",
        {"primary": [P("[WIN]", "WIN-future-121")], "secondary": [
            S("[IDEM]", "IDEM-forged-rejected", "o id forjado para 10:20 passa a ser aceito às 10:11 e a execução deixa de registrar window_in_future")]}),
    "M28_dispatch_after_start": (LIB, " || t > startedMs + DISPATCH_MAX_FUTURE_S * 1000) return", ") return",
        {"primary": [P("[WIN]", "WIN-dispatch-after-start")]}),
    "M29_gap_from_duplicate": (MON, "const prevProbing = runs.filter((r) => PROBING_OUTCOMES.includes(r.outcome)).at(-1) || null;",
        "const prevProbing = runs.at(-1) || null;", {"primary": [P("[IDEM]", "IDEM-gap-from-probing-run")]}),
    "M30_cf_watch_without_owner_switch": (WDG, 'const gate = !expected ? "NOT_EXPECTED" : !activated ? "AWAITING_FIRST_PROOF" : "ACTIVE";',
        'const gate = !activated ? "AWAITING_FIRST_PROOF" : "ACTIVE";', {"primary": [P("[WD-CF]", "WDCF-gate-off")]}),
    "M31_cf_stale_edge_900": (LIB, 'if (age > staleMin * 60) return { ...ok, state: "STALE" };',
        'if (age >= staleMin * 60) return { ...ok, state: "STALE" };', {"primary": [P("[WD-CF]", "WDCF-900")]}),
    "M32_window_not_aligned": (LIB, "if (Number.isNaN(ms) || windowIdOf(ms) !== id || windowStartMs(ms) !== ms) return null;",
        "if (Number.isNaN(ms)) return null;", {"primary": [P("[WIN]", "WIN-strict")], "secondary": [
            S("[WIN-INVALID]", "WININV-reason", "o id desalinhado (T1503Z) passa a ser aceito e a execução não registra bad_window_id")]}),
    "M33_source_not_allowlisted": (LIB, "const src = DISPATCH_SOURCES.includes(source) ? source : null;", "const src = source || null;",
        {"primary": [P("[WIN]", "WIN-source-allowlist")]}),
    "M34_dup_start_not_recorded": (MON, "    writeCfDispatch(dir, dup);\n", "",
        {"primary": [P("[IDEM]", "IDEM-cf-dup-recorded")]}),
    "M35_window_input_not_passed": (WFM, "          P18_WINDOW_ID: ${{ inputs.window_id }}\n", "",
        {"primary": [P(WF, "WF-env window_id")]}),
    "M36_unbounded_queue": (WFM, "  cancel-in-progress: false\n", "  cancel-in-progress: false\n  queue: max\n",
        {"primary": [P(WF, "WF-single-pending")]}),
    # ---- Ordem Sol 259-262 ----
    "M37_duplicate_touches_heartbeat": (MON, "    writeCfDispatch(dir, dup);\n", "    writeCfDispatch(dir, dup);\n    writeFileSync(join(dir, \"p18\", \"heartbeat.json\"), \"{}\\n\");\n",
        {"primary": [P("[IDEM-HB]", "IDEMHB-unchanged-sched")], "secondary": [
            S("[IDEM]", "IDEM-no-heartbeat", "a duplicada do agendador no teste [IDEM] também reescreve o batimento")]}),
    "M38_invalid_window_skips_probe": (MON, "if (isDuplicateWindow(runs, dispatch)) {", "if (isDuplicateWindow(runs, dispatch) || dispatch.window_rejected) {",
        {"primary": [P("[WIN-INVALID]", "WININV-probes")], "secondary": [
            S("[IDEM]", "IDEM-forged-still-probes", "o id forjado para o futuro é rejeitado e, com o mutante, a execução deixa de sondar")]}),
    "M39_cf_gate_without_first_proof": (WDG, "const activated = cfEv0.valid_proof === true || priorProof !== null;", "const activated = true;",
        {"primary": [P("[WD-CF]", "WDCF-awaiting-first-proof")], "secondary": [
            S("[WD-CF-GATE]", "WDG-awaiting-malformed", "sem exigência de prova, o documento malformado já ativa o vigia")]}),
    "M40_incoherent_dispatch_keeps_window": (LIB, 'return { ...out, window_id: null, window_rejected: "bad_dispatched_at" };', 'return { ...out, window_rejected: "bad_dispatched_at" };',
        {"primary": [P("[WIN-INVALID]", "WININV-null")]}),
    # ---- Ordem Sol 263: transições do vigia do caminho Cloudflare ----
    "M41_revert_to_not_missing": (WDG, "const activated = cfEv0.valid_proof === true || priorProof !== null;", 'const activated = cfEv0.state !== "MISSING";',
        {"primary": [P("[WD-CF-GATE]", "WDG-awaiting-malformed")]}),
    "M42_revert_to_not_missing_with_prior": (WDG, "const activated = cfEv0.valid_proof === true || priorProof !== null;", 'const activated = cfEv0.state !== "MISSING" || priorProof !== null;',
        {"primary": [P("[WD-CF-GATE]", "WDG-awaiting-malformed")]}),
    "M43_prior_proof_ignored": (WDG, "const priorProof = firstProofAt(read.hb, now());", "const priorProof = null;",
        {"primary": [P("[WD-CF-GATE]", "WDG-active-after-prior-proof")]}),
    "M44_order_not_checked": (LIB, 'if (dt > st) return { ...base, state: "INVALID_PROOF", reason: "dispatched_after_start" };', "",
        {"primary": [P("[CF-PROOF]", "CFP-order")], "secondary": [
            S("[WD-CF-GATE]", "WDG-awaiting-invalid-timestamps", "pedido depois do início passa a ser prova válida e ativa o vigia")]}),
    "M45_future_is_proof": (LIB, 'if (age < -120) return { ...base, state: "FUTURE", age_s: age, started_at: doc.started_at };', "",
        {"primary": [P("[CF-PROOF]", "CFP-future")], "secondary": [
            S("[WD-CF-GATE]", "WDG-awaiting-future", "início no futuro passa a ser prova válida e ativa o vigia")]}),
    "M46_broken_doc_becomes_first_proof": (MON, "return ev?.valid_proof ? ev.started_at : null;", "return ev ? (ev.started_at ?? new Date(nowMs).toISOString()) : null;",
        {"primary": [P("[CF-FIRST-PROOF]", "CFFP-broken-doc-not-proof")]}),
    "M47_first_proof_not_carried": (MON, "  if (prev) return prev;\n", "",
        {"primary": [P("[CF-FIRST-PROOF]", "CFFP-carried-forward")]}),
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
    with tempfile.TemporaryDirectory(prefix="zev-p18-mut-") as tmp:
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
