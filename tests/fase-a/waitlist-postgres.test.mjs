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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const MOD = pathToFileURL(path.resolve(process.env.WAITLIST_MODULE || path.join(ROOT, "worker", "waitlist.mjs"))).href;
const MIGRATION = path.resolve(process.env.WAITLIST_MIGRATION || path.join(ROOT, "db", "migrations", "030_waitlist_fase_a.sql"));
const W = await import(MOD);
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
  FASE_A_WINDOW_ID: "fa1", FASE_A_WINDOW_END: "2026-11-30", RESEND_API_KEY: "re_nao_e_fallback_123456789012345678901234", ZEVANORY_PRIVATE_ARTIFACTS: kv(), ...o });
const HUMAN = "Mozilla/5.0 (Linux; Android 14; SM-A146M) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";
const call = async (env, p, body, now = T0) => { const r = await W.handleWaitlist(new Request("https://waitlist.internal" + p, { method: "POST", body: JSON.stringify(body) }), env, { sqlFactory, now }); return { status: r.status, body: r.status === 204 ? null : await r.json() }; };
// Visita: devolve o valor do cookie em uso (o recebido ou o novo emitido).
async function visit(env, o = {}, now = T0) {
  const r = await call(env, "/visita", { nicho: "confeitaria", method: "GET", ua: HUMAN, ip: "200.1.1.1", asn: 28573, ...o }, now);
  assert.equal(r.status, 200);
  return r.body.cookie ? r.body.cookie.value : o.vid || null;
}
const confirm = (env, vid, nicho = "confeitaria", now = T0) => call(env, "/confirmar", { nicho, vid }, now);
async function person(env, o = {}, now = T0) { const vid = await visit(env, o, now); await confirm(env, vid, o.nicho || "confeitaria", now); return vid; }
const sub = (env, o = {}, now = T0) => call(env, "/inscrever", { nicho: "confeitaria", contato: "ana@exemplo.com", q1: "sim", q2: "sim", consent: true, ua: HUMAN, asn: 28573, src: "youtube", ...o }, now);
const summary = (o = {}) => W.buildWaitlistSummary(sqlFactory(), { windowId: "fa1", ...o });
const TABLES = ["waitlist_signups", "waitlist_persons", "waitlist_person_alias", "waitlist_person_days", "waitlist_raw_daily"];
function reset({ migrate = true } = {}) {
  psql("drop table if exists " + TABLES.join(", "));
  psql("create table if not exists schema_migrations (migration_id text primary key, applied_at timestamptz not null default now())");
  psql("delete from schema_migrations where migration_id = '030_waitlist_fase_a'");
  if (migrate) psql(MIGRATION, { file: true });
  W.resetWaitlistState?.();
}
const n = (q) => Number(psql(q)[0].n);

test("bandeira desligada: 404 e nada gravado", { skip }, async () => {
  reset();
  const env = ENV({ FASE_A_WAITLIST: undefined });
  assert.equal((await call(env, "/visita", { nicho: "confeitaria", method: "GET", ua: HUMAN })).status, 404);
  assert.equal((await sub(env)).status, 404);
  for (const t of TABLES) assert.equal(n(`select count(*)::int as n from ${t}`), 0, t);
});

test("fail-closed: sem migração 030 -> 503; sem chave de contato -> 503; o módulo não cria tabelas", { skip }, async () => {
  reset({ migrate: false });
  assert.equal((await sub(ENV())).status, 503);
  assert.equal((await call(ENV(), "/visita", { nicho: "confeitaria", method: "GET", ua: HUMAN, ip: "1.1.1.1" })).status, 503);
  assert.equal(psql("select to_regclass('waitlist_signups') is null as ausente")[0].ausente, "t", "módulo não cria esquema");
  reset();
  assert.equal((await sub(ENV({ LEAD_PRIVACY_SECRET: "" }))).status, 503);
  assert.equal(n("select count(*)::int as n from waitlist_signups"), 0);
});

