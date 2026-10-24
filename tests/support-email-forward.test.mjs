import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readTextNormalized } from "./helpers/text.mjs";
import * as fwd from "../worker/support-email-forward.mjs";
import * as v2 from "../worker/sandbox-proof-v2.mjs";

// Sem rede, sem segredo real: assinatura Svix com segredo sintético; Resend e PostgreSQL falsos em memória
// (o PostgreSQL falso implementa a semântica de cada comando marcado /*support:...*/, com relógio controlado).
const SECRET = "whsec_" + Buffer.from("segredo-sintetico-de-teste-32bytes!").toString("base64");
const PRIVACY = "privacidade-sintetica-de-teste-0123456789abcdef";
const OWNER = "dono-teste@example.org";
const CUSTOMER = "cliente@example.com";
const T0 = 1_800_000_000_000;

function sign(body, { secret = SECRET, id = "msg_1", ts } = {}) {
  const t = ts ?? Math.floor(T0 / 1000);
  const sig = createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${t}.${body}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": String(t), "svix-signature": `v1,${sig}` };
}
function req(event, opts = {}) {
  const body = typeof event === "string" ? event : JSON.stringify(event);
  return new Request("https://zevanory.api.br/api/webhooks/resend", { method: "POST", headers: { "content-type": "application/json", ...(opts.headers || sign(body, opts)) }, body });
}
function received({ id = "em-1", to = ["suporte@zevanory.api.br"], from = `Cliente <${CUSTOMER}>` } = {}) {
  return { type: "email.received", created_at: "2026-10-23T12:00:00Z", data: { email_id: id, from, to, received_for: to, subject: "Não recebi o acesso", message_id: "<abc@example.com>", attachments: [] } };
}

