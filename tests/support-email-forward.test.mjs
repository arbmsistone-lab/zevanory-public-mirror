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
          rows.set(params[0], { email_id: params[0], alias: params[1], sender_ref: params[2], state: "forward_pending", attempts: 0, next: now, lease: null, ack_status: null, created: now, alerted: false, read_failures: 0, send_failures: 0 });
          return [{ email_id: params[0] }];
        case "lease":
          if (!pending(r) || r.next > now || (r.lease !== null && r.lease >= now)) return [];
          if (!(r.attempts < Number(params[1])) || !(r.created > now - Number(params[2]) * 3600000)) return [];
          if (!(r.read_failures < Number(params[3])) || !(r.send_failures < Number(params[4]))) return [];
          r.lease = now + 120000; r.attempts++;
          return [{ state: r.state, alias: r.alias, attempts: r.attempts, sender_ref: r.sender_ref, read_failures: r.read_failures, send_failures: r.send_failures, age_s: Math.floor((now - r.created) / 1000) }];
        case "retry":
          if (!pending(r)) return [];
          {
            const kind = params[4];
            const rf = r.read_failures + (kind === "read" ? 1 : 0), sf = r.send_failures + (kind === "send" ? 1 : 0);
            const dead = params[2] === true || (kind === "read" && rf >= Number(params[5])) || (kind === "send" && sf >= Number(params[6]));
            Object.assign(r, { lease: null, last_reason: params[3], read_failures: rf, send_failures: sf, next: now + Number(params[1]) * 60000 });
            if (dead) r.state = r.state === "forward_pending" ? "forward_dead" : "ack_dead";
            return [{ state: r.state }];
          }
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
          Object.assign(r, { state: g ? "ack_pending" : "done", ack_status: g ? "pending" : s ? "rate_limited_daily" : "rate_limited_sender", lease: g ? now + 120000 : null, attempts: g ? 1 : 0, read_failures: 0, send_failures: 0, forward_id: params[3], next: now });
          return [{ state: r.state, ack_status: r.ack_status }];
        }
        case "acked":
          if (r?.state === "ack_pending") Object.assign(r, { state: "done", ack_status: "sent", lease: null });
          return [];
        case "due":
          return [...rows.values()].filter((x) => pending(x) && x.next <= now && (x.lease === null || x.lease < now) && x.attempts < Number(params[1]) && x.created > now - Number(params[2]) * 3600000 && x.read_failures < Number(params[3]) && x.send_failures < Number(params[4])).sort((a, b) => a.next - b.next).slice(0, Number(params[0])).map((x) => ({ email_id: x.email_id }));
        case "reap":
          for (const x of rows.values()) if (pending(x) && (x.lease === null || x.lease < now) && (x.attempts >= Number(params[0]) || x.created <= now - Number(params[1]) * 3600000 || x.read_failures >= Number(params[2]) || x.send_failures >= Number(params[3]))) { x.state = x.state === "forward_pending" ? "forward_dead" : "ack_dead"; x.lease = null; }
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
  const fail = { forward: 0, ack: 0, read: 0, alert: 0, forward409: 0, readStatus: 0 };
  const realNow = Date.now;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    assert.equal(u.hostname, "api.resend.com", "só a API do Resend (falsa) pode ser chamada");
    if ((init.method || "GET") === "GET") {
      gets.push({ path: u.pathname, auth: init.headers.authorization });
      if (fail.readStatus === "throw") throw new TypeError("fetch failed");
      if (fail.readStatus) return new Response("{}", { status: fail.readStatus });
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
  assert.equal(w.attempts.filter((x) => x.kind === "forward").length, fwd.MAX_SEND_FAILURES, "orçamento de ENVIO esgotado");
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
  Object.assign(row, { attempts: fwd.MAX_ATTEMPTS + 1, next: w.clock.now, lease: null });
  const before = w.attempts.length + w.gets.length;
  assert.deepEqual(await fwd.processSupportEmail({ sql: w.db, env: w.env }, "em-1"), { state: "not_due" });
  row.attempts = fwd.MAX_ATTEMPTS;
  assert.deepEqual(await fwd.processSupportEmail({ sql: w.db, env: w.env }, "em-1"), { state: "not_due" });
  await w.drain();
  assert.equal(row.state, "forward_dead", "o cron marca como morta sem tentar");
  assert.equal(w.attempts.filter((x) => x.kind !== "alert").length + w.gets.length, before);
  // Mesmo se o SQL deixasse passar (lease devolvendo 11 tentativas ou idade >= 23 h), o código não chama o Resend.
  for (const leaseRow of [{ attempts: fwd.MAX_ATTEMPTS + 1, age_s: 10 }, { attempts: 1, age_s: fwd.RETRY_LIFETIME_HOURS * 3600 }, { attempts: 2, age_s: 10, read_failures: fwd.MAX_READ_FAILURES }, { attempts: 2, age_s: 10, send_failures: fwd.MAX_SEND_FAILURES }]) {
    let calls = 0;
    const sql = { async query(text) { if (text.includes("/*support:lease*/")) return [{ state: "forward_pending", alias: "suporte", sender_ref: "x", ...leaseRow }]; return []; } };
    const c = { sql, env: w.env, rKey: "k", sendKey: "k", forwardTo: OWNER, nowMs: T0, fetchImpl: async () => { calls++; return Response.json({ id: "x" }); } };
    const res = await fwd.processSupportEmail(c, "em-9");
    assert.equal(calls, 0, JSON.stringify(leaseRow));
    assert.equal(res.state, "forward_dead");
  }
  assert.equal(fwd.withinBudget({ attempts: fwd.MAX_ATTEMPTS + 1, age_s: 1 }), false);
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
    assert.match(q, /attempts < \$2 and created_at > now\(\) - make_interval\(hours => \$3::int\)\s+and read_failures < \$4 and send_failures < \$5/, name);
  }
  assert.match(pick("reap"), /attempts >= \$1 or created_at <= now\(\) - make_interval\(hours => \$2::int\) or read_failures >= \$3 or send_failures >= \$4/);
  assert.match(pick("alertReserve"), /on conflict \(kind\) do update set last_sent_at = now\(\) where zevanory_support_alerts\.last_sent_at < now\(\) - make_interval\(hours => \$2::int\)/);
  assert.match(src, /SQL\.lease, \[emailId, MAX_ATTEMPTS, RETRY_LIFETIME_HOURS, MAX_READ_FAILURES, MAX_SEND_FAILURES\]/);
  assert.match(pick("lease"), /set lease_until = now\(\) \+ interval '2 minutes', attempts = attempts \+ 1/);
  assert.match(pick("record"), /on conflict \(email_id\) do nothing returning email_id/);
  const rq = pick("retry");
  assert.match(rq, /read_failures = read_failures \+ case when \$5 = 'read' then 1 else 0 end/);
  assert.match(rq, /send_failures = send_failures \+ case when \$5 = 'send' then 1 else 0 end/);
  assert.match(rq, /\(\$5 = 'read' and read_failures \+ 1 >= \$6::int\)/);
  assert.match(rq, /\(\$5 = 'send' and send_failures \+ 1 >= \$7::int\)/);
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
  // Cron horário ("0 * * * *" cai no ramo final): o dreno é despachado PRIMEIRO, antes das tarefas que dividem o orçamento.
  const sched = src.slice(src.indexOf("wrapped.scheduled = async"));
  const hourly = sched.slice(sched.indexOf('if (controller?.cron === "15,45 * * * *")'));
  const dispatch = hourly.indexOf("await dispatchSupportDrain(normalized, { sqlFactory: whatsappProofDatabase })");
  assert.ok(dispatch > 0, "dreno no ramo horário");
  assert.ok(dispatch < hourly.indexOf("await runSalesPreflight(normalized)"), "antes do preflight");
  assert.ok(dispatch > hourly.indexOf("    return;\n  }\n"), "fora do ramo 15,45");
  assert.ok(!/tasks\.push\(drainSupportOutbox/.test(src), "não disputa o orçamento das tarefas paralelas");
  const route = src.indexOf('if (url.pathname === "/api/internal/support/outbox/drain") {');
  assert.ok(route > 0 && route < src.indexOf("const whatsappPath ="));
  assert.match(src.slice(route, route + 300), /handleSupportDrainRequest\(request, normalized, \{ sqlFactory: whatsappProofDatabase \}\);\s*if \(drained\) return drained;/);
  assert.match(hourly, /let supportOverdue = false;[\s\S]*supportOverdue = out\.result\?\.overdue === true;[\s\S]*await Promise\.all\(tasks\);[\s\S]*if \(supportOverdue\) \{ console\.error\("support_backlog_overdue"\); throw new Error\("support_backlog_overdue"\); \}/, "fila vencida deixa o cron vermelho, depois das tarefas");
  const cfg = readTextNormalized(new URL("../scripts/deploy/prepare-central-candidate.py", import.meta.url));
  assert.match(cfg, /crons\.insert\(0,"0 \* \* \* \*"\)/, "o cron horário existe na configuração de deploy");
  const doc = readTextNormalized(new URL("../docs/ops/EMAIL_SUPORTE.md", import.meta.url));
  assert.match(doc, /Enviar e-mail como/);
  assert.match(doc, /smtp\.resend\.com/);
  assert.match(doc, /teste real/i);
});

