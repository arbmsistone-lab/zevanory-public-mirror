// Formulário de atendimento com protocolo (worker/atendimento.mjs), complementar ao mailto oficial
// suporte@zevanory.api.br. Decreto 7.962/2013, art. 4º: confirmação imediata (tela + e-mail) e resposta
// em até 5 dias; arrependimento continua pela mesma ferramenta da compra (/pedir-reembolso).
// Prova (unidade): acessibilidade estrutural, fail-closed de configuração, protocolo por HMAC, estrutura
// atômica da outbox, isca anti-robô, nenhum log e nenhuma oferta de resposta por WhatsApp. Os cenários com
// estado rodam contra PostgreSQL real (tests/integration/atendimento-outbox-postgres.test.mjs).
// Mutantes: protocolo ausente, e-mail oficial ausente, resposta por WhatsApp, wa.me/número banido,
// telephone — todos mortos pelos verificadores deste arquivo.
import test from "node:test";
import assert from "node:assert/strict";
import { readTextNormalized } from "./helpers/text.mjs";
import { fileURLToPath } from "node:url";
import { handleAtendimento, formPage, confirmationPage, parseInput, protocolFor, drainAtendimentoOutbox, resendFailureIsTransient, ATENDIMENTO_SQL, MAX_ATTEMPTS, SEND_WINDOW_HOURS, TIPOS, RESPONSE_DAYS } from "../worker/atendimento.mjs";
import { handleRefundFlow } from "../worker/refund-flow.mjs";
import { FORWARD_TO_KV_KEY as SUPPORT_FORWARD_KEY } from "../worker/support-email-forward.mjs";
import { FORWARD_TO_KV_KEY } from "../worker/atendimento.mjs";

const PROTO = /ZEV-\d{8}-[0-9A-F]{10}/;
const WA = /wa\.me\/|api\.whatsapp\.com\/|whatsapp:\/\/|5588992545413|99254[-\s.]?5413/i;

function fakeKv() {
  const m = new Map();
  return {
    m,
    async get(k, o) { const v = m.has(k) ? m.get(k).v : null; if (v == null) return null; return (o === "json" || o?.type === "json") ? JSON.parse(v) : v; },
    async put(k, v, opt = {}) { m.set(k, { v: String(v), ttl: opt.expirationTtl }); },
    async list({ prefix = "" } = {}) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
  };
}
function withMail(fn, { ownerFails = false } = {}) {
  return async () => {
    const sent = [];
    const orig = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      sent.push(body);
      const isOwner = body.to[0] === "dono@example.com";
      return new Response("{}", { status: ownerFails && isOwner ? 500 : 200 });
    };
    try { await fn(sent); } finally { globalThis.fetch = orig; }
  };
}
const env = (kv = fakeKv()) => ({ ZEVANORY_PRIVATE_ARTIFACTS: kv, RESEND_API_KEY: "re_test", OWNER_ALERT_EMAIL: "dono@example.com" });
const form = (fields, ip = "203.0.113.7") => new Request("https://zevanory.api.br/api/atendimento", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip }, body: new URLSearchParams(fields).toString() });
const VALID = { tipo: "reclamacao", email: "Cliente.Teste@example.com", pedido: "", mensagem: "O link de download não abriu no meu computador." };
const NOW = Date.UTC(2026, 9, 23, 15, 0, 0);

// ---- verificadores (usados nos testes e nos mutantes) ----
export function formContract(html) {
  const v = [];
  if (!/<html lang="pt-BR">/.test(html)) v.push("lang");
  if (!html.includes('href="mailto:suporte@zevanory.api.br"')) v.push("e-mail oficial ausente");
  if (!html.includes('href="/pedir-reembolso"')) v.push("arrependimento pela ferramenta da compra ausente");
  for (const id of ["email", "pedido", "mensagem"]) if (!new RegExp(`<label[^>]*for="${id}"`).test(html) || !new RegExp(`id="${id}"`).test(html)) v.push("rótulo " + id);
  if (!/<fieldset[^>]*><legend>/.test(html)) v.push("fieldset/legend");
  for (const k of Object.keys(TIPOS)) if (!html.includes(`value="${k}"`)) v.push("tipo " + k);
  if (!/class="isca" aria-hidden="true"[\s\S]*?tabindex="-1"/.test(html)) v.push("isca acessível");
  if (!/name="robots" content="noindex"/.test(html)) v.push("noindex");
  v.push(...replyChannelViolations(html));
  return v;
}
export function confirmationContract(html) {
  const v = [];
  if (!PROTO.test(html)) v.push("protocolo ausente");
  if (!/role="status"/.test(html)) v.push("anúncio acessível");
  if (!html.includes("mailto:suporte@zevanory.api.br")) v.push("e-mail oficial ausente");
  v.push(...replyChannelViolations(html));
  return v;
}
// Nenhuma superfície do atendimento pode oferecer/afirmar resposta por WhatsApp, nem link/número.
export function replyChannelViolations(text) {
  const v = [];
  if (/whats\s?app|zap\b/i.test(text)) v.push("WhatsApp mencionado no atendimento");
  if (WA.test(text)) v.push("link/número de WhatsApp");
  if (/"telephone"|itemprop="telephone"|type="tel"/i.test(text)) v.push("telefone");
  return v;
}

