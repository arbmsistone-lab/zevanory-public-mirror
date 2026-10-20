#!/usr/bin/env python3
"""ZEVANORY · Restauração COMPLETA do backup cifrado num banco PostgreSQL NOVO (vazio).

Decisão do proprietário (20/10/2026): o projeto Neon de produção está suspenso por cota de transferência
(plano gratuito, 5 GB por projeto/mês); a saída de custo zero é um projeto Neon novo, restaurado a partir do
arquivo cifrado preservado (backup íntegro de 14/10/2026).

O que faz, em ordem, e PARA na primeira divergência (fail-closed):
  1. decifra e confere o arquivo contra o manifesto (mesma rotina do backup_preserve_archive.py);
  2. recusa alvo que já tenha tabelas em public (nunca sobrescreve);
  3. aplica as 30 migrações de db/migrations (esquema exigido pelo Worker: 40 tabelas, 29 migrações);
  4. cria as tabelas que o Worker cria em tempo de execução, com o DDL LIDO do próprio código do Worker
     ou capturado EXECUTANDO o módulo que o monta (fonte única; nada copiado à mão); tabelas legadas que
     nenhum código atual cria são preservadas como jsonb no esquema zevanory_restore_preservado;
  5. remove as linhas-semente das migrações nas tabelas do backup (o backup é a autoridade) e carrega cada tabela em ordem de chave estrangeira (jsonb_populate_recordset, OVERRIDING SYSTEM VALUE);
  6. ajusta sequências ao maior valor carregado;
  7. confere cada tabela: contagem igual ao manifesto E hash de conteúdo independente de ordem
     (md5 das linhas row_to_json ordenadas) igual entre a cópia do backup e o banco restaurado;
  8. confere o esquema exigido pelo Worker (tabelas e migrações), como faz o /api/health.
Nenhum dado é impresso (repositório público): só contagens, hashes e nomes de tabela.
Tabelas de credenciais nunca entraram no backup (política do Worker): ficam vazias e são reemitidas.

Uso:
  rehearse --out DIR            ensaio num Postgres efêmero (variáveis PG*): CI, sem tocar produção
  restore  --out DIR --confirm "RESTAURAR <dia> EM BANCO NOVO"
                                alvo = variável RESTORE_TARGET_DATABASE_URL (segredo do Environment)
Variáveis: BACKUP_ARCHIVE_PASSPHRASE (segredo do proprietário).
"""
import argparse
import glob
import json
import os
import re
import secrets
import subprocess
import sys
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, HERE)
import backup_preserve_archive as bpa  # noqa: E402

IDENT = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")
RUNTIME_DDL = re.compile(r"create table if not exists\s+(?:public\.)?(\$\{BACKUP_TABLE\}|[a-z_][a-z0-9_]*)\s*\(", re.I)
RUNTIME_ALTER = re.compile(r"alter table\s+(?:public\.)?([a-z_][a-z0-9_]*)\s+add column if not exists\s+[a-z_][a-z0-9_]*\s+[a-z ]+?(?=[`'\";])", re.I)


def fail(msg):
    print(f"::error title=RESTORE_NEW_DATABASE::{msg}")
    raise SystemExit(2)


def pg_env_from_url(url):
    """Converte a URL em variáveis PG* (a credencial nunca vai para a linha de comando)."""
    u = urllib.parse.urlsplit(url)
    if u.scheme not in ("postgres", "postgresql") or not u.hostname:
        fail("target_url_invalid")
    env = dict(os.environ)
    env.update({"PGHOST": u.hostname, "PGPORT": str(u.port or 5432), "PGUSER": urllib.parse.unquote(u.username or ""),
                "PGPASSWORD": urllib.parse.unquote(u.password or ""), "PGDATABASE": (u.path or "/").lstrip("/") or "postgres"})
    q = urllib.parse.parse_qs(u.query)
    env["PGSSLMODE"] = (q.get("sslmode") or ["require"])[0]
    return env


