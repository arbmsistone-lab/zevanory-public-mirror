// P01 Fase A (AVAL 085): SQL REAL de worker/waitlist.mjs + migração 030 contra PostgreSQL efêmero
// (dados sintéticos, sem rede). Pulado sem WAITLIST_PG_HOST; o workflow exige "# skipped 0".
// WAITLIST_MODULE / WAITLIST_MIGRATION permitem ao executor de mutantes trocar módulo e migração.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolvePsql, parseCsv } from "../../scripts/fase_a/tools.mjs";
import { TEST_LIA, TEST_ROPA, TEST_DOCS, APPROVED_ENV, manifestOf, APPROVED_TEXT } from "./lia-fixture.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const MOD = pathToFileURL(path.resolve(process.env.WAITLIST_MODULE || path.join(ROOT, "worker", "waitlist.mjs"))).href;
const MIGRATION = path.resolve(process.env.WAITLIST_MIGRATION || path.join(ROOT, "db", "migrations", "030_waitlist_fase_a.sql"));
const W = await import(MOD);
const MOD_DIR = path.dirname(fileURLToPath(MOD));
const { LIA_FASE_A: REAL_LIA, ROPA_FASE_A: REAL_ROPA } = await import(pathToFileURL(path.join(MOD_DIR, "fase-a-lia.generated.mjs")).href);
const HOST = process.env.WAITLIST_PG_HOST;
const PORT = process.env.WAITLIST_PG_PORT || "5432";
const DB = process.env.WAITLIST_PG_DB || "postgres";
const skip = !HOST && "WAITLIST_PG_HOST not set";
const PSQL = HOST ? resolvePsql() : "psql";

const lit = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return "'{" + v.map((x) => (x === null ? "NULL" : '"' + String(x).replace(/["\\]/g, "\\$&") + '"')).join(",") + "}'";
  return "'" + String(v).replace(/'/g, "''") + "'";
};
function psql(sqlText, { file = false } = {}) {
  const args = ["-h", HOST, "-p", PORT, "-U", "postgres", "-d", DB, "-X", "-q", "-v", "ON_ERROR_STOP=1", "--csv", ...(file ? ["-f", sqlText] : ["-c", sqlText])];
  const r = spawnSync(PSQL, args, { encoding: "utf8", env: { ...process.env, PGCLIENTENCODING: "UTF8" } });
  if (r.status !== 0) throw new Error("psql: " + String(r.stderr).slice(0, 400));
  return parseCsv(r.stdout).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v === "" ? null : v])));
}
const sqlFactory = () => ({ query: async (text, params = []) => psql(text.replace(/\$(\d+)/g, (_, n) => lit(params[Number(n) - 1]))) });
const kv = () => { const m = new Map(); return { m, async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); } }; };
const T0 = Date.parse("2026-11-02T12:00:00Z"), DAY = 86_400_000;
const ENV = (o = {}) => ({ DATABASE_URL: "postgres://synthetic", FASE_A_WAITLIST: "on", LEAD_PRIVACY_SECRET: "k".repeat(40), WAITLIST_VISITOR_SECRET: "v".repeat(40),
  FASE_A_WINDOW_ID: "fa1", FASE_A_WINDOW_END: "2026-11-30", ...APPROVED_ENV, RESEND_API_KEY: "re_nao_e_fallback_123456789012345678901234", ZEVANORY_PRIVATE_ARTIFACTS: kv(), ...o });
const HUMAN = "Mozilla/5.0 (Linux; Android 14; SM-A146M) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";
// LIA e ROPA aprovados SINTÉTICOS (tests/fase-a/lia-fixture.mjs); o repositório continua com ambos pendentes.
const V = W.AVISO_VERSION;
const call = async (env, p, body, now = T0, docs = TEST_DOCS) => { const r = await W.handleWaitlist(new Request("https://waitlist.internal" + p, { method: "POST", body: JSON.stringify(body) }), env, { sqlFactory, now, docs }); return { status: r.status, body: r.status === 204 ? null : await r.json() }; };
// Visita: devolve o valor do cookie em uso (o recebido ou o novo emitido).
async function visit(env, o = {}, now = T0) {
  const r = await call(env, "/visita", { aviso: V, nicho: "confeitaria", method: "GET", ua: HUMAN, ip: "200.1.1.1", asn: 28573, ...o }, now);
  assert.equal(r.status, 200);
  return r.body.cookie ? r.body.cookie.value : o.vid || null;
}
const confirm = (env, vid, nicho = "confeitaria", now = T0) => call(env, "/confirmar", { nicho, vid }, now);
async function person(env, o = {}, now = T0) { const vid = await visit(env, o, now); await confirm(env, vid, o.nicho || "confeitaria", now); return vid; }
const sub = (env, o = {}, now = T0) => call(env, "/inscrever", { nicho: "confeitaria", contato: "ana@exemplo.com", q1: "sim", q2: "sim", consent: true, ua: HUMAN, asn: 28573, src: "youtube", ...o }, now);
const summary = (o = {}) => W.buildWaitlistSummary(sqlFactory(), { windowId: "fa1", ...o });
const TABLES = ["waitlist_signups", "waitlist_persons", "waitlist_person_alias", "waitlist_raw_daily", "waitlist_deletion_log"];
function reset({ migrate = true } = {}) {
  psql("drop table if exists " + [...TABLES, "waitlist_person_days"].join(", ")); // inclui a tabela pessoa-dia removida (v5)
  psql("create table if not exists schema_migrations (migration_id text primary key, applied_at timestamptz not null default now())");
  psql("delete from schema_migrations where migration_id = '030_waitlist_fase_a'");
  if (migrate) psql(MIGRATION, { file: true });
  W.resetWaitlistState?.();
}
const n = (q) => Number(psql(q)[0].n);

test("bandeira desligada: 404 e nada gravado", { skip }, async () => {
  reset();
  const env = ENV({ FASE_A_WAITLIST: undefined });
  assert.equal((await call(env, "/visita", { aviso: V, nicho: "confeitaria", method: "GET", ua: HUMAN })).status, 404);
  assert.equal((await sub(env)).status, 404);
  for (const t of TABLES) assert.equal(n(`select count(*)::int as n from ${t}`), 0, t);
});

test("fail-closed: sem migração 030 -> 503; sem chave de contato -> 503; o módulo não cria tabelas", { skip }, async () => {
  reset({ migrate: false });
  assert.equal((await sub(ENV())).status, 503);
  assert.equal((await call(ENV(), "/visita", { aviso: V, nicho: "confeitaria", method: "GET", ua: HUMAN, ip: "1.1.1.1" })).status, 503);
  assert.equal(psql("select to_regclass('waitlist_signups') is null as ausente")[0].ausente, "t", "módulo não cria esquema");
  reset();
  assert.equal((await sub(ENV({ LEAD_PRIVACY_SECRET: "" }))).status, 503);
  assert.equal(n("select count(*)::int as n from waitlist_signups"), 0);
});

