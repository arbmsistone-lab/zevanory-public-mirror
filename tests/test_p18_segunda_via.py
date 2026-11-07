"""P18 segunda via (Supabase pg_cron + pg_net), testada num PostgreSQL comum com imitações de pg_net/pg_cron/Vault
(tests/fixtures/p18-segunda-via/supabase_stubs.sql) e relógio simulado (p18sv.tick(p_now)). Sem rede.

Requer variáveis PG* apontando para um servidor descartável (o teste cria e apaga bancos p18sv_t*); sem PGHOST, pula
(o workflow p18-second-monitor-tests exige zero pulados). Prova, com tempos medidos no relógio simulado:
(1) desligado não sonda; (2) operação saudável sem incidente, orçamento de requisições e nada além de GET;
(3) queda logo depois de uma rodada: e-mail pedido e aceito em <= 600 s (pior caso com resposta 503 e sem resposta);
(4) falha isolada não alerta; (5) recuperação com um único e-mail; (6) lembrete a cada 6 h; (7) ensaio [ENSAIO] com
tempos e recuperação; (8) canal sem chave/destinatário registra erro e não faz POST; (9) monitor primário parado vira
incidente próprio; (10) mudança da trava gera aviso; (11) sales_mode desconhecido, health ready=false, página sem
marca e JSON quebrado contam como queda; (12) a chave do Resend só vai no cabeçalho do POST ao Resend e nunca é
gravada em p18sv; (13) dois ticks no mesmo instante não duplicam a rodada; (14) agendar recusa canal não configurado;
desligar remove o job."""
import datetime, json, os, subprocess, unittest, uuid

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
SQL = os.path.join(ROOT, "ops", "p18-segunda-via", "supabase")
STUBS = os.path.join(HERE, "fixtures", "p18-segunda-via", "supabase_stubs.sql")
SKIP = not os.environ.get("PGHOST")
T0 = datetime.datetime(2026, 11, 8, 12, 0, 0, tzinfo=datetime.timezone.utc)
FAKE_RESEND = "sintetico-p18sv-" + "0" * 8  # valor SINTÉTICO de teste, nunca uma chave real
HEALTH, RELEASE, SALES = "https://zevanory.api.br/api/health", "https://zevanory.api.br/api/release", "https://vendas.zevanory.api.br/"
PRIMARY = "https://raw.githubusercontent.com/arbmsistone-lab/zevanory-public-mirror/evidence/b0-baseline/p18/heartbeat.json"
RESEND = "https://api.resend.com/emails"


def psql(db, sql):
    env = dict(os.environ, PGDATABASE=db)
    r = subprocess.run(["psql", "-v", "ON_ERROR_STOP=1", "-X", "-qtA", "-f", "-"], input=sql, capture_output=True, text=True, env=env)
    if r.returncode:
        raise AssertionError(r.stderr[:800])
    return r.stdout.strip()


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