function fakeSql(clock) {
  const rows = new Map(), quota = new Map(), alerts = new Map();
  const db = {
    rows, quota, alerts, statements: [], failTag: null,
    async query(text, params = []) {
      const tag = (/\/\*support:([a-z_]+)\*\//.exec(text) || [])[1];
      assert.ok(tag, "comando sem marca: " + text.slice(0, 60));
      db.statements.push(tag);
      if (db.failTag === tag) throw new Error("db_fail");
      const now = clock.now;
      const r = rows.get(params[0]);
      const pending = (x) => x && (x.state === "forward_pending" || x.state === "ack_pending");
      switch (tag) {
        case "schema": return [];
        case "record":
          if (r) return [];
          rows.set(params[0], { email_id: params[0], alias: params[1], sender_ref: params[2], state: "forward_pending", attempts: 0, next: now, lease: null, ack_status: null, created: now, alerted: false });
          return [{ email_id: params[0] }];
        case "lease":
          if (!pending(r) || r.next > now || (r.lease !== null && r.lease >= now)) return [];
          if (!(r.attempts < Number(params[1])) || !(r.created > now - Number(params[2]) * 3600000)) return [];
          r.lease = now + 120000; r.attempts++;
          return [{ state: r.state, alias: r.alias, attempts: r.attempts, sender_ref: r.sender_ref, age_s: Math.floor((now - r.created) / 1000) }];
        case "retry":
          if (pending(r)) { r.lease = null; r.next = now + Number(params[1]) * 60000; if (params[2] === true) r.state = r.state === "forward_pending" ? "forward_dead" : "ack_dead"; }
          return [];
        case "forwarded_no_ack":
          if (r?.state === "forward_pending") Object.assign(r, { state: "done", ack_status: params[1], forward_id: params[2], lease: null, attempts: 0, next: now });
          return [];
        case "forwarded_reserve_ack": {
          if (r?.state !== "forward_pending") return [];
          const sKey = `s:${r.sender_ref}|${params[1]}`, gKey = `all|${params[1]}`;
          const s = !quota.has(sKey);
          if (s) quota.set(sKey, 1);
          let g = false;
          if (s) { const n = quota.get(gKey); if (n === undefined) { quota.set(gKey, 1); g = true; } else if (n < Number(params[2])) { quota.set(gKey, n + 1); g = true; } }
          Object.assign(r, { state: g ? "ack_pending" : "done", ack_status: g ? "pending" : s ? "rate_limited_daily" : "rate_limited_sender", lease: g ? now + 120000 : null, attempts: g ? 1 : 0, forward_id: params[3], next: now });
          return [{ state: r.state, ack_status: r.ack_status }];
        }
        case "acked":
          if (r?.state === "ack_pending") Object.assign(r, { state: "done", ack_status: "sent", lease: null });
          return [];
        case "due":
          return [...rows.values()].filter((x) => pending(x) && x.next <= now && (x.lease === null || x.lease < now) && x.attempts < Number(params[1]) && x.created > now - Number(params[2]) * 3600000).sort((a, b) => a.next - b.next).slice(0, Number(params[0])).map((x) => ({ email_id: x.email_id }));
        case "reap":
          for (const x of rows.values()) if (pending(x) && (x.lease === null || x.lease < now) && (x.attempts >= Number(params[0]) || x.created <= now - Number(params[1]) * 3600000)) { x.state = x.state === "forward_pending" ? "forward_dead" : "ack_dead"; x.lease = null; }
          return [];
        case "stats": {
          const all = [...rows.values()];
          const pend = all.filter(pending);
          return [{ dead_new: all.filter((x) => /_dead$/.test(x.state) && !x.alerted).length, pending: pend.length, oldest_min: pend.length ? Math.floor((now - Math.min(...pend.map((x) => x.created))) / 60000) : 0 }];
        }
        case "alert_reserve": {
          const last = alerts.get(params[0]);
          if (last !== undefined && !(last < now - Number(params[1]) * 3600000)) return [];
          alerts.set(params[0], now);
          return [{ kind: params[0] }];
        }
        case "alert_release": alerts.set(params[0], 0); return [];
        case "dead_alerted": for (const x of rows.values()) if (/_dead$/.test(x.state)) x.alerted = true; return [];
        default: throw new Error("comando não previsto " + tag);
      }
    }
  };
  return db;
}

function world({ details = {}, attachments = null } = {}) {
  const clock = { now: T0 };
  const db = fakeSql(clock);
  const sent = [], attempts = [], gets = [];
  const fail = { forward: 0, ack: 0, read: 0, alert: 0, forward409: 0 };
  const realNow = Date.now;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    assert.equal(u.hostname, "api.resend.com", "só a API do Resend (falsa) pode ser chamada");
    if ((init.method || "GET") === "GET") {
      gets.push({ path: u.pathname, auth: init.headers.authorization });
      if (fail.read > 0) { fail.read--; return new Response("{}", { status: 500 }); }
      const id = decodeURIComponent(u.pathname.split("/")[3]);
      if (u.pathname.endsWith("/attachments")) return Response.json({ data: attachments || [] });
      return Response.json({ object: "email", id, from: `Cliente <${CUSTOMER}>`, created_at: "2026-10-23T12:00:00Z", subject: "Não recebi o acesso", message_id: "<abc@example.com>", text: "Corpo SECRETO do cliente", html: "<p>Corpo SECRETO do cliente</p>", headers: {}, attachments: attachments ? attachments.map((a) => ({ id: a.id })) : [], ...(details[id] || details["*"] || {}) });
    }
    const body = JSON.parse(init.body);
    const kind = body.to[0] !== OWNER ? "ack" : /^\[ZEVANORY suporte\] ALERTA/.test(body.subject) ? "alert" : "forward";
    attempts.push({ kind, body, idem: init.headers["idempotency-key"] });
    if (kind === "forward" && fail.forward409 > 0) { fail.forward409--; return Response.json({ name: "invalid_idempotent_request", message: "x" }, { status: 409 }); }
    if (fail[kind] > 0) { fail[kind]--; return new Response("{}", { status: 500 }); }
    sent.push({ kind, body, idem: init.headers["idempotency-key"], auth: init.headers.authorization });
    return Response.json({ id: "out-" + sent.length });
  };
  void realNow;
  const env = { RESEND_WEBHOOK_SECRET: SECRET, RESEND_API_KEY: "re_send_only", RESEND_RECEIVING_API_KEY: "re_full_receiving", SUPPORT_FORWARD_TO: OWNER, LEAD_PRIVACY_SECRET: PRIVACY, DATABASE_URL: "postgres://fake" };
  const opts = () => ({ sqlFactory: () => db, fetchImpl, nowMs: clock.now });
  const hook = (r, e = env) => fwd.handleSupportInboundWebhook(r, e, opts());
  const drain = (e = env) => fwd.drainSupportOutbox(e, { ...opts(), limit: 5 });
  return { env, db, clock, sent, attempts, gets, fail, fetchImpl, opts, hook, drain };
}
const forwards = (w) => w.sent.filter((s) => s.kind === "forward");
const acks = (w) => w.sent.filter((s) => s.kind === "ack");
const alerts = (w) => w.sent.filter((s) => s.kind === "alert");
const advance = (w, minutes) => { w.clock.now += minutes * 60000; };

