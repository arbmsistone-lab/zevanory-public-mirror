// P01 Fase A: SQL REAL de worker/waitlist.mjs contra PostgreSQL efêmero (dados sintéticos, sem rede).
// Pulado sem WAITLIST_PG_HOST; o workflow da Fase A exige "# skipped 0", então no CI nada é pulado.
// WAITLIST_MODULE permite ao executor de mutantes (scripts/fase_a/mutants.mjs) trocar o módulo testado.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const MOD = process.env.WAITLIST_MODULE ? pathToFileURL(path.resolve(process.env.WAITLIST_MODULE)).href : pathToFileURL(path.join(ROOT, "worker", "waitlist.mjs")).href;
const W = await import(MOD);
const HOST = process.env.WAITLIST_PG_HOST;
const PORT = process.env.WAITLIST_PG_PORT || "5432";
const DB = process.env.WAITLIST_PG_DB || "postgres";
const skip = !HOST && "WAITLIST_PG_HOST not set";

const lit = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return "'{" + v.map((x) => (x === null ? "NULL" : '"' + String(x).replace(/["\\]/g, "\\$&") + '"')).join(",") + "}'";
  return "'" + String(v).replace(/'/g, "''") + "'";
};
function psql(sqlText) {
  const out = execFileSync("psql", ["-h", HOST, "-p", PORT, "-U", "postgres", "-d", DB, "-X", "-v", "ON_ERROR_STOP=1", "--csv", "-c", sqlText], { encoding: "utf8" });
  const lines = out.trim().split("\n").filter(Boolean);
  if (!lines.length || /^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE) /.test(lines[0]) || /^(DROP|CREATE|TRUNCATE) [A-Z]+$/.test(lines[0])) return [];
  const parse = (line) => { const cells = []; let cur = "", q = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; } else if (c === '"') q = true; else if (c === ",") { cells.push(cur); cur = ""; } else cur += c; } cells.push(cur); return cells; };
  const [head, ...rows] = lines;
  const cols = parse(head);
  return rows.filter((r) => !/^(INSERT|UPDATE|DELETE) /.test(r)).map((r) => Object.fromEntries(parse(r).map((v, i) => [cols[i], v === "" ? null : v])));
}
const sqlFactory = () => ({ query: async (text, params = []) => psql(text.replace(/\$(\d+)/g, (_, n) => lit(params[Number(n) - 1]))) });
const kv = () => { const m = new Map(); return { m, async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); } }; };
const ENV = () => ({ DATABASE_URL: "postgres://synthetic", FASE_A_WAITLIST: "on", LEAD_PRIVACY_SECRET: "k".repeat(40), RESEND_API_KEY: "salt-sintetico", ZEVANORY_PRIVATE_ARTIFACTS: kv() });
const HUMAN = "Mozilla/5.0 (Linux; Android 14; SM-A146M) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";
const call = async (env, p, body) => { const r = await W.handleWaitlist(new Request("https://waitlist.internal" + p, { method: "POST", body: JSON.stringify(body) }), env, { sqlFactory }); return { status: r.status, body: r.status === 204 ? null : await r.json() }; };
const sub = (env, o = {}) => call(env, "/inscrever", { nicho: "confeitaria", contato: "ana@exemplo.com", q1: "sim", q2: "sim", consent: true, ua: HUMAN, asn: 28573, src: "youtube", ...o });
const visit = (env, o = {}) => call(env, "/visita", { nicho: "confeitaria", method: "GET", ua: HUMAN, ip: "200.1.1.1", asn: 28573, ...o });
function reset() { psql("drop table if exists waitlist_signups, waitlist_events, waitlist_visitors"); W.resetWaitlistSchemaCache(); }
const count = (where = "true") => Number(psql(`select count(*)::int as n from waitlist_signups where ${where}`)[0].n);

test("flag desligada: 404 e nenhuma tabela criada nem dado gravado", { skip }, async () => {
  reset();
  const env = { ...ENV(), FASE_A_WAITLIST: undefined };
  assert.equal((await sub(env)).status, 404);
  assert.equal((await visit(env)).status, 404);
  assert.equal(psql("select to_regclass('waitlist_signups') is null as ausente")[0].ausente, "t");
});

test("sem chave de privacidade: 503 (fail-closed), nada gravado", { skip }, async () => {
  reset();
  const env = { ...ENV(), LEAD_PRIVACY_SECRET: "" };
  const r = await sub(env);
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "indisponivel");
  assert.equal(psql("select to_regclass('waitlist_signups') is null as ausente")[0].ausente, "t");
});

test("consentimento obrigatório e validação: sem consentimento, contato ou respostas -> 400 e 0 linhas", { skip }, async () => {
  reset();
  const env = ENV();
  for (const [o, code] of [[{ consent: false }, "consentimento"], [{ consent: "sim" }, "consentimento"], [{ consent: undefined }, "consentimento"], [{ contato: "nao-e-contato" }, "contato"], [{ contato: "123" }, "contato"], [{ q1: "" }, "perguntas"], [{ q2: "talvez" }, "perguntas"], [{ nicho: "academia" }, "nicho"]]) {
    const r = await sub(env, o);
    assert.equal(r.status, 400, JSON.stringify(o));
    assert.equal(r.body.code, code, JSON.stringify(o));
  }
  assert.equal(psql("select to_regclass('waitlist_signups') is null as ausente")[0].ausente, "t", "nenhuma tabela criada por pedido inválido");
});