test("segredo de visitante dedicado: ausente ou < 32 bytes NÃO usa fallback (RESEND/DATABASE_URL), nada é contado e a decisão é INCONCLUSIVO", { skip }, async () => {
  for (const secret of [undefined, "", "x".repeat(31)]) {
    reset();
    const env = ENV({ WAITLIST_VISITOR_SECRET: secret });
    const r = await call(env, "/visita", { aviso: V, nicho: "confeitaria", method: "GET", ua: HUMAN, ip: "200.1.1.1" });
    assert.equal(r.body.cookie, null, "sem cookie");
    assert.equal(n("select count(*)::int as n from waitlist_persons"), 0);
    const c = (await summary()).niches.confeitaria;
    assert.ok(c.blockers.includes("segredo_de_visitante_ausente"));
    assert.equal(c.decision, "INCONCLUSIVO");
    assert.equal(c.excluded.no_secret, 1);
  }
});

test("sem janela configurada: visita conta só no agregado, sem identificador, e a decisão é INCONCLUSIVO", { skip }, async () => {
  reset();
  const env = ENV({ FASE_A_WINDOW_END: undefined });
  const r = await call(env, "/visita", { aviso: V, nicho: "confeitaria", method: "GET", ua: HUMAN, ip: "200.1.1.1" });
  assert.equal(r.body.cookie, null);
  assert.equal(n("select count(*)::int as n from waitlist_persons"), 0);
  const c = (await summary()).niches.confeitaria;
  assert.equal(c.excluded.no_secret, 0);
  assert.ok(c.blockers.includes("identificador_nao_estabelecido"));
  assert.equal(c.decision, "INCONCLUSIVO");
  const expired = await call(ENV({ FASE_A_WINDOW_END: "2026-11-01" }), "/visita", { aviso: V, nicho: "confeitaria", method: "GET", ua: HUMAN, ip: "200.1.1.2" });
  assert.equal(expired.body.cookie, null, "janela vencida não emite identificador");
});

test("M-SOL-085: o MESMO navegador (mesmo cookie) em dois dias conta UMA vez; navegadores distintos contam separados", { skip }, async () => {
  reset();
  const env = ENV();
  // O navegador guarda o último cookie recebido e o devolve em cada pedido (como um navegador real).
  let vid = await person(env, {}, T0);
  assert.match(vid, /^[0-9a-f]{32}\.[0-9a-f]{32}$/);
  vid = await visit(env, { vid }, T0 + 3600_000);
  await confirm(env, vid, "confeitaria", T0 + 3600_000);
  vid = await visit(env, { vid }, T0 + DAY);
  await confirm(env, vid, "confeitaria", T0 + DAY);
  await person(env, { ip: "200.2.2.2" }, T0 + DAY);
  const c = (await summary()).niches.confeitaria;
  assert.equal(c.eligible_browsers, 2, "2 navegadores, não 3 visitas-dia");
  assert.equal(c.multi_day_browsers, 1);
  assert.equal(c.unit, "navegador_dispositivo_pseudonimo");
  assert.deepEqual(psql("select days from waitlist_persons where days > 1"), [{ days: "2" }]);
  assert.ok(c.oracle.ok, JSON.stringify(c.oracle.checks));
});

test("visitas sem devolver o cookie não inflam o denominador: 10 dias sem cookie = 10 identificadores não confirmados, 0 navegadores confirmados", { skip }, async () => {
  reset();
  const env = ENV();
  for (let d = 0; d < 10; d++) await visit(env, {}, T0 + d * DAY);
  const c = (await summary()).niches.confeitaria;
  assert.equal(c.eligible_browsers, 0);
  assert.equal(c.unconfirmed_ids, 10);
  assert.equal(c.decision, "INCONCLUSIVO");
  assert.equal(n("select count(*)::int as n from waitlist_persons where confirmed"), 0);
});