test.beforeEach(() => fwd.resetSupportSchemaCache());

test("assinatura inválida, ausente, vencida, sem segredo ou fora do formato é recusada (401) sem efeito", async () => {
  const w = world();
  const ev = received();
  const body = JSON.stringify(ev);
  const odd = "xxxxxx" + SECRET.slice(6);
  const cases = [
    [req(ev, { secret: "whsec_" + Buffer.from("outro-segredo-qualquer").toString("base64") }), w.env],
    [req(ev, { headers: { "content-type": "application/json" } }), w.env],
    [req(ev, { ts: Math.floor(T0 / 1000) - 301 }), w.env],
    [new Request("https://zevanory.api.br/api/webhooks/resend", { method: "POST", headers: sign(body), body: body.replace("em-1", "em-X") }), w.env],
    [req(ev), { ...w.env, RESEND_WEBHOOK_SECRET: "" }],
    [req(ev, { secret: odd }), { ...w.env, RESEND_WEBHOOK_SECRET: odd }]
  ];
  for (const [r, e] of cases) assert.equal((await w.hook(r, e)).status, 401);
  assert.equal(w.attempts.length + w.gets.length + w.db.rows.size, 0);
});

test("suporte@: encaminhado uma vez de suporte@ (Reply-To cliente, prefixo) e confirmado uma vez; dono nunca exposto; logs limpos", async () => {
  const w = world();
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  let res;
  try { res = await w.hook(req(received())); } finally { console.log = orig; }
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.state, "done");
  assert.equal(out.ack, "sent");
  const [f] = forwards(w);
  assert.equal(forwards(w).length, 1);
  assert.deepEqual(f.body.to, [OWNER]);
  assert.equal(f.body.from, "ZEVANORY suporte <suporte@zevanory.api.br>");
  assert.deepEqual(f.body.reply_to, [CUSTOMER]);
  assert.equal(f.body.subject, "[ZEVANORY suporte] Não recebi o acesso");
  assert.equal(f.idem, "support-fwd/em-1");
  assert.equal(f.auth, "Bearer re_send_only");
  assert.equal(w.gets[0].auth, "Bearer re_full_receiving");
  const [a] = acks(w);
  assert.equal(acks(w).length, 1);
  assert.deepEqual(a.body.to, [CUSTOMER]);
  assert.equal(a.body.from, "ZEVANORY suporte <suporte@zevanory.api.br>");
  assert.deepEqual(a.body.reply_to, ["suporte@zevanory.api.br"]);
  assert.equal(a.idem, "support-ack/em-1");
  assert.equal(a.body.headers["Auto-Submitted"], "auto-replied");
  assert.ok(!JSON.stringify(a.body).includes(OWNER), "confirmação não revela o endereço do dono");
  assert.equal(w.db.rows.get("em-1").state, "done");
  assert.ok(!/SECRETO|cliente@example|Não recebi|dono-teste/.test(logs.join("\n")), "log sem conteúdo, assunto ou endereço");
});

test("contato@ e destino via KV; destino ausente ou no próprio domínio => 503; nada fixo no código", async () => {
  const w = world();
  const kv = { async get(k) { return k === fwd.FORWARD_TO_KV_KEY ? OWNER : null; } };
  assert.equal((await w.hook(req(received({ to: ["contato@zevanory.api.br"] })), { ...w.env, SUPPORT_FORWARD_TO: "", ZEVANORY_PRIVATE_ARTIFACTS: kv })).status, 200);
  assert.equal(forwards(w).length, 1);
  for (const dest of ["", "suporte@zevanory.api.br"]) {
    const x = world();
    const r = await x.hook(req(received()), { ...x.env, SUPPORT_FORWARD_TO: dest });
    assert.equal(r.status, 503);
    assert.equal(x.attempts.length + x.db.rows.size, 0);
  }
  assert.ok(!/gmail\.com/i.test(readTextNormalized(new URL("../worker/support-email-forward.mjs", import.meta.url))));
});

