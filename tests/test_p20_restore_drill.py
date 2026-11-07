"""P20: ensaio mensal de restauração COMPLETA, ponta a ponta, num PostgreSQL descartável com dados SINTÉTICOS.

Requer variáveis PG* apontando para um servidor descartável (o teste cria e apaga bancos próprios); sem PGHOST, pula.
Prova: (1) origem com o esquema real -> o CÓDIGO REAL do Worker (worker/data-backup.mjs) grava o backup num KV em
memória -> o ensaio lê esse formato, confere o SHA-256 de cada tabela contra o manifesto e restaura TUDO num banco
p20_drill* vazio, com contagem e hash de conteúdo por tabela, RPO e RTO; (2) bundle adulterado -> REPROVADO e nada
restaurado; (3) alvo não efêmero recusado antes de conectar (JS e Python); (4) nenhum dado de linha no registro;
(5) toda tabela do esquema real tem classe no inventário da seção 9.1; (6) com P20_BACKUP_KEY o Worker real grava os
bundles cifrados (AES-256-GCM) e o ensaio, com P20_BACKUP_KEYS, decifra, restaura TUDO e marca copia_cifrada em todas
as partes; (7) cópia cifrada sem a chave no ensaio reprova sem restaurar nada e sem vazar a chave."""
import base64, datetime, json, os, subprocess, sys, tempfile, unittest
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "scripts", "ops"))
import restore_new_database as rnd  # noqa: E402

SKIP = not os.environ.get("PGHOST")
SEGREDO = "pessoa-sintetica-p20@example.invalid"
# Backup "tirado" 2 h antes do ensaio (RPO esperado ~2 h; cópia no futuro seria rpo_not_computable).
NOW = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ")


def sh(db, sql):
    env = dict(os.environ, PGDATABASE=db)
    r = subprocess.run(["psql", "-v", "ON_ERROR_STOP=1", "-X", "-qtA", "-f", "-"], input=sql, capture_output=True, text=True, env=env)
    if r.returncode:
        raise AssertionError(r.stderr[:500])
    return r.stdout


def fresh(name):
    sh("postgres", f"drop database if exists {name}; create database {name};")
    return name


def build_source(db):
    env = dict(os.environ, PGDATABASE=db)
    for m in sorted(os.listdir(os.path.join(ROOT, "db", "migrations"))):
        rnd.psql(open(os.path.join(ROOT, "db", "migrations", m), encoding="utf-8").read(), env)
    rnd.psql("\n".join(rnd.runtime_ddl()[1] + rnd.dynamic_ddl()), env)
    sh(db, "create table zpc_records(id text primary key, payload jsonb); insert into zpc_records values ('a','{\"k\":\"ç\"}');")
    sh(db, f"""insert into orders(order_id,request_id,session_id,experiment_id,offer_id,amount,currency,provider,external_reference,status) values
      (gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'exp','ZEV-1',47,'BRL','mercadopago','ref-p20-1','paid');
      insert into knowledge_documents(document_id,namespace,title,content) values (gen_random_uuid(),'suporte','Guia','Conteúdo ç "aspas" $1 $$');
      insert into inbound_followups(followup_key,kind,subject_ref,recipient_hash) values ('cart:p20','cart_recovery','{SEGREDO}','h');""")


def make_fixture(src_db, out, key=None):
    env = dict(os.environ, PGDATABASE=src_db)
    env.pop("P20_BACKUP_KEY", None)
    if key:
        env["P20_BACKUP_KEY"] = key
    r = subprocess.run(["node", "tests/helpers/p20_worker_backup_fixture.mjs", out, NOW], cwd=ROOT, env=env, capture_output=True, text=True, timeout=600)
    if r.returncode:
        raise AssertionError(r.stderr[-800:])
    rep = json.loads(r.stdout.strip().splitlines()[-1])
    assert rep["ok"] is True and rep["failures"] == [], rep
    return rep