test("entre aparelhos: o mesmo contato inscrito de dois identificadores é UMA pessoa (alias) e UMA inscrição", { skip }, async () => {
  reset();
  const env = ENV();
  const phone = await person(env, { ip: "200.3.3.3" });
  const laptop = await person(env, { ip: "200.4.4.4", ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36" });
  assert.equal((await sub(env, { contato: "dois@exemplo.com", vid: phone })).body.code, "inscrito");
  assert.equal((await sub(env, { contato: "dois@exemplo.com", vid: laptop })).body.code, "ja_inscrito");
  const c = (await summary()).niches.confeitaria;
  assert.equal(c.aliases, 1);
  assert.equal(c.eligible_browsers, 1);
  assert.equal(c.signups, 1);
  assert.ok(c.oracle.ok, JSON.stringify(c.oracle.checks));
});

test("consentimento separado: a lista exige só o aviso; o convite para entrevista é opcional e gravado à parte", { skip }, async () => {
  reset();
  const env = ENV();
  const a = await person(env, { ip: "200.5.5.5" });
  const b = await person(env, { ip: "200.6.6.6" });
  assert.equal((await sub(env, { contato: "semconvite@exemplo.com", vid: a })).body.code, "inscrito");
  assert.equal((await sub(env, { contato: "comconvite@exemplo.com", vid: b, interview: true })).body.code, "inscrito");
  assert.deepEqual(psql("select contact, interview_ok, consent_version from waitlist_signups order by contact"), [
    { contact: "comconvite@exemplo.com", interview_ok: "t", consent_version: W.CONSENT_VERSION },
    { contact: "semconvite@exemplo.com", interview_ok: "f", consent_version: W.CONSENT_VERSION }]);
  for (const consent of [false, "sim", undefined]) assert.equal((await sub(env, { contato: "x@exemplo.com", consent, interview: true })).body.code, "consentimento");
  for (const [o, code] of [[{ contato: "123" }, "contato"], [{ q1: "" }, "perguntas"], [{ nicho: "academia" }, "nicho"]]) assert.equal((await sub(env, o)).body.code, code);
  assert.equal(n("select count(*)::int as n from waitlist_signups"), 2);
  assert.equal((await summary()).niches.confeitaria.interview_ok, 1);
});

test("idempotência por contato + nicho: repetição (outra grafia) não duplica nem conta duas vezes", { skip }, async () => {
  reset();
  const env = ENV();
  const vid = await person(env);
  assert.equal((await sub(env, { contato: " Ana@Exemplo.COM ", vid })).body.code, "inscrito");
  assert.equal((await sub(env, { contato: "ana@exemplo.com", vid, q1: "nao" })).body.code, "ja_inscrito");
  const w = await person(env, { ip: "200.7.7.7" });
  assert.equal((await sub(env, { contato: "(88) 99254-0000", vid: w })).body.code, "inscrito");
  assert.equal((await sub(env, { contato: "+55 88 99254-0000", vid: w })).body.code, "ja_inscrito");
  assert.equal(n("select count(*)::int as n from waitlist_signups"), 2);
  assert.equal(psql("select q_recurring from waitlist_signups where contact_kind='email'")[0].q_recurring, "t", "primeira inscrição preservada");
  const c = (await summary()).niches.confeitaria;
  assert.equal(c.signups, 2);
  assert.ok(c.oracle.ok, JSON.stringify(c.oracle.checks));
});

test("inscrição sem identificador: guardada para o aviso, fora do numerador, e a decisão vira INCONCLUSIVO", { skip }, async () => {
  reset();
  const env = ENV();
  await person(env);
  assert.equal((await sub(env, { contato: "semcookie@exemplo.com" })).body.code, "inscrito");
  assert.equal((await sub(env, { contato: "forjado@exemplo.com", vid: "a".repeat(32) + "." + "b".repeat(32) })).body.code, "inscrito");
  const c = (await summary()).niches.confeitaria;
  assert.equal(c.signups, 0);
  assert.equal(c.signups_without_id, 2);
  assert.ok(c.blockers.includes("inscricao_sem_identificador"));
  assert.equal(c.decision, "INCONCLUSIVO");
});

test("robôs fora do denominador e do numerador, com análise de sensibilidade com/sem filtros de ASN e UA", { skip }, async () => {
  reset();
  const env = ENV();
  const human = await person(env);
  const dc = await person(env, { ip: "3.3.3.3", asn: 16509 });
  const bot = await person(env, { ip: "66.249.66.1", ua: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" });
  assert.equal((await call(env, "/visita", { aviso: V, nicho: "confeitaria", method: "GET", ua: HUMAN, ip: "9.9.9.9", purpose: "prefetch" })).body.cookie, null, "prefetch sem identificador");
  await sub(env, { contato: "humano@exemplo.com", vid: human });
  await sub(env, { contato: "dc@exemplo.com", vid: dc, asn: 16509 });
  await sub(env, { contato: "bot@exemplo.com", vid: bot, ua: "python-requests/2.32" });
  const c = (await summary()).niches.confeitaria;
  assert.deepEqual([c.eligible_browsers, c.signups], [1, 1]);
  assert.deepEqual(c.sensitivity.with_filters, { browsers: 1, signups: 1, conversion: 1 });
  assert.deepEqual([c.sensitivity.without_asn_filter.browsers, c.sensitivity.without_asn_filter.signups], [2, 2]);
  assert.deepEqual([c.sensitivity.without_ua_filter.browsers, c.sensitivity.without_ua_filter.signups], [2, 2]);
  assert.deepEqual([c.sensitivity.without_filters.browsers, c.sensitivity.without_filters.signups], [3, 3]);
  assert.deepEqual([c.excluded.asn, c.excluded.ua, c.excluded.prefetch], [1, 1, 1]);
  assert.ok(c.oracle.ok, JSON.stringify(c.oracle.checks));
});

test("oráculo independente: contadores agregados reconciliam com as linhas; qualquer divergência vira INCONCLUSIVO", { skip }, async () => {
  reset();
  const env = ENV();
  const vids = [];
  for (let i = 0; i < 3; i++) vids.push(await person(env, { ip: "201.0.0." + i }));
  await sub(env, { contato: "o1@exemplo.com", vid: vids[0] });
  let c = (await summary()).niches.confeitaria;
  assert.ok(c.oracle.ok, JSON.stringify(c.oracle.checks));
  assert.equal(Object.keys(c.oracle.checks).length, 6);
  psql("delete from waitlist_persons where person_id = (select person_id from waitlist_persons where confirmed limit 1 offset 2)");
  c = (await summary()).niches.confeitaria;
  assert.equal(c.oracle.ok, false);
  assert.equal(c.oracle.checks.navegadores_linhas_igual_criados, false);
  assert.ok(c.blockers.includes("oraculo_divergente"));
  assert.equal(c.decision, "INCONCLUSIVO");
});

test("métricas: números corretos na mesma unidade, qualificadas = duas respostas sim, e NENHUM dado pessoal na saída", { skip }, async () => {
  reset();
  const env = ENV();
  const v = [];
  for (let i = 0; i < 10; i++) v.push(await person(env, { ip: "202.0.0." + i }));
  await sub(env, { contato: "d1@exemplo.com", nome: "Daniela Souza", vid: v[0], q1: "sim", q2: "sim" });
  await sub(env, { contato: "d2@exemplo.com", nome: "Eduardo", vid: v[1], q1: "sim", q2: "nao" });
  await sub(env, { contato: "(11) 98888-7777", vid: v[2], q1: "nao", q2: "sim" });
  const s = await summary();
  const c = s.niches.confeitaria;
  assert.deepEqual([c.unit, c.eligible_browsers, c.signups, c.qualified], ["navegador_dispositivo_pseudonimo", 10, 3, 1]);
  assert.equal(c.conversion, 0.3);
  assert.equal(c.decision, "INCONCLUSIVO", "menos de 300 pessoas nunca é NO-GO");
  const out = JSON.stringify(s);
  const rows = psql("select contact_ref, contact, person_id from waitlist_signups");
  for (const needle of [...rows.map((x) => x.contact_ref), ...rows.map((x) => x.contact), ...rows.map((x) => x.person_id), ...v.map((x) => x.slice(0, 32)), "Daniela", "Eduardo", "exemplo.com", "98888", "@"])
    assert.ok(!out.includes(needle), "vazou: " + needle);
});

test("saída: link assinado apaga TODAS as inscrições do contato numa instrução; nenhuma tabela guarda o contato ou sua referência depois", { skip }, async () => {
  reset();
  const env = ENV();
  const a = await person(env, { ip: "203.0.0.1" });
  const b = await person(env, { ip: "203.0.0.2", nicho: "salao-e-barbearia" });
  const first = await sub(env, { contato: "bia@exemplo.com", vid: a });
  await sub(env, { contato: "bia@exemplo.com", vid: b, nicho: "salao-e-barbearia" });
  await sub(env, { contato: "caio@exemplo.com" });
  const u = new URL(first.body.optout), r = u.searchParams.get("r"), t = u.searchParams.get("t");
  assert.equal((await call(env, "/sair", { r, t: t.replace(/^./, (x) => (x === "0" ? "1" : "0")) })).status, 400);
  assert.equal(n("select count(*)::int as n from waitlist_signups"), 3, "token inválido não apaga");
  const ok = await call(env, "/sair", { r, t });
  assert.deepEqual([ok.status, ok.body.erased], [200, 2]);
  assert.deepEqual(psql("select contact from waitlist_signups"), [{ contact: "caio@exemplo.com" }]);
  const refCols = psql("select table_name from information_schema.columns where table_schema='public' and column_name in ('contact','contact_ref','name') and table_name like 'waitlist%' group by table_name order by 1");
  assert.deepEqual(refCols, [{ table_name: "waitlist_signups" }], "só a tabela de inscrições tem colunas ligadas ao contato");
  for (const tbl of ["waitlist_raw_daily", "waitlist_persons", "waitlist_person_alias", "waitlist_deletion_log"]) {
    const dump = JSON.stringify(psql(`select * from ${tbl}`));
    assert.ok(!dump.includes(r) && !dump.includes("bia@"), tbl);
  }
  assert.equal(n("select coalesce(sum(n),0)::int as n from waitlist_raw_daily where metric='inscricao:revogada'"), 2, "contagem agregada = linhas apagadas");
  assert.equal((await call(env, "/sair", { r, t })).body.erased, 0);
  assert.ok((await summary()).niches.confeitaria.oracle.ok);
});

test("retenção (AVAL 101 §5): medição apagada no primeiro de encerramento sem continuidade, decisão + 30 dias ou janela + 60 dias (sem teto de 180); inscrições também por 12 meses; registro de exclusão sem dado pessoal; células pequenas suprimidas; sem uso, nenhuma consulta", { skip }, async () => {
  const seed = async (env) => { const vid = await person(env); await sub(env, { contato: "ret@exemplo.com", vid }); return vid; };
  const log = () => psql("select scope, trigger, n, result from waitlist_deletion_log order by id");
  // 1) Decisão + 30 dias.
  reset();
  const env = ENV({ FASE_A_DECISION_DATE: "2026-11-10" });
  await seed(env);
  const before = await W.runWaitlistRetention(env, { sqlFactory, now: Date.parse("2026-12-09T12:00:00Z"), force: true });
  assert.deepEqual([before.erased, before.measurement_erased, before.purpose_over, before.activation], [0, 0, false, "lia_pendente_de_revisao"], "29 dias depois: mantém (a retenção roda mesmo com a medição travada)");
  psql("insert into waitlist_raw_daily (day, niche, metric, n) values ('2026-11-05','confeitaria','celula:grande',7)");
  const done = await W.runWaitlistRetention(env, { sqlFactory, now: Date.parse("2026-12-10T12:00:00Z"), force: true });
  assert.deepEqual([done.erased, done.measurement_erased, done.purpose_over, done.trigger], [1, 1, true, "30_dias_apos_decisao"]);
  for (const t of ["waitlist_signups", "waitlist_persons", "waitlist_person_alias"]) assert.equal(n(`select count(*)::int as n from ${t}`), 0, t);
  assert.ok(done.aggregates_suppressed > 0, "contadores com 0 < n < 5 apagados ao fim da finalidade");
  assert.equal(n("select count(*)::int as n from waitlist_raw_daily where n > 0 and n < 5"), 0);
  assert.equal(n("select count(*)::int as n from waitlist_raw_daily where metric = 'celula:grande'"), 1, "agregado com n >= 5 permanece");
  const l = log();
  assert.deepEqual(l.filter((r) => r.n !== "0").map((r) => [r.scope, r.trigger, r.result]), [["inscricoes", "30_dias_apos_decisao", "ok"], ["medicao", "30_dias_apos_decisao", "ok"], ["agregados", "celula_pequena", "ok"]]);
  assert.ok(!JSON.stringify(l).includes("ret@") && Object.keys(l[0]).every((k) => ["scope", "trigger", "n", "result"].includes(k)), "registro sem dado pessoal");
  // 2) Encerrado sem continuidade (antes da decisão).
  reset();
  const env2 = ENV({ FASE_A_CLOSED_NO_CONTINUATION: "2026-11-05" });
  await seed(env2);
  const closed = await W.runWaitlistRetention(env2, { sqlFactory, now: Date.parse("2026-11-05T01:00:00Z"), force: true });
  assert.deepEqual([closed.erased, closed.measurement_erased, closed.trigger], [1, 1, "encerrado_sem_continuidade"]);
  // 3) 60 dias após o fim da janela de cada linha (sem decisão registrada): 59 dias mantém, 61 apaga; não há teto de 180.
  reset();
  const env3 = ENV();
  await seed(env3);
  assert.equal(psql("select window_end::text as w from waitlist_persons")[0].w, "2026-11-30");
  assert.equal((await W.runWaitlistRetention(env3, { sqlFactory, now: Date.parse("2027-01-28T12:00:00Z"), force: true })).measurement_erased, 0, "59 dias após a janela: mantém");
  const w60 = await W.runWaitlistRetention(env3, { sqlFactory, now: Date.parse("2027-01-30T12:00:00Z"), force: true });
  assert.deepEqual([w60.measurement_erased, w60.erased], [1, 0], "60 dias após a janela: apaga a medição; a inscrição segue até a decisão ou 12 meses");
  assert.deepEqual(log().filter((r) => r.scope === "medicao" && r.n !== "0").map((r) => r.trigger), ["60_dias_apos_janela"]);
  assert.deepEqual(Object.keys(W.RETENTION).sort(), ["afterDecisionDays", "afterWindowCloseDays", "cookieMaxDays", "signupMaxMonths"], "sem teto de 180 dias");
  // 4) Inscrição: 12 meses.
  psql("update waitlist_signups set created_at = now() - interval '13 months'");
  assert.equal((await W.runWaitlistRetention(env3, { sqlFactory, now: Date.now(), force: true })).erased, 1);
  assert.equal(await env3.ZEVANORY_PRIVATE_ARTIFACTS.get(W.SEEN_MARKER), "1");
  let queries = 0;
  const never = await W.runWaitlistRetention({ DATABASE_URL: "x", ZEVANORY_PRIVATE_ARTIFACTS: kv() }, { sqlFactory: () => ({ query: async () => { queries++; return []; } }), force: true });
  assert.deepEqual([never.skipped, queries], ["never_enabled", 0]);
});

test("script de resumo (somente leitura) reproduz o resumo do Worker sem dado pessoal", { skip }, async () => {
  reset();
  const env = ENV();
  const vid = await person(env);
  await sub(env, { contato: "script@exemplo.com", nome: "Fernanda", vid });
  const url = `postgresql://postgres@/${DB}?host=${encodeURIComponent(HOST)}&port=${PORT}`;
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "fase_a", "resumo.mjs"), "--janela", "fa1", "--since", "2026-01-01", "--until", "2999-12-31"], { encoding: "utf8", env: { ...process.env, DATABASE_URL: url } });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  const w = await summary();
  assert.deepEqual(j.niches, w.niches);
  assert.deepEqual([j.channel_balance, j.finalists], [w.channel_balance, w.finalists]);
  assert.equal(j.niches.confeitaria.signups, 1);
  for (const needle of ["script@", "Fernanda", "exemplo.com", psql("select contact_ref from waitlist_signups")[0].contact_ref]) assert.ok(!r.stdout.includes(needle), "vazou: " + needle);
  assert.equal(n("select count(*)::int as n from waitlist_signups"), 1, "o script não altera dados");
});

test("restrições do esquema (migração 030): nicho fora da lista e identificadores fora do formato são recusados", { skip }, async () => {
  reset();
  const base = "insert into waitlist_signups (window_id, niche, contact_kind, contact, contact_ref, q_recurring, q_digital, consent_version, consent_at) values ";
  assert.throws(() => psql(base + "('fa1','academia','email','x@y.com','" + "a".repeat(64) + "',true,true,'v',now())"));
  assert.throws(() => psql(base + "('fa1','confeitaria','email','x@y.com','nao-hex',true,true,'v',now())"));
  assert.throws(() => psql("insert into waitlist_persons (window_id, niche, person_id, first_day, last_day) values ('fa1','confeitaria','curto',current_date,current_date)"));
  assert.equal(psql("select count(*)::int as n from schema_migrations where migration_id='030_waitlist_fase_a'")[0].n, "1");
});

test("origem v3: rótulo de lista fechada gravado no navegador (primeira visita); fora da lista = invalido; referer = organico; nada = direto", { skip }, async () => {
  reset();
  const env = ENV();
  const cases = [["wa_status", false, "wa_status"], ["IG_REEL", false, "ig_reel"], ["parc_padaria1", false, "parc_padaria1"], ["meta_teste", false, "meta_teste"], ["youtube", false, "invalido"], ["", true, "organico"], ["", false, "direto"]];
  const vids = [];
  for (const [i, [utm, ref, _]] of cases.entries()) vids.push(await person(env, { ip: "204.0.0." + i, utm: utm.toLowerCase(), ref_ext: ref }));
  const got = psql("select src, count(*)::int as n from waitlist_persons group by src order by src").map((r) => r.src);
  assert.deepEqual(got, cases.map((c) => c[2]).sort());
  await visit(env, { vid: vids[0], ip: "204.0.0.0", utm: "ig_post" }, T0 + DAY);
  assert.equal(psql("select count(*)::int as n from waitlist_persons where src='ig_post'")[0].n, "0", "origem da primeira visita é mantida");
  const r = await call(env, "/visita", { aviso: V, nicho: "confeitaria", method: "GET", ua: HUMAN, ip: "204.9.9.9", utm: "fb_grupo" });
  assert.equal(r.body.src, "fb_grupo", "rótulo devolvido para o campo oculto");
  // Pessoa criada pela inscrição (cookie válido sem visita registrada) usa o rótulo do formulário, revalidado.
  const vid = r.body.cookie.value;
  psql("delete from waitlist_persons where src='fb_grupo'");
  await sub(env, { contato: "origem@exemplo.com", vid, src: "<script>" });
  assert.equal(psql("select src from waitlist_signups where contact='origem@exemplo.com'")[0].src, "invalido");
  assert.equal(psql("select src from waitlist_persons where person_id=(select person_id from waitlist_signups where contact='origem@exemplo.com')")[0].src, "invalido");
});

test("wa_owned (wa_status, wa_lista) e parceiros (parc_*) ficam FORA da métrica primária; wa_owned é reportado como métrica secundária, com exclusões por razão, sensibilidade e mistura de canais por nicho", { skip }, async () => {
  reset();
  const env = ENV();
  const mk = async (nicho, utm, i, contato) => { const vid = await person(env, { nicho, utm, ip: `205.${nicho.length}.0.${i}` }); if (contato) await sub(env, { nicho, contato, vid, src: utm }); };
  await mk("confeitaria", "ig_post", 1, "a1@exemplo.com"); await mk("confeitaria", "ig_post", 2);
  await mk("confeitaria", "wa_status", 3, "a3@exemplo.com"); await mk("confeitaria", "wa_lista", 4); await mk("confeitaria", "parc_amiga", 5, "a5@exemplo.com");
  let s = await summary();
  let c = s.niches.confeitaria;
  assert.deepEqual([c.eligible_browsers, c.signups], [2, 1], "só tráfego independente decide");
  assert.deepEqual(c.excluded_source, { wa_owned: 2, parceiro: 1 });
  assert.deepEqual([c.sensitivity.with_wa_owned_and_partners.browsers, c.sensitivity.with_wa_owned_and_partners.signups], [5, 3]);
  // Secundária pré-registrada: wa_owned com unidade própria (2 pessoas, 1 inscrição), nunca decide; parceiro não entra nela.
  assert.deepEqual([c.secondary.wa_owned.source_class, c.secondary.wa_owned.browsers, c.secondary.wa_owned.signups, c.secondary.wa_owned.conversion, c.secondary.wa_owned.decides], ["wa_owned", 2, 1, 0.5, false]);
  assert.ok(c.secondary.wa_owned.wilson95.low > 0 && c.secondary.wa_owned.wilson95.high < 1);
  assert.deepEqual(c.source_mix, { ig_post: 2, parc_amiga: 1, wa_lista: 1, wa_status: 1 });
  assert.deepEqual(c.source_mix_decision_population, { ig_post: 2 });
  assert.equal(s.channel_balance.status, "NAO_VERIFICAVEL", "nichos sem pessoas: mistura não verificável");
  assert.deepEqual(s.finalists, []);
  await mk("loja-de-roupas", "ig_post", 1); await mk("loja-de-roupas", "ig_post", 2);
  await mk("salao-e-barbearia", "ig_post", 1); await mk("salao-e-barbearia", "wa_status", 2);
  s = await summary();
  assert.equal(s.channel_balance.status, "EQUILIBRADO", JSON.stringify(s.channel_balance));
  assert.equal(s.reason, "nenhum_go");
  await mk("loja-de-roupas", "direto", 3);
  s = await summary();
  assert.equal(s.channel_balance.status, "DESEQUILIBRADO");
  assert.ok(s.niches.confeitaria.oracle.ok, JSON.stringify(s.niches.confeitaria.oracle.checks));
  const out = JSON.stringify(s);
  for (const needle of ["@exemplo", "a1@", ...psql("select person_id from waitlist_persons").map((r) => r.person_id)]) assert.ok(!out.includes(needle), needle);
});

test("semana de teste (funil das calculadoras, bandeira FASE_A_SEMANA_TESTE): qualificada = visitante único do dia, BR e com Accept-Language; sem bandeira nada é contado", { skip }, async () => {
  const F = await import(pathToFileURL(path.join(MOD_DIR, "funnel.mjs")).href);
  psql("drop table if exists zevanory_funnel_daily, zevanory_funnel_visitors");
  const day0 = Date.parse("2026-11-03T12:00:00Z");
  const hit = (env, o) => F.recordPageView(env, { sqlFactory, page: "calculadora-taxa-maquininha", ip: "206.0.0.1", userAgent: HUMAN, camp: "sdt-confeitaria", src: "wa_status", asn: 28573, acceptLanguage: true, country: "BR", now: day0, docs: TEST_DOCS, ...o });
  const off = { DATABASE_URL: "x", RESEND_API_KEY: "salt" }, on = { ...off, FASE_A_SEMANA_TESTE: "on", ...APPROVED_ENV };
  await hit(off, {});
  assert.equal(n("select count(*)::int as n from zevanory_funnel_daily where metric like 'sdt:%'"), 0, "bandeira desligada");
  // Trava da LIA: bandeira ligada, mas LIA real (pendente) ou hash aprovado ausente => nada é contado.
  await hit(on, { ip: "206.0.0.90", docs: undefined });
  await hit({ ...on, FASE_A_LIA_APPROVED_SHA256: undefined }, { ip: "206.0.0.91" });
  await hit({ ...on, FASE_A_ROPA_APPROVED_SHA256: undefined }, { ip: "206.0.0.92" });
  assert.equal(n("select count(*)::int as n from zevanory_funnel_daily where metric like 'sdt:%'"), 0, "LIA/ROPA não aprovados: semana de teste não conta");
  await hit(on, { ip: "206.0.0.2" });
  await hit(on, { ip: "206.0.0.2" });
  await hit(on, { ip: "206.0.0.3", country: "US" });
  await hit(on, { ip: "206.0.0.4", acceptLanguage: false });
  await hit(on, { ip: "206.0.0.5", camp: "sdt-loja-de-roupas" });
  await hit(on, { ip: "206.0.0.6", camp: "outra" });
  await hit(on, { ip: "206.0.0.7", page: "solucoes" });
  await hit(on, { ip: "206.0.0.8", src: "meta_teste", camp: "sdt-salao-e-barbearia", country: "US" });
  const m = Object.fromEntries(psql("select metric, sum(n)::int as n from zevanory_funnel_daily where metric like 'sdt:%' group by metric").map((r) => [r.metric, Number(r.n)]));
  assert.deepEqual(m, { "sdt:confeitaria:visita": 4, "sdt:confeitaria:qualificada": 1, "sdt:loja-de-roupas:visita": 1, "sdt:loja-de-roupas:qualificada": 1, "sdt:salao-e-barbearia:visita": 1, "sdt:salao-e-barbearia:pago": 1 });
  const w = await W.buildTestWeekSummary(sqlFactory(), { since: "2026-11-03", until: "2026-11-03" });
  assert.equal(w.decision, "PERIODO_INVALIDO", "1 dia não é semana de teste");
  const ok = await W.buildTestWeekSummary(sqlFactory(), { since: "2026-11-03", until: "2026-11-09" });
  assert.deepEqual([ok.decision, ok.niches.confeitaria.qualified, ok.period.days], ["NAO_AUTORIZA", 1, 7]);
  assert.ok(ok.niches["salao-e-barbearia"].reasons.includes("trafego_pago"));
  const url = `postgresql://postgres@/${DB}?host=${encodeURIComponent(HOST)}&port=${PORT}`;
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "fase_a", "resumo.mjs"), "--semana-teste", "--since", "2026-11-03", "--until", "2026-11-09"], { encoding: "utf8", env: { ...process.env, DATABASE_URL: url } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ok, "script = Worker");
});