SQLSTATE = re.compile(r"ERROR:\s+([0-9A-Z]{5})\b")


def psql(sql, env, timeout=600):
    # VERBOSITY sqlstate: o servidor devolve só o código SQLSTATE, nunca a mensagem (que pode citar valores
    # de linha, ex.: chave duplicada). E mesmo assim só o código de 5 caracteres é repassado ao log.
    r = subprocess.run(["psql", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=sqlstate", "-X", "-qtA", "-f", "-"],
                       input="\\set VERBOSITY sqlstate\n" + sql.lstrip("\ufeff"), capture_output=True, text=True, timeout=timeout, env=env)
    if r.returncode != 0:
        m = SQLSTATE.search(r.stderr or "")
        fail("psql_error sqlstate=" + (m.group(1) if m else "unknown"))
    return r.stdout


def dollar(js):
    tag = "zv" + secrets.token_hex(6)
    while f"${tag}$" in js:
        tag = "zv" + secrets.token_hex(6)
    return f"${tag}${js}${tag}$"


def runtime_ddl(worker_dir=None):
    """DDL das tabelas criadas pelo Worker em tempo de execução, lido do próprio código (fonte única)."""
    worker_dir = worker_dir or os.path.join(ROOT, "worker")
    stmts, names = [], []
    for f in sorted(glob.glob(os.path.join(worker_dir, "*.mjs"))):
        with open(f, encoding="utf-8") as fh:
            src = fh.read()
        for m in RUNTIME_DDL.finditer(src):
            i, depth = m.end() - 1, 0
            for j in range(i, len(src)):
                if src[j] == "(":
                    depth += 1
                elif src[j] == ")":
                    depth -= 1
                    if depth == 0:
                        break
            stmt = src[m.start():j + 1]
            name = m.group(1)
            if name == "${BACKUP_TABLE}":
                name = "zevanory_kv_backup"
                stmt = stmt.replace("${BACKUP_TABLE}", name)
            if "${" in stmt:
                fail(f"runtime_ddl_interpolated {os.path.basename(f)}")
            if name.lower() in names:
                continue
            names.append(name.lower())
            stmts.append(stmt + ";")
        for m in RUNTIME_ALTER.finditer(src):
            stmts.append(m.group(0) + ";")
    return names, stmts


DYNAMIC_DDL_JS = """
import { createWhatsappNeonStore } from "./worker/whatsapp-neon-store.mjs";
const q = [];
const s = createWhatsappNeonStore({ query: async (x) => { q.push(String(x)); return []; } });
await s.put("whatsapp:instant:restore-ddl-probe", "x");
process.stdout.write(JSON.stringify(q.filter((x) => /^create /i.test(x))));
"""


def dynamic_ddl():
    """DDL que o Worker monta em tempo de execução (nome de tabela concatenado), capturado EXECUTANDO o
    próprio módulo com um banco falso que só registra os comandos. Fonte única, sem cópia manual."""
    r = subprocess.run(["node", "--input-type=module", "-e", DYNAMIC_DDL_JS], cwd=ROOT, capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        fail("dynamic_ddl_capture_failed")
    stmts = json.loads(r.stdout or "[]")
    if not stmts:
        fail("dynamic_ddl_empty")
    return [s + ";" for s in stmts]


PRESERVE_SCHEMA = "zevanory_restore_preservado"


def fk_order(env, tables):
    rows = psql("""select tc.table_name, ccu.table_name from information_schema.table_constraints tc
      join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
      where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public';""", env)
    deps = {t: set() for t in tables}
    for line in rows.splitlines():
        child, parent = line.split("|")
        if child in deps and parent in deps and child != parent:
            deps[child].add(parent)
    order, done = [], set()
    while len(order) < len(tables):
        ready = sorted(t for t in tables if t not in done and deps[t] <= done)
        if not ready:
            fail("fk_cycle " + ",".join(sorted(set(tables) - done))[:200])
        order += ready
        done |= set(ready)
    return order


def row_hash_sql(source):
    return f"(select md5(coalesce(string_agg(r, '|' order by r), '')) from (select row_to_json(x)::text r from {source} x) a)"


def restore_full(env, tables_json, manifest_tables):
    if psql("select count(*) from information_schema.tables where table_schema='public';", env).strip() != "0":
        fail("target_not_empty")
    migrations = sorted(glob.glob(os.path.join(ROOT, "db", "migrations", "*.sql")))
    if len(migrations) != 30:
        fail(f"migrations_expected_30_found_{len(migrations)}")
    for m in migrations:
        psql(open(m, encoding="utf-8").read(), env)
    names, ddl = runtime_ddl()
    psql("\n".join(ddl + dynamic_ddl()), env)
    present = set(psql("select table_name from information_schema.tables where table_schema='public';", env).split())
    # Tabelas do backup que nenhum código atual cria (legado): os dados são PRESERVADOS, sem inventar
    # esquema, como linhas jsonb num esquema separado, com contagem e hash conferidos.
    orphans = sorted(set(tables_json) - present)
    report = {"tables": {}, "runtime_tables": names, "preserved_without_schema": orphans}
    for t in orphans:
        if not IDENT.match(t):
            fail("table_name_invalid")
        js = tables_json[t]
        out = psql(f'create schema if not exists {PRESERVE_SCHEMA};\n'
                   f'create table {PRESERVE_SCHEMA}."{t}" (doc jsonb not null);\n'
                   f'insert into {PRESERVE_SCHEMA}."{t}"(doc) select value from jsonb_array_elements({dollar(js)}::jsonb);\n'
                   f'select count(*) from {PRESERVE_SCHEMA}."{t}";\n'
                   f"select (select md5(coalesce(string_agg(v::text, '|' order by v::text), '')) from jsonb_array_elements({dollar(js)}::jsonb) v)"
                   f" = (select md5(coalesce(string_agg(doc::text, '|' order by doc::text), '')) from {PRESERVE_SCHEMA}.\"{t}\");", env).split()
        if int(out[-2]) != manifest_tables[t]["rows"]:
            fail(f"count_mismatch {t}")
        if out[-1] != "t":
            fail(f"content_hash_mismatch {t}")
        report["tables"][t] = {"rows": int(out[-2]), "content_hash": "ok", "schema": PRESERVE_SCHEMA}
    order = fk_order(env, sorted(set(tables_json) - set(orphans)))
    # O alvo estava vazio: qualquer linha agora presente veio das migrações (sementes). O backup é a
    # autoridade sobre o conteúdo, então as sementes das tabelas do backup saem (ordem inversa de FK).
    psql("\n".join(f'delete from public."{t}";' for t in reversed(order)), env)
    for t in order:
        if not IDENT.match(t):
            fail("table_name_invalid")
        js = tables_json[t]
        src = f'json_populate_recordset(null::public."{t}", {dollar(js)}::json)'
        # Colunas geradas (GENERATED ALWAYS ... STORED) são recalculadas pelo banco: não podem ser inseridas.
        cols = [c for c in psql(f"select column_name from information_schema.columns where table_schema='public' and table_name='{t}' "
                                f"and is_generated='NEVER' order by ordinal_position;", env).split() if IDENT.match(c)]
        if not cols:
            fail(f"no_insertable_columns {t}")
        cl = ",".join(f'"{c}"' for c in cols)
        out = psql(f'insert into public."{t}" ({cl}) overriding system value select {cl} from {src};\n'
                   f'select count(*) from public."{t}";\nselect {row_hash_sql(src)} = {row_hash_sql(f"public.{chr(34)}{t}{chr(34)}")};', env).split()
        count, same = int(out[-2]), out[-1] == "t"
        expected = manifest_tables[t]["rows"]
        if count != expected:
            fail(f"count_mismatch {t} {count}!={expected}")
        if not same:
            fail(f"content_hash_mismatch {t}")
        report["tables"][t] = {"rows": count, "content_hash": "ok"}
    # Sequências (serial/identity) no maior valor carregado.
    psql("""do $$ declare r record; begin
      for r in select c.table_name, c.column_name, pg_get_serial_sequence(format('public.%I', c.table_name), c.column_name) seq
               from information_schema.columns c where c.table_schema='public'
                 and pg_get_serial_sequence(format('public.%I', c.table_name), c.column_name) is not null loop
        execute format('select setval(%L, coalesce((select max(%I) from public.%I), 0) + 1, false)', r.seq, r.column_name, r.table_name);
      end loop; end $$;""", env)
    req = worker_requirements()
    have = set(psql("select table_name from information_schema.tables where table_schema='public';", env).split())
    migs = set(psql("select migration_id from schema_migrations;", env).split())
    lack_t, lack_m = sorted(set(req["tables"]) - have), sorted(set(req["migrations"]) - migs)
    if lack_t or lack_m:
        fail(f"worker_schema_not_ready tables={lack_t[:5]} migrations={lack_m[:5]}")
    report["worker_schema"] = {"required_tables": len(req["tables"]), "required_migrations": len(req["migrations"]), "ready": True}
    report["totals"] = {"tables": len(report["tables"]), "rows": sum(v["rows"] for v in report["tables"].values())}
    return report


def worker_requirements():
    src = open(os.path.join(ROOT, "worker", "cloudflare-worker.recovered.mjs"), encoding="utf-8").read()
    def block(name):
        a = src.index(f"var {name} = Object.freeze([")
        return re.findall(r'"([a-z0-9_]+)"', src[a:src.index("]);", a)])
    return {"tables": block("REQUIRED_TABLES"), "migrations": block("REQUIRED_MIGRATIONS")}


def load_archive(out_dir):
    """Decifra e confere (fail-closed) usando a rotina oficial; devolve (tabelas_json, manifesto)."""
    passphrase = bpa.passphrase_or_fail()
    with open(os.path.join(out_dir, "manifest.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    with open(os.path.join(out_dir, "archive.enc"), "rb") as f:
        blob = f.read()
    if bpa.sha256_hex(blob) != manifest["ciphertext_sha256"]:
        fail("ciphertext_hash_mismatch")
    try:
        plaintext = bpa.decrypt(blob, passphrase)
    except Exception:  # InvalidTag: arquivo adulterado ou senha errada
        fail("decrypt_failed")
    if bpa.sha256_hex(plaintext) != manifest["plaintext_sha256"]:
        fail("plaintext_hash_mismatch")
    doc = json.loads(plaintext)
    raw = {int(p): v.encode("utf-8") for p, v in doc["parts"].items()}
    if bpa.describe_bundles(raw) != manifest["tables"]:
        fail("table_manifest_mismatch")
    tables_json = {}
    for b in raw.values():
        tables_json.update(json.loads(b))
    return tables_json, manifest


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["rehearse", "restore"])
    ap.add_argument("--out", required=True)
    ap.add_argument("--confirm", default="")
    a = ap.parse_args(argv)
    tables_json, manifest = load_archive(a.out)
    if a.mode == "rehearse":
        env = dict(os.environ)
    else:
        if a.confirm != f"RESTAURAR {manifest['day']} EM BANCO NOVO":
            fail("confirmation_phrase_mismatch")
        url = os.environ.get("RESTORE_TARGET_DATABASE_URL", "")
        if not url:
            fail("target_url_missing")
        env = pg_env_from_url(url)
    report = restore_full(env, tables_json, manifest["tables"])
    report.update({"mode": a.mode, "day": manifest["day"]})
    bpa.note("RESTORE_NEW_DATABASE", {k: v for k, v in report.items() if k != "tables"})
    print(json.dumps({"tables": {t: v["rows"] for t, v in report["tables"].items()}}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