test("GET /atendimento: formulário acessível, e-mail oficial, 4 tipos, isca, sem WhatsApp", async () => {
  const r = await handleAtendimento(new Request("https://zevanory.api.br/atendimento?tipo=reembolso"), env());
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const html = await r.text();
  assert.deepEqual(formContract(html), []);
  assert.match(html, /id="tipo-reembolso" name="tipo" value="reembolso" required checked/);
  assert.match(html, /<form method="post" action="\/api\/atendimento"/, "funciona sem JavaScript");
  assert.doesNotMatch(html, /<script/, "sem script (CSP e acessibilidade)");
  // também pelo despachante do reembolso (rota real do Worker central)
  const viaRefund = await handleRefundFlow(new Request("https://zevanory.api.br/atendimento"), env(), { sqlFactory: () => ({}) });
  assert.equal(viaRefund.status, 200);
  assert.deepEqual(formContract(await viaRefund.text()), []);
});

// Os cenários com estado (queda após o protocolo, falha e recuperação, teto de tentativas, dead-letter,
// drenos simultâneos e cotas concorrentes) rodam contra PostgreSQL REAL em
// tests/integration/atendimento-outbox-postgres.test.mjs (gate trava-vendas-integracao-postgres).
const CFG = { DATABASE_URL: "postgres://x", RESEND_API_KEY: "re_test", LEAD_PRIVACY_SECRET: "k".repeat(40), SUPPORT_FORWARD_TO: "dono@example.com" };
const noDb = () => ({ query: async () => { throw new Error("o banco não pode ser tocado"); } });

test("fail-closed (503, banco intocado): sem segredo, sem destino, destino no próprio domínio, sem banco ou sem Resend", withMail(async (sent) => {
  for (const env of [
    { ...CFG, LEAD_PRIVACY_SECRET: "" }, { ...CFG, LEAD_PRIVACY_SECRET: "x".repeat(31) },
    { ...CFG, SUPPORT_FORWARD_TO: "" }, { ...CFG, SUPPORT_FORWARD_TO: "contato@zevanory.api.br" }, { ...CFG, SUPPORT_FORWARD_TO: "não-é-email" },
    { ...CFG, DATABASE_URL: "" }, { ...CFG, RESEND_API_KEY: "" },
  ]) {
    const r = await handleAtendimento(form(VALID), env, { sqlFactory: noDb, now: NOW });
    assert.equal(r.status, 503, JSON.stringify(Object.keys(env).filter((k) => !env[k])));
    assert.deepEqual(replyChannelViolations(await r.text()), []);
  }
  const j = await handleAtendimento(new Request("https://zevanory.api.br/api/atendimento", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(VALID) }), { ...CFG, LEAD_PRIVACY_SECRET: "" }, { sqlFactory: noDb });
  assert.deepEqual(Object.keys(await j.json()).sort(), ["error", "message"], "503 não expõe o que falta");
  assert.equal(sent.length, 0);
}));

test("protocolo por HMAC com segredo: mesmo envio e dia => mesmo protocolo; outro segredo, dia ou conteúdo => outro", async () => {
  const i = parseInput(VALID);
  const a = await protocolFor("k".repeat(40), i, NOW);
  assert.match(a, /^ZEV-20261023-[0-9A-F]{10}$/);
  assert.equal(await protocolFor("k".repeat(40), { ...i, mensagem: i.mensagem.replace(" ", "   ") }, NOW + 3600e3), a, "espaços e mesmo dia");
  assert.notEqual(await protocolFor("j".repeat(40), i, NOW), a, "sem o segredo não se reproduz o protocolo");
  assert.notEqual(await protocolFor("k".repeat(40), i, NOW + 86400e3), a);
  assert.notEqual(await protocolFor("k".repeat(40), { ...i, tipo: "suporte" }, NOW), a);
});