test("multi-aparelho: a mesma pessoa em dois aparelhos (cookies distintos) conta como DUAS unidades, salvo identidade consentida (mesmo contato inscrito nos dois); limitação documentada", { skip }, async () => {
  reset();
  const env = ENV();
  const LAPTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
  // Só visita nos dois aparelhos: nada liga os cookies -> 2 pessoas (viés conservador: denominador maior).
  const phone = await person(env, { ip: "207.0.0.1" });
  const laptop = await person(env, { ip: "207.0.0.2", ua: LAPTOP });
  assert.notEqual(phone, laptop, "cada aparelho recebe o seu identificador");
  let c = (await summary()).niches.confeitaria;
  assert.deepEqual([c.eligible_browsers, c.signups, c.aliases], [2, 0, 0], "sem identidade consentida: duas unidades");
  // Inscrição (consentida) só num aparelho: continua 2 pessoas e 1 inscrição.
  assert.equal((await sub(env, { contato: "multi@exemplo.com", vid: phone })).body.code, "inscrito");
  c = (await summary()).niches.confeitaria;
  assert.deepEqual([c.eligible_browsers, c.signups, c.aliases], [2, 1, 0], "um aparelho sem inscrição continua unidade separada");
  // Mesmo contato inscrito no outro aparelho = identidade consentida: funde em 1 pessoa e 1 inscrição.
  assert.equal((await sub(env, { contato: "MULTI@exemplo.com", vid: laptop })).body.code, "ja_inscrito");
  c = (await summary()).niches.confeitaria;
  assert.deepEqual([c.eligible_browsers, c.signups, c.aliases], [1, 1, 1], "identidade consentida: uma unidade");
  assert.equal(c.conversion, 1);
  assert.ok(c.oracle.ok, JSON.stringify(c.oracle.checks));
});

