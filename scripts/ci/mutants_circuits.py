#!/usr/bin/env python3
"""Mutantes B04 (PR #865): circuitos A/B (chave de vendas, portão de checkout, roteador de continuidade, disjuntor
de voz). Cada mutante altera um arquivo do worker NO LUGAR, roda tests/circuits-adversarial.test.mjs e restaura o
original (verificado a cada mutante e no fim). Imprime `MUTANT <id> KILLED|SURVIVED` e sai != 0 se algum
sobreviver ou se a linha de base não passar com a contagem exata.
Uso: python3 scripts/ci/mutants_circuits.py
"""
import pathlib, re, subprocess, sys

root = pathlib.Path(__file__).resolve().parents[2]
EXPECTED_TESTS = 31
M = [
 ("M01 checkout: remove autorizacao (allow all)", "worker/commercial-checkout-guard.mjs", "return REQUIRED.every(k=>flags?.[k]===true);", "return true;"),
 ("M02 checkout: bloqueia tudo (deny all)", "worker/commercial-checkout-guard.mjs", "return REQUIRED.every(k=>flags?.[k]===true);", "return false;"),
 ("M03 chave de vendas: abre sem preflight (allow all)", "worker/sales-control.mjs", "value = pre?.ok === true && fresh", "value = true"),
 ("M04 chave de vendas: off-by-one no TTL 3h (< vira <=)", "worker/sales-control.mjs", "now - preAt < 3 * 3600 * 1000", "now - preAt <= 3 * 3600 * 1000"),
 ("M05 checkout: off-by-one no TTL 3h (< vira <=)", "worker/commercial-checkout-guard.mjs", "now-timestamp<3*3600000", "now-timestamp<=3*3600000"),
 ("M06 chave de vendas: ignora staleness futura", "worker/sales-control.mjs", "preAt <= now && ", ""),
 ("M07 checkout: ignora staleness futura", "worker/commercial-checkout-guard.mjs", "timestamp<=now&&", ""),
 ("M08 continuidade: estado corrompido como saudavel (coercao)", "worker/continuity-router.mjs", 'typeof v==="string"?v.toLowerCase():""', 'String(v||"").toLowerCase()'),
 ("M09 continuidade: comercial por lista de negacao (ausente = liberado)", "worker/continuity-router.mjs", "ACTIVE_SCOPE.has(release) && ACTIVE_SCOPE.has(execution)", '!["blocked","globally-blocked","disabled"].includes(release) && !["blocked","globally-blocked","disabled"].includes(execution)'),
 ("M10 continuidade: troca primaria/secundaria", "worker/continuity-router.mjs", "primary_channel:eligible[0]?.name||null,\n    fallback_channels:Object.freeze(eligible.slice(1).map((x)=>x.name)),", "primary_channel:(eligible[1]||eligible[0])?.name||null,\n    fallback_channels:Object.freeze([eligible[0],...eligible.slice(2)].filter((x,i)=>x&&!(i===0&&eligible.length<2)).map((x)=>x.name)),"),
 ("M11 voz: troca primaria/secundaria (cadeia invertida)", "worker/voice-provider-router.mjs", "const unique = [...new Set(values)];", "const unique = [...new Set(values)].reverse();"),
 ("M12 continuidade: prioridade duplicada infla quorum", "worker/continuity-router.mjs", "&&!eligible.includes(state)", ""),
 ("M13 continuidade: bloqueia tudo (quorum nunca ok)", "worker/continuity-router.mjs", "const quorumOk=eligible.length>=minQuorum;", "const quorumOk=false;"),
 ("M14 voz: off-by-one no cooldown (>= vira >)", "worker/voice-provider-router.mjs", "if (state.openUntil && Date.now() >= state.openUntil) {", "if (state.openUntil && Date.now() > state.openUntil) {"),
 ("M15 voz: disjuntor nunca abre", "worker/voice-provider-router.mjs", "const FAILURE_THRESHOLD = 2;", "const FAILURE_THRESHOLD = 99;"),
 ("M16 voz: failover desligado ignorado", "worker/voice-provider-router.mjs", 'if (String(env.VOICE_TTS_FAILOVER_ENABLED || "true").toLowerCase() !== "true") break;', ";"),
 ("M17 chave de vendas: cache aceita relogio para tras", "worker/sales-control.mjs", "now >= cached.at && ", ""),
 ("M18 token: cache aceita relogio para tras", "worker/commercial-checkout-guard.mjs", "now>=tokenCache.at&&", ""),
 ("M19 checkout: token nunca verificado (allow token)", "worker/commercial-checkout-guard.mjs", "flags.token=await verify(env);", "flags.token=true;"),
 ("M20 chave de vendas: cache de 10 s off-by-one (< vira <=)", "worker/sales-control.mjs", "now - cached.at < CACHE_MS", "now - cached.at <= CACHE_MS"),
]


def run():
    r = subprocess.run(["node", "--test", "tests/circuits-adversarial.test.mjs"], cwd=root, capture_output=True,
                       text=True, stdin=subprocess.DEVNULL, timeout=300)
    g = lambda k: int(m.group(1)) if (m := re.search(rf"^# {k} (\d+)$", r.stdout, re.M)) else -1
    return r, {k: g(k) for k in ("tests", "pass", "fail", "skipped", "todo")}


base, c = run()
ok = base.returncode == 0 and c["tests"] == EXPECTED_TESTS == c["pass"] and c["fail"] == c["skipped"] == c["todo"] == 0
print(f"MUTANT BASELINE tests={c['tests']} pass={c['pass']} fail={c['fail']} skipped={c['skipped']} todo={c['todo']} {'PASS' if ok else 'FAIL'}")
if not ok:
    sys.exit(2)

survivors = 0
originals = {f: (root / f).read_text() for _, f, _, _ in M}
try:
    for name, f, a, b in M:
        mid = name.split()[0]
        p = root / f
        orig = originals[f]
        assert orig.count(a) == 1, (name, orig.count(a))
        p.write_text(orig.replace(a, b))
        try:
            r, c = run()
        finally:
            p.write_text(orig)
            assert p.read_text() == orig, f"restauração falhou: {f}"
        fails = [l.split(" - ", 1)[1] for l in r.stdout.splitlines() if l.startswith("not ok ")]
        killed = r.returncode != 0
        survivors += 0 if killed else 1
        print(f"MUTANT {mid} {'KILLED' if killed else 'SURVIVED'} falhas={len(fails)} — {name[len(mid) + 1:]}", flush=True)
finally:
    for f, orig in originals.items():
        (root / f).write_text(orig)
print(f"MUTANTS_TOTAL={len(M)} KILLED={len(M) - survivors} SURVIVED={survivors}")
sys.exit(1 if survivors else 0)