test("idempotência por contato + nicho: repetição (inclusive com outra grafia) não duplica nem conta duas vezes", { skip }, async () => {
  reset();
  const env = ENV();
  const a = await sub(env, { contato: " Ana@Exemplo.COM ", nome: "Ana" });
  assert.equal(a.status, 200); assert.equal(a.body.code, "inscrito");
  const b = await sub(env, { contato: "ana@exemplo.com", q1: "nao" });
  assert.equal(b.status, 200); assert.equal(b.body.code, "ja_inscrito");
  assert.equal(b.body.optout, a.body.optout, "mesmo link de saída");
  const w1 = await sub(env, { contato: "(88) 99254-0000" });
  const w2 = await sub(env, { contato: "+55 88 99254-0000" });
  assert.equal(w1.body.code, "inscrito"); assert.equal(w2.body.code, "ja_inscrito");
  const other = await sub(env, { contato: "ana@exemplo.com", nicho: "loja-de-roupas" });
  assert.equal(other.body.code, "inscrito", "outro nicho é outra inscrição");
  assert.equal(count("niche='confeitaria'"), 2);
  assert.equal(count(), 3);
  assert.deepEqual(psql("select q_recurring, contact, contact_kind, consent_version from waitlist_signups where niche='confeitaria' and contact_kind='email'"), [{ q_recurring: "t", contact: "ana@exemplo.com", contact_kind: "email", consent_version: W.CONSENT_VERSION }], "primeira inscrição preservada");
  assert.equal(psql("select contact from waitlist_signups where contact_kind='whatsapp'")[0].contact, "5588992540000");
  assert.equal(Number(psql("select count(*)::int as n from waitlist_events where event='consent_given'")[0].n), 3);
  const s = await W.buildWaitlistSummary(sqlFactory());
  assert.equal(s.niches.confeitaria.signups, 2);
  assert.equal(s.niches["loja-de-roupas"].signups, 1);
});

test("opt-out: link assinado apaga o contato em todos os nichos; token errado não apaga nada", { skip }, async () => {
  reset();
  const env = ENV();
  const a = await sub(env, { contato: "bia@exemplo.com" });
  await sub(env, { contato: "bia@exemplo.com", nicho: "salao-e-barbearia" });
  await sub(env, { contato: "caio@exemplo.com" });
  const u = new URL(a.body.optout);
  assert.equal(u.origin + u.pathname, "https://vendas.zevanory.api.br/lista-de-espera/sair");
  const r = u.searchParams.get("r"), t = u.searchParams.get("t");
  assert.equal((await call(env, "/sair/verificar", { r, t })).status, 200);
  const wrong = t.replace(/^./, (c) => (c === "0" ? "1" : "0"));
  assert.equal((await call(env, "/sair/verificar", { r, t: wrong })).status, 400);
  assert.equal((await call(env, "/sair", { r, t: wrong })).status, 400);
  assert.equal(count(), 3, "token inválido não apaga");
  const ok = await call(env, "/sair", { r, t });
  assert.equal(ok.status, 200); assert.equal(ok.body.erased, 2);
  assert.deepEqual(psql("select contact from waitlist_signups"), [{ contact: "caio@exemplo.com" }]);
  assert.equal(Number(psql(`select count(*)::int as n from waitlist_events where event='revoked_and_erased' and contact_ref=${lit(r)}`)[0].n), 2);
  assert.equal(psql("select count(*)::int as n from waitlist_events where contact_ref is not null and contact_ref !~ '^[0-9a-f]{64}$'")[0].n, "0", "auditoria só com referência pseudonimizada");
  const again = await call(env, "/sair", { r, t });
  assert.equal(again.status, 200); assert.equal(again.body.erased, 0);
  const s = await W.buildWaitlistSummary(sqlFactory());
  assert.equal(s.niches.confeitaria.signups, 1); assert.equal(s.niches.confeitaria.revoked, 1);
});

test("robôs fora das métricas: visitas automatizadas/datacenter/prefetch não contam; inscrição de datacenter fica fora", { skip }, async () => {
  reset();
  const env = ENV();
  for (const v of [{}, { ip: "200.2.2.2" }, {}, { ua: "Googlebot/2.1 (+http://www.google.com/bot.html)", ip: "66.249.66.1" }, { asn: 16509, ip: "3.3.3.3" }, { purpose: "prefetch", ip: "200.9.9.9" }, { ua: "", ip: "200.8.8.8" }, { ua: "curl/8.5.0", ip: "200.7.7.7" }, { method: "POST", ip: "200.6.6.6" }, { nicho: "inexistente" }])
    assert.equal((await visit(env, v)).status, 204);
  await sub(env, { contato: "humana@exemplo.com" });
  await sub(env, { contato: "dc@exemplo.com", asn: 14061 });
  await sub(env, { contato: "bot@exemplo.com", ua: "python-requests/2.32" });
  const s = await W.buildWaitlistSummary(sqlFactory());
  assert.equal(s.niches.confeitaria.eligible_visitors, 2, "2 humanos distintos no dia (repetição deduplicada)");
  assert.equal(s.niches.confeitaria.signups, 1);
  assert.equal(s.niches.confeitaria.excluded_automation, 2);
  assert.equal(count("counted"), 1);
});