test("segredo de visitante dedicado: ausente ou < 32 bytes NÃO usa fallback (RESEND/DATABASE_URL), nada é contado e a decisão é INCONCLUSIVO", { skip }, async () => {
  for (const secret of [undefined, "", "x".repeat(31)]) {
    reset();
    const env = ENV({ WAITLIST_VISITOR_SECRET: secret });
    const r = await call(env, "/visita", { nicho: "confeitaria", method: "GET", ua: HUMAN, ip: "200.1.1.1" });
    assert.equal(r.body.cookie, null, "sem cookie");
    assert.equal(n("select count(*)::int as n from waitlist_persons"), 0);
    assert.equal(n("select count(*)::int as n from waitlist_person_days"), 0);
    const c = (await summary()).niches.confeitaria;
    assert.ok(c.blockers.includes("segredo_de_visitante_ausente"));
    assert.equal(c.decision, "INCONCLUSIVO");
    assert.equal(c.excluded.no_secret, 1);
  }
});

test("sem janela configurada: visita vira só exposição pessoa-dia, sem identificador, e a decisão é INCONCLUSIVO", { skip }, async () => {
  reset();
  const env = ENV({ FASE_A_WINDOW_END: undefined });
  const r = await call(env, "/visita", { nicho: "confeitaria", method: "GET", ua: HUMAN, ip: "200.1.1.1" });
  assert.equal(r.body.cookie, null);
  assert.equal(n("select count(*)::int as n from waitlist_persons"), 0);
  assert.equal(n("select count(*)::int as n from waitlist_person_days"), 1);
  const c = (await summary()).niches.confeitaria;
  assert.equal(c.exposure_person_days, 1);
  assert.ok(c.blockers.includes("identificador_nao_estabelecido"));
  assert.equal(c.decision, "INCONCLUSIVO");
  const expired = await call(ENV({ FASE_A_WINDOW_END: "2026-11-01" }), "/visita", { nicho: "confeitaria", method: "GET", ua: HUMAN, ip: "200.1.1.2" });
  assert.equal(expired.body.cookie, null, "janela vencida não emite identificador");
});

test("M-SOL-085: a MESMA pessoa (mesmo IP+navegador) em dois dias conta UMA vez; pessoas distintas contam separadas", { skip }, async () => {
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
  assert.equal(c.eligible_visitors, 2, "2 pessoas, não 3 pessoas-dia");
  assert.equal(c.multi_day_persons, 1);
  assert.equal(c.exposure_person_days, 3, "pessoa-dia é só descritiva");
  assert.deepEqual(psql("select days from waitlist_persons where days > 1"), [{ days: "2" }]);
  assert.ok(c.oracle.ok, JSON.stringify(c.oracle.checks));
});