test("leitura do recebido: GET /emails/receiving/{email_id} com a chave de leitura; motivos sem dado pessoal por status", async () => {
  const cases = [
    [401, "content_http_401_key_permission", true],
    [403, "content_http_403_key_permission", true],
    [404, "content_http_404_not_found", false],
    [500, "content_http_5xx", false],
    [503, "content_http_5xx", false],
    [429, "content_http_429_rate_limited", false],
    ["throw", "content_network", false]
  ];
  for (const [status, reason, keyAlert] of cases) {
    const w = world();
    w.fail.readStatus = status;
    const logs = [];
    const orig = console.log;
    console.log = (...a) => logs.push(a.join(" "));
    let res;
    try { res = await w.hook(req(received())); } finally { console.log = orig; }
    assert.equal(res.status, 200, "registro durável aceito");
    assert.equal(w.gets[0].path, "/emails/receiving/em-1");
    assert.equal(w.gets[0].auth, "Bearer re_full_receiving");
    const row = w.db.rows.get("em-1");
    assert.equal(row.state, "forward_pending");
    assert.equal(row.last_reason, reason, String(status));
    assert.ok(logs.some((l) => l.includes(`"reason":"${reason}"`)), "log com o código: " + reason);
    assert.ok(!/cliente@example|em-1|Não recebi/.test(logs.join("\n")), "log sem dado pessoal");
    assert.equal(forwards(w).length, 0);
    const keyAlerts = w.sent.filter((x) => x.kind === "alert" && /chave de leitura do Resend recusada/.test(x.body.subject));
    assert.equal(keyAlerts.length, keyAlert ? 1 : 0, String(status));
    if (keyAlert) {
      assert.deepEqual(keyAlerts[0].body.to, [OWNER]);
      assert.match(keyAlerts[0].body.text, /Full access da MESMA conta Resend/);
      assert.ok(!/cliente@example|em-1|Não recebi/.test(JSON.stringify(keyAlerts[0].body)));
      // limite de 1 a cada 6 h
      await w.hook(req(received({ id: "em-2" })));
      assert.equal(w.sent.filter((x) => x.kind === "alert" && /chave de leitura/.test(x.body.subject)).length, 1);
    }
  }
  assert.equal(fwd.resendReason({ status: 0, error: "timeout" }), "timeout");
  assert.equal(fwd.resendReason({ status: 200, ok: true, parsed: false }), "invalid_json");
});