test("remetente pseudonimizado com HMAC (LEAD_PRIVACY_SECRET); sem segredo => 503, nunca hash simples", async () => {
  const w = world();
  await w.hook(req(received()));
  const ref = w.db.rows.get("em-1").sender_ref;
  const expected = createHmac("sha256", "zevanory-support-sender-v1:" + PRIVACY).update("sender:" + CUSTOMER).digest("hex").slice(0, 40);
  assert.equal(ref, expected);
  assert.notEqual(ref, createHash("sha256").update(CUSTOMER).digest("hex").slice(0, 40));
  assert.ok(![...w.db.quota.keys()].some((k) => k.includes("cliente")));
  for (const bad of ["", "curto-demais"]) {
    const x = world();
    const r = await x.hook(req(received()), { ...x.env, LEAD_PRIVACY_SECRET: bad });
    assert.equal(r.status, 503);
    assert.equal(x.db.rows.size + x.attempts.length, 0);
  }
});

test("redelivery do mesmo email_id depois de concluído: duplicado, nenhum envio novo", async () => {
  const w = world();
  await w.hook(req(received(), { id: "a" }));
  const b = await w.hook(req(received(), { id: "b" }));
  assert.equal(b.status, 200);
  assert.equal((await b.json()).duplicate, true);
  advance(w, 600);
  await w.drain();
  assert.equal(forwards(w).length, 1);
  assert.equal(acks(w).length, 1);
});

test("falha no encaminhamento: registro durável, recuo, cron encaminha exatamente uma vez e confirma uma vez", async () => {
  const w = world();
  w.fail.forward = 1;
  const r = await w.hook(req(received()));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).state, "forward_pending");
  assert.equal(forwards(w).length + acks(w).length, 0);
  await w.hook(req(received(), { id: "redelivery" }));
  assert.equal(w.attempts.length, 1, "redelivery durante o recuo não reenvia");
  advance(w, 3);
  const d = await w.drain();
  assert.equal(d.done, 1);
  advance(w, 600);
  await w.drain();
  await w.hook(req(received(), { id: "late", ts: Math.floor(w.clock.now / 1000) }));
  assert.equal(forwards(w).length, 1);
  assert.equal(acks(w).length, 1);
  assert.ok(w.attempts.filter((x) => x.kind === "forward").every((x) => x.idem === "support-fwd/em-1"));
});

test("falha na confirmação depois do encaminhamento: fica ack_pending e a recuperação envia exatamente uma confirmação", async () => {
  const w = world();
  w.fail.ack = 2;
  const r = await w.hook(req(received()));
  assert.equal((await r.json()).state, "ack_pending");
  assert.equal(forwards(w).length, 1);
  assert.equal(acks(w).length, 0);
  assert.equal(w.db.rows.get("em-1").state, "ack_pending");
  await w.hook(req(received(), { id: "redelivery" }));
  assert.equal(acks(w).length, 0, "redelivery em recuo não força a confirmação");
  advance(w, 3);
  await w.drain();
  assert.equal(acks(w).length, 0);
  advance(w, 10);
  await w.drain();
  advance(w, 600);
  await w.drain();
  await w.hook(req(received(), { id: "late", ts: Math.floor(w.clock.now / 1000) }));
  assert.equal(forwards(w).length, 1, "o encaminhamento nunca se repete por causa da confirmação");
  assert.equal(acks(w).length, 1);
  assert.ok(w.attempts.filter((x) => x.kind === "ack").every((x) => x.idem === "support-ack/em-1"));
  assert.equal(w.db.rows.get("em-1").state, "done");
});

test("lease impede processamento concorrente; tentativas esgotadas => forward_dead e o cron para", async () => {
  const w = world();
  w.fail.forward = 1000;
  await w.hook(req(received()));
  const row = w.db.rows.get("em-1");
  row.next = w.clock.now; row.lease = w.clock.now + 60000;
  const c = { sql: w.db, env: w.env };
  assert.deepEqual(await fwd.processSupportEmail(c, "em-1"), { state: "not_due" });
  row.lease = null;
  for (let i = 0; i < 40 && row.state === "forward_pending"; i++) { w.clock.now = Math.max(w.clock.now, row.next); await w.drain(); }
  assert.equal(row.state, "forward_dead");
  assert.equal(w.attempts.filter((x) => x.kind === "forward").length, fwd.MAX_ATTEMPTS);
  advance(w, 400);
  assert.equal((await w.drain()).checked, 0);
});

