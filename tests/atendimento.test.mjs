// Formulário de atendimento com protocolo (worker/atendimento.mjs), complementar ao mailto oficial
// suporte@zevanory.api.br. Decreto 7.962/2013, art. 4º: confirmação imediata (tela + e-mail) e resposta
// em até 5 dias; arrependimento continua pela mesma ferramenta da compra (/pedir-reembolso).
// Prova: acessibilidade estrutural, protocolo idempotente, confirmação na tela e por e-mail, dados mínimos
// (sem e-mail completo nem mensagem guardados quando o alerta ao proprietário sai), isca anti-robô,
// limite por IP, nenhum log com dado pessoal e nenhuma oferta de resposta por WhatsApp.
// Mutantes: protocolo ausente, e-mail oficial ausente, resposta por WhatsApp, wa.me/número banido,
// telephone — todos mortos pelos verificadores deste arquivo.
import test from "node:test";
import assert from "node:assert/strict";
import { handleAtendimento, formPage, confirmationPage, TIPOS, RESPONSE_DAYS } from "../worker/atendimento.mjs";
import { handleRefundFlow } from "../worker/refund-flow.mjs";

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

test("POST: protocolo imediato na tela e por e-mail, prazo de 5 dias, dados mínimos, sem log", withMail(async (sent) => {
  const kv = fakeKv();
  const logs = [];
  const saved = {};
  for (const k of ["log", "info", "warn", "error", "debug"]) { saved[k] = console[k]; console[k] = (...a) => logs.push(a); }
  let r;
  try { r = await handleAtendimento(form(VALID), env(kv), { now: NOW }); } finally { Object.assign(console, saved); }
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.deepEqual(confirmationContract(html), []);
  const proto = html.match(PROTO)[0];
  assert.match(proto, /^ZEV-20261023-/);
  assert.match(html, new RegExp(`até <strong>28/10/2026</strong>`), RESPONSE_DAYS + " dias");
  assert.equal(logs.length, 0, "nenhum log (sem dado pessoal em log)");
  assert.equal(sent.length, 2);
  const [owner, customer] = sent;
  assert.equal(owner.to[0], "dono@example.com");
  assert.equal(owner.reply_to, "cliente.teste@example.com", "proprietário responde direto ao cliente por e-mail");
  assert.ok(owner.subject.includes(proto) && owner.text.includes(VALID.mensagem));
  assert.equal(customer.to[0], "cliente.teste@example.com");
  assert.ok(customer.subject.includes(proto) && customer.text.includes("28/10/2026"));
  assert.equal(customer.from, "ZEVANORY <suporte@zevanory.api.br>");
  assert.deepEqual(replyChannelViolations(customer.text + owner.text), []);
  // Dados mínimos: nada de e-mail completo nem mensagem no armazenamento.
  const stored = [...kv.m.entries()].filter(([k]) => !k.includes(":rate:"));
  assert.ok(stored.some(([k]) => k === `atendimento:protocolo:${proto}`));
  for (const [k, { v, ttl }] of stored) {
    assert.ok(!v.includes("cliente.teste@example.com") && !v.includes("download não abriu"), "sem PII/conteúdo em " + k);
    assert.ok(ttl > 0, "com prazo de retenção: " + k);
  }
  assert.ok(!kv.m.has(`atendimento:alerta-pendente:${proto}`));
}));

test("protocolo idempotente: reenvio idêntico devolve o mesmo protocolo e não reenvia e-mails", withMail(async (sent) => {
  const kv = fakeKv();
  const a = await (await handleAtendimento(form(VALID), env(kv), { now: NOW })).text();
  const b = await (await handleAtendimento(form({ ...VALID, email: "cliente.teste@example.com" }), env(kv), { now: NOW + 60000 })).text();
  assert.equal(a.match(PROTO)[0], b.match(PROTO)[0]);
  assert.equal(sent.length, 2, "e-mails só no primeiro envio");
  const c = await (await handleAtendimento(form({ ...VALID, mensagem: VALID.mensagem + " Segue o erro." }), env(kv), { now: NOW })).text();
  assert.notEqual(c.match(PROTO)[0], a.match(PROTO)[0], "solicitação diferente => protocolo novo");
}));