class Sim:
    """Relógio simulado + rede falsa: cada pedido pendente recebe a resposta de `net` 1 s depois do tick que o criou."""

    def __init__(self, test, configure=True):
        self.db = "p18sv_t" + uuid.uuid4().hex[:10]
        psql("postgres", f"create database {self.db};")
        test.addCleanup(psql, "postgres", f"drop database if exists {self.db} with (force);")
        psql(self.db, read(STUBS))
        psql(self.db, read(os.path.join(SQL, "001_p18_segunda_via.sql")))
        self.t = 0
        self.handled = set()
        self.net = self.good
        if configure:
            psql(self.db, f"insert into vault.decrypted_secrets values ('p18sv_resend_api_key', '{FAKE_RESEND}');"
                          "update p18sv.config set alert_to = '{dono@example.invalid}' where id = 1;")
            psql(self.db, read(os.path.join(SQL, "002_agendar.sql")))

    def now(self):
        return T0 + datetime.timedelta(seconds=self.t)

    def good(self, method, url):
        if method == "POST" and url == RESEND:
            return 200, '{"id":"sintetico"}'
        return {HEALTH: (200, '{"ready":true,"live":true}'), RELEASE: (200, '{"sales_mode":"globally-blocked"}'),
                SALES: (200, "<html><title>ZEVANORY</title></html>"),
                PRIMARY: (200, json.dumps({"schema": "zevanory.p18.heartbeat.v1", "last_success_at": iso(self.now() - datetime.timedelta(seconds=90))}))}[url]

    def tick(self):
        out = json.loads(psql(self.db, f"select p18sv.tick('{iso(self.now())}');"))
        pend = psql(self.db, "select id, method, url from net._stub_requests order by id;")
        for line in filter(None, pend.splitlines()):
            rid, method, url = line.split("|", 2)
            if rid in self.handled:
                continue
            self.handled.add(rid)
            resp = self.net(method, url)
            if resp is None:
                continue  # sem resposta (fila perdida / pendurado): o monitor precisa perceber sozinho
            status, body = resp
            when = iso(self.now() + datetime.timedelta(seconds=1))
            psql(self.db, f"insert into net._http_response (id, status_code, content, timed_out, created) values ({rid}, {status}, $b${body}$b$, false, '{when}');")
        return out

    def run(self, seconds, step=60):
        end = self.t + seconds
        while self.t < end:
            self.tick()
            self.t += step

    def q(self, sql):
        return psql(self.db, sql)

    def alerts(self):
        return [tuple(l.split("|")) for l in filter(None, self.q("select kind, subject, coalesce(error,'') from p18sv.alert order by id;").splitlines())]


def outage(sim, targets, status=503, body='{"error":"down"}', none=False):
    base = sim.net

    def f(method, url):
        if url in targets:
            return None if none else (status, body)
        return base(method, url)
    sim.net = f
    return base