def drill(fixture, target_db, extra_env=None):
    out = os.path.join(tempfile.mkdtemp(), "drill.json")
    env = dict(os.environ, PGDATABASE=target_db, **(extra_env or {}))
    r = subprocess.run(["node", "scripts/p20/restore-drill.mjs", "--mode", "sintetica", "--fixture", fixture, "--out", out], cwd=ROOT, env=env, capture_output=True, text=True, timeout=1200)
    with open(out, encoding="utf-8") as f:
        text = f.read()
    return r, json.loads(text), text


def public_tables(db):
    return int(sh(db, "select count(*) from information_schema.tables where table_schema='public'").strip())


@unittest.skipIf(SKIP, "PGHOST ausente (PostgreSQL descartável necessário)")
class T(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.src = fresh("p20_origem")
        build_source(cls.src)
        cls.dir = tempfile.mkdtemp()
        cls.fixture = os.path.join(cls.dir, "kv.json")
        cls.worker = make_fixture(cls.src, cls.fixture)
        cls.key = base64.b64encode(os.urandom(32)).decode()  # chave sintética, só deste teste
        cls.enc_fixture = os.path.join(cls.dir, "kv-cifrado.json")
        cls.enc_worker = make_fixture(cls.src, cls.enc_fixture, cls.key)

    def test_1_restauracao_completa_com_formato_real_do_worker(self):
        db = fresh("p20_drill_t1")
        r, rec, text = drill(self.fixture, db)
        self.assertEqual(r.returncode, 0, r.stdout[-800:])
        self.assertEqual(rec["verdict"], "APROVADO")
        self.assertEqual(rec["label"], "SINTETICA")
        self.assertEqual(rec["integrity"]["tables_checked"], self.worker["tables"])
        self.assertEqual(rec["integrity"]["tables_hash_ok"], self.worker["tables"])
        self.assertEqual(rec["restore"]["tables"], self.worker["tables"])
        self.assertEqual(rec["backup"]["rows"], self.worker["rows"])
        self.assertTrue(rec["restore"]["worker_schema_ready"])
        self.assertEqual(rec["restore"]["preserved_without_schema"], ["zpc_records"])
        self.assertGreater(rec["rto_seconds"], 0)
        self.assertTrue(1.9 <= rec["rpo_hours"] <= 3, rec["rpo_hours"])
        self.assertEqual(sh(db, "select count(*) from orders").strip(), "1")
        self.assertEqual(sh(db, "select count(*) from zevanory_restore_preservado.zpc_records").strip(), "1")
        self.assertNotIn(SEGREDO, text)
        self.assertNotIn("ref-p20-1", text)
        self.assertEqual(rec["unclassified_tables"], ["zpc_records"], "só a tabela legada sintética fica sem classe")
        self.assertEqual([p["copia_cifrada"] for p in rec["backup"]["parts"]], [False, False, False], "sem chave: legado em claro")
        self.assertTrue(any(s.startswith("copia_cifrada:") for s in rec["not_covered"]))

    def test_2_bundle_adulterado_reprova_e_nada_e_restaurado(self):
        with open(self.fixture, encoding="utf-8") as f:
            kv = json.load(f)
        key = next(k for k in kv if k.startswith("zpc:backup:v1:neon:") and "orders" in json.loads(kv[k]))
        b = json.loads(kv[key]); rows = json.loads(b["orders"]); rows[0]["amount"] = 1; b["orders"] = json.dumps(rows); kv[key] = json.dumps(b)
        bad = os.path.join(self.dir, "kv-adulterado.json")
        with open(bad, "w", encoding="utf-8") as f:
            json.dump(kv, f)
        db = fresh("p20_drill_t2")
        r, rec, _ = drill(bad, db)
        self.assertEqual(r.returncode, 1)
        self.assertEqual(rec["verdict"], "REPROVADO")
        self.assertIn("hash_mismatch:orders", rec["failures"])
        self.assertEqual(public_tables(db), 0, "nada restaurado a partir de cópia adulterada")

    def test_3_alvo_nao_efemero_recusado_antes_de_conectar(self):
        db = fresh("p20_drill_t3")
        r, rec, _ = drill(self.fixture, db, {"DATABASE_URL": "postgres://u:p@ep-real.neon.tech/neondb"})
        self.assertEqual(rec["verdict"], "REPROVADO")
        self.assertTrue(any("TARGET_NOT_EPHEMERAL" in f for f in rec["failures"]))
        self.assertEqual(public_tables(db), 0)
        fresh("naop20")
        r, rec, _ = drill(self.fixture, "naop20")
        self.assertEqual(rec["verdict"], "REPROVADO")
        self.assertEqual(public_tables("naop20"), 0)

    def test_4_ponte_python_recusa_alvo_real_por_conta_propria(self):
        d = tempfile.mkdtemp()
        for name in ("tables.json", "manifest.json"):
            with open(os.path.join(d, name), "w") as f:
                f.write("{}")
        for extra in ({"PGDATABASE": "postgres"}, {"PGDATABASE": "p20_drill", "PGHOST": "ep-real.neon.tech"}, {"PGDATABASE": "p20_drill", "RESTORE_TARGET_DATABASE_URL": "postgres://x"}):
            env = dict(os.environ, **extra)
            r = subprocess.run([sys.executable, "scripts/p20/restore_bridge.py", d], cwd=ROOT, env=env, capture_output=True, text=True, timeout=60)
            self.assertEqual(r.returncode, 1, extra)
            self.assertFalse(json.loads(r.stdout.strip())["ok"], extra)

    def test_5_inventario_classifica_todas_as_tabelas_do_esquema_real(self):
        with open(os.path.join(ROOT, "docs", "p20", "inventario-estado-critico.json"), encoding="utf-8") as f:
            inv = json.load(f)
        owned = {t for c in inv["classes"] for t in c["tables"]}
        real = set(sh(self.src, "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'").split())
        real -= {"zpc_records", "zevanory_kv_backup"}  # legado sintético; a cópia KV -> Neon tem classe própria (estado_comercial_kv)
        self.assertEqual(sorted(real - owned), [], "tabela do esquema real sem classe no inventário 9.1")

    def test_6_copia_cifrada_pelo_worker_real_restaura_tudo_com_a_chave(self):
        self.assertEqual(self.enc_worker["encryption"]["state"], "cifrado")
        self.assertEqual(self.enc_worker["encryption"]["parts_cifradas"], 3)
        with open(self.enc_fixture, encoding="utf-8") as f:
            kv = json.load(f)
        bundles = [v for k, v in kv.items() if k.startswith("zpc:backup:v1:neon:")]
        self.assertEqual(len(bundles), 3)
        for b in bundles:
            self.assertTrue(b.startswith('{"$enc":"zevanory-backup-enc/v1"'))
            self.assertNotIn("ref-p20-1", b)
            self.assertNotIn(SEGREDO, b)
        db = fresh("p20_drill_t6")
        r, rec, text = drill(self.enc_fixture, db, {"P20_BACKUP_KEYS": self.key})
        self.assertEqual(r.returncode, 0, r.stdout[-800:])
        self.assertEqual(rec["verdict"], "APROVADO")
        self.assertEqual(rec["restore"]["tables"], self.enc_worker["tables"])
        self.assertEqual(rec["backup"]["rows"], self.enc_worker["rows"])
        self.assertEqual([p["copia_cifrada"] for p in rec["backup"]["parts"]], [True, True, True])
        self.assertTrue(rec["backup"]["copia_cifrada"])
        self.assertFalse(any(s.startswith("copia_cifrada:") for s in rec["not_covered"]))
        self.assertFalse(rec["scope_complete_9_1"], "outras lacunas da seção 9.1 continuam")
        self.assertEqual(sh(db, "select count(*) from orders").strip(), "1")
        for out in (text, r.stdout, r.stderr):
            self.assertNotIn(self.key, out)
            self.assertNotIn(SEGREDO, out)

    def test_7_copia_cifrada_sem_chave_reprova_e_nada_e_restaurado(self):
        db = fresh("p20_drill_t7")
        r, rec, text = drill(self.enc_fixture, db, {"P20_BACKUP_KEYS": ""})
        self.assertEqual(r.returncode, 1)
        self.assertEqual(rec["verdict"], "REPROVADO")
        self.assertIn("bundle_kid_unknown:0", rec["failures"])
        self.assertEqual(public_tables(db), 0)
        self.assertNotIn(self.key, text + r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