test("métricas: números corretos, qualificadas = as duas respostas sim, e NENHUM dado pessoal na saída", { skip }, async () => {
  reset();
  const env = ENV();
  const contacts = ["d1@exemplo.com", "d2@exemplo.com", "(11) 98888-7777", "d4@exemplo.com"];
  await sub(env, { contato: contacts[0], nome: "Daniela Souza", q1: "sim", q2: "sim" });
  await sub(env, { contato: contacts[1], nome: "Eduardo", q1: "sim", q2: "nao" });
  await sub(env, { contato: contacts[2], q1: "nao", q2: "sim" });
  await sub(env, { contato: contacts[3], nicho: "salao-e-barbearia", q1: "sim", q2: "sim" });
  for (let i = 0; i < 10; i++) await visit(env, { ip: "201.0.0." + i });
  const s = await W.buildWaitlistSummary(sqlFactory());
  const c = s.niches.confeitaria;
  assert.deepEqual([c.eligible_visitors, c.signups, c.qualified], [10, 3, 1]);
  assert.equal(c.conversion, 0.3);
  assert.equal(c.decision, "INCONCLUSIVO", "menos de 300 visitantes nunca é NO-GO");
  assert.deepEqual(Object.keys(s.niches).sort(), [...W.WAITLIST_NICHES].sort());
  const out = JSON.stringify(s);
  const refs = psql("select contact_ref, contact from waitlist_signups");
  for (const needle of [...refs.map((x) => x.contact_ref), ...refs.map((x) => x.contact), "Daniela", "Eduardo", "exemplo.com", "98888", "@"]) assert.ok(!out.includes(needle), "vazou: " + needle);
  const allowed = new Set(["eligible_visitors", "signups", "qualified", "excluded_automation", "revoked", "conversion", "wilson95", "qualified_conversion", "qualified_wilson95", "decision"]);
  for (const n of Object.values(s.niches)) assert.deepEqual(Object.keys(n).filter((k) => !allowed.has(k)), [], "só campos agregados");
});

test("retenção: inscrição com mais de 12 meses é apagada (com evento), recente fica; roda 1x por dia", { skip }, async () => {
  reset();
  const env = ENV();
  await sub(env, { contato: "velha@exemplo.com" });
  await sub(env, { contato: "nova@exemplo.com" });
  psql("update waitlist_signups set created_at = now() - interval '13 months' where contact='velha@exemplo.com'");
  const out = await W.runWaitlistRetention(env, { sqlFactory });
  assert.deepEqual(out, { ok: true, erased: 1 });
  assert.deepEqual(psql("select contact from waitlist_signups"), [{ contact: "nova@exemplo.com" }]);
  assert.equal(Number(psql("select count(*)::int as n from waitlist_events where event='erased_retention'")[0].n), 1);
  assert.equal((await W.runWaitlistRetention(env, { sqlFactory })).skipped, "already_ran_today");
});

test("restrições do esquema: nicho fora da lista e referência fora do formato são recusados pelo banco", { skip }, async () => {
  reset();
  await W.ensureWaitlistSchema(sqlFactory());
  assert.throws(() => psql("insert into waitlist_signups (niche, contact_kind, contact, contact_ref, q_recurring, q_digital, consent_version, consent_at) values ('academia','email','x@y.com','" + "a".repeat(64) + "',true,true,'v',now())"));
  assert.throws(() => psql("insert into waitlist_signups (niche, contact_kind, contact, contact_ref, q_recurring, q_digital, consent_version, consent_at) values ('confeitaria','email','x@y.com','nao-hex',true,true,'v',now())"));
});

test("script de resumo (somente leitura) imprime agregados sem dado pessoal", { skip }, async () => {
  reset();
  const env = ENV();
  await sub(env, { contato: "script@exemplo.com", nome: "Fernanda" });
  await visit(env, { ip: "202.0.0.1" });
  const url = `postgresql://postgres@/${DB}?host=${encodeURIComponent(HOST)}&port=${PORT}`;
  const out = execFileSync(process.execPath, [path.join(ROOT, "scripts", "fase_a", "resumo.mjs"), "--since", "2026-01-01", "--until", "2999-12-31"], { encoding: "utf8", env: { ...process.env, DATABASE_URL: url } });
  const j = JSON.parse(out);
  assert.equal(j.niches.confeitaria.signups, 1);
  assert.equal(j.niches.confeitaria.eligible_visitors, 1);
  for (const needle of ["script@", "Fernanda", "exemplo.com", psql("select contact_ref from waitlist_signups")[0].contact_ref]) assert.ok(!out.includes(needle), "vazou: " + needle);
  assert.equal(count(), 1, "o script não altera dados");
});