@unittest.skipIf(SKIP, "sem PGHOST")
class SegundaVia(unittest.TestCase):
    def test_01_desligado_nao_sonda(self):
        s = Sim(self, configure=False)
        self.assertEqual(s.tick(), {"state": "disabled"}, "[P18SV.1] desligado")
        self.assertEqual(s.q("select count(*) from net._stub_requests;"), "0", "[P18SV.1] nenhuma sondagem")
        self.assertEqual(s.q("select ticks from p18sv.heartbeat;"), "1", "[P18SV.1] batimento conta mesmo desligado")

    def test_02_saudavel_orcamento_e_somente_get(self):
        s = Sim(self)
        s.run(3600)  # 1 h, tick por minuto
        self.assertEqual(s.q("select count(*) from p18sv.incident;"), "0", "[P18SV.2] nenhum incidente")
        self.assertEqual(s.q("select count(*) from p18sv.round;"), "30", "[P18SV.2] 1 rodada a cada 120 s")
        self.assertEqual(s.q("select count(*) from net._stub_requests where url like 'https://%zevanory.api.br/%';"), "90", "[P18SV.2] 3 GET por rodada na Cloudflare")
        self.assertEqual(s.q("select count(*) from net._stub_requests where method <> 'GET';"), "0", "[P18SV.2] nada além de GET")
        self.assertEqual(s.q("select count(*) from net._stub_requests where headers ? 'Authorization' or headers ? 'Cookie';"), "0", "[P18SV.2] sem credencial nas sondagens")
        self.assertEqual(s.q("select sales_mode from (select last_value as sales_mode from p18sv.state where check_name='sales_mode') x;"), "globally-blocked", "[P18SV.2] trava lida")
        self.assertEqual(s.q("select ticks from p18sv.heartbeat;"), "60", "[P18SV.2] batimento a cada tick")

    def _down_case(self, none):
        s = Sim(self)
        s.run(600)                 # 10 min saudáveis; rodadas em t=0,120,...,480; próxima em 600
        s.tick(); s.t += 1         # tick t=600 dispara a rodada; a queda começa 1 s DEPOIS (pior caso)
        start = s.t
        outage(s, {HEALTH, RELEASE, SALES}, none=none)
        s.t = 660
        s.run(900)
        row = s.q("select confirmed_at, alert_requested_at, alert_accepted_at from p18sv.incident where check_name='availability';").split("|")
        self.assertTrue(all(row), "[P18SV.3] incidente confirmado e e-mail aceito: " + str(row))
        req = (datetime.datetime.fromisoformat(row[1]) - (T0 + datetime.timedelta(seconds=start))).total_seconds()
        acc = (datetime.datetime.fromisoformat(row[2]) - (T0 + datetime.timedelta(seconds=start))).total_seconds()
        self.assertLessEqual(acc, 600, f"[P18SV.3] e-mail aceito {acc:.0f} s depois do início real da queda (alvo <= 600)")
        self.assertEqual(s.q("select dentro_de_10_min from p18sv.incident_report where check_name='availability';"), "t", "[P18SV.3] relatório marca dentro de 10 min")
        downs = [a for a in s.alerts() if a[0] == "down"]
        self.assertEqual(len(downs), 1, "[P18SV.3] um único e-mail de queda")
        self.assertIn("[P18-2ª via] Vendas/API fora do ar", downs[0][1], "[P18SV.3] assunto")
        post = s.q("select count(*) from net._stub_requests where method='POST' and url = 'https://api.resend.com/emails';")
        self.assertEqual(post, "1", "[P18SV.3] POST só para o Resend")
        print(f"P18SV_MEASURE caso={'sem_resposta' if none else 'http_503'} pedido_s={req:.0f} aceito_s={acc:.0f} alvo_s=600")
        return req, acc

    def test_03a_queda_503_alerta_em_ate_10_min(self):
        req, acc = self._down_case(none=False)
        self.assertLessEqual(req, 360, f"[P18SV.3] pedido do e-mail {req:.0f} s após a queda (desenho: <= ~300 s)")

    def test_03b_queda_sem_resposta_alerta_em_ate_10_min(self):
        req, acc = self._down_case(none=True)
        self.assertLessEqual(req, 420, f"[P18SV.3] pedido do e-mail {req:.0f} s após a queda sem resposta (desenho: <= ~360 s)")

    def test_04_falha_isolada_nao_alerta(self):
        s = Sim(self)
        s.run(240)
        good = outage(s, {RELEASE})
        s.run(120)                # uma rodada ruim
        s.net = good
        s.run(600)
        self.assertEqual(s.q("select count(*) from p18sv.incident where check_name='availability';"), "1", "[P18SV.4] incidente aberto pela falha")
        self.assertEqual(s.q("select count(*) from p18sv.incident where confirmed_at is not null;"), "0", "[P18SV.4] não confirmado")
        self.assertEqual(s.alerts(), [], "[P18SV.4] nenhum e-mail")
        self.assertEqual(s.q("select count(*) from p18sv.incident where recovered_at is null;"), "0", "[P18SV.4] fechado na rodada boa")

    def test_05_recuperacao_um_email(self):
        s = Sim(self)
        s.run(240)
        good = outage(s, {HEALTH})
        s.run(600)
        s.net = good
        s.run(900)
        kinds = [a[0] for a in s.alerts()]
        self.assertEqual(kinds, ["down", "recovery"], "[P18SV.5] queda e recuperação, um de cada")
        r = s.q("select recovered_at is not null, recovery_alert_accepted_at is not null from p18sv.incident;")
        self.assertEqual(r, "t|t", "[P18SV.5] recuperação registrada e e-mail aceito")

    def test_06_lembrete_a_cada_6h(self):
        s = Sim(self)
        s.run(240)
        outage(s, {SALES})
        s.run(7 * 3600, step=120)
        kinds = [a[0] for a in s.alerts()]
        self.assertEqual(kinds.count("down"), 1, "[P18SV.6] uma queda")
        self.assertEqual(kinds.count("reminder"), 1, "[P18SV.6] um lembrete em 7 h")

    def test_07_ensaio_mede_tempos(self):
        s = Sim(self)
        s.run(300)
        s.t = 330
        msg = s.q(f"select p18sv.drill_start(6, '{iso(s.now())}');")
        self.assertIn("ensaio de 6 min", msg, "[P18SV.7] ensaio iniciado")
        s.t = 360
        s.run(1500)
        r = s.q("select drill, alerta_aceito_s, dentro_de_10_min, recovered_at is not null, recovery_alert_accepted_at is not null from p18sv.incident_report where check_name='availability';")
        self.assertEqual(len(r.split("|")), 5, "[P18SV.7] incidente do ensaio registrado: " + r)
        drill, acc, ok10, rec, recmail = r.split("|")
        print(f"P18SV_MEASURE caso=ensaio aceito_s={acc} alvo_s=600")
        self.assertEqual(drill, "t", "[P18SV.7] incidente marcado como ensaio")
        self.assertLessEqual(int(acc), 600, f"[P18SV.7] e-mail aceito {acc} s após o início do ensaio")
        self.assertEqual((ok10, rec, recmail), ("t", "t", "t"), "[P18SV.7] dentro de 10 min, recuperado, e-mail de recuperação aceito")
        subj = [a[1] for a in s.alerts()]
        self.assertTrue(subj and all(x.startswith("[ENSAIO] ") for x in subj), "[P18SV.7] todo e-mail do ensaio leva [ENSAIO]: " + str(subj))
        with self.assertRaises(AssertionError, msg="[P18SV.7] duração fora de 4..30 recusada"):
            s.q(f"select p18sv.drill_start(60, '{iso(s.now())}');")

    def test_08_canal_nao_configurado(self):
        s = Sim(self, configure=False)
        s.q("update p18sv.config set enabled = true where id = 1;")
        s.run(120)
        outage(s, {HEALTH})
        s.run(600)
        self.assertEqual(s.alerts(), [("down", "[P18-2ª via] Vendas/API fora do ar", "not_configured:secret")], "[P18SV.8] erro registrado")
        self.assertEqual(s.q("select count(*) from net._stub_requests where method='POST';"), "0", "[P18SV.8] nenhum POST sem chave")
        self.assertEqual(s.q("select (p18sv.status()->'last_result'->>'alert_errors_24h');"), "1", "[P18SV.8] erro visível no status")

    def test_09_monitor_primario_parado(self):
        s = Sim(self)
        s.run(240)
        base = s.net
        s.net = lambda m, u: (200, json.dumps({"schema": "zevanory.p18.heartbeat.v1", "last_success_at": iso(T0 - datetime.timedelta(hours=6))})) if u == PRIMARY else base(m, u)
        s.run(600)
        self.assertEqual([a[1] for a in s.alerts()], ["[P18-2ª via] Monitor primário (GitHub) parado"], "[P18SV.9] alerta próprio do primário")
        self.assertEqual(s.q("select count(*) from p18sv.incident where check_name='availability';"), "0", "[P18SV.9] disponibilidade não confundida")
        self.assertEqual(s.q("select reasons->0->>'reason' from p18sv.incident where check_name='primary';"), "primary_stale", "[P18SV.9] motivo")

    def test_10_mudanca_da_trava_avisa(self):
        s = Sim(self)
        s.run(240)
        base = s.net
        s.net = lambda m, u: (200, '{"sales_mode":"enabled"}') if u == RELEASE else base(m, u)
        s.run(600)
        info = [a for a in s.alerts() if a[0] == "info"]
        self.assertEqual(len(info), 1, "[P18SV.10] um aviso de mudança")
        self.assertIn("globally-blocked -> enabled", info[0][1], "[P18SV.10] de -> para")

    def test_11_200_sem_conteudo_valido_conta_como_queda(self):
        cases = {RELEASE: (200, '{"sales_mode":"ENABLED"}'), HEALTH: (200, '{"ready":false}'), SALES: (200, "<html>Bad gateway</html>")}
        for url, resp in cases.items():
            s = Sim(self)
            s.run(240)
            base = s.net
            s.net = lambda m, u, url=url, resp=resp: resp if u == url else base(m, u)
            s.run(600)
            self.assertEqual([a[0] for a in s.alerts()], ["down"], "[P18SV.11] 200 inválido vira queda: " + url)
        self.assertEqual(psql("postgres", "select 1;"), "1")
        s = Sim(self)
        for body, want in [("{", "not_json"), ('{"sales_mode":"x"}', "sales_mode_unknown")]:
            self.assertEqual(s.q(f"select reason from p18sv.evaluate('release', 200, $b${body}$b$, false, null, now(), 1200);"), want, "[P18SV.11] " + want)
        self.assertEqual(s.q("select reason from p18sv.evaluate('health', 200, null, true, null, now(), 1200);"), "timeout", "[P18SV.11] timeout")
        self.assertEqual(s.q("select reason from p18sv.evaluate('primary', 200, '{\"schema\":\"zevanory.p18.heartbeat.v1\",\"last_success_at\":\"2999-01-01T00:00:00Z\"}', false, null, now(), 1200);"), "primary_future", "[P18SV.11] batimento no futuro")

    def test_12_chave_nunca_gravada(self):
        s = Sim(self)
        s.run(240)
        outage(s, {HEALTH})
        s.run(600)
        dump = s.q("select string_agg(t::text, ' ') from (select to_jsonb(x) t from p18sv.alert x union all select to_jsonb(y) from p18sv.incident y "
                   "union all select to_jsonb(z) from p18sv.probe z union all select to_jsonb(c) from p18sv.config c union all select to_jsonb(h) from p18sv.heartbeat h) u;")
        self.assertNotIn(FAKE_RESEND, dump, "[P18SV.12] chave fora de p18sv")
        auth = s.q("select url || ' ' || (headers->>'Authorization') from net._stub_requests where headers ? 'Authorization';")
        self.assertEqual(auth, RESEND + " Bearer " + FAKE_RESEND, "[P18SV.12] chave só no POST ao Resend")

    def test_13_tick_repetido_nao_duplica(self):
        s = Sim(self)
        s.tick(); s.tick()
        self.assertEqual(s.q("select count(*) from p18sv.round;"), "1", "[P18SV.13] uma rodada")
        self.assertEqual(s.q("select count(*) from net._stub_requests;"), "4", "[P18SV.13] quatro GET")

    def test_14_agendar_e_desligar(self):
        s = Sim(self, configure=False)
        agendar = read(os.path.join(SQL, "002_agendar.sql"))
        s.q(f"insert into vault.decrypted_secrets values ('p18sv_resend_api_key', '{FAKE_RESEND}');")
        with self.assertRaises(AssertionError, msg="[P18SV.14] agendar sem destinatário recusado"):
            s.q(agendar)
        self.assertEqual(s.q("select count(*) || ' ' || (select enabled::text from p18sv.config) from cron.job;"), "0 false", "[P18SV.14] sem destinatário nada agendado")
        s.q("update p18sv.config set alert_to = '{dono@example.invalid}' where id = 1; delete from vault.decrypted_secrets;")
        with self.assertRaises(AssertionError, msg="[P18SV.14] agendar sem segredo recusado"):
            s.q(agendar)
        self.assertEqual(s.q("select count(*) || ' ' || (select enabled::text from p18sv.config) from cron.job;"), "0 false", "[P18SV.14] sem segredo nada agendado")
        s.q(f"insert into vault.decrypted_secrets values ('p18sv_resend_api_key', '{FAKE_RESEND}');")
        s.q(agendar)
        self.assertEqual(s.q("select jobname || ' ' || schedule from cron.job;"), "p18sv-tick * * * * *", "[P18SV.14] 1 job por minuto")
        s.q(read(os.path.join(SQL, "003_desligar.sql")))
        self.assertEqual(s.q("select count(*) || ' ' || (select enabled::text from p18sv.config) from cron.job;"), "0 false", "[P18SV.14] desligado")


if __name__ == "__main__":
    unittest.main()
