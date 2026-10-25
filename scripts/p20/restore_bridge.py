#!/usr/bin/env python3
"""ZEVANORY | P20: ponte do ensaio mensal para a rotina oficial de restauração completa.

Uso: python3 scripts/p20/restore_bridge.py <dir>   (dir contém tables.json {tabela: json} e manifest.json {tabela: {rows}})
Restaura TUDO com scripts/ops/restore_new_database.restore_full (migrações + DDL do Worker, carga em ordem de chave
estrangeira, contagem E hash de conteúdo por tabela) num PostgreSQL LOCAL e descartável. Recusa, antes de conectar,
qualquer alvo que não seja localhost com banco p20_drill* ou qualquer variável de banco real no ambiente.
Saída: UMA linha JSON só com metadados (nomes de tabela e contagens). Nunca imprime dado de linha.
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
    hashes_ok = all(v.get("content_hash") == "ok" for v in report["tables"].values())
    complete = set(report["tables"]) == set(tables)
    print(json.dumps({
        "ok": bool(hashes_ok and complete and report.get("worker_schema", {}).get("ready") is True),
        "error": None if hashes_ok and complete else "restore_incomplete",
        "tables": {t: v["rows"] for t, v in sorted(report["tables"].items())},
        "preserved_without_schema": report.get("preserved_without_schema", []),
        "worker_schema_ready": report.get("worker_schema", {}).get("ready") is True,
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
