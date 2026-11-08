"""P20: ensaio mensal de restauração COMPLETA, ponta a ponta, num PostgreSQL descartável com dados SINTÉTICOS.

Requer variáveis PG* apontando para um servidor descartável (o teste cria e apaga bancos próprios); sem PGHOST, pula.
Prova: (1) origem com o esquema real -> o CÓDIGO REAL do Worker (worker/data-backup.mjs) grava o backup num KV em
memória -> o ensaio lê esse formato, confere o SHA-256 de cada tabela contra o manifesto e restaura TUDO num banco
p20_drill* vazio, com contagem e hash de conteúdo por tabela, RPO e RTO; (2) bundle adulterado -> REPROVADO e nada
restaurado; (3) alvo não efêmero recusado antes de conectar (JS e Python); (4) nenhum dado de linha no registro;
(5) toda tabela do esquema real tem classe no inventário da seção 9.1; (6) com P20_BACKUP_KEY o Worker real grava os
bundles cifrados (AES-256-GCM) e o ensaio, com P20_BACKUP_KEYS, decifra, restaura TUDO e marca copia_cifrada em todas
as partes; (7) cópia cifrada sem a chave no ensaio reprova sem restaurar nada e sem vazar a chave; (8) cópia KV -> Neon:
o Worker real copia as chaves críticas do KV (com TTL e metadados) para zevanory_kv_backup, relê do Neon e grava a cópia
do dia; o ensaio a restaura em zevanory_kv_backup do banco p20_drill*, RELÊ do Postgres, reconstrói o KV e confere chave a
chave contra o manifesto da fonte, retirando a lacuna copia_kv_para_neon; (9) idem com a cópia do KV cifrada;
(10) cópia do KV adulterada (bundle ou valor + hash da linha) reprova e nada é restaurado;
(11) com a leitura
do diário D1 (pedido anterior à cópia e pedido posterior, só no diário), o ensaio valida a cadeia, reaplica o evento
posterior em p20_diario_reconstruido no banco efêmero, confere restaurado + reconstruído = diário pelas consultas reais
da reconciliação e tira diario_d1 de not_covered com rpo_critico_medido_s; (12) evento do diário sem origem na cópia:
diario_d1 continua com o motivo; (13) sem o token ou com a cadeia adulterada: diario_d1 continua com o motivo, e o
ensaio dos dados segue aprovado (fase sombra)."""
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
    # Pedido "antigo": 3 h antes do ensaio, 1 h antes da cópia (NOW). Entra na cópia e no diário (costura do ensaio 8).
    sh(db, "update orders set created_at = now() - interval '3 hours', updated_at = now() - interval '3 hours';")


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


def drill(fixture, target_db, extra_env=None, diario=None):
    out = os.path.join(tempfile.mkdtemp(), "drill.json")
    env = dict(os.environ, PGDATABASE=target_db, **(extra_env or {}))
    extra = ["--diario", diario] if diario else []
    r = subprocess.run(["node", "scripts/p20/restore-drill.mjs", "--mode", "sintetica", "--fixture", fixture, "--out", out, *extra], cwd=ROOT, env=env, capture_output=True, text=True, timeout=1200)
    with open(out, encoding="utf-8") as f:
        text = f.read()
    return r, json.loads(text), text