test("sem a chave de leitura do Resend: 503 ANTES de aceitar (nenhuma linha, nenhuma chamada)", async () => {
  const w = world();
  const kv = { async get() { return null; } };
  const r = await w.hook(req(received()), { ...w.env, RESEND_RECEIVING_API_KEY: "", ZEVANORY_PRIVATE_ARTIFACTS: kv });
  assert.equal(r.status, 503);
  assert.ok((await r.json()).missing.includes("receiving_key"));
  assert.equal(w.db.rows.size + w.attempts.length + w.gets.length, 0);
  const viaKv = world();
  const kv2 = { async get(k) { return k === "sandbox-config:resend-receiving-key" ? "re_full_kv" : null; } };
  assert.equal((await viaKv.hook(req(received()), { ...viaKv.env, RESEND_RECEIVING_API_KEY: "", ZEVANORY_PRIVATE_ARTIFACTS: kv2 })).status, 200);
  assert.equal(viaKv.gets[0].auth, "Bearer re_full_kv");
  const d = await world().drain({ ...w.env, RESEND_RECEIVING_API_KEY: "" });
  assert.equal(d.skipped, "unconfigured");
});

test("orçamento: 10+ tentativas ou fora da janela de 23 h nunca chegam a um efeito externo (SQL e código)", async () => {
  const w = world();
  w.fail.forward = 1;
  await w.hook(req(received()));
  const row = w.db.rows.get("em-1");
  Object.assign(row, { attempts: 11, next: w.clock.now, lease: null });
  const before = w.attempts.length + w.gets.length;
  assert.deepEqual(await fwd.processSupportEmail({ sql: w.db, env: w.env }, "em-1"), { state: "not_due" });
  row.attempts = fwd.MAX_ATTEMPTS;
  assert.deepEqual(await fwd.processSupportEmail({ sql: w.db, env: w.env }, "em-1"), { state: "not_due" });
  await w.drain();
  assert.equal(row.state, "forward_dead", "o cron marca como morta sem tentar");
  assert.equal(w.attempts.filter((x) => x.kind !== "alert").length + w.gets.length, before);
  // Mesmo se o SQL deixasse passar (lease devolvendo 11 tentativas ou idade >= 23 h), o código não chama o Resend.
  for (const leaseRow of [{ attempts: 11, age_s: 10 }, { attempts: 1, age_s: fwd.RETRY_LIFETIME_HOURS * 3600 }]) {
    let calls = 0;
    const sql = { async query(text) { if (text.includes("/*support:lease*/")) return [{ state: "forward_pending", alias: "suporte", sender_ref: "x", ...leaseRow }]; return []; } };
    const c = { sql, env: w.env, rKey: "k", sendKey: "k", forwardTo: OWNER, nowMs: T0, fetchImpl: async () => { calls++; return Response.json({ id: "x" }); } };
    const res = await fwd.processSupportEmail(c, "em-9");
    assert.equal(calls, 0, JSON.stringify(leaseRow));
    assert.equal(res.state, "forward_dead");
  }
  assert.equal(fwd.withinBudget({ attempts: 11, age_s: 1 }), false);
  assert.equal(fwd.withinBudget({ attempts: 3, age_s: 23 * 3600 }), false);
  assert.equal(fwd.withinBudget({ attempts: 3, age_s: 60 }), true);
  const old = world();
  old.fail.forward = 1;
  await old.hook(req(received()));
  advance(old, fwd.RETRY_LIFETIME_HOURS * 60 + 1);
  const n = old.attempts.length;
  await old.drain();
  assert.equal(old.db.rows.get("em-1").state, "forward_dead");
  assert.equal(old.attempts.filter((x) => x.kind !== "alert").length, n, "nenhuma repetição depois de 23 h (janela de 24 h da Idempotency-Key)");
});

test("409 invalid_idempotent_request no encaminhamento = já encaminhado antes: não reenvia", async () => {
  const w = world();
  w.fail.forward409 = 1;
  const r = await w.hook(req(received()));
  assert.equal((await r.json()).state, "done");
  advance(w, 600);
  await w.drain();
  assert.equal(w.attempts.filter((x) => x.kind === "forward").length, 1);
  assert.match(w.db.rows.get("em-1").forward_id, /^idempotent:/);
});