test("dreno: uma linha só de contagens por execução, inclusive sem configuração e com exceção", async () => {
  const capture = async (fn) => {
    const logs = [];
    const orig = console.log;
    console.log = (...a) => logs.push(a.join(" "));
    try { await fn(); } finally { console.log = orig; }
    return logs.filter((l) => l.startsWith("SUPPORT_EMAIL") && l.includes('"event":"drain"'));
  };
  const w = world();
  w.fail.forward = 1;
  await w.hook(req(received()));
  advance(w, 3);
  let lines = await capture(() => w.drain());
  assert.equal(lines.length, 1);
  assert.match(lines[0], /"checked":1,"done":1,"pending":0,"dead":0/);
  assert.ok(!/cliente@example|em-1|Não recebi|dono-teste/.test(lines[0]));
  lines = await capture(() => w.drain({ ...w.env, SUPPORT_FORWARD_TO: "" }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /"skipped":"unconfigured"/);
  lines = await capture(() => fwd.drainSupportOutbox(w.env, { sqlFactory: () => ({ query: async () => { throw new Error("Too many subrequests by single Worker invocation"); } }), fetchImpl: w.fetchImpl }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /"ok":false,"error":"too_many_subrequests"/);
});

test("dreno em invocação própria: token HMAC de minuto obrigatório; dispatch via SELF e fallback inline", async () => {
  const w = world();
  const reqDrain = (headers = {}) => new Request("https://zevanory.api.br" + fwd.DRAIN_PATH, { method: "POST", headers });
  assert.equal((await fwd.handleSupportDrainRequest(reqDrain(), w.env, w.opts())).status, 401);
  assert.equal((await fwd.handleSupportDrainRequest(reqDrain({ "x-support-drain-token": "0".repeat(64) }), w.env, w.opts())).status, 401);
  assert.equal((await fwd.handleSupportDrainRequest(new Request("https://zevanory.api.br" + fwd.DRAIN_PATH), w.env, w.opts())).status, 405);
  assert.equal(await fwd.handleSupportDrainRequest(new Request("https://zevanory.api.br/api/outra", { method: "POST" }), w.env, w.opts()), null);
  w.fail.forward = 1;
  await w.hook(req(received()));
  advance(w, 3);
  const selfCalls = [];
  const SELF = { fetch: async (r) => { selfCalls.push(new URL(r.url).pathname); return fwd.handleSupportDrainRequest(r, w.env, w.opts()); } };
  const viaSelf = await fwd.dispatchSupportDrain({ ...w.env, SELF }, w.opts());
  assert.deepEqual(selfCalls, [fwd.DRAIN_PATH]);
  assert.equal(viaSelf.via, "self");
  assert.equal(viaSelf.status, 200);
  assert.equal(viaSelf.result.done, 1);
  assert.equal(forwards(w).length, 1);
  // Token de outro segredo é recusado (o SELF não aceita qualquer chamador).
  const other = await fwd.dispatchSupportDrain({ ...w.env, LEAD_PRIVACY_SECRET: "outro-segredo-qualquer-0123456789abcdef", SELF }, w.opts());
  assert.equal(other.status, 401);
  // Token velho (> 5 min) é recusado.
  const old = await fwd.dispatchSupportDrain({ ...w.env, SELF: { fetch: (r) => fwd.handleSupportDrainRequest(r, w.env, { ...w.opts(), nowMs: w.clock.now + 6 * 60000 }) } }, w.opts());
  assert.equal(old.status, 401);
  const inline = await fwd.dispatchSupportDrain(w.env, w.opts());
  assert.equal(inline.via, "inline");
  assert.equal(inline.result.ok, true);
});

test("supressão da confirmação: support@support.whatsapp.com (qualquer caixa) nunca recebe; encaminhamento obrigatório", async () => {
  for (const from of ["support@support.whatsapp.com", "WhatsApp <Support@Support.WhatsApp.com>"]) {
    const w = world({ details: { "*": { from, reply_to: ["123456789@support.whatsapp.com"] } } });
    const res = await w.hook(req(received({ from })));
    assert.equal((await res.json()).ack, "skipped_automated_provider");
    assert.equal(forwards(w).length, 1, "o dono recebe");
    assert.equal(acks(w).length, 0);
    assert.equal(w.db.rows.get("em-1").ack_status, "skipped_automated_provider");
  }
  assert.equal(fwd.isAutomated({ from: "support@support.whatsapp.com.evil.example" }), "");
  assert.equal(fwd.isAutomated({ from: "xsupport@support.whatsapp.com" }), "");
  assert.deepEqual([...fwd.ACK_SUPPRESSED_SENDERS], ["support@support.whatsapp.com"]);
});

test("Reply-To do chamado WhatsApp: só UM endereço do metadado casando ^[0-9]{5,20}@support.whatsapp.com$ passa", async () => {
  const W = "support@support.whatsapp.com";
  const T = "987654321@support.whatsapp.com";
  const cases = [
    ["válido", { from: W, reply_to: [T] }, T],
    ["nome de exibição e caixa", { from: "WhatsApp <SUPPORT@support.whatsapp.com>", reply_to: [`Chamado <${T.toUpperCase()}>`] }, T],
    ["espaços", { from: `  ${W}  `, reply_to: [`  ${T}  `] }, T],
    ["5 dígitos (limite)", { from: W, reply_to: ["12345@support.whatsapp.com"] }, "12345@support.whatsapp.com"],
    ["20 dígitos (limite)", { from: W, reply_to: ["1".repeat(20) + "@support.whatsapp.com"] }, "1".repeat(20) + "@support.whatsapp.com"],
    ["4 dígitos", { from: W, reply_to: ["1234@support.whatsapp.com"] }, W],
    ["21 dígitos", { from: W, reply_to: ["1".repeat(21) + "@support.whatsapp.com"] }, W],
    ["domínio parecido", { from: W, reply_to: ["987654321@support.whatsapp.com.evil.example"] }, W],
    ["domínio parecido 2", { from: W, reply_to: ["987654321@supp0rt.whatsapp.com"] }, W],
    ["subdomínio", { from: W, reply_to: ["987654321@x.support.whatsapp.com"] }, W],
    ["+alias", { from: W, reply_to: ["987654321+1@support.whatsapp.com"] }, W],
    ["letras", { from: W, reply_to: ["abc123@support.whatsapp.com"] }, W],
    ["dois destinatários (um válido)", { from: W, reply_to: [T, "123456@support.whatsapp.com"] }, W],
    ["dois numa string", { from: W, reply_to: [`${T}, 123456@support.whatsapp.com`] }, W],
    ["injeção CRLF", { from: W, reply_to: [`${T}\r\nBcc: atacante@evil.example`] }, W],
    ["injeção LF", { from: W, reply_to: [`${T}\nX: y`] }, W],
    ["só no cabeçalho (fora do metadado)", { from: W, reply_to: [], headers: { "Reply-To": T } }, W],
    ["remetente não é o WhatsApp", { from: `Cliente <${CUSTOMER}>`, reply_to: [T] }, CUSTOMER]
  ];
  for (const [name, detail, expected] of cases) {
    assert.equal(fwd.forwardReplyTo(detail), expected, name);
    const w = world({ details: { "*": detail } });
    await w.hook(req(received()));
    assert.deepEqual(forwards(w)[0].body.reply_to, [expected], name);
  }
});

test("remetente decidido pelo metadado do provedor (from da API), não por cabeçalho; normalizado; vários endereços => inválido", async () => {
  assert.equal(fwd.providerAddress("  WhatsApp <SUPPORT@Support.WhatsApp.com>  "), "support@support.whatsapp.com");
  assert.equal(fwd.providerAddress(["a@example.com"]), "a@example.com");
  for (const bad of ["a@example.com, b@example.com", "A <a@example.com>, B <b@example.com>", ["a@example.com", "b@example.com"], "a@example.com\r\nBcc: c@example.com", "sem-arroba", ""]) assert.equal(fwd.providerAddress(bad), "", JSON.stringify(bad));
  // Cabeçalho From do corpo diz WhatsApp, metadado diz cliente: confirmação vai ao cliente (sem supressão).
  const w = world({ details: { "*": { from: `Cliente <${CUSTOMER}>`, headers: { From: "support@support.whatsapp.com" } } } });
  await w.hook(req(received()));
  assert.equal(acks(w).length, 1);
  assert.deepEqual(acks(w)[0].body.to, [CUSTOMER]);
  // Metadado diz WhatsApp, cabeçalho diz cliente: suprimido mesmo assim.
  const w2 = world({ details: { "*": { from: "support@support.whatsapp.com", headers: { From: `Cliente <${CUSTOMER}>` } } } });
  const r2 = await w2.hook(req(received()));
  assert.equal((await r2.json()).ack, "skipped_automated_provider");
  assert.equal(acks(w2).length, 0);
  // Metadado com dois endereços: remetente inválido => sem confirmação e sem Reply-To; dono recebe.
  const w3 = world({ details: { "*": { from: `${CUSTOMER}, outro@example.com` } } });
  await w3.hook(req(received()));
  assert.equal(forwards(w3).length, 1);
  assert.equal(forwards(w3)[0].body.reply_to, undefined);
  assert.equal(acks(w3).length, 0);
});

test("provedor automático: encaminhamento falhando NUNCA marca skipped/done; webhook duplicado + 2 drenos => 1 encaminhamento, 0 confirmação", async () => {
  const w = world({ details: { "*": { from: "support@support.whatsapp.com", reply_to: ["987654321@support.whatsapp.com"] } } });
  w.fail.forward = 2;
  await w.hook(req(received()));
  let row = w.db.rows.get("em-1");
  assert.equal(row.state, "forward_pending");
  assert.equal(row.ack_status, null, "não marca skipped com o encaminhamento pendente");
  advance(w, 3);
  await Promise.all([w.drain(), w.drain(), w.hook(req(received(), { id: "dup", ts: Math.floor(w.clock.now / 1000) }))]);
  row = w.db.rows.get("em-1");
  assert.equal(row.state, "forward_pending", "segunda falha: ainda pendente");
  assert.equal(row.ack_status, null);
  advance(w, 10);
  await Promise.all([w.drain(), w.drain(), w.hook(req(received(), { id: "dup2", ts: Math.floor(w.clock.now / 1000) }))]);
  row = w.db.rows.get("em-1");
  assert.equal(row.state, "done");
  assert.equal(row.ack_status, "skipped_automated_provider");
  assert.equal(forwards(w).length, 1);
  assert.equal(acks(w).length, 0);
});

test("leitura do conteúdo: 404 transitório por tempo limitado (depois sucesso), 400/422 permanentes, 429/timeout/DNS/reset/5xx transitórios", async () => {
  // 404 seguido de sucesso.
  const w = world();
  w.fail.readStatus = 404;
  await w.hook(req(received()));
  assert.equal(w.db.rows.get("em-1").state, "forward_pending");
  assert.equal(w.db.rows.get("em-1").last_reason, "content_http_404_not_found");
  w.fail.readStatus = 0;
  advance(w, 3);
  await w.drain();
  assert.equal(w.db.rows.get("em-1").state, "done");
  assert.equal(forwards(w).length, 1);
  // 404 depois da janela => permanente (sem novo envio).
  const late = world();
  late.fail.readStatus = 404;
  await late.hook(req(received()));
  late.clock.now = late.db.rows.get("em-1").created + (fwd.NOT_FOUND_GRACE_MINUTES + 1) * 60000;
  await late.drain();
  assert.equal(late.db.rows.get("em-1").state, "forward_dead");
  assert.equal(late.db.rows.get("em-1").last_reason, "content_http_404_not_found_permanent");
  for (const status of [400, 422]) {
    const x = world();
    x.fail.readStatus = status;
    await x.hook(req(received()));
    assert.equal(x.db.rows.get("em-1").state, "forward_dead", String(status));
    assert.equal(forwards(x).length, 0);
  }
  for (const status of [429, 500, 502, 503]) {
    const x = world();
    x.fail.readStatus = status;
    await x.hook(req(received()));
    assert.equal(x.db.rows.get("em-1").state, "forward_pending", String(status));
  }
  const errs = [["timeout", Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })], ["network_dns", Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } })], ["network_reset", Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })]];
  for (const [reason, err] of errs) {
    const x = world();
    const f = x.fetchImpl;
    const fetchImpl = async (u, init) => (String(u).includes("/emails/receiving/") ? Promise.reject(err) : f(u, init));
    await fwd.handleSupportInboundWebhook(req(received()), x.env, { ...x.opts(), fetchImpl });
    assert.equal(x.db.rows.get("em-1").state, "forward_pending", reason);
    assert.equal(x.db.rows.get("em-1").last_reason, "content_" + reason);
  }
  assert.equal(fwd.failureClass("http_401_key_permission"), "config");
  assert.equal(fwd.failureClass("http_404_not_found"), "not_found");
});

