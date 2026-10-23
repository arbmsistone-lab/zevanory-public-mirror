import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readTextNormalized } from "./helpers/text.mjs";
import * as fwd from "../worker/support-email-forward.mjs";
import * as v2 from "../worker/sandbox-proof-v2.mjs";

// Sem rede, sem segredo real: assinatura Svix com segredo sintético, Resend e PostgreSQL falsos em memória.
const SECRET = "whsec_" + Buffer.from("segredo-sintetico-de-teste-32bytes!").toString("base64");
const OWNER = "dono-teste@example.org";
const NOW = 1_800_000_000_000;

function sign(body, { secret = SECRET, id = "msg_1", ts = Math.floor(NOW / 1000) } = {}) {
  const sig = createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${ts}.${body}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": String(ts), "svix-signature": `v1,${sig}` };
}
function req(event, opts = {}) {
  const body = typeof event === "string" ? event : JSON.stringify(event);
  const headers = { "content-type": "application/json", ...(opts.headers || sign(body, opts)) };
  return new Request("https://zevanory.api.br/api/webhooks/resend", { method: "POST", headers, body });
}
function received({ id = "em-1", to = ["suporte@zevanory.api.br"], from = "Cliente <cliente@example.com>", subject = "Não recebi o acesso" } = {}) {
  return { type: "email.received", created_at: "2026-10-23T12:00:00Z", data: { email_id: id, created_at: "2026-10-23T12:00:00Z", from, to, received_for: to, subject, message_id: "<abc@example.com>", attachments: [] } };
}

function fakeSql() {
  const rows = new Map();
  const db = {
    rows,
    down: false,
    async query(text, params = []) {
      if (db.down) throw new Error("db_down");
      const q = text.replace(/\s+/g, " ").trim();
      if (/^create (table|index)/.test(q)) return [];
      if (q.startsWith("insert into zevanory_support_inbound")) {
        const [id, alias, sender_hash] = params;
        const cur = rows.get(id);
        if (!cur) { rows.set(id, { email_id: id, alias, sender_hash, status: "claimed", attempts: 1, claimed_at: Date.now(), ack_sent_at: null }); return [{ email_id: id, attempts: 1 }]; }
        if (cur.status === "failed" || (cur.status === "claimed" && Date.now() - cur.claimed_at > 300000)) { cur.status = "claimed"; cur.attempts++; cur.claimed_at = Date.now(); return [{ email_id: id, attempts: cur.attempts }]; }
        return [];
      }
      if (q.includes("set status = 'failed'")) { const r = rows.get(params[0]); if (r && r.status === "claimed") r.status = "failed"; return []; }
      if (q.includes("set status = 'forwarded'")) { const r = rows.get(params[0]); r.status = "forwarded"; r.forward_id = params[1]; return []; }
      if (q.includes("set ack_status = 'sent'")) { const r = rows.get(params[0]); r.ack_sent_at = Date.now(); return []; }
      if (q.startsWith("select count(*)::int as n from zevanory_support_inbound where sender_hash")) return [{ n: [...rows.values()].filter((r) => r.sender_hash === params[0] && r.ack_sent_at).length }];
      if (q.startsWith("select count(*)::int as n from zevanory_support_inbound where ack_sent_at")) return [{ n: [...rows.values()].filter((r) => r.ack_sent_at).length }];
      throw new Error("query não prevista: " + q.slice(0, 80));
    }
  };
  return db;
}

function world({ detail = {}, sendStatus = 200 } = {}) {
  const sent = [], gets = [];
  const db = fakeSql();
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    assert.equal(u.hostname, "api.resend.com", "só a API do Resend (falsa) pode ser chamada");
    if ((init.method || "GET") === "GET") {
      gets.push({ path: u.pathname, auth: init.headers.authorization });
      const id = decodeURIComponent(u.pathname.split("/")[3]);
      return Response.json({ object: "email", id, subject: "Não recebi o acesso", text: "Corpo SECRETO do cliente", html: "<p>Corpo SECRETO do cliente</p>", headers: {}, ...detail });
    }
    const body = JSON.parse(init.body);
    sent.push({ body, idem: init.headers["idempotency-key"], auth: init.headers.authorization });
    return sendStatus === 200 ? Response.json({ id: "out-" + sent.length }) : new Response("{}", { status: sendStatus });
  };
  const env = { RESEND_WEBHOOK_SECRET: SECRET, RESEND_API_KEY: "re_send_only", RESEND_RECEIVING_API_KEY: "re_full_receiving", SUPPORT_FORWARD_TO: OWNER, DATABASE_URL: "postgres://fake" };
  return { env, db, sent, gets, fetchImpl, opts: { sqlFactory: () => db, fetchImpl, nowMs: NOW } };
}
const forwards = (w) => w.sent.filter((s) => s.body.to[0] === OWNER);
const acks = (w) => w.sent.filter((s) => s.body.to[0] !== OWNER);