test("multi-nicho: um visitante (mesmo cookie) em 2 nichos conta 1 vez em CADA denominador visitado, nunca 2 no mesmo; a inscrição conta só no nicho em que foi feita; sobreposição reportada", { skip }, async () => {
  reset();
  const env = ENV();
  // Mesmo navegador: visita e confirma confeitaria, depois salão (o cookie tem escopo /lista-de-espera).
  let vid = await person(env, { ip: "208.0.0.1", nicho: "confeitaria" });
  vid = await visit(env, { vid, ip: "208.0.0.1", nicho: "salao-e-barbearia" });
  await confirm(env, vid, "salao-e-barbearia");
  // Só visita a loja (folha de estilo da loja não pedida): sem confirmação NESSE nicho.
  await visit(env, { vid, ip: "208.0.0.1", nicho: "loja-de-roupas" });
  // Volta à confeitaria no dia seguinte e confirma lá: continua 1 pessoa nesse nicho e NÃO confirma a loja.
  vid = await visit(env, { vid, ip: "208.0.0.1", nicho: "confeitaria" }, T0 + DAY);
  await confirm(env, vid, "confeitaria", T0 + DAY);
  // Outra pessoa só na confeitaria.
  await person(env, { ip: "208.0.0.2", nicho: "confeitaria" });
  assert.equal(new Set(psql("select person_id from waitlist_persons").map((r) => r.person_id)).size, 2, "mesmo identificador nos 3 nichos");
  assert.equal((await sub(env, { contato: "nichos@exemplo.com", vid, nicho: "confeitaria" })).body.code, "inscrito");
  const s = await summary();
  const [conf, salao, loja] = ["confeitaria", "salao-e-barbearia", "loja-de-roupas"].map((k) => s.niches[k]);
  assert.deepEqual([conf.eligible_browsers, salao.eligible_browsers, loja.eligible_browsers], [2, 1, 0], "1 por nicho visitado e confirmado");
  assert.deepEqual([conf.signups, salao.signups, loja.signups], [1, 0, 0], "inscrição só no nicho dela");
  assert.equal(loja.unconfirmed_ids, 1);
  assert.deepEqual([conf.cross_niche_browsers, salao.cross_niche_browsers, loja.cross_niche_browsers], [1, 1, 0]);
  assert.deepEqual(s.cross_niche, { rule: "um_por_nicho", browser_niche_rows: 3, unique_browsers: 2, browsers_2plus_niches: 1 });
  // Inscrição também no salão (mesmo contato, outro nicho): conta 1 em cada nicho, nunca 2 no mesmo.
  assert.equal((await sub(env, { contato: "nichos@exemplo.com", vid, nicho: "salao-e-barbearia" })).body.code, "inscrito");
  assert.equal((await sub(env, { contato: "nichos@exemplo.com", vid, nicho: "salao-e-barbearia" })).body.code, "ja_inscrito");
  const s2 = await summary();
  assert.deepEqual([s2.niches.confeitaria.signups, s2.niches["salao-e-barbearia"].signups], [1, 1]);
  for (const k of ["confeitaria", "salao-e-barbearia", "loja-de-roupas"]) assert.ok(s2.niches[k].oracle.ok, k + " " + JSON.stringify(s2.niches[k].oracle.checks));
});