test("alertas ao dono: linhas mortas e fila acumulada/antiga, sem conteúdo, 1 por tipo a cada 6 h, liberado se o envio falhar", async () => {
  const w = world();
  w.fail.forward = 1000;
  await w.hook(req(received({ id: "d1" })));
  const row = w.db.rows.get("d1");
  for (let i = 0; i < 40 && row.state === "forward_pending"; i++) { w.clock.now = Math.max(w.clock.now, row.next); await w.drain(); }
  assert.equal(row.state, "forward_dead");
  const dead = alerts(w).filter((a) => /não entregues/.test(a.body.subject));
  assert.equal(dead.length, 1);
  assert.deepEqual(dead[0].body.to, [OWNER]);
  assert.match(dead[0].body.from, /suporte@zevanory\.api\.br/);
  assert.ok(!/cliente@example|Não recebi|SECRETO|d1/.test(JSON.stringify(dead[0].body)), "alerta sem conteúdo, endereço, assunto ou id");
  await w.drain();
  advance(w, 7 * 60);
  await w.drain();
  assert.equal(alerts(w).filter((a) => /não entregues/.test(a.body.subject)).length, 1, "não repete o mesmo morto");
  // Fila: 5 pendentes => alerta de atraso; repetição limitada a 1 por 6 h; falha de envio libera a vaga.
  const q = world();
  q.fail.forward = 1000;
  q.fail.alert = 1;
  for (let i = 0; i < fwd.BACKLOG_ALERT_COUNT; i++) await q.hook(req(received({ id: "q" + i })));
  advance(q, 3);
  await q.drain();
  assert.equal(alerts(q).length, 0, "primeiro envio falhou");
  advance(q, 1);
  await q.drain();
  assert.equal(alerts(q).filter((a) => /atrasada/.test(a.body.subject)).length, 1, "vaga liberada após a falha");
  advance(q, 60);
  await q.drain();
  assert.equal(alerts(q).filter((a) => /atrasada/.test(a.body.subject)).length, 1, "limite de 6 h");
  // Uma única mensagem antiga (>= 2 h) também alerta.
  const o = world();
  o.fail.forward = 1000;
  await o.hook(req(received({ id: "o1" })));
  advance(o, fwd.BACKLOG_ALERT_AGE_MINUTES - 1);
  await o.drain();
  assert.equal(alerts(o).length, 0);
  advance(o, 2);
  await o.drain();
  assert.equal(alerts(o).length, 1);
});

test("confirmação: nunca para auto-resposta/bounce/lista/no-reply/próprio domínio/dono; 1 por remetente/dia; teto diário; desligável", async () => {
  const auto = [
    { headers: { "Auto-Submitted": "auto-replied" } },
    { headers: [{ name: "Precedence", value: "bulk" }] },
    { headers: { "List-Id": "<lista.example.com>" } },
    { headers: { "Return-Path": "<>" } },
    { from: "MAILER-DAEMON@example.com" },
    { from: "no-reply@loja.example" },
    { from: "contato@zevanory.api.br" },
    { from: OWNER },
    { subject: "Resposta automática: Não recebi o acesso" }
  ];
  const logs = [];
  const orig = console.log;
  for (const d of auto) {
    const w = world({ details: { "*": d } });
    console.log = (...a) => logs.push(a.join(" "));
    let res;
    try { res = await w.hook(req(received())); } finally { console.log = orig; }
    assert.equal(forwards(w).length, 1, "o dono recebe mesmo assim");
    assert.equal(acks(w).length, 0, JSON.stringify(d));
    assert.match((await res.json()).ack, /^skipped_/);
  }
  assert.ok(logs.length && !/SECRETO|cliente@example|Não recebi|dono-teste/.test(logs.join("\n")), "log sem conteúdo também sem confirmação");
  const w = world();
  await w.hook(req(received({ id: "h1" })));
  await w.hook(req(received({ id: "h2" })));
  assert.equal(forwards(w).length, 2);
  assert.equal(acks(w).length, 1);
  assert.equal(w.db.rows.get("h2").ack_status, "rate_limited_sender");
  const cap = world({ details: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`c${i}`, { from: `pessoa${i}@example.net` }])) });
  for (let i = 0; i < 32; i++) await cap.hook(req(received({ id: `c${i}`, from: `pessoa${i}@example.net` })));
  assert.equal(forwards(cap).length, 32);
  assert.equal(acks(cap).length, fwd.ACK_DAILY_CAP);
  assert.equal(cap.db.rows.get("c31").ack_status, "rate_limited_daily");
  const off = world();
  const r = await off.hook(req(received()), { ...off.env, SUPPORT_AUTO_ACK: "false" });
  assert.equal((await r.json()).ack, "disabled");
  assert.equal(acks(off).length, 0);
});

