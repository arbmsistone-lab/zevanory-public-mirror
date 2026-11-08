#!/usr/bin/env python3
"""ZEVANORY | P20: ponte do ensaio mensal para a rotina oficial de restauração completa.

Uso: python3 scripts/p20/restore_bridge.py <dir>   (dir contém tables.json {tabela: json} e manifest.json {tabela: {rows}})
Restaura TUDO com scripts/ops/restore_new_database.restore_full (migrações + DDL do Worker, carga em ordem de chave
estrangeira, contagem E hash de conteúdo por tabela) num PostgreSQL LOCAL e descartável. Recusa, antes de conectar,
qualquer alvo que não seja localhost com banco p20_drill* ou qualquer variável de banco real no ambiente.
Saída: UMA linha JSON só com metadados (nomes de tabela e contagens). Nunca imprime dado de linha.
Cópia KV -> Neon (opcional: kv_copy.json [linhas] + kv_manifest.json {day, rows}): depois da restauração completa, as
linhas vão para public.zevanory_kv_backup (DDL do próprio Worker) com contagem e hash de conteúdo conferidos, e são
RELIDAS do Postgres para kv_restored.json (0600, no mesmo diretório temporário que o chamador apaga): é dessa releitura
que o ensaio reconstrói o KV e confere chave a chave.
"""
import contextlib
import io
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "scripts", "ops"))

LOCAL = {"localhost", "127.0.0.1", "::1"}
REAL_DB_VARS = ("DATABASE_URL", "RESTORE_TARGET_DATABASE_URL", "CERTIFICATION_DATABASE_URL", "PGSERVICE", "PGSERVICEFILE")


def guard(env):
    if env.get("PGHOST", "") not in LOCAL:
        return "target_not_ephemeral_host"
    if env.get("PGHOSTADDR") and env["PGHOSTADDR"] not in LOCAL:
        return "target_not_ephemeral_hostaddr"
    for k in REAL_DB_VARS:
        if env.get(k):
            return "target_not_ephemeral_" + k.lower()
    if not re.fullmatch(r"p20_drill[a-z0-9_]{0,40}", env.get("PGDATABASE", "")):
        return "target_not_ephemeral_database"
    return None


KV_COLS = ("snapshot_day", "key", "value", "sha256", "expiration", "metadata")


def restore_kv_copy(env, kv_json, kv_man, out_path, rnd):
    """Carrega a cópia do KV em public.zevanory_kv_backup (tabela criada pelo DDL do Worker em restore_full), confere
    contagem e hash de conteúdo e relê do Postgres para out_path. Nunca imprime dado de linha."""
    day = str(kv_man.get("day", ""))
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day) or not isinstance(kv_man.get("rows"), int):
        rnd.fail("kv_manifest_malformed")
    have = set(rnd.psql("select column_name from information_schema.columns where table_schema='public' and table_name='zevanory_kv_backup';", env).split())
    if not set(KV_COLS) <= have:
        rnd.fail("kv_copy_table_schema_missing")
    if rnd.psql("select count(*) from public.zevanory_kv_backup;", env).strip() != "0":
        rnd.fail("kv_copy_target_not_empty")
    cl = ",".join(f'"{c}"' for c in KV_COLS)
    src = f"json_populate_recordset(null::public.zevanory_kv_backup, {rnd.dollar(kv_json)}::json)"
    out = rnd.psql(f"insert into public.zevanory_kv_backup ({cl}) select {cl} from {src};\n"
                   f"select count(*) from public.zevanory_kv_backup;\n"
                   f"select {rnd.row_hash_sql(src, cl)} = {rnd.row_hash_sql('public.zevanory_kv_backup', cl)};", env).split()
    if int(out[-2]) != kv_man["rows"]:
        rnd.fail("kv_copy_count_mismatch")
    if out[-1] != "t":
        rnd.fail("kv_copy_content_hash_mismatch")
    back = rnd.psql("select coalesce(json_agg(x order by x.key), '[]'::json)::text from "
                    f"(select to_char(snapshot_day, 'YYYY-MM-DD') as snapshot_day, key, value, sha256, expiration, metadata "
                    f"from public.zevanory_kv_backup where snapshot_day = '{day}'::date) x;", env)
    fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(back.strip())
    return {"rows": int(out[-2]), "content_hash": "ok", "table": "zevanory_kv_backup"}


def main(argv):
    if len(argv) != 2:
        print(json.dumps({"ok": False, "error": "usage"}))
        return 2
    env = dict(os.environ)
    refused = guard(env)
    if refused:
        print(json.dumps({"ok": False, "error": refused}))
        return 1
    with open(os.path.join(argv[1], "tables.json"), encoding="utf-8") as f:
        tables = json.load(f)
    with open(os.path.join(argv[1], "manifest.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    import restore_new_database as rnd  # noqa: E402  (depois do guard: nada conecta antes da verificação)
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            report = rnd.restore_full(env, tables, manifest)
    except SystemExit:
        # rnd.fail imprime "::error title=RESTORE_NEW_DATABASE::<motivo>" (só nomes de tabela e SQLSTATE).
        lines = [ln for ln in buf.getvalue().splitlines() if "::error" in ln]
        msg = lines[-1].split("::")[-1] if lines else "restore_failed"
        print(json.dumps({"ok": False, "error": re.sub(r"[^A-Za-z0-9_.:,=!/ -]", "", msg)[:160]}))
        return 1
    kv_out = None
    kv_path = os.path.join(argv[1], "kv_copy.json")
    if os.path.exists(kv_path):
        with open(kv_path, encoding="utf-8") as f:
            kv_json = f.read()
        with open(os.path.join(argv[1], "kv_manifest.json"), encoding="utf-8") as f:
            kv_man = json.load(f)
        try:
            with contextlib.redirect_stdout(buf):
                kv_out = restore_kv_copy(env, kv_json, kv_man, os.path.join(argv[1], "kv_restored.json"), rnd)
        except SystemExit:
            lines = [ln for ln in buf.getvalue().splitlines() if "::error" in ln]
            msg = lines[-1].split("::")[-1] if lines else "kv_restore_failed"
            print(json.dumps({"ok": False, "error": re.sub(r"[^A-Za-z0-9_.:,=!/ -]", "", msg)[:160]}))
            return 1
    hashes_ok = all(v.get("content_hash") == "ok" for v in report["tables"].values())
    complete = set(report["tables"]) == set(tables)
    print(json.dumps({
        "ok": bool(hashes_ok and complete and report.get("worker_schema", {}).get("ready") is True),
        "error": None if hashes_ok and complete else "restore_incomplete",
        "tables": {t: v["rows"] for t, v in sorted(report["tables"].items())},
        "preserved_without_schema": report.get("preserved_without_schema", []),
        "worker_schema_ready": report.get("worker_schema", {}).get("ready") is True,
        "kv_copy": kv_out,
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