test("trava da LIA (AVAL 099): sem LIA e ROPA aprovados + hashes aprovados iguais, a medição recusa (503, sem cookie, nada gravado), /saude dá o motivo e a saída continua; LIA editada depois da aprovação desliga", { skip }, async () => {
  reset();
  const edited = { lia: await manifestOf(APPROVED_TEXT + "\nNota acrescentada depois da aprovação.\n"), ropa: TEST_ROPA };
  const cases = [
    ["LIA e ROPA reais do repositório (pendentes)", ENV(), { lia: REAL_LIA, ropa: REAL_ROPA }, "lia_pendente_de_revisao"],
    ["ROPA real pendente com LIA aprovada", ENV(), { lia: TEST_LIA, ropa: REAL_ROPA }, "ropa_pendente_de_revisao"],
    ["hash aprovado da LIA ausente", ENV({ FASE_A_LIA_APPROVED_SHA256: undefined }), TEST_DOCS, "lia_aprovacao_nao_configurada"],
    ["hash aprovado do ROPA ausente", ENV({ FASE_A_ROPA_APPROVED_SHA256: undefined }), TEST_DOCS, "ropa_aprovacao_nao_configurada"],
    ["hash aprovado mal formado", ENV({ FASE_A_LIA_APPROVED_SHA256: "abc" }), TEST_DOCS, "lia_aprovacao_formato_invalido"],
    ["LIA editada depois da aprovação", ENV(), edited, "lia_alterada_apos_aprovacao"],
  ];
  for (const [label, env, lia, reason] of cases) {
    const v = await call(env, "/visita", { aviso: V, nicho: "confeitaria", method: "GET", ua: HUMAN, ip: "209.0.0.1", asn: 28573 }, T0, lia);
    assert.deepEqual([v.status, v.body.code, v.body.reason, v.body.cookie], [503, "lia_nao_aprovada", reason, undefined], label + ": visita");
    assert.equal((await call(env, "/confirmar", { nicho: "confeitaria", vid: "a".repeat(32) + "." + "b".repeat(32) }, T0, lia)).status, 503, label + ": confirmação");
    const i = await call(env, "/inscrever", { nicho: "confeitaria", contato: "trava@exemplo.com", q1: "sim", q2: "sim", consent: true, ua: HUMAN }, T0, lia);
    assert.deepEqual([i.status, i.body.code], [503, "lia_nao_aprovada"], label + ": inscrição");
    for (const t of TABLES) assert.equal(n(`select count(*)::int as n from ${t}`), 0, label + ": nada gravado em " + t);
    assert.equal(await env.ZEVANORY_PRIVATE_ARTIFACTS.get(W.SEEN_MARKER), null, label + ": nem o marcador de uso");
    const h = await call(env, "/saude", {}, T0, lia);
    assert.deepEqual([h.status, h.body.measurement_active, h.body.reason, h.body.lia.active], [200, false, reason, false], label + ": saúde");
    // Direito do titular: a saída nunca é bloqueada pela trava (link inválido = 400, não 503).
    assert.equal((await call(env, "/sair", { r: "a".repeat(64), t: "b".repeat(32) }, T0, lia)).status, 400, label + ": saída");
  }
  const off = await call(ENV({ FASE_A_WAITLIST: undefined }), "/saude", {});
  assert.deepEqual([off.body.measurement_active, off.body.reason], [false, "bandeira_desligada"]);
  // Aprovada e com o hash igual: liga (cookie emitido, linha gravada) e /saude confirma.
  const ok = await call(ENV(), "/visita", { aviso: V, nicho: "confeitaria", method: "GET", ua: HUMAN, ip: "209.0.0.2", asn: 28573 });
  assert.equal(ok.status, 200);
  assert.match(ok.body.cookie.value, /^[0-9a-f]{32}\.[0-9a-f]{32}$/);
  assert.equal(n("select count(*)::int as n from waitlist_persons"), 1);
  const h = await call(ENV(), "/saude", {});
  assert.deepEqual([h.body.measurement_active, h.body.reason, h.body.lia.lia_sha256, h.body.lia.ropa_sha256], [true, null, TEST_LIA.sha256, TEST_ROPA.sha256]);
});