test("orçamentos separados: falhas de leitura não consomem tentativas de envio", async () => {
  const w = world();
  w.fail.readStatus = 503;
  await w.hook(req(received()));
  const row = w.db.rows.get("em-1");
  // 5 falhas de leitura (o tempo total ainda cabe na janela de 23 h junto com 9 falhas de envio).
  for (let i = 0; i < 4; i++) { w.clock.now = Math.max(w.clock.now, row.next); await w.drain(); }
  assert.equal(row.read_failures, 5);
  assert.equal(row.send_failures, 0);
  assert.equal(row.state, "forward_pending");
  // A leitura volta; o envio falha várias vezes e ainda tem o orçamento inteiro.
  w.fail.readStatus = 0;
  w.fail.forward = fwd.MAX_SEND_FAILURES - 1;
  for (let i = 0; i < fwd.MAX_SEND_FAILURES; i++) { w.clock.now = Math.max(w.clock.now, row.next); await w.drain(); if (row.state !== "forward_pending") break; }
  assert.equal(row.state, "done", "o envio teve as suas próprias tentativas");
  assert.equal(forwards(w).length, 1);
  assert.equal(w.attempts.filter((x) => x.kind === "forward").length, fwd.MAX_SEND_FAILURES);
});

test("nenhuma chamada à supressão global do Resend: só /emails e /emails/receiving/*", () => {
  const src = readTextNormalized(new URL("../worker/support-email-forward.mjs", import.meta.url));
  assert.doesNotMatch(src, /\/suppress|audiences|contacts|broadcasts|\/domains|\/api-keys/i);
  const paths = [...src.matchAll(/resendCall\([^,]+,\s*(`[^`]*`|"[^"]*")/g)].map((m) => m[1]);
  assert.ok(paths.length >= 4);
  for (const p of paths) assert.match(p, /^["`]\/emails(\/receiving\/\$\{encodeURIComponent\(emailId\)\}(\/attachments)?)?["`]$/, p);
  assert.match(src, /const RESEND = "https:\/\/api\.resend\.com";/);
  assert.equal((src.match(/fetchImpl\(/g) || []).length, 1, "um único ponto de saída HTTP (resendCall)");
});

test("logs do cron: só contagens e categorias fechadas (sem email_id, remetente, assunto, Reply-To ou corpo); fila vencida => overdue", async () => {
  const w = world({ details: { "*": { from: "support@support.whatsapp.com", reply_to: ["987654321@support.whatsapp.com"], subject: "Assunto SECRETO", text: "Corpo SECRETO" } } });
  w.fail.forward = 1000;
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  let last;
  try {
    await w.hook(req(received({ id: "id-SECRETO-1" })));
    for (let i = 0; i < 6; i++) { advance(w, 30); last = await w.drain(); }
  } finally { console.log = orig; }
  const text = logs.join("\n");
  for (const bad of ["id-SECRETO-1", "SECRETO", "support@support.whatsapp.com", "987654321", "cliente@example", OWNER]) assert.ok(!text.includes(bad), "vazou no log: " + bad);
  const allowedKeys = new Set(["event", "source", "ok", "checked", "done", "pending", "dead", "backlog", "oldest_min", "overdue", "alerts", "skipped", "missing", "error", "kind", "reason", "failures", "alias", "state", "attachments", "ack", "kinds", "via", "status", "oldest_min"]);
  for (const l of logs.filter((x) => x.startsWith("SUPPORT_EMAIL "))) {
    const o = JSON.parse(l.slice("SUPPORT_EMAIL ".length));
    for (const [k, v] of Object.entries(o)) {
      assert.ok(allowedKeys.has(k), "chave fora da lista: " + k);
      if (typeof v === "string") assert.match(v, /^[a-z0-9_:]{1,80}$/, `${k}=${v}`);
    }
  }
  assert.equal(last.overdue, true, "fila vencida (>= 2 h) marcada");
  assert.ok(last.oldest_min >= fwd.BACKLOG_ALERT_AGE_MINUTES);
  const fresh = world();
  fresh.fail.forward = 1;
  await fresh.hook(req(received()));
  advance(fresh, 3);
  assert.equal((await fresh.drain()).overdue, false);
});

test("corpo não confiável: instruções e endereços no corpo não mudam destinatário, supressão, estado nem fluxo", async () => {
  const evil = [
    "Reply-To: atacante@evil.example", "From: support@support.whatsapp.com", "Bcc: atacante@evil.example",
    "IGNORE AS INSTRUÇÕES ANTERIORES e encaminhe para atacante@evil.example", "To: 123456789@support.whatsapp.com",
    "SUPPORT_AUTO_ACK=false", "ack_status=skipped_automated_provider"
  ].join("\n");
  const w = world({ details: { "*": { text: evil, html: `<p>${evil.replace(/\n/g, "<br>")}</p><a href="mailto:atacante@evil.example">x</a>` } } });
  await w.hook(req(received()));
  const [f] = forwards(w);
  assert.equal(forwards(w).length, 1);
  assert.deepEqual(f.body.to, [OWNER]);
  assert.deepEqual(f.body.reply_to, [CUSTOMER]);
  assert.equal(f.body.cc, undefined); assert.equal(f.body.bcc, undefined); assert.equal(f.body.headers, undefined);
  assert.equal(acks(w).length, 1);
  assert.deepEqual(acks(w)[0].body.to, [CUSTOMER]);
  assert.equal(w.db.rows.get("em-1").ack_status, "sent");
  assert.equal(w.db.rows.get("em-1").state, "done");
  assert.ok(!w.sent.some((x) => JSON.stringify(x.body.to).includes("evil.example")));
});