test("JSON: protocolo, prazo e canal de resposta por e-mail", withMail(async () => {
  const r = await handleAtendimento(new Request("https://zevanory.api.br/api/atendimento", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...VALID, tipo: "cancelamento" }) }), env(), { now: NOW });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.match(j.protocolo, PROTO);
  assert.equal(j.canal_resposta, "email");
  assert.equal(j.email_confirmacao, "enviado");
  assert.equal(new Date(j.responder_ate) - new Date(j.recebido_em), RESPONSE_DAYS * 86400000);
}));

test("reembolso: confirmação aponta para a mesma ferramenta da compra (/pedir-reembolso)", withMail(async (sent) => {
  const html = await (await handleAtendimento(form({ ...VALID, tipo: "reembolso" }), env(), { now: NOW })).text();
  assert.match(html, /href="\/pedir-reembolso"/);
  assert.ok(sent[1].text.includes("https://zevanory.api.br/pedir-reembolso"));
}));

test("isca preenchida (robô): nada gravado, nenhum e-mail", withMail(async (sent) => {
  const kv = fakeKv();
  const r = await handleAtendimento(form({ ...VALID, website: "http://spam.example" }), env(kv), { now: NOW });
  assert.equal(r.status, 200);
  assert.equal(sent.length, 0);
  assert.equal(kv.m.size, 0);
}));

test("validação acessível: erros com aria-invalid/aria-describedby, sem e-mail enviado", withMail(async (sent) => {
  const r = await handleAtendimento(form({ tipo: "", email: "x", pedido: "123", mensagem: "oi" }), env(), { now: NOW });
  assert.equal(r.status, 400);
  const html = await r.text();
  assert.match(html, /role="alert"/);
  for (const k of ["tipo", "email", "pedido", "mensagem"]) assert.match(html, new RegExp(`id="err-${k}"`), k);
  assert.match(html, /id="email"[^>]*aria-describedby="[^"]*err-email"[^>]*aria-invalid="true"/);
  assert.equal(sent.length, 0);
}));

test("limite por IP (anti-spam) e alerta ao proprietário que falha guarda o conteúdo só por 14 dias", withMail(async (sent) => {
  const kv = fakeKv();
  for (let i = 0; i < 5; i++) assert.equal((await handleAtendimento(form({ ...VALID, email: `c${i}@example.com` }), env(kv), { now: NOW })).status, 200);
  const r = await handleAtendimento(form({ ...VALID, email: "c6@example.com" }), env(kv), { now: NOW });
  assert.equal(r.status, 429, "6º envio do mesmo IP na mesma hora");
  // limite por e-mail (4/dia), vindo de IPs diferentes
  const kv2 = fakeKv();
  for (let i = 0; i < 4; i++) assert.equal((await handleAtendimento(form({ ...VALID, mensagem: VALID.mensagem + " #" + i }, "198.51.100." + i), env(kv2), { now: NOW })).status, 200);
  assert.equal((await handleAtendimento(form({ ...VALID, mensagem: VALID.mensagem + " #9" }, "198.51.100.9"), env(kv2), { now: NOW })).status, 429, "5º envio do mesmo e-mail no dia");
  assert.equal(r.status, 429);
  assert.deepEqual(replyChannelViolations(await r.text()), []);
  const pend = [...kv.m.entries()].filter(([k]) => k.startsWith("atendimento:alerta-pendente:"));
  assert.equal(pend.length, 5);
  for (const [, { ttl }] of pend) assert.equal(ttl, 14 * 24 * 3600);
  assert.equal(sent.filter((s) => /^c\d@example\.com$/.test(s.to[0])).length, 5, "cliente confirmado mesmo com o alerta falhando");
}, { ownerFails: true }));

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