test("pessoa-dia não infla o denominador: mesmo IP+navegador em 10 dias sem devolver o cookie não vira pessoa confirmada", { skip }, async () => {
  reset();
  const env = ENV();
  for (let d = 0; d < 10; d++) await visit(env, {}, T0 + d * DAY);
  const c = (await summary()).niches.confeitaria;
  assert.equal(c.eligible_visitors, 0);
  assert.equal(c.unconfirmed_ids, 10);
  assert.equal(c.exposure_person_days, 10);
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
  assert.equal(c.eligible_visitors, 1);
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
  assert.equal((await call(env, "/visita", { nicho: "confeitaria", method: "GET", ua: HUMAN, ip: "9.9.9.9", purpose: "prefetch" })).body.cookie, null, "prefetch sem identificador");
  await sub(env, { contato: "humano@exemplo.com", vid: human });
  await sub(env, { contato: "dc@exemplo.com", vid: dc, asn: 16509 });
  await sub(env, { contato: "bot@exemplo.com", vid: bot, ua: "python-requests/2.32" });
  const c = (await summary()).niches.confeitaria;
  assert.deepEqual([c.eligible_visitors, c.signups], [1, 1]);
  assert.deepEqual(c.sensitivity.with_filters, { persons: 1, signups: 1, conversion: 1 });
  assert.deepEqual([c.sensitivity.without_asn_filter.persons, c.sensitivity.without_asn_filter.signups], [2, 2]);
  assert.deepEqual([c.sensitivity.without_ua_filter.persons, c.sensitivity.without_ua_filter.signups], [2, 2]);
  assert.deepEqual([c.sensitivity.without_filters.persons, c.sensitivity.without_filters.signups], [3, 3]);
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
  assert.equal(Object.keys(c.oracle.checks).length, 7);
  psql("delete from waitlist_persons where person_id = (select person_id from waitlist_persons where confirmed limit 1 offset 2)");
  c = (await summary()).niches.confeitaria;
  assert.equal(c.oracle.ok, false);
  assert.equal(c.oracle.checks.pessoas_linhas_igual_criadas, false);
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
  assert.deepEqual([c.unit, c.eligible_visitors, c.signups, c.qualified], ["pessoa_experimental_confirmada", 10, 3, 1]);
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
  for (const tbl of ["waitlist_raw_daily", "waitlist_persons", "waitlist_person_alias", "waitlist_person_days"]) {
    const dump = JSON.stringify(psql(`select * from ${tbl}`));
    assert.ok(!dump.includes(r) && !dump.includes("bia@"), tbl);
  }
  assert.equal(n("select coalesce(sum(n),0)::int as n from waitlist_raw_daily where metric='inscricao:revogada'"), 2, "contagem agregada = linhas apagadas");
  assert.equal((await call(env, "/sair", { r, t })).body.erased, 0);
  assert.ok((await summary()).niches.confeitaria.oracle.ok);
});

