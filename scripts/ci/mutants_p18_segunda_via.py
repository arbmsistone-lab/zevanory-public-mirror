#!/usr/bin/env python3
"""Mutantes causais da segunda via P18 (ops/p18-segunda-via/supabase/*.sql), contra tests/test_p18_segunda_via.py
num PostgreSQL descartável (variáveis PG*; sem PGHOST = exit 2, nunca "verde" por omissão).

Cada mutante altera UMA regra do SQL numa cópia mínima da árvore em diretório temporário (o repositório nunca é
alterado) e roda os testes declarados em mutants_p18_segunda_via_allow.json. KILLED só quando a execução falha E a
saída contém o marcador [P18SV.n] declarado (asserção que codifica a regra); falha sem o marcador = INCONCLUSIVE.
Expectativas escritas por raciocínio sobre cada mutação antes de rodar. Baseline (sem mutação) precisa passar.
Exit: 0 todos KILLED; 1 SURVIVED; 2 baseline/config/ambiente; 3 INCONCLUSIVE.
Uso: python3 scripts/ci/mutants_p18_segunda_via.py [raiz-do-repo]"""
import json, os, shutil, subprocess, sys, tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.dont_write_bytecode = True
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
REPO = Path(ARGS[0] if ARGS else Path(__file__).resolve().parents[2])
SQL = "ops/p18-segunda-via/supabase/001_p18_segunda_via.sql"
AG = "ops/p18-segunda-via/supabase/002_agendar.sql"
COPY = ["ops/p18-segunda-via/supabase", "tests/fixtures/p18-segunda-via", "tests/test_p18_segunda_via.py"]
ALLOW = Path(__file__).with_name("mutants_p18_segunda_via_allow.json")

M = {
    "S01 confirma na 1ª falha": (SQL, "if i.confirmed_at is null and s.consecutive_fail >= c.confirm_failures then", "if i.confirmed_at is null and s.consecutive_fail >= 1 then"),
    "S02 recuperação sem e-mail": (SQL, "        perform p18sv.send_alert(i.id, 'recovery',", "        perform 1; perform format(i.id::text, 'recovery',"),
    "S03 sem resposta nunca vira falha": (SQL, "  update p18sv.probe set collected_at = p_now, ok = false, reason = 'no_response'\n   where collected_at is null and sent_at < p_now - make_interval(secs => c.timeout_ms / 1000.0 + c.response_grace_s);\n", ""),
    "S04 ensaio ignorado": (SQL, "    if r.drill then avail_ok := false;", "    if false then avail_ok := false;"),
    "S05 health 200 basta": (SQL, "    ok := coalesce(j->>'ready', 'true') = 'true';", "    ok := true;"),
    "S06 chave gravada no alerta": (SQL, "insert into p18sv.alert (incident_id, kind, subject, requested_at, request_id) values (p_incident, p_kind, p_subject, p_now, rid)",
                                    "insert into p18sv.alert (incident_id, kind, subject, requested_at, request_id, error) values (p_incident, p_kind, p_subject, p_now, rid, k)"),
    "S07 rodada a cada tick": (SQL, "make_interval(secs => c.probe_interval_s - 5)", "make_interval(secs => 0)"),
    "S08 mudança da trava silenciosa": (SQL, "        perform p18sv.send_alert(null, 'info',", "        perform format(null, 'info',"),
    "S09 primário velho aceito": (SQL, "    elsif age_s > p_stale_s then ok := false; reason := 'primary_stale';", "    elsif false then ok := false; reason := 'primary_stale';"),
    "S10 agendar sem canal": (AG, "  if cardinality((select alert_to from p18sv.config where id = 1)) = 0 then", "  if false then"),
    "S11 sem lembrete": (SQL, "    elsif i.confirmed_at is not null and p_now - coalesce(i.last_alert_at, i.confirmed_at) >= make_interval(secs => c.reminder_every_s) then",
                         "    elsif false then"),
    "S12 trava com caixa trocada aceita": (SQL, "    ok := (j->>'sales_mode') in ('globally-blocked', 'enabled');", "    ok := lower(j->>'sales_mode') in ('globally-blocked', 'enabled');"),
    "S13 destino do Resend livre": (SQL, "    alter table p18sv.config add constraint p18sv_resend_url_fixa check (resend_url = 'https://api.resend.com/emails');", "    null;"),
}


def build(tmp, mutation=None):
    for rel in COPY:
        src, dst = REPO / rel, Path(tmp) / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        (shutil.copytree if src.is_dir() else shutil.copyfile)(src, dst)
    if mutation:
        rel, old, new = mutation
        f = Path(tmp) / rel
        text = f.read_text(encoding="utf-8")
        if text.count(old) != 1:
            return False
        f.write_text(text.replace(old, new, 1), encoding="utf-8")
    return True


def run(tmp, tests):
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    names = [f"tests.test_p18_segunda_via.SegundaVia.{t}" for t in tests] if tests else ["tests.test_p18_segunda_via"]
    r = subprocess.run([sys.executable, "-m", "unittest", *names], cwd=tmp, capture_output=True, text=True, env=env, timeout=900)
    return r.returncode, r.stdout + r.stderr


def main():
    if not os.environ.get("PGHOST"):
        print("ENV_MISSING PGHOST"); return 2
    cfg = json.loads(ALLOW.read_text(encoding="utf-8"))["mutants"]
    if set(cfg) != set(M):
        print("CONFIG_INVALID", sorted(set(M) ^ set(cfg))); return 2
    for mid, spec in cfg.items():
        if not spec.get("tests") or not str(spec.get("marker", "")).startswith("[P18SV."):
            print("CONFIG_INVALID", mid); return 2
    with tempfile.TemporaryDirectory() as tmp:
        build(tmp)
        code, out = run(tmp, sorted({t for s in cfg.values() for t in s["tests"]}))
    if code != 0 or "skipped" in out:
        print("BASELINE FAILED"); print(out[-2000:]); return 2
    print("BASELINE PASS")

    def judge(item):
        mid, mutation = item
        with tempfile.TemporaryDirectory() as tmp:
            if not build(tmp, mutation):
                return mid, "INCONCLUSIVE", "anchor_not_unique"
            code, out = run(tmp, cfg[mid]["tests"])
        if code == 0:
            return mid, "SURVIVED", "tests_passed"
        if cfg[mid]["marker"] in out and "Traceback" not in out.split("FAIL:")[0][-200:]:
            return mid, "KILLED", cfg[mid]["marker"]
        return mid, "INCONCLUSIVE", "failed_without_marker: " + out[-300:].replace("\n", " ")

    with ThreadPoolExecutor(max_workers=min(4, os.cpu_count() or 2)) as ex:
        results = list(ex.map(judge, M.items()))
    for mid, v, why in results:
        print(f"MUTANT {mid} {v}" + ("" if v == "KILLED" else f" ({why})"))
    k = sum(v == "KILLED" for _, v, _ in results); s = sum(v == "SURVIVED" for _, v, _ in results); i = len(results) - k - s
    print(f"MUTANTS total={len(results)} killed={k} survived={s} inconclusive={i}")
    return 1 if s else 3 if i else 0


if __name__ == "__main__":
    sys.exit(main())