test("estrutura da outbox: cota e gravação num único comando atômico, chaves de idempotência estáveis, sem log", () => {
  const src = readTextNormalized(fileURLToPath(new URL("../worker/atendimento.mjs", import.meta.url)));
  const admit = ATENDIMENTO_SQL.admit;
  assert.equal((admit.match(/on conflict \(bucket\) do update set n = zevanory_atendimento_quota\.n \+ 1 where zevanory_atendimento_quota\.n < \$\d/g) || []).length, 2, "duas cotas com teto no ON CONFLICT");
  assert.match(admit, /insert into zevanory_atendimento_outbox[\s\S]*from q2/, "linha só entra se as duas cotas passaram, no mesmo comando");
  assert.doesNotMatch(src, /ZEVANORY_PRIVATE_ARTIFACTS\.put|kv\.put/, "nada de cota/estado em KV (get/put não atômico)");
  assert.match(src, /`atendimento-owner\/\$\{protocolo\}`/);
  assert.match(src, /`atendimento-ack\/\$\{protocolo\}`/);
  assert.match(src, /`atendimento-dead\/\$\{d\.protocolo\}`/);
  assert.match(ATENDIMENTO_SQL.lease, /> now\(\) - interval '23 hours'\) as owner_window_ok/);
  assert.match(ATENDIMENTO_SQL.alertLease, /> now\(\) - interval '23 hours'\) as alert_window_ok/);
  assert.equal(SEND_WINDOW_HOURS, 23);
  assert.doesNotMatch(src, /console\./, "nenhum log (sem dado pessoal em log)");
  assert.ok(MAX_ATTEMPTS >= 3 && MAX_ATTEMPTS <= 12);
  assert.equal(FORWARD_TO_KV_KEY, SUPPORT_FORWARD_KEY, "mesmo destino do proprietário do suporte@ (#894)");
  assert.match(ATENDIMENTO_SQL.lease, /lease_until is null or lease_until < now\(\)/);
  assert.match(ATENDIMENTO_SQL.release, /payload = case when owner_status = 'sent' and customer_status = 'sent' then null/);
});

// Matriz explícita de classificação (resíduo Sol #892): 408 e 429 temporários (RFC 9110: 408 = o servidor
// desistiu de esperar; repetir com a mesma Idempotency-Key é seguro), demais 4xx permanentes.
const STATUS_MATRIX = Object.freeze({
  transient: Object.freeze([0, 408, 429, 500, 502, 503, 504, 599]),
  permanent: Object.freeze([400, 401, 403, 404, 405, 409, 410, 413, 422, 451]),
});
function assertStatusMatrix(classify) {
  for (const s of STATUS_MATRIX.transient) assert.equal(classify(s), true, "temporário: " + s);
  for (const s of STATUS_MATRIX.permanent) assert.equal(classify(s), false, "permanente: " + s);
}
test("Resend: rede/tempo esgotado, 408, 429 e 5xx são temporários; 400/401/403/404/409/422 são permanentes", () => {
  for (const s of [400, 401, 403, 404, 408, 409, 422, 429]) assert.ok(STATUS_MATRIX.transient.includes(s) !== STATUS_MATRIX.permanent.includes(s), "na matriz: " + s);
  assertStatusMatrix(resendFailureIsTransient);
});
test("mutantes da classificação: 4xx permanente virando temporário e 408 virando permanente — mortos por asserção", () => {
  const report = [];
  const mutants = [
    ...[400, 401, 403, 404, 409, 422].map((p) => [`C${p} ${p} como temporário`, (s) => s === p || resendFailureIsTransient(s)]),
    ["C408 408 como permanente", (s) => s !== 408 && resendFailureIsTransient(s)],
  ];
  for (const [name, mutant] of mutants) {
    let err = null;
    try { assertStatusMatrix(mutant); } catch (e) { err = e; }
    const killed = err?.code === "ERR_ASSERTION";
    report.push(`${name}: ${killed ? "KILLED" : "SURVIVED"}`);
    assert.ok(killed, name + " sobreviveu (ou falhou sem asserção)");
  }
  console.log("ATENDIMENTO_STATUS_MUTANTS " + report.join(" | "));
});

test("cron sem configuração: verde se não há envio parado, vermelho se houver", async () => {
  const stuck = (n) => () => ({ query: async (s) => (s.includes("/*atendimento:stuck*/") ? [{ n }] : []) });
  assert.equal((await drainAtendimentoOutbox({ DATABASE_URL: "x" }, { sqlFactory: stuck(0) })).ok, true);
  const red = await drainAtendimentoOutbox({ DATABASE_URL: "x" }, { sqlFactory: stuck(2) });
  assert.equal(red.ok, false);
  assert.ok(red.missing.includes("LEAD_PRIVACY_SECRET") && red.missing.includes("support-config:forward-to"));
  assert.equal((await drainAtendimentoOutbox({}, {})).ok, true, "sem banco não há outbox");
});