test.beforeEach(() => fwd.resetSupportSchemaCache());

test("assinatura inválida, ausente, vencida ou sem segredo é recusada (401) sem nenhuma chamada externa", async () => {
  const w = world();
  const ev = received();
  const body = JSON.stringify(ev);
  const cases = [
    req(ev, { secret: "whsec_" + Buffer.from("outro-segredo-qualquer").toString("base64") }),
    req(ev, { headers: { "content-type": "application/json" } }),
    req(ev, { ts: Math.floor(NOW / 1000) - 301 }),
    new Request("https://zevanory.api.br/api/webhooks/resend", { method: "POST", headers: sign(body), body: body.replace("em-1", "em-X") })
  ];
  for (const r of cases) {
    const res = await fwd.handleSupportInboundWebhook(r, w.env, w.opts);
    assert.equal(res.status, 401);
  }
  const noSecret = await fwd.handleSupportInboundWebhook(req(ev), { ...w.env, RESEND_WEBHOOK_SECRET: "" }, w.opts);
  assert.equal(noSecret.status, 401);
  // Segredo fora do formato Svix (sem "whsec_") é recusado mesmo se a assinatura bater com ele.
  const odd = "xxxxxx" + SECRET.slice(6);
  const badFormat = await fwd.handleSupportInboundWebhook(req(ev, { secret: odd }), { ...w.env, RESEND_WEBHOOK_SECRET: odd }, w.opts);
  assert.equal(badFormat.status, 401);
  assert.equal(w.sent.length + w.gets.length, 0);
  assert.equal(w.db.rows.size, 0);
});

test("suporte@ é encaminhado uma vez ao destino configurado, com Reply-To do cliente, prefixo e sem conteúdo nos logs", async () => {
  const w = world();
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  let res;
  try { res = await fwd.handleSupportInboundWebhook(req(received()), w.env, w.opts); } finally { console.log = orig; }
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.forwarded, true);
  const f = forwards(w);
  assert.equal(f.length, 1);
  assert.deepEqual(f[0].body.to, [OWNER]);
  assert.deepEqual(f[0].body.reply_to, ["cliente@example.com"]);
  assert.equal(f[0].body.subject, "[ZEVANORY suporte] Não recebi o acesso");
  assert.match(f[0].body.from, /suporte@zevanory\.api\.br/);
  assert.match(f[0].body.text, /Corpo SECRETO do cliente/);
  assert.equal(f[0].idem, "support-fwd/em-1");
  assert.equal(f[0].auth, "Bearer re_send_only");
  assert.equal(w.gets[0].auth, "Bearer re_full_receiving", "leitura do recebido usa a chave de recebimento");
  assert.equal(w.db.rows.get("em-1").status, "forwarded");
  const joined = logs.join("\n");
  assert.ok(!/SECRETO|cliente@example|Não recebi|dono-teste/.test(joined), "log sem conteúdo, assunto ou endereço");
});

test("contato@ também é encaminhado; destino só via env ou KV privado, nunca no código", async () => {
  const w = world();
  const kv = { async get(k) { return k === fwd.FORWARD_TO_KV_KEY ? OWNER : null; } };
  const env = { ...w.env, SUPPORT_FORWARD_TO: "", ZEVANORY_PRIVATE_ARTIFACTS: kv };
  const res = await fwd.handleSupportInboundWebhook(req(received({ to: ["contato@zevanory.api.br"] })), env, w.opts);
  assert.equal(res.status, 200);
  assert.equal(forwards(w).length, 1);
  const none = world();
  const r2 = await fwd.handleSupportInboundWebhook(req(received()), { ...none.env, SUPPORT_FORWARD_TO: "" }, none.opts);
  assert.equal(r2.status, 503);
  assert.equal(none.sent.length, 0);
  const loop = world();
  const r3 = await fwd.handleSupportInboundWebhook(req(received()), { ...loop.env, SUPPORT_FORWARD_TO: "suporte@zevanory.api.br" }, loop.opts);
  assert.equal(r3.status, 503, "encaminhar para o próprio domínio seria laço");
  const src = readTextNormalized(new URL("../worker/support-email-forward.mjs", import.meta.url));
  assert.ok(!/gmail\.com/i.test(src), "endereço do dono não pode estar fixo no código");
});

test("mesmo email_id não é reencaminhado (retentativa do Resend)", async () => {
  const w = world();
  const a = await fwd.handleSupportInboundWebhook(req(received(), { id: "msg_a" }), w.env, w.opts);
  const b = await fwd.handleSupportInboundWebhook(req(received(), { id: "msg_b" }), w.env, w.opts);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal((await b.json()).duplicate, true);
  assert.equal(forwards(w).length, 1);
  assert.equal(acks(w).length, 1);
});

