// Lista de espera real (worker/waitlist.mjs) contra PostgreSQL REAL (cada consulta num processo psql próprio: concorrência
// de verdade). Prova: dupla confirmação; nada sai com vendas fechadas; com vendas abertas UM aviso por contato (mesmo com
// dois produtos e execuções simultâneas) e os dados apagados na hora; falha de envio e queda depois de reservar sem 2º
// envio; saída apaga; retenção (pendente, 30 dias depois da abertura, teto de 365 dias, também com a flag desligada);
// separação do material gratuito (Sol AVAL 272, A272-02): abrir as vendas nunca transforma contato do checklist em
// destinatário do aviso ou de oferta sem o consentimento correspondente, e a nutrição nunca alcança contato só da lista.
// Rótulos [Pn.k] são usados pelos mutantes (scripts/ci/mutants_waitlist.py).
// Rodar: T4_PG_HOST=/var/tmp/pg/sock T4_PG_PORT=55433 node --test tests/integration/waitlist-postgres.test.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { handleWaitlist, runWaitlistNotify, runWaitlistRetention, waitlistOptOutLink, waitlistSubjectRef, WAITLIST_SQL, WAITLIST_CONSENT_VERSION, WAITLIST_HAS_DATA_KEY } from "../../worker/waitlist.mjs";
import { ensureLeadSchema, runLeadNurture, subjectRef, CONSENT_V2_VERSION } from "../../worker/lead-magnet.mjs";

const run = promisify(execFile);
const HOST = process.env.T4_PG_HOST, PORT = process.env.T4_PG_PORT || "5432";
const SKIP = !HOST && "T4_PG_HOST not set (throwaway local PostgreSQL required)";
const DB = process.env.WAITLIST_PG_DB || "ci_waitlist";
const lit = (v) => v === null || v === undefined ? "NULL" : Array.isArray(v) ? (v.length ? "ARRAY[" + v.map(lit).join(",") + "]" : "'{}'") : typeof v === "number" ? String(v) : typeof v === "boolean" ? (v ? "true" : "false") : "'" + String(v).replace(/'/g, "''") + "'";
const inline = (q, p) => q.replace(/\$(\d+)/g, (_, n) => lit(p[Number(n) - 1]));
const psqlSync = (sql, db = DB) => execFileSync("psql", ["-h", HOST, "-p", PORT, "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "-tA", "-c", sql], { encoding: "utf8" }).trim();
function parseCsv(text) {
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] === "" ? null : r[i]])));
}
const pgQuery = async (statement, params = []) => parseCsv((await run("psql", ["-h", HOST, "-p", PORT, "-U", "postgres", "-d", DB, "-v", "ON_ERROR_STOP=1", "-q", "--csv", "-c", inline(statement, params)], { encoding: "utf8" })).stdout);
const sqlFactory = () => ({ query: pgQuery });
const kv = () => { const m = new Map(); return { m, async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); } }; };
const SECRET = "w".repeat(40);
const env = (extra = {}) => ({ DATABASE_URL: "postgres://ci", RESEND_API_KEY: "re_ci", LEAD_PRIVACY_SECRET: SECRET, WAITLIST_ENABLED: "true", ZEVANORY_PRIVATE_ARTIFACTS: kv(), ...extra });