test("isca preenchida (robô): nada gravado, nenhum e-mail, nem configuração consultada", withMail(async (sent) => {
  const r = await handleAtendimento(form({ ...VALID, website: "http://spam.example" }), CFG, { sqlFactory: noDb, now: NOW });
  assert.equal(r.status, 200);
  assert.equal(sent.length, 0);
}));

test("validação acessível: erros com aria-invalid/aria-describedby, sem e-mail enviado nem banco", withMail(async (sent) => {
  const r = await handleAtendimento(form({ tipo: "", email: "x", pedido: "123", mensagem: "oi" }), CFG, { sqlFactory: noDb, now: NOW });
  assert.equal(r.status, 400);
  const html = await r.text();
  assert.match(html, /role="alert"/);
  for (const k of ["tipo", "email", "pedido", "mensagem"]) assert.match(html, new RegExp(`id="err-${k}"`), k);
  assert.match(html, /id="email"[^>]*aria-describedby="[^"]*err-email"[^>]*aria-invalid="true"/);
  assert.equal(sent.length, 0);
}));

test("confirmação: protocolo, prazo de 5 dias, aviso de reenvio automático quando o e-mail ainda não saiu", () => {
  const v = { protocolo: "ZEV-20261023-ABCDEF0123", tipo: "reembolso", recebido_em: new Date(NOW).toISOString(), responder_ate: new Date(NOW + RESPONSE_DAYS * 86400000).toISOString() };
  const sentHtml = confirmationPage(v, { emailSent: true });
  assert.deepEqual(confirmationContract(sentHtml), []);
  assert.match(sentHtml, /até <strong>28\/10\/2026<\/strong>/);
  assert.match(sentHtml, /href="\/pedir-reembolso"/);
  const pend = confirmationPage(v, { emailSent: false });
  assert.deepEqual(confirmationContract(pend), []);
  assert.match(pend, /reenviada automaticamente/);
});

test("mutantes: protocolo ausente, e-mail oficial ausente, resposta por WhatsApp, wa.me, número banido, telephone — mortos", () => {
  const formHtml = formPage();
  const conf = confirmationPage({ protocolo: "ZEV-20261023-ABCDEF0123", tipo: "suporte", recebido_em: new Date(NOW).toISOString(), responder_ate: new Date(NOW + 5 * 86400000).toISOString() });
  assert.deepEqual(formContract(formHtml), []);
  assert.deepEqual(confirmationContract(conf), []);
  const mutants = {
    "A1 confirmação sem protocolo": () => confirmationContract(conf.replace(PROTO, "")),
    "A2 formulário sem o e-mail oficial": () => formContract(formHtml.replaceAll('href="mailto:suporte@zevanory.api.br"', 'href="mailto:contato@zevanory.api.br"')),
    "A3 confirmação sem o e-mail oficial": () => confirmationContract(conf.replaceAll("mailto:suporte@zevanory.api.br", "mailto:contato@zevanory.api.br")),
    "A4 opção de resposta por WhatsApp": () => formContract(formHtml.replace("</fieldset>", '<label for="r">Responder por</label><select id="r" name="responder_por"><option>E-mail</option><option>WhatsApp</option></select></fieldset>')),
    "A5 confirmação promete resposta pelo WhatsApp": () => confirmationContract(conf.replace("pelo e-mail informado", "pelo WhatsApp informado")),
    "A6 link wa.me no atendimento": () => formContract(formHtml.replace("</form>", '<a href="https://wa.me/5588992545413">x</a></form>')),
    "A7 número banido no texto": () => confirmationContract(conf.replace("</div>", "<p>Ou ligue 88 99254-5413</p></div>")),
    "A8 campo de telefone": () => formContract(formHtml.replace("</form>", '<input type="tel" name="telefone"></form>')),
    "A9 sem arrependimento pela ferramenta da compra": () => formContract(formHtml.replace('href="/pedir-reembolso"', 'href="/atendimento"')),
  };
  const report = [];
  for (const [name, run] of Object.entries(mutants)) {
    const v = run();
    report.push(`${name}: ${v.length ? "KILLED" : "SURVIVED"}`);
    assert.ok(v.length > 0, name + " sobreviveu");
  }
  console.log("ATENDIMENTO_MUTANTS " + report.join(" | "));
});