test("falha no envio marca failed (503) e a retentativa encaminha; banco fora => 503 sem encaminhar", async () => {
  const w = world({ sendStatus: 500 });
  const a = await fwd.handleSupportInboundWebhook(req(received()), w.env, w.opts);
  assert.equal(a.status, 503);
  assert.equal(w.db.rows.get("em-1").status, "failed");
  const ok = world();
  ok.db.rows.set("em-1", { ...w.db.rows.get("em-1") });
  const b = await fwd.handleSupportInboundWebhook(req(received()), ok.env, ok.opts);
  assert.equal(b.status, 200);
  assert.equal(forwards(ok).length, 1);
  const down = world();
  down.db.down = true;
  const c = await fwd.handleSupportInboundWebhook(req(received()), down.env, down.opts);
  assert.equal(c.status, 503);
  assert.equal(down.sent.length, 0);
});

test("confirmação automática: nunca para auto-resposta/bounce/no-reply/próprio domínio; máx. 1 por remetente/dia", async () => {
  const auto = [
    { detail: { headers: { "Auto-Submitted": "auto-replied" } } },
    { detail: { headers: [{ name: "Precedence", value: "bulk" }] } },
    { detail: { headers: { "List-Id": "<lista.example.com>" } } },
    { detail: { headers: { "Return-Path": "<>" } } },
    { from: "MAILER-DAEMON@example.com" },
    { from: "no-reply@loja.example" },
    { from: "contato@zevanory.api.br" },
    { from: OWNER },
    { detail: { subject: "Resposta automática: Não recebi o acesso" } }
  ];
  let i = 0;
  for (const c of auto) {
    const w = world({ detail: c.detail || {} });
    const res = await fwd.handleSupportInboundWebhook(req(received({ id: "auto-" + i++, from: c.from })), w.env, w.opts);
    assert.equal(res.status, 200);
    assert.equal(forwards(w).length, 1, "o dono recebe mesmo assim");
    assert.equal(acks(w).length, 0, JSON.stringify(c));
    assert.match((await res.json()).ack, /^skipped_/);
  }
  const w = world();
  await fwd.handleSupportInboundWebhook(req(received({ id: "h1" })), w.env, w.opts);
  await fwd.handleSupportInboundWebhook(req(received({ id: "h2", subject: "De novo" })), w.env, w.opts);
  assert.equal(forwards(w).length, 2);
  assert.equal(acks(w).length, 1);
  const ack = acks(w)[0];
  assert.equal(ack.body.headers["Auto-Submitted"], "auto-replied");
  assert.deepEqual(ack.body.to, ["cliente@example.com"]);
  assert.equal(ack.idem, "support-ack/h1");
  const off = world();
  const r = await fwd.handleSupportInboundWebhook(req(received()), { ...off.env, SUPPORT_AUTO_ACK: "false" }, off.opts);
  assert.equal((await r.json()).ack, "disabled");
  assert.equal(acks(off).length, 0);
});

test("prova-sandbox@, outros destinatários e eventos de entrega seguem para o handler legado (null), sem efeito", async () => {
  const w = world();
  for (const ev of [
    received({ to: [v2.SANDBOX_INBOX_ADDRESS] }),
    received({ to: ["vendas@zevanory.api.br"] }),
    { type: "email.delivered", data: { email_id: "x" } }
  ]) {
    const r = req(ev);
    assert.equal(await fwd.handleSupportInboundWebhook(r, w.env, w.opts), null);
    assert.equal(r.bodyUsed, false, "corpo original intacto para o handler legado");
  }
  assert.equal(w.sent.length + w.gets.length, 0);
  assert.equal(w.db.rows.size, 0);
  assert.equal(await fwd.handleSupportInboundWebhook(new Request("https://zevanory.api.br/api/webhooks/meta", { method: "POST", body: "{}" }), w.env, w.opts), null);
  const other = { to: "suporte@zevanory.api.br" };
  assert.equal(await v2.handleSandboxInboundEmail(other, {}), false, "Email Worker da sandbox inalterado");
});

test("Worker: rota interceptada antes do legado e dos carregamentos de WhatsApp", () => {
  const src = readTextNormalized(new URL("../worker/cloudflare-worker.compat.mjs", import.meta.url));
  const at = src.indexOf('url.pathname === "/api/webhooks/resend" && request.method === "POST"');
  assert.ok(at > 0);
  assert.ok(at < src.indexOf("const whatsappPath ="));
  assert.match(src.slice(at, at + 300), /handleSupportInboundWebhook\(request, normalized, \{ sqlFactory: whatsappProofDatabase \}\);\s*if \(support\) return support;/);
});
