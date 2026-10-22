"""Ensaio da restauração completa num PostgreSQL efêmero, com dados SINTÉTICOS (nenhum dado real).
Requer variáveis PG* apontando para um servidor descartável (o teste cria e apaga bancos próprios).
Prova: (1) origem com esquema real -> exportação idêntica à do Worker -> arquivo cifrado -> restauração em banco
vazio com contagem E hash de conteúdo por tabela; (2) recusa alvo não vazio; (3) recusa arquivo adulterado;
(4) tabelas de tempo de execução criadas com DDL lido do código do Worker; (5) esquema do Worker pronto."""
import json, os, subprocess, sys, tempfile, unittest, uuid
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "scripts", "ops"))
import backup_preserve_archive as bpa  # noqa: E402
import restore_new_database as rnd  # noqa: E402

PASS = "senha-sintetica-de-teste-com-mais-de-32-caracteres"
SKIP = not os.environ.get("PGHOST")

def sh(db, sql):
    env = dict(os.environ, PGDATABASE=db)
    r = subprocess.run(["psql", "-v", "ON_ERROR_STOP=1", "-X", "-qtA", "-f", "-"], input=sql, capture_output=True, text=True, env=env)
    if r.returncode: raise AssertionError(r.stderr[:500])
    return r.stdout

def fresh(name):
    sh("postgres", f"drop database if exists {name}; create database {name};"); return name

def build_source(db):
    env = dict(os.environ, PGDATABASE=db)
    rnd.restore_full.__globals__  # garante import
    for m in rnd.migration_manifest()[0]:
        sh(db, open(os.path.join(ROOT, "db", "migrations", m), encoding="utf-8-sig").read())
    sh(db, "\n".join(rnd.runtime_ddl()[1] + rnd.dynamic_ddl()))
    # Tabela LEGADA que nenhum código atual cria (como zpc_records em produção): deve ser preservada.
    sh(db, "create table zpc_records(id text primary key, payload jsonb, at timestamptz default now()); "
           "insert into zpc_records(id,payload) values ('a','{\"k\":1}'),('b','{\"k\":\"ç\"}');")
    o1, o2 = str(uuid.uuid4()), str(uuid.uuid4())
    sh(db, f"""insert into orders(order_id,request_id,session_id,experiment_id,offer_id,amount,currency,provider,external_reference,status) values
      ('{o1}','{uuid.uuid4()}','{uuid.uuid4()}','exp','ZEV-1',47,'BRL','mercadopago','ref-{o1}','paid'),
      ('{o2}','{uuid.uuid4()}','{uuid.uuid4()}','exp','ZEV-2',97.5,'BRL','asaas','ref-{o2}','checkout_ready');
      insert into financial_events(provider_event_id,provider,provider_payment_id,normalized_event,provider_event_name,provider_status,external_reference,amount,order_id)
        values ('mp:1:approved:0','mercadopago','1','payment_confirmed','payment.updated','approved','ref-{o1}',47,'{o1}');
      insert into service_fulfillment(fulfillment_id,order_id,status,delivery_mode,evidence_ref) values ('{uuid.uuid4()}','{o1}','delivered','digital','{{"email_status":"sent","nota":"acentuação ç \\" aspas"}}');
      insert into inbound_followups(followup_key,kind,subject_ref,recipient_hash) values ('cart:x','cart_recovery','x','h');
      insert into knowledge_documents(document_id,namespace,title,content) values (gen_random_uuid(),'suporte','Guia de preços','Conteúdo ç');
      insert into whatsapp_stage_events(store_key,store_value) values ('whatsapp:instant:1','{{"sent":true}}');
      insert into zevanory_kv_backup(snapshot_day,key,value,sha256) values ('2026-10-14','sales:open:v1','{{"enabled":false}}','abc');""")
    # Exportação idêntica à do Worker (data-backup.mjs): json_agg por tabela, 3 partes, sem tabelas sensíveis.
    names = sh(db, "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' and table_name <> 'zevanory_kv_backup_unused' order by 1").split()
    names = [n for n in names if not bpa.re.search(r"credential|oauth|secret|token|password", n)]
    parts = {0: {}, 1: {}, 2: {}}
    for i, t in enumerate(names):
        js = sh(db, f"select coalesce(json_agg(x), '[]'::json)::text from public.\"{t}\" x").strip()
        if t == "knowledge_documents":
            # Simula produção: tsvector gerado por outra versão do dicionário (run real 39500283679).
            rows = json.loads(js)
            for r in rows: r["search_vector"] = "'outra':1 'versao':2"
            js = json.dumps(rows, ensure_ascii=False)
        parts[i % 3][t] = js
    raw = {p: json.dumps(v, separators=(",", ":")).encode() for p, v in parts.items()}
    return raw