test("cota reservada atomicamente: um único comando trava a linha, reserva remetente e global e muda o estado", () => {
  const src = readTextNormalized(new URL("../worker/support-email-forward.mjs", import.meta.url));
  const m = /forwardedReserveAck: `([\s\S]*?)`,/.exec(src);
  assert.ok(m, "comando de reserva ausente");
  const q = m[1];
  assert.match(q, /for update/);
  assert.equal((q.match(/insert into zevanory_support_ack_quota/g) || []).length, 2);
  assert.match(q, /on conflict \(bucket, day\) do nothing/);
  assert.match(q, /do update set n = zevanory_support_ack_quota\.n \+ 1 where zevanory_support_ack_quota\.n < \$3/);
  assert.match(q, /select 'all', \$2::date, 1 from s/);
  assert.match(q, /update zevanory_support_inbound i set/);
  assert.ok(!/select count\(/i.test(src), "nada de ler-e-depois-gravar contagens");
  assert.equal((src.match(/SQL\.forwardedReserveAck/g) || []).length, 1);
});

test("lease, recuo e estado fazem parte dos comandos do outbox (concorrência e redelivery)", () => {
  const src = readTextNormalized(new URL("../worker/support-email-forward.mjs", import.meta.url));
  const pick = (name) => { const m = new RegExp(name + ": `([\\s\\S]*?)`,").exec(src); assert.ok(m, name); return m[1].replace(/\s+/g, " "); };
  for (const name of ["lease", "due"]) {
    const q = pick(name);
    assert.match(q, /state in \('forward_pending','ack_pending'\)/, name);
    assert.match(q, /next_attempt_at <= now\(\)/, name);
    assert.match(q, /\(lease_until is null or lease_until < now\(\)\)/, name);
    assert.match(q, /attempts < \$2 and created_at > now\(\) - make_interval\(hours => \$3::int\)/, name);
  }
  assert.match(pick("reap"), /attempts >= \$1 or created_at <= now\(\) - make_interval\(hours => \$2::int\)/);
  assert.match(pick("alertReserve"), /on conflict \(kind\) do update set last_sent_at = now\(\) where zevanory_support_alerts\.last_sent_at < now\(\) - make_interval\(hours => \$2::int\)/);
  assert.match(src, /SQL\.lease, \[emailId, MAX_ATTEMPTS, RETRY_LIFETIME_HOURS\]/);
  assert.match(pick("lease"), /set lease_until = now\(\) \+ interval '2 minutes', attempts = attempts \+ 1/);
  assert.match(pick("record"), /on conflict \(email_id\) do nothing returning email_id/);
  assert.match(pick("acked"), /where email_id = \$1 and state = 'ack_pending'/);
  assert.match(pick("forwardedNoAck"), /where email_id = \$1 and state = 'forward_pending'/);
});

test("HTML higienizado por lista de permissão e com teto de tamanho", async () => {
  const dirty = `<p onclick="x()">Olá<script>alert(1)</script><style>p{}</style><iframe src="https://x"></iframe>
    <a href="javascript:alert(1)">j</a><a href=" jav&#x61;script:alert(1)">k</a><a href="data:text/html,x">d</a>
    <a href="https://ok.example/p?a=1">ok</a><img src="https://track.example/p.gif" onerror="x()"><svg><g onload="x()"/></svg>
    <scr<script>x</script>ipt>alert(2)</scr<script>x</script>ipt><!-- c --><form><input></form><b>fim</b>`;
  const out = fwd.sanitizeHtml(dirty);
  for (const bad of [/alert\(/, /<script/i, /<style/i, /<iframe/i, /<img/i, /<svg/i, /<form/i, /<input/i, /onclick|onerror|onload/i, /javascript:/i, /data:text/i, /<!--/]) assert.doesNotMatch(out, bad);
  assert.match(out, /<a href="https:\/\/ok\.example\/p\?a=1" rel="noopener noreferrer nofollow">ok<\/a>/);
  assert.match(out, /<b>fim<\/b>/);
  assert.doesNotMatch(out, /<(?!\/?(p|a|b)\b)[a-z]/i, "só tags permitidas sobrevivem");
  assert.equal(fwd.sanitizeHtml("<p>" + "x".repeat(fwd.MAX_HTML_IN) + "</p>"), "");
  const w = world({ details: { "*": { html: "<p>" + "y".repeat(fwd.MAX_HTML_OUT + 10) + "</p>" } } });
  await w.hook(req(received()));
  const [f] = forwards(w);
  assert.equal(f.body.html, undefined);
  assert.match(f.body.text, /versão HTML omitida/);
  const w2 = world({ details: { "*": { html: dirty } } });
  await w2.hook(req(received()));
  assert.doesNotMatch(forwards(w2)[0].body.html, /<script|javascript:|onerror/i);
});

test("anexos: executáveis, tamanho desconhecido/excessivo e excesso de quantidade são recusados", async () => {
  const MB = 1024 * 1024;
  const a = (filename, size, content_type = "application/pdf") => ({ id: filename, filename, size, content_type, download_url: `https://att.example/${encodeURIComponent(filename)}` });
  const rows = [
    a("nota.pdf", 1 * MB), a("virus.exe", 10), a("boleto.pdf.exe", 10), a("x.bin.txt", 10, "application/x-msdownload"),
    a("script.js", 10, "text/plain"), a("macro.docm", 10, "application/vnd.ms-word.document.macroEnabled.12"),
    a("semtamanho.pdf", undefined), a("vazio.pdf", 0), a("grande.pdf", 11 * MB), a("f1.png", 1, "image/png"), a("f2.png", 1, "image/png"),
    a("f3.png", 1, "image/png"), a("f4.png", 1, "image/png"), a("f5.png", 1, "image/png")
  ];
  const picked = fwd.selectAttachments(rows);
  assert.deepEqual(picked.accepted.map((x) => x.filename), ["nota.pdf", "f1.png", "f2.png", "f3.png", "f4.png"]);
  assert.equal(picked.rejected, rows.length - 5);
  const total = fwd.selectAttachments([a("a.pdf", 9 * MB), a("b.pdf", 9 * MB), a("c.pdf", 9 * MB)]);
  assert.equal(total.accepted.length, 2, "teto total de bytes");
  const w = world({ attachments: rows });
  await w.hook(req(received()));
  const [f] = forwards(w);
  assert.equal(f.body.attachments.length, 5);
  assert.ok(!f.body.attachments.some((x) => /exe|js|docm/.test(x.filename)));
  assert.match(f.body.text, /9 anexo\(s\) não copiados/);
});

test("prova-sandbox@, outros destinatários e eventos de entrega seguem para o handler legado (null), sem efeito", async () => {
  const w = world();
  for (const ev of [received({ to: [v2.SANDBOX_INBOX_ADDRESS] }), received({ to: ["vendas@zevanory.api.br"] }), { type: "email.delivered", data: { email_id: "x" } }]) {
    const r = req(ev);
    assert.equal(await w.hook(r), null);
    assert.equal(r.bodyUsed, false, "corpo original intacto para o handler legado");
  }
  assert.equal(w.attempts.length + w.gets.length + w.db.rows.size, 0);
  assert.equal(await w.hook(new Request("https://zevanory.api.br/api/webhooks/meta", { method: "POST", body: "{}" })), null);
  assert.equal(await v2.handleSandboxInboundEmail({ to: "suporte@zevanory.api.br" }, {}), false, "Email Worker da sandbox inalterado");
});

test("Worker: webhook interceptado antes do legado/WhatsApp, outbox drenado no cron horário; doc exige responder como suporte@", () => {
  const src = readTextNormalized(new URL("../worker/cloudflare-worker.compat.mjs", import.meta.url));
  const at = src.indexOf('url.pathname === "/api/webhooks/resend" && request.method === "POST"');
  assert.ok(at > 0 && at < src.indexOf("const whatsappPath ="));
  assert.match(src.slice(at, at + 300), /handleSupportInboundWebhook\(request, normalized, \{ sqlFactory: whatsappProofDatabase \}\);\s*if \(support\) return support;/);
  const cron = src.indexOf("tasks.push(drainSupportOutbox(normalized, { sqlFactory: whatsappProofDatabase })");
  assert.ok(cron > 0 && cron < src.indexOf("await Promise.all(tasks);"));
  const doc = readTextNormalized(new URL("../docs/ops/EMAIL_SUPORTE.md", import.meta.url));
  assert.match(doc, /Enviar e-mail como/);
  assert.match(doc, /smtp\.resend\.com/);
  assert.match(doc, /teste real/i);
});