// Resend falso com Idempotency-Key (mesma chave => mesma entrega, sem nova mensagem).
function resend({ fail = () => false } = {}) {
  const calls = [], delivered = new Map();
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body); const key = init.headers["idempotency-key"] || init.headers["Idempotency-Key"];
    calls.push({ key, to: body.to[0], subject: body.subject, text: body.text });
    if (fail(body, key)) return new Response("{}", { status: 500 });
    if (!delivered.has(key)) delivered.set(key, { to: body.to[0], subject: body.subject, text: body.text });
    return new Response("{}", { status: 200 });
  };
  return { fetchImpl, calls, delivered, to: (a) => [...delivered.values()].filter((d) => d.to === a) };
}
const form = (o) => new URLSearchParams(o).toString();
const req = (path, method = "GET", body) => new Request("https://zevanory.api.br" + path, { method, ...(body ? { body, headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113." + Math.floor(Math.random() * 250) } } : {}) });
const wl = (r, e, m, salesOpen = false) => handleWaitlist(r, e, { sqlFactory, fetchImpl: m.fetchImpl, salesOpen });
async function signup(e, m, email, product) {
  const r = await wl(req("/lista-de-espera/inscrever", "POST", form({ email, produto: product, consentimento: "sim", versao_consentimento: WAITLIST_CONSENT_VERSION })), e, m);
  assert.equal(r.status, 200, await r.text());
  const mail = [...m.delivered.values()].reverse().find((d) => d.to === email.toLowerCase() && /^Confirme/.test(d.subject));
  return mail ? /\/lista-de-espera\/confirmar\?t=([0-9a-f]{64})/.exec(mail.text)?.[1] : null;
}
async function confirmToken(e, m, token) { return wl(req("/lista-de-espera/confirmar", "POST", form({ t: token })), e, m); }
async function joined(e, m, email, product) { const t = await signup(e, m, email, product); assert.ok(t, "[J1] token"); assert.equal((await confirmToken(e, m, t)).status, 200, "[J1] confirmação de " + email); }
const rows = (where = "true") => JSON.parse(psqlSync(`select coalesce(json_agg(w order by email, product), '[]') from zevanory_waitlist w where ${where}`));
const events = () => JSON.parse(psqlSync("select coalesce(json_agg(e order by id), '[]') from zevanory_waitlist_events e"));
const reset = () => psqlSync("truncate zevanory_waitlist, zevanory_waitlist_events, zevanory_waitlist_state; truncate zevanory_leads, zevanory_lead_events");
const notices = (m) => [...m.delivered.values()].filter((d) => /abriram/.test(d.subject));

before(async () => {
  if (SKIP) return;
  try { psqlSync(`drop database if exists ${DB}`, "postgres"); } catch {}
  psqlSync(`create database ${DB}`, "postgres");
  for (const s of WAITLIST_SQL.schema) await pgQuery(s);
  await ensureLeadSchema(sqlFactory());
});

test("P1 dupla confirmação: inscrição fica pendente, um e-mail de confirmação, confirmação por POST; registro sem e-mail em claro", { skip: SKIP }, async () => {
  reset(); const e = env(); const m = resend();
  const page = await (await wl(req("/lista-de-espera?produto=lucro-e-caixa"), e, m)).text();
  assert.match(page, /Avise-me quando as vendas do Lucro &amp; Caixa abrirem/);
  const token = await signup(e, m, "Ana@Example.com", "lucro-e-caixa");
  assert.equal(m.calls.length, 1, "[P1.1] um e-mail de confirmação");
  assert.ok(m.calls[0].text.includes("/lista-de-espera/sair?r="), "[P1.2] confirmação traz o link de saída");
  assert.deepEqual(rows().map((r) => [r.email, r.status, r.consent_version]), [["ana@example.com", "pending", WAITLIST_CONSENT_VERSION]], "[P1.3] pendente até confirmar");
  assert.equal(e.ZEVANORY_PRIVATE_ARTIFACTS.m.get(WAITLIST_HAS_DATA_KEY), "1");
  assert.equal((await wl(req("/lista-de-espera/confirmar?t=" + token), e, m)).status, 200);
  assert.equal(rows()[0].status, "pending", "[P1.4] GET não confirma (scanner de e-mail)");
  assert.equal((await confirmToken(e, m, token)).status, 200);
  assert.equal(rows()[0].status, "confirmed", "[P1.5]");
  assert.equal((await confirmToken(e, m, token)).status, 400, "[P1.6] link de uso único");
  assert.deepEqual(events().map((x) => x.event), ["consent_given", "confirmed"]);
  assert.doesNotMatch(JSON.stringify(events()), /example\.com/, "[P1.7] eventos sem e-mail");
  // Inscrição repetida de quem já confirmou: mesma resposta, nada enviado, nada muda.
  const before = m.calls.length;
  const again = await wl(req("/lista-de-espera/inscrever", "POST", form({ email: "ana@example.com", produto: "lucro-e-caixa", consentimento: "sim", versao_consentimento: WAITLIST_CONSENT_VERSION })), e, m);
  assert.equal(again.status, 200); assert.equal(m.calls.length, before, "[P1.8] sem e-mail para quem já está confirmado");
  assert.equal(rows()[0].status, "confirmed");
});

test("P2 vendas fechadas: nada é enviado, nem para confirmados, em várias execuções", { skip: SKIP }, async () => {
  reset(); const e = env(); const m = resend();
  await joined(e, m, "bia@example.com", "ia-na-pratica");
  const before = m.calls.length;
  for (let i = 0; i < 3; i++) { const out = await runWaitlistNotify(e, { sqlFactory, fetchImpl: m.fetchImpl, salesOpen: false }); assert.equal(out.sent, 0, "[P2.1]"); }
  for (const v of [undefined, null, "true", 1, {}]) assert.equal((await runWaitlistNotify(e, { sqlFactory, fetchImpl: m.fetchImpl, salesOpen: v })).sent, 0, "[P2.2] só salesOpen === true abre: " + JSON.stringify(v));
  assert.equal(m.calls.length, before, "[P2.3] nenhum e-mail");
  assert.equal(rows()[0].status, "confirmed");
});

test("P3 vendas abertas: UM aviso por contato (2 produtos, 5 execuções simultâneas), dados apagados na hora; pendente nunca é avisado", { skip: SKIP }, async () => {
  reset(); const e = env(); const m = resend();
  await joined(e, m, "caio@example.com", "lucro-e-caixa");
  await joined(e, m, "caio@example.com", "conteudo-pronto");
  await joined(e, m, "duda@example.com", "vendas-na-pratica");
  await signup(e, m, "pend@example.com", "ia-na-pratica"); // nunca confirmou
  const outs = await Promise.all(Array.from({ length: 5 }, () => runWaitlistNotify(e, { sqlFactory, fetchImpl: m.fetchImpl, salesOpen: true })));
  assert.equal(outs.reduce((n, o) => n + o.sent, 0), 2, "[P3.1] dois contatos, dois avisos");
  assert.equal(notices(m).filter((d) => d.to === "caio@example.com").length, 1, "[P3.2] um aviso para quem pediu dois produtos");
  const caio = notices(m).find((d) => d.to === "caio@example.com");
  assert.match(caio.text, /Lucro & Caixa/); assert.match(caio.text, /Conteúdo Pronto/);
  assert.match(caio.text, /Este é o único aviso/);
  assert.equal(notices(m).filter((d) => d.to === "pend@example.com").length, 0, "[P3.3] sem confirmação, sem aviso");
  assert.deepEqual(rows("email <> 'pend@example.com'"), [], "[P3.4] avisados apagados");
  assert.equal(events().filter((x) => x.event === "notified_and_erased").length, 3);
  const later = await runWaitlistNotify(e, { sqlFactory, fetchImpl: m.fetchImpl, salesOpen: true });
  assert.equal(later.sent, 0, "[P3.5] nada mais depois do aviso");
});

test("P4 A272-02: abrir as vendas nunca usa contatos do material gratuito como destinatários do aviso, e a nutrição nunca alcança contato só da lista", { skip: SKIP }, async () => {
  reset(); const e = env(); const m = resend();
  const old = new Date(Date.now() - 20 * 86400e3).toISOString();
  // Contatos do checklist (v1 e v2, confirmados, no passo da oferta), um deles também na lista de espera de outro produto.
  for (const [email, version, step] of [["lead1@example.com", "lead-magnet-v1-2026-10-07", 2], ["lead2@example.com", CONSENT_V2_VERSION, 3], ["ambos@example.com", "lead-magnet-v1-2026-10-07", 5]]) {
    psqlSync(`insert into zevanory_leads (email, email_hash, consent_version, consent_at, status, confirmed_at, nurture_step, nurture_at, subject_ref)
      values ('${email}', 'h', '${version}', now() - interval '20 days', 'confirmed', now() - interval '20 days', ${step}, '${old}', '${await subjectRef(e, email)}')`);
  }
  await joined(e, m, "so-lista@example.com", "negocio-completo");
  await joined(e, m, "ambos@example.com", "lucro-e-caixa");
  const leadsBefore = psqlSync("select string_agg(email || ':' || nurture_step || ':' || consent_version, ',' order by email) from zevanory_leads");
  await runWaitlistNotify(e, { sqlFactory, fetchImpl: m.fetchImpl, salesOpen: true });
  const recipients = notices(m).map((d) => d.to).sort();
  assert.deepEqual(recipients, ["ambos@example.com", "so-lista@example.com"], "[P4.1] aviso só para quem confirmou a lista de espera");
  assert.ok(!notices(m).some((d) => /lead[12]@/.test(d.to)), "[P4.2] contato do checklist nunca recebe o aviso");
  assert.doesNotMatch(notices(m).find((d) => d.to === "ambos@example.com").text, /Negócio Completo|IA na Prática|Vendas na Prática/, "[P4.3] o aviso fala só do produto pedido");
  assert.equal(psqlSync("select string_agg(email || ':' || nurture_step || ':' || consent_version, ',' order by email) from zevanory_leads"), leadsBefore, "[P4.4] a lista de espera não toca zevanory_leads");
  // Nutrição com vendas abertas: só contatos do checklist, cada um no limite do seu consentimento; nunca o contato só da lista.
  const nurtured = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { nurtured.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); };
  try {
    psqlSync(`update zevanory_leads set nurture_at = '${old}'`);
    await runLeadNurture({ ...e, DATABASE_URL: "postgres://ci" }, { sqlFactory, salesOpen: true });
  } finally { globalThis.fetch = realFetch; }
  assert.ok(!nurtured.some((x) => x.to[0] === "so-lista@example.com"), "[P4.5] contato só da lista nunca recebe e-mail do checklist");
  assert.ok(nurtured.every((x) => /lead[12]@example\.com/.test(x.to[0])), "[P4.6] nutrição só para contatos do checklist dentro do limite: " + nurtured.map((x) => x.to[0]));
  assert.equal(psqlSync("select nurture_step from zevanory_leads where email='lead1@example.com'"), "3", "[P4.7] v1 recebeu o 3º e-mail e parou no limite");
});

test("P5 falha de envio: volta para confirmado e a próxima execução envia uma única vez", { skip: SKIP }, async () => {
  reset(); const e = env(); let down = true;
  const m = resend({ fail: (body) => down && /abriram/.test(body.subject) });
  await joined(e, m, "eva@example.com", "combo-ia-vendas");
  const first = await runWaitlistNotify(e, { sqlFactory, fetchImpl: m.fetchImpl, salesOpen: true });
  assert.deepEqual([first.sent, first.failed], [0, 1]);
  assert.deepEqual(rows().map((r) => r.status), ["confirmed"], "[P5.1] falha libera a reserva");
  down = false;
  assert.equal((await runWaitlistNotify(e, { sqlFactory, fetchImpl: m.fetchImpl, salesOpen: true })).sent, 1, "[P5.2]");
  assert.equal(notices(m).length, 1, "[P5.3] um aviso"); assert.deepEqual(rows(), [], "[P5.3] apagado");
});

test("P6 queda depois de reservar: a reserva abandonada volta e a mesma Idempotency-Key impede o 2º aviso", { skip: SKIP }, async () => {
  reset(); const e = env(); const m = resend();
  await joined(e, m, "fe@example.com", "ia-na-pratica");
  // Primeira execução: o aviso sai, mas o processo morre antes de apagar (exclusão falha).
  const crashing = () => ({ query: async (s, p) => { if (/^delete from zevanory_waitlist where email=\$1 and status='notifying'/.test(s)) throw new Error("crash"); return pgQuery(s, p); } });
  await assert.rejects(runWaitlistNotify(e, { sqlFactory: crashing, fetchImpl: m.fetchImpl, salesOpen: true }), /crash/, "[P6.0] queda simulada na exclusão");
  assert.equal(notices(m).length, 1, "[P6.0] aviso saiu antes da queda");
  psqlSync("update zevanory_waitlist set notify_claimed_at = now() - interval '2 hours'");
  await runWaitlistNotify(e, { sqlFactory, fetchImpl: m.fetchImpl, salesOpen: true });
  assert.equal(new Set(m.calls.filter((c) => /abriram/.test(c.subject)).map((c) => c.key)).size, 1, "[P6.1] mesma chave nas duas tentativas");
  assert.equal(notices(m).length, 1, "[P6.2] uma única entrega");
  assert.deepEqual(rows(), [], "[P6.3] apagado depois");
});

test("P7 saída: o link apaga todos os produtos do contato; link adulterado não apaga nada", { skip: SKIP }, async () => {
  reset(); const e = env(); const m = resend();
  await joined(e, m, "gil@example.com", "lucro-e-caixa");
  await signup(e, m, "gil@example.com", "ia-na-pratica");
  await joined(e, m, "hugo@example.com", "lucro-e-caixa");
  const ref = await waitlistSubjectRef(e, "gil@example.com");
  const link = new URL(await waitlistOptOutLink(e, ref));
  const bad = await wl(req(link.pathname + "?r=" + ref + "&t=" + "0".repeat(32), "POST", "x=1"), e, m);
  assert.equal(bad.status, 400); assert.equal(rows("email='gil@example.com'").length, 2, "[P7.1] token errado não apaga");
  assert.equal((await wl(req(link.pathname + link.search), e, m)).status, 200);
  assert.equal(rows("email='gil@example.com'").length, 2, "[P7.2] GET não apaga");
  assert.equal((await wl(req(link.pathname + link.search, "POST", "x=1"), e, m)).status, 200);
  assert.deepEqual(rows("email='gil@example.com'"), [], "[P7.3] POST apaga tudo do contato");
  assert.equal(rows().length, 1, "outro contato intacto");
  assert.equal(events().filter((x) => x.event === "revoked_and_erased").length, 2);
});

test("P8 retenção: pendente expirado, 30 dias depois da abertura, teto de 365 dias; roda também com a lista desligada", { skip: SKIP }, async () => {
  reset(); const e = env(); const m = resend();
  await signup(e, m, "pend@example.com", "lucro-e-caixa");
  await joined(e, m, "teto@example.com", "lucro-e-caixa");
  await joined(e, m, "fica@example.com", "lucro-e-caixa");
  psqlSync("update zevanory_waitlist set token_expires_at = now() - interval '8 days' where email='pend@example.com'");
  psqlSync("update zevanory_waitlist set consent_at = now() - interval '366 days' where email='teto@example.com'");
  await runWaitlistRetention(e, sqlFactory(), { force: true });
  assert.deepEqual(rows().map((r) => r.email), ["fica@example.com"], "[P8.1] pendente expirado e teto apagados");
  // 30 dias depois de as vendas abrirem, o que não pôde ser avisado é apagado.
  psqlSync("insert into zevanory_waitlist_state (k, v) values ('sales_open_since', now() - interval '31 days')");
  await runWaitlistRetention(e, sqlFactory(), { force: true });
  assert.deepEqual(rows(), [], "[P8.2] apagado 30 dias depois da abertura");
  // Lista desligada com dados de antes: o job ainda apaga (sem enviar).
  await joined(e, m, "resto@example.com", "lucro-e-caixa");
  psqlSync("delete from zevanory_waitlist_state; update zevanory_waitlist set consent_at = now() - interval '400 days'");
  const off = env({ WAITLIST_ENABLED: "" }); off.ZEVANORY_PRIVATE_ARTIFACTS.m.set(WAITLIST_HAS_DATA_KEY, "1");
  const before = m.calls.length;
  const out = await runWaitlistNotify(off, { sqlFactory, fetchImpl: m.fetchImpl, salesOpen: true });
  assert.equal(out.sent, 0, "[P8.3] desligada não envia (contador)"); assert.equal(m.calls.length, before, "[P8.3] desligada não envia");
  assert.deepEqual(rows(), [], "[P8.4] desligada ainda apaga pela retenção");
  // Fechar as vendas apaga o marco da abertura (a próxima abertura recomeça a contagem).
  psqlSync("insert into zevanory_waitlist_state (k, v) values ('sales_open_since', now())");
  await runWaitlistNotify(env(), { sqlFactory, fetchImpl: m.fetchImpl, salesOpen: false });
  assert.equal(psqlSync("select count(*) from zevanory_waitlist_state"), "0", "[P8.5]");
});

test("P9 vendas abertas: a inscrição não guarda nada", { skip: SKIP }, async () => {
  reset(); const e = env(); const m = resend();
  const r = await wl(req("/lista-de-espera/inscrever", "POST", form({ email: "ivo@example.com", produto: "lucro-e-caixa", consentimento: "sim", versao_consentimento: WAITLIST_CONSENT_VERSION })), e, m, true);
  assert.equal(r.status, 200); assert.deepEqual(rows(), [], "[P9.1]"); assert.equal(m.calls.length, 0);
});