test("retenção por finalidade: 30 dias após a decisão apaga contatos e medição (só agregados ficam); limites de 12 meses e 180 dias; sem uso, nenhuma consulta", { skip }, async () => {
  reset();
  const env = ENV({ FASE_A_DECISION_DATE: "2026-11-10" });
  const vid = await person(env);
  await sub(env, { contato: "ret@exemplo.com", vid });
  assert.deepEqual(await W.runWaitlistRetention(env, { sqlFactory, now: Date.parse("2026-12-09T12:00:00Z"), force: true }), { ok: true, erased: 0, measurement_erased: 0, purpose_over: false }, "29 dias depois: mantém");
  const done = await W.runWaitlistRetention(env, { sqlFactory, now: Date.parse("2026-12-10T12:00:00Z"), force: true });
  assert.deepEqual([done.erased, done.purpose_over], [1, true]);
  assert.ok(done.measurement_erased >= 2);
  for (const t of ["waitlist_signups", "waitlist_persons", "waitlist_person_alias", "waitlist_person_days"]) assert.equal(n(`select count(*)::int as n from ${t}`), 0, t);
  assert.ok(n("select count(*)::int as n from waitlist_raw_daily") > 0, "contagens agregadas permanecem");
  assert.equal(n("select coalesce(sum(n),0)::int as n from waitlist_raw_daily where metric='inscricao:apagada_retencao'"), 1);
  // Sem data de decisão: limites absolutos.
  reset();
  const env2 = ENV();
  const v2 = await person(env2);
  await sub(env2, { contato: "velha@exemplo.com", vid: v2 });
  await sub(env2, { contato: "nova@exemplo.com", vid: v2 });
  psql("update waitlist_signups set created_at = now() - interval '13 months' where contact='velha@exemplo.com'");
  psql("update waitlist_persons set last_day = current_date - 181");
  const caps = await W.runWaitlistRetention(env2, { sqlFactory, now: Date.now(), force: true });
  assert.equal(caps.erased, 1);
  assert.deepEqual(psql("select contact from waitlist_signups"), [{ contact: "nova@exemplo.com" }]);
  assert.equal(n("select count(*)::int as n from waitlist_persons"), 0);
  assert.equal(await env2.ZEVANORY_PRIVATE_ARTIFACTS.get(W.SEEN_MARKER), "1");
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

test("origem v3: rótulo de lista fechada gravado na pessoa (primeira visita); fora da lista = invalido; referer = organico; nada = direto", { skip }, async () => {
  reset();
  const env = ENV();
  const cases = [["wa_status", false, "wa_status"], ["IG_REEL", false, "ig_reel"], ["parc_padaria1", false, "parc_padaria1"], ["meta_teste", false, "meta_teste"], ["youtube", false, "invalido"], ["", true, "organico"], ["", false, "direto"]];
  const vids = [];
  for (const [i, [utm, ref, _]] of cases.entries()) vids.push(await person(env, { ip: "204.0.0." + i, utm: utm.toLowerCase(), ref_ext: ref }));
  const got = psql("select src, count(*)::int as n from waitlist_persons group by src order by src").map((r) => r.src);
  assert.deepEqual(got, cases.map((c) => c[2]).sort());
  await visit(env, { vid: vids[0], ip: "204.0.0.0", utm: "ig_post" }, T0 + DAY);
  assert.equal(psql("select count(*)::int as n from waitlist_persons where src='ig_post'")[0].n, "0", "origem da primeira visita é mantida");
  const r = await call(env, "/visita", { nicho: "confeitaria", method: "GET", ua: HUMAN, ip: "204.9.9.9", utm: "fb_grupo" });
  assert.equal(r.body.src, "fb_grupo", "rótulo devolvido para o campo oculto");
  // Pessoa criada pela inscrição (cookie válido sem visita registrada) usa o rótulo do formulário, revalidado.
  const vid = r.body.cookie.value;
  psql("delete from waitlist_persons where src='fb_grupo'");
  await sub(env, { contato: "origem@exemplo.com", vid, src: "<script>" });
  assert.equal(psql("select src from waitlist_signups where contact='origem@exemplo.com'")[0].src, "invalido");
  assert.equal(psql("select src from waitlist_persons where person_id=(select person_id from waitlist_signups where contact='origem@exemplo.com')")[0].src, "invalido");
});

test("rede pessoal (wa_status, wa_lista) e parceiros (parc_*) marcados ficam FORA da população da decisão, com exclusões por razão, sensibilidade e mistura de canais por nicho", { skip }, async () => {
  reset();
  const env = ENV();
  const mk = async (nicho, utm, i, contato) => { const vid = await person(env, { nicho, utm, ip: `205.${nicho.length}.0.${i}` }); if (contato) await sub(env, { nicho, contato, vid, src: utm }); };
  await mk("confeitaria", "ig_post", 1, "a1@exemplo.com"); await mk("confeitaria", "ig_post", 2);
  await mk("confeitaria", "wa_status", 3, "a3@exemplo.com"); await mk("confeitaria", "wa_lista", 4); await mk("confeitaria", "parc_amiga", 5, "a5@exemplo.com");
  let s = await summary();
  let c = s.niches.confeitaria;
  assert.deepEqual([c.eligible_visitors, c.signups], [2, 1], "só tráfego independente decide");
  assert.deepEqual(c.excluded_source, { rede_pessoal: 2, parceiro: 1 });
  assert.deepEqual([c.sensitivity.with_personal_network_and_partners.persons, c.sensitivity.with_personal_network_and_partners.signups], [5, 3]);
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
  const F = await import(pathToFileURL(path.join(ROOT, "worker", "funnel.mjs")).href);
  psql("drop table if exists zevanory_funnel_daily, zevanory_funnel_visitors");
  const day0 = Date.parse("2026-11-03T12:00:00Z");
  const hit = (env, o) => F.recordPageView(env, { sqlFactory, page: "calculadora-taxa-maquininha", ip: "206.0.0.1", userAgent: HUMAN, camp: "sdt-confeitaria", src: "wa_status", asn: 28573, acceptLanguage: true, country: "BR", now: day0, ...o });
  const off = { DATABASE_URL: "x", RESEND_API_KEY: "salt" }, on = { ...off, FASE_A_SEMANA_TESTE: "on" };
  await hit(off, {});
  assert.equal(n("select count(*)::int as n from zevanory_funnel_daily where metric like 'sdt:%'"), 0, "bandeira desligada");
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