def write_archive(raw, out, tamper=False):
    tables = bpa.describe_bundles(raw)
    plaintext = json.dumps({"schema": "zevanory-backup-archive/v1", "day": "2026-10-14", "parts": {str(p): b.decode() for p, b in raw.items()}}, separators=(",", ":")).encode()
    blob = bpa.encrypt(plaintext, PASS)
    if tamper: blob = blob[:-1] + bytes([blob[-1] ^ 1])
    m = bpa.build_manifest("2026-10-14", raw, tables, blob, plaintext, {})
    os.makedirs(out, exist_ok=True)
    open(os.path.join(out, "archive.enc"), "wb").write(blob); json.dump(m, open(os.path.join(out, "manifest.json"), "w"))
    return tables

@unittest.skipIf(SKIP, "PGHOST ausente (PostgreSQL descartável necessário)")
class T(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ["BACKUP_ARCHIVE_PASSPHRASE"] = PASS
        cls.raw = build_source(fresh("rnd_origem"))
        cls.dir = tempfile.mkdtemp(); cls.tables = write_archive(cls.raw, cls.dir)

    def run_rehearse(self, db, out):
        os.environ["PGDATABASE"] = db
        try: return rnd.main(["rehearse", "--out", out])
        finally: os.environ.pop("PGDATABASE", None)

    def test_1_restauracao_completa_contagem_hash_e_esquema(self):
        db = fresh("rnd_alvo1")
        self.assertEqual(self.run_rehearse(db, self.dir), 0)
        for t, meta in self.tables.items():
            schema = "zevanory_restore_preservado" if t == "zpc_records" else "public"
            self.assertEqual(int(sh(db, f'select count(*) from {schema}."{t}"').strip()), meta["rows"], t)
        self.assertIn("aspas", sh(db, "select evidence_ref from service_fulfillment").strip())
        self.assertEqual(sh(db, "select count(*) from schema_migrations").strip(), str(len(rnd.migration_manifest()[0])))
        self.assertEqual(len(rnd.migration_manifest()[0]), 31, "manifesto explícito: 30 migrações anteriores + 030_waitlist_fase_a")
        for t in ["waitlist_signups", "waitlist_persons", "waitlist_person_alias", "waitlist_person_days", "waitlist_raw_daily"]:
            self.assertEqual(sh(db, f"select to_regclass('public.{t}') is not null").strip(), "t", t)
        self.assertEqual(sh(db, "select count(*) from public.whatsapp_stage_events").strip(), "1", "DDL dinâmico do Worker")
        self.assertNotIn("outra", sh(db, "select search_vector::text from knowledge_documents"), "coluna gerada recalculada, não copiada")
        self.assertEqual(sh(db, "select count(*) from zevanory_restore_preservado.zpc_records").strip(), "2", "legado preservado")
        self.assertEqual(sh(db, "select count(*) from information_schema.tables where table_schema='public' and table_name='zpc_records'").strip(), "0")

    def test_2_recusa_alvo_nao_vazio(self):
        db = fresh("rnd_alvo2"); sh(db, "create table qualquer(x int);")
        with self.assertRaises(SystemExit): self.run_rehearse(db, self.dir)
        self.assertEqual(sh(db, "select count(*) from information_schema.tables where table_schema='public'").strip(), "1", "nada foi criado")

    def test_3_recusa_arquivo_adulterado(self):
        d = tempfile.mkdtemp(); write_archive(self.raw, d, tamper=True)
        db = fresh("rnd_alvo3")
        with self.assertRaises(SystemExit): self.run_rehearse(db, d)
        self.assertEqual(sh(db, "select count(*) from information_schema.tables where table_schema='public'").strip(), "0")

    def test_4b_ddl_dinamico_capturado_executando_o_modulo(self):
        stmts = rnd.dynamic_ddl()
        for t in ["whatsapp_stage_events", "whatsapp_observations", "whatsapp_evidence", "whatsapp_history"]:
            self.assertTrue(any(s.startswith(f"create table if not exists {t} (") for s in stmts), t)

    def test_4_ddl_de_tempo_de_execucao_vem_do_codigo_do_worker(self):
        names, stmts = rnd.runtime_ddl()
        for t in ["inbound_followups", "zevanory_leads", "zevanory_funnel_daily", "zevanory_kv_backup", "refund_provider_claims"]:
            self.assertIn(t, names)
        self.assertTrue(any("subject_ref" in s and s.lower().startswith("alter table zevanory_leads") for s in stmts))

    def test_5_confirmacao_exata_para_banco_real(self):
        with self.assertRaises(SystemExit): rnd.main(["restore", "--out", self.dir, "--confirm", "restaurar"])

    def test_6_erro_do_banco_nunca_vaza_dado_para_o_log(self):
        import contextlib, io
        db = fresh("rnd_vazamento"); sh(db, "create table t(v text primary key); insert into t values ('SEGREDO-DE-LINHA-123');")
        env = dict(os.environ, PGDATABASE=db); buf = io.StringIO()
        with contextlib.redirect_stdout(buf), self.assertRaises(SystemExit):
            rnd.psql("insert into t values ('SEGREDO-DE-LINHA-123');", env)
        out = buf.getvalue()
        self.assertIn("sqlstate=23505", out)
        self.assertNotIn("SEGREDO", out); self.assertNotIn("duplicate", out.lower())
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), self.assertRaises(SystemExit):
            rnd.psql("select 1/0 from t where v = 'OUTRO-SEGREDO';", env)
        self.assertNotIn("SEGREDO", buf.getvalue()); self.assertIn("sqlstate=22012", buf.getvalue())

    def test_7_manifesto_exato_de_migracoes(self):
        import shutil
        tmp = tempfile.mkdtemp(); shutil.copytree(os.path.join(ROOT, "db"), os.path.join(tmp, "db"))
        old = rnd.ROOT
        try:
            rnd.ROOT = tmp
            self.assertEqual(len(rnd.migration_manifest()[0]), 31)
            open(os.path.join(tmp, "db", "migrations", "031_nao_listada.sql"), "w").write("select 1;")
            with self.assertRaises(SystemExit): rnd.migration_manifest()
            os.remove(os.path.join(tmp, "db", "migrations", "031_nao_listada.sql"))
            os.remove(os.path.join(tmp, "db", "migrations", "030_waitlist_fase_a.sql"))
            with self.assertRaises(SystemExit): rnd.migration_manifest()
        finally:
            rnd.ROOT = old

    def test_8_migracao_030_aplica_reverte_e_reaplica(self):
        db = fresh("rnd_rollback030")
        for m in rnd.migration_manifest()[0]:
            sh(db, open(os.path.join(ROOT, "db", "migrations", m), encoding="utf-8-sig").read())
        tabs = ["waitlist_signups", "waitlist_persons", "waitlist_person_alias", "waitlist_person_days", "waitlist_raw_daily"]
        q = "select count(*) from information_schema.tables where table_schema='public' and table_name in (" + ",".join(f"'{t}'" for t in tabs) + ")"
        self.assertEqual(sh(db, q).strip(), "5")
        sh(db, "insert into waitlist_raw_daily(day,niche,metric,n) values (current_date,'confeitaria','recebidas',1)")
        sh(db, open(os.path.join(ROOT, "db", "rollback", "030_waitlist_fase_a.down.sql"), encoding="utf-8").read())
        self.assertEqual(sh(db, q).strip(), "0")
        self.assertEqual(sh(db, "select count(*) from schema_migrations where migration_id='030_waitlist_fase_a'").strip(), "0")
        self.assertEqual(sh(db, "select count(*) from schema_migrations").strip(), "30", "reversão só remove a 030")
        sh(db, open(os.path.join(ROOT, "db", "migrations", "030_waitlist_fase_a.sql"), encoding="utf-8").read())
        sh(db, open(os.path.join(ROOT, "db", "migrations", "030_waitlist_fase_a.sql"), encoding="utf-8").read())
        self.assertEqual(sh(db, q).strip(), "5", "reaplicação idempotente")

if __name__ == "__main__":
    unittest.main(verbosity=2)