test("aviso antes da coleta (AVAL 101 §3): sem o sinal do aviso (ou com outra versão) nenhum identificador, HMAC ou evento; com o sinal, o identificador nasce e o cookie expira até o fim da janela", { skip }, async () => {
  reset();
  const env = ENV();
  for (const aviso of [undefined, "", "fase-a-aviso-v0-antigo"]) {
    const r = await call(env, "/visita", { nicho: "confeitaria", method: "GET", ua: HUMAN, asn: 28573, ...(aviso === undefined ? {} : { aviso }) });
    assert.deepEqual([r.status, r.body.cookie, r.body.refused], [200, null, "aviso_ausente"], String(aviso));
  }
  for (const t of TABLES) assert.equal(n(`select count(*)::int as n from ${t}`), 0, "nada gravado em " + t);
  assert.equal(await env.ZEVANORY_PRIVATE_ARTIFACTS.get(W.SEEN_MARKER), null, "nem o marcador de uso");
  const ok = await call(env, "/visita", { aviso: V, nicho: "confeitaria", method: "GET", ua: HUMAN, asn: 28573 });
  assert.match(ok.body.cookie.value, /^[0-9a-f]{32}\.[0-9a-f]{32}$/);
  // Cookie: até o fim da janela ativa (2026-11-30T23:59:59Z), nunca depois.
  assert.equal(ok.body.cookie.maxAge, Math.floor((Date.parse("2026-11-30T23:59:59Z") - T0) / 1000));
  const longWin = await call(ENV({ FASE_A_WINDOW_END: "2027-06-30" }), "/visita", { aviso: V, nicho: "confeitaria", method: "GET", ua: HUMAN });
  assert.ok(longWin.body.cookie.maxAge <= Math.floor((Date.parse("2027-06-30T23:59:59Z") - T0) / 1000));
});