def make_diario(src_db, out, extra_ts=None):
    env = dict(os.environ, PGDATABASE=src_db)
    lido = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=40)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    args = ["node", "tests/helpers/p20_diario_fixture.mjs", out, lido] + ([str(extra_ts)] if extra_ts else [])
    r = subprocess.run(args, cwd=ROOT, env=env, capture_output=True, text=True, timeout=300)
    if r.returncode:
        raise AssertionError(r.stderr[-800:])
    return json.loads(r.stdout.strip().splitlines()[-1])


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
        # Pedido posterior à cópia: existe na origem (e no diário), não na cópia restaurada.
        sh(cls.src, """insert into orders(order_id,request_id,session_id,experiment_id,offer_id,amount,currency,provider,external_reference,status) values
          (gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'exp','ZEV-2',47,'BRL','mercadopago','ref-p20-2','created');""")
        cls.diario = os.path.join(cls.dir, "diario.json")
        cls.diario_info = make_diario(cls.src, cls.diario)

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

    def _kv_copy(self, path):
        with open(path, encoding="utf-8") as f:
            kv = json.load(f)
        key = next(k for k in kv if k.startswith("zpc:backup:v1:kv:"))
        return kv, key

    def test_8_copia_kv_restaurada_no_postgres_e_conferida_chave_a_chave(self):
        self.assertEqual(self.worker["kv_keys"], 4, "trava, resumo, chave com TTL e chave com metadados; lead fora")
        kv, key = self._kv_copy(self.fixture)
        self.assertNotIn("fora-da-copia@example.invalid", kv[key])
        db = fresh("p20_drill_t8")
        r, rec, text = drill(self.fixture, db)
        self.assertEqual(r.returncode, 0, r.stdout[-800:])
        self.assertEqual(rec["verdict"], "APROVADO")
        k = rec["kv_copy"]
        self.assertEqual((k["keys"], k["restored"], k["expired_at_restore"], k["with_ttl"], k["with_metadata"]), (4, 4, 0, 1, 1))
        self.assertTrue(k["pg_rows_ok"] and k["values_hash_ok"] and k["ttl_metadata_ok"] and k["entries_manifest_ok"])
        self.assertFalse(any(s.startswith("copia_kv_para_neon:") for s in rec["not_covered"]))
        self.assertTrue(any(s.startswith("copia_cifrada:") for s in rec["not_covered"]), "cópia em claro: essa lacuna continua")
        # A cópia foi restaurada na tabela do Worker DENTRO do banco efêmero, com TTL e metadados.
        self.assertEqual(sh(db, "select count(*), count(expiration), count(metadata) from zevanory_kv_backup").strip(), "4|1|1")
        self.assertEqual(sh(db, "select count(*) from zevanory_kv_backup where key like 'zpc:interest:%'").strip(), "0")
        for out in (text, r.stdout, r.stderr):
            self.assertNotIn("acentuação", out)
            self.assertNotIn('"enabled"', out)

    def test_9_copia_kv_cifrada_pelo_worker_real(self):
        kv, key = self._kv_copy(self.enc_fixture)
        self.assertTrue(kv[key].startswith('{"$enc":"zevanory-backup-enc/v1"'))
        self.assertNotIn("enabled", kv[key])
        db = fresh("p20_drill_t9")
        r, rec, text = drill(self.enc_fixture, db, {"P20_BACKUP_KEYS": self.key})
        self.assertEqual(r.returncode, 0, r.stdout[-800:])
        self.assertEqual(rec["verdict"], "APROVADO")
        self.assertTrue(rec["kv_copy"]["copia_cifrada"])
        self.assertEqual([s.split(":")[0] for s in rec["not_covered"]], ["conciliacao_pedidos_x_provedor", "diario_d1"])
        self.assertEqual(sh(db, "select count(*) from zevanory_kv_backup").strip(), "4")
        self.assertNotIn(self.key, text + r.stdout + r.stderr)

    def test_10_copia_kv_adulterada_reprova_e_nada_e_restaurado(self):
        kv, key = self._kv_copy(self.fixture)
        rows = json.loads(kv[key])
        i = next(n for n, x in enumerate(rows) if x["key"] == "sales:open:v1")
        rows[i]["value"] = json.dumps({"enabled": True})  # trava aberta forjada, com hash da linha refeito
        rows[i]["sha256"] = __import__("hashlib").sha256(rows[i]["value"].encode()).hexdigest()
        kv[key] = json.dumps(rows, separators=(",", ":"), ensure_ascii=False)
        p0 = json.loads(kv["zpc:backup:v1:report:part:0"])
        p0["kv"]["copy"]["sha"] = __import__("hashlib").sha256(kv[key].encode()).hexdigest()
        kv["zpc:backup:v1:report:part:0"] = json.dumps(p0)
        bad = os.path.join(self.dir, "kv-copia-kv-adulterada.json")
        with open(bad, "w", encoding="utf-8") as f:
            json.dump(kv, f)
        db = fresh("p20_drill_t10")
        r, rec, _ = drill(bad, db)
        self.assertEqual(r.returncode, 1)
        self.assertEqual(rec["verdict"], "REPROVADO")
        self.assertIn("kv_copy_manifest_mismatch", rec["failures"])
        self.assertTrue(any(s.startswith("copia_kv_para_neon:") for s in rec["not_covered"]))
        self.assertEqual(public_tables(db), 0, "nada restaurado a partir de cópia do KV adulterada")

    def test_11_diario_reconstroi_eventos_posteriores_a_copia(self):
        self.assertEqual(self.diario_info["eventos"], 2)
        db = fresh("p20_drill_t11")
        r, rec, text = drill(self.fixture, db, diario=self.diario)
        self.assertEqual(r.returncode, 0, r.stdout[-800:])
        self.assertEqual(rec["verdict"], "APROVADO")
        d = rec["diario"]
        self.assertEqual(d["estado"], "provado", d)
        self.assertTrue(d["cadeia_ok"] and d["reconstrucao_ok"] and d["conjunto_igual"])
        self.assertEqual(d["reconstruidos"], 1, "só o pedido posterior à cópia é reaplicado")
        self.assertEqual(d["restaurados"], 1, "o pedido anterior vem da cópia restaurada")
        self.assertEqual((d["faltando"], d["sobrando"]), (0, 0))
        self.assertEqual(sh(db, "select count(*) from p20_diario_reconstruido").strip(), "1")
        self.assertEqual(sh(db, "select count(*) from orders").strip(), "1", "a cópia não tem o pedido posterior")
        self.assertFalse(any(x.startswith("diario_d1:") for x in rec["not_covered"]))
        self.assertFalse(any(x.startswith("copia_kv_para_neon:") for x in rec["not_covered"]), "as duas provas no mesmo ensaio, cada uma com a sua")
        self.assertTrue(rec["kv_copy"]["entries_manifest_ok"])
        self.assertIsInstance(rec["rpo_critico_medido_s"], int)
        self.assertTrue(0 <= rec["rpo_critico_medido_s"] <= 600, rec["rpo_critico_medido_s"])
        self.assertNotIn("ref-p20-2", text)
        self.assertNotIn(SEGREDO, text)

    def test_12_evento_do_diario_sem_origem_na_copia_mantem_a_lacuna(self):
        out = os.path.join(self.dir, "diario-sobra.json")
        corte_ms = int(datetime.datetime.strptime(NOW, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc).timestamp() * 1000)
        make_diario(self.src, out, extra_ts=corte_ms - 5 * 3600 * 1000)
        db = fresh("p20_drill_t12")
        r, rec, _ = drill(self.fixture, db, diario=out)
        self.assertEqual(rec["verdict"], "APROVADO", "fase sombra: o diário não reprova o ensaio dos dados")
        self.assertEqual(rec["diario"]["estado"], "nao_provado")
        self.assertEqual(rec["diario"]["sobrando"], 1)
        self.assertIn("diario_d1: conjunto_divergente", rec["not_covered"])
        self.assertFalse(any(x.startswith("copia_kv_para_neon:") for x in rec["not_covered"]), "lacunas independentes: a do KV sai com a própria prova")
        self.assertIsNone(rec["rpo_critico_medido_s"])

    def test_13_sem_token_ou_cadeia_adulterada_mantem_a_lacuna(self):
        sem = os.path.join(self.dir, "diario-sem-token.json")
        with open(sem, "w", encoding="utf-8") as f:
            json.dump({"schema": "zevanory.p20.diario-leitura.v1", "estado": "sem_token", "lido_em": NOW, "head": None, "rows": [], "consultas": 0, "motivo": "CF_TOKEN_D1_DIARIO_READ ausente"}, f)
        db = fresh("p20_drill_t13a")
        r, rec, _ = drill(self.fixture, db, diario=sem)
        self.assertEqual(rec["verdict"], "APROVADO")
        self.assertIn("diario_d1: token CF_TOKEN_D1_DIARIO_READ ausente no ensaio", rec["not_covered"])
        with open(self.diario, encoding="utf-8") as f:
            d = json.load(f)
        d["rows"][0]["payload_json"] = d["rows"][0]["payload_json"].replace("47", "48")
        bad = os.path.join(self.dir, "diario-adulterado.json")
        with open(bad, "w", encoding="utf-8") as f:
            json.dump(d, f)
        db = fresh("p20_drill_t13b")
        r, rec, _ = drill(self.fixture, db, diario=bad)
        self.assertEqual(rec["verdict"], "APROVADO")
        self.assertEqual(rec["diario"]["motivo"], "cadeia_quebrada")
        self.assertIn("diario_d1: cadeia_quebrada", rec["not_covered"])
        self.assertEqual(public_tables(db) > 0, True, "a restauração dos dados segue")
        self.assertEqual(sh(db, "select count(*) from information_schema.tables where table_name='p20_diario_reconstruido'").strip(), "0", "nada reaplicado de um diário adulterado")


if __name__ == "__main__":
    unittest.main(verbosity=2)
