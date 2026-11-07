// R150: alerta do proprietário pelo Telegram. Só depois do e-mail oficial à equipe, sem dado pessoal do cliente,
// melhor esforço (falha não muda estado) e desligado sem o segredo TELEGRAM_ALERT.
import test from "node:test";
import assert from "node:assert/strict";
import { drainAtendimentoOutbox, parseTelegramAlert, telegramAlertText, TELEGRAM_API } from "../worker/atendimento.mjs";
import { OFFICIAL_TURNSTILE_SITEKEY } from "../worker/site-chat.mjs";

const TOKEN = "123456789:AAH" + "x".repeat(32);
const CHAT = "987654321";
const CFG = { DATABASE_URL: "postgres://x", RESEND_API_KEY: "re_test", LEAD_PRIVACY_SECRET: "k".repeat(40), SUPPORT_FORWARD_TO: "dono@example.com" };
const PROTO = "ZEV-20261107-0123456789";
const CLIENTE = "cliente.sigilo@example.com";
const MSG = "Mensagem pessoal do cliente que não pode sair para o Telegram.";

function harness({ ownerOk = true, telegramStatus = 200, telegramThrows = false } = {}) {
  const states = { owner: "pending", customer: "pending" };
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith(TELEGRAM_API)) {
      calls.push({ kind: "telegram", url: String(url), body: JSON.parse(init.body) });
      if (telegramThrows) throw new Error("rede");
      return new Response("{}", { status: telegramStatus });
    }
    const body = JSON.parse(init.body);
    const owner = init.headers["idempotency-key"].startsWith("atendimento-owner/");
    calls.push({ kind: owner ? "owner" : "ack", to: body.to[0] });
    if (owner && !ownerOk) return new Response(JSON.stringify({ name: "validation_error" }), { status: 422 });
    return new Response(JSON.stringify({ id: "id_" + calls.length }), { status: 200 });
  };
  const q = Object.fromEntries(["due", "lease", "ownerSent", "customerSent", "ownerFailed", "customerFailed", "release", "alertDue", "health", "housekeeping", "monitorClaim"].map((k) => [k, k]));
  q.schema = [];
  const sql = {
    async query(statement) {
      if (statement === q.due) return [{ protocolo: PROTO }];
      if (statement === q.lease) return [{ protocolo: PROTO, tipo: "reclamacao", owner_status: states.owner, customer_status: states.customer, owner_attempts: 0, customer_attempts: 0,
        payload: { email: CLIENTE, pedido: "hp123", mensagem: MSG }, recebido_em: "2026-11-07T12:00:00.000Z", responder_ate: "2026-11-12T12:00:00.000Z", owner_window_ok: true, customer_window_ok: true }];
      if (statement === q.ownerSent) { states.owner = "sent"; return []; }
      if (statement === q.customerSent) { states.customer = "sent"; return []; }
      if (statement === q.ownerFailed) { states.owner = "dead"; return [{ owner_status: "dead", owner_attempts: 1 }]; }
      if (statement === q.customerFailed) return [{ customer_status: states.customer, customer_attempts: 1 }];
      if (statement === q.release) return [{ owner_status: states.owner, customer_status: states.customer, alert_status: "none" }];
      if (statement === q.alertDue) return [];
      if (statement === q.health) return [{ alert_dead: 0, old_alert: 0, old_deadline: 0, oldest_hours: 0 }];
      if (statement === q.housekeeping) return [{ quotas: 0, purged: 0 }];
      throw new Error("SQL inesperado: " + statement);
    },
  };
  return { states, calls, run: (env) => drainAtendimentoOutbox(env, { sqlFactory: () => sql, q, fetchImpl }) };
}

test("TG01 formato do segredo: só '<token>|<chat_id>' válido liga o alerta", () => {
  assert.deepEqual(parseTelegramAlert(`${TOKEN}|${CHAT}`), { token: TOKEN, chatId: CHAT }, "[TG01.1]");
  assert.deepEqual(parseTelegramAlert(` ${TOKEN}|-100${CHAT} `), { token: TOKEN, chatId: "-100" + CHAT }, "[TG01.2] grupo (id negativo)");
  for (const bad of ["", undefined, TOKEN, `${TOKEN}|`, `|${CHAT}`, `abc|${CHAT}`, `${TOKEN}|${CHAT}|x`, `${TOKEN}|chat`]) assert.equal(parseTelegramAlert(bad), null, `[TG01.3] ${bad}`);
});

test("TG02 texto do alerta: protocolo, tipo e prazo; nenhum dado pessoal do cliente", () => {
  const t = telegramAlertText({ protocolo: PROTO, tipo: "reclamacao", responder_ate: "2026-11-12T12:00:00.000Z" });
  assert.ok(t.includes(PROTO), "[TG02.1]");
  assert.doesNotMatch(t, /@example|cliente|hp123|Mensagem pessoal/i, "[TG02.2] sem e-mail, pedido ou mensagem do cliente");
});

test("TG03 com segredo: alerta sai uma vez, depois do e-mail oficial, para o chat certo, sem dado do cliente", async () => {
  const h = harness();
  const r = await h.run({ ...CFG, TELEGRAM_ALERT: `${TOKEN}|${CHAT}` });
  assert.equal(r.ok, true);
  assert.deepEqual(h.calls.map((c) => c.kind), ["owner", "telegram", "ack"], "[TG03.1] ordem: e-mail à equipe, Telegram, confirmação ao cliente");
  const tg = h.calls.find((c) => c.kind === "telegram");
  assert.equal(tg.url, `${TELEGRAM_API}/bot${TOKEN}/sendMessage`, "[TG03.2]");
  assert.equal(tg.body.chat_id, CHAT, "[TG03.3]");
  assert.doesNotMatch(JSON.stringify(tg.body), /sigilo|hp123|Mensagem pessoal/, "[TG03.4] nenhum dado pessoal no Telegram");
  assert.equal(h.states.owner, "sent"); assert.equal(h.states.customer, "sent");
});

test("TG04 Telegram fora do ar ou recusando: nada muda no atendimento oficial", async () => {
  for (const opts of [{ telegramStatus: 500 }, { telegramStatus: 401 }, { telegramThrows: true }]) {
    const h = harness(opts);
    const r = await h.run({ ...CFG, TELEGRAM_ALERT: `${TOKEN}|${CHAT}` });
    assert.equal(r.ok, true, "[TG04.1]");
    assert.equal(h.states.owner, "sent", "[TG04.2]"); assert.equal(h.states.customer, "sent", "[TG04.3]");
    assert.equal(h.calls.filter((c) => c.kind === "telegram").length, 1, "[TG04.4] sem nova tentativa");
  }
});

test("TG05 sem segredo, ou e-mail à equipe sem sucesso: nenhuma chamada ao Telegram", async () => {
  const off = harness();
  await off.run({ ...CFG });
  assert.equal(off.calls.filter((c) => c.kind === "telegram").length, 0, "[TG05.1] desligado sem TELEGRAM_ALERT");
  const fail = harness({ ownerOk: false });
  await fail.run({ ...CFG, TELEGRAM_ALERT: `${TOKEN}|${CHAT}` });
  assert.equal(fail.calls.filter((c) => c.kind === "telegram").length, 0, "[TG05.2] só depois do e-mail oficial enviado");
});

test("TG06 sitekey público no código (libera vaga no limite de variáveis) e igual ao widget publicado", () => {
  assert.equal(OFFICIAL_TURNSTILE_SITEKEY, "0x4AAAAAAF2sozEg8we6MsOP", "[TG06.1]");
});