test("não participação (AVAL 101 §4): zvfa_optout/Sec-GPC impedem cookie, HMAC e evento; /nao-participar apaga as linhas localizáveis em todos os nichos, desvincula a inscrição e registra a exclusão sem dado pessoal", { skip }, async () => {
  reset();
  const env = ENV();
  for (const flag of [{ optout: true }, { gpc: true }]) {
    const r = await call(env, "/visita", { aviso: V, nicho: "confeitaria", method: "GET", ua: HUMAN, ...flag });
    assert.deepEqual([r.body.cookie, r.body.refused], [null, "nao_participa"], JSON.stringify(flag));
    assert.equal((await call(env, "/confirmar", { nicho: "confeitaria", vid: "a".repeat(32) + "." + "b".repeat(32), ...flag })).status, 204);
  }
  for (const t of TABLES) assert.equal(n(`select count(*)::int as n from ${t}`), 0, "nada gravado em " + t);
  // Navegador medido em 2 nichos, inscrito, com alias de outro aparelho; depois recusa.
  let vid = await person(env);
  vid = await visit(env, { vid, nicho: "salao-e-barbearia" }); await confirm(env, vid, "salao-e-barbearia");
  await sub(env, { contato: "opt@exemplo.com", vid });
  const other = await person(env, { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36" });
  await sub(env, { contato: "opt@exemplo.com", vid: other });
  const keep = await person(env);
  assert.equal(n("select count(*)::int as n from waitlist_person_alias"), 1);
  const out = await call(env, "/nao-participar", { vid });
  assert.deepEqual([out.status, out.body.erased], [200, 2], "as duas linhas (2 nichos) do navegador");
  assert.equal(out.body.maxAge, Math.floor((Date.parse("2026-11-30T23:59:59Z") - T0) / 1000), "marcador até o fim da janela");
  assert.equal(n("select count(*)::int as n from waitlist_person_alias"), 0, "identidade consentida desfeita");
  assert.deepEqual(psql("select exclusion, person_id from waitlist_signups"), [{ exclusion: "optout", person_id: null }], "inscrição mantida (consentimento), sem vínculo de medição");
  assert.deepEqual(psql("select scope, trigger, n, result from waitlist_deletion_log"), [{ scope: "optout", trigger: "nao_participar", n: "2", result: "ok" }]);
  const s = await summary();
  const c = s.niches.confeitaria;
  assert.deepEqual([c.eligible_browsers, c.signups, c.signups_optout, c.signups_without_id, c.erased_by_request], [2, 0, 1, 0, 1]);
  assert.ok(!c.blockers.includes("inscricao_sem_identificador"), "opt-out não bloqueia a decisão");
  for (const k of ["confeitaria", "salao-e-barbearia"]) assert.ok(s.niches[k].oracle.ok, k + " " + JSON.stringify(s.niches[k].oracle.checks));
  // Inscrição de navegador que não participa: guardada sem vínculo, sem linha de medição.
  assert.equal((await sub(env, { contato: "gpc@exemplo.com", vid: keep, gpc: true })).body.code, "inscrito");
  assert.deepEqual(psql("select exclusion, person_id from waitlist_signups where contact = 'gpc@exemplo.com'"), [{ exclusion: "optout", person_id: null }]);
  assert.ok((await summary()).niches.confeitaria.oracle.ok);
  // Sem cookie localizável: nada apagado, mas o marcador vale.
  const none = await call(env, "/nao-participar", {});
  assert.deepEqual([none.body.erased, none.body.maxAge > 0], [0, true]);
});

test("minimização (AVAL 101 §2): nenhum IP, UA ou derivado de IP+UA é persistido; colunas da medição são só as permitidas", { skip }, async () => {
  reset();
  const env = ENV();
  const UA = HUMAN + " MarcadorUnico/9.9";
  const vid = await visit(env, { ua: UA, ip: "203.113.7.9", asn: 28573 });
  await confirm(env, vid);
  await sub(env, { contato: "min@exemplo.com", vid, ua: UA });
  const cols = psql("select column_name from information_schema.columns where table_name = 'waitlist_persons' order by ordinal_position").map((r) => r.column_name);
  assert.deepEqual(cols, ["window_id", "niche", "person_id", "first_day", "last_day", "days", "confirmed", "exclusion", "src", "window_end", "dsr_ref"]);
  assert.equal(psql("select count(*)::int as n from information_schema.columns where table_schema='public' and table_name like 'waitlist%' and column_name ~ '(^ip|_ip$|user_agent|^ua$|dhash|asn)'")[0].n, "0");
  assert.equal(psql("select to_regclass('waitlist_person_days') is null as ausente")[0].ausente, "t", "tabela de pessoa-dia (HMAC de IP+UA) removida");
  const dump = JSON.stringify(TABLES.map((t) => psql(`select * from ${t}`)));
  for (const needle of ["203.113.7.9", "MarcadorUnico", "Android 14", "28573"]) assert.ok(!dump.includes(needle), "persistido: " + needle);
});

test("pedido do titular por ação local e código opaco (AVAL 101 §4): /meus-dados mostra o registro e um código que não é o cookie nem o identificador interno; o operador localiza e apaga pelo código, com registro", { skip }, async () => {
  reset();
  const env = ENV();
  let vid = await person(env, {}, T0);
  vid = await visit(env, { vid }, T0 + DAY); await confirm(env, vid, "confeitaria", T0 + DAY);
  await person(env);
  const md = await call(env, "/meus-dados", { vid }, T0 + DAY);
  assert.equal(md.body.exists, true);
  assert.deepEqual(md.body.rows, [{ niche: "confeitaria", first_day: "2026-11-02", last_day: "2026-11-03", days: 2 }]);
  const token = md.body.token;
  assert.match(token, /^[0-9a-f]{32}$/);
  const pid = psql("select person_id from waitlist_persons where days = 2")[0].person_id;
  assert.ok(token !== pid && !vid.includes(token) && !token.includes(vid.slice(0, 32)), "código opaco ≠ cookie ≠ identificador interno");
  assert.deepEqual((await call(env, "/meus-dados", {})).body, { ok: true, exists: false, rows: [], token: null }, "sem cookie: nada");
  const url = `postgresql://postgres@/${DB}?host=${encodeURIComponent(HOST)}&port=${PORT}`;
  const run = (...a) => spawnSync(process.execPath, [path.join(ROOT, "scripts", "fase_a", "atendimento.mjs"), "--janela", "fa1", ...a], { encoding: "utf8", env: { ...process.env, DATABASE_URL: url } });
  const found = run("--localizar", token);
  assert.equal(found.status, 0, found.stderr);
  assert.deepEqual(JSON.parse(found.stdout), { found: true, rows: [{ niche: "confeitaria", first_day: "2026-11-02", last_day: "2026-11-03", days: 2 }] });
  assert.equal(run("--localizar", "nao-hex").status, 2);
  const del = run("--apagar", token);
  assert.equal(del.status, 0, del.stderr);
  assert.deepEqual(JSON.parse(del.stdout), { erased: 1 });
  assert.equal(n("select count(*)::int as n from waitlist_persons"), 1, "só o registro do titular foi apagado");
  assert.deepEqual(psql("select scope, trigger, n from waitlist_deletion_log"), [{ scope: "pedido", trigger: "codigo_atendimento", n: "1" }]);
  assert.ok((await summary()).niches.confeitaria.oracle.ok);
  assert.equal(JSON.parse(run("--localizar", token).stdout).found, false);
});
