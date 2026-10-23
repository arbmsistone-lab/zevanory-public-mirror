// Sol, bloqueio #879-1 — alerta da fila morta (DLQ) do webhook Asaas: exatamente UM alerta entregue, nunca zero e nunca
// duplicado, com drenagens CONCORRENTES reais coordenadas pelo livro-razão PostgreSQL (db/b05/asaas_dlq_alerts.sql).
// Conexões concorrentes REAIS (um processo psql por chamada). Run: T4_PG_HOST=... node --test tests/integration/psp-dlq-alert-postgres.test.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SKIP, psqlRaw, asyncSql, rowsSync } from "./psp-pg.mjs";
import {
  ASAAS_WEBHOOK_DLQ_ALERT_PREFIX, ASAAS_WEBHOOK_DLQ_PREFIX, ASAAS_WEBHOOK_REVIEW_PREFIX, createPgDlqAlertLedger, dlqAlertIdempotencyKey,
  drainAsaasWebhookReview, queueAsaasWebhookReview,
} from "../../worker/asaas-webhook-safety.mjs";

const DDL = () => readFileSync(new URL("../../db/b05/asaas_dlq_alerts.sql", import.meta.url), "utf8");
const quiet = { error() {}, info() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unresolved = async () => ({ status: 200, body: { accepted: true, ignored: true, reason: "refund_before_payment_recorded" } });
function sharedKv() {
  const m = new Map();
  return { m, async get(k) { await sleep(1); return m.get(k) ?? null; }, async put(k, v) { await sleep(1); m.set(k, String(v)); }, async delete(k) { await sleep(1); m.delete(k); },
    async list({ prefix = "" } = {}) { await sleep(1); return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }; } };
}
// Provedor de e-mail falso SEM deduplicação própria: conta cada envio aceito (o livro-razão é que garante um só).
function mailer({ failFirst = 0, delayMs = 30 } = {}) {
  const m = { calls: [], sent: [], failures: failFirst };
  m.alert = async (a) => {
    m.calls.push(a);
    await sleep(delayMs);
    if (m.failures > 0) { m.failures -= 1; return { sent: false, reason: "provider_503" }; }
    m.sent.push(a);
    return { sent: true };
  };
  return m;
}
const queue = (kv, id) => queueAsaasWebhookReview(kv, { eventId: id, event: "PAYMENT_REFUNDED", paymentId: "pay_pgdlq01", orderId: "0f8fad5b-d9cb-469f-a165-70867728950e", reason: "refund_before_payment_recorded", now: Date.now() });
const row = (key) => rowsSync("select state, attempts::int as attempts, claim_owner from asaas_dlq_alerts where idempotency_key=$1", [key])[0];

before(() => {
  if (SKIP) return;
  psqlRaw("drop table if exists asaas_dlq_alerts;\n");
  psqlRaw(DDL());
});

test("A1 20 reivindicações simultâneas (20 conexões) => exatamente 1; depois de 'sent' ninguém mais reivindica", { skip: SKIP }, async () => {
  psqlRaw("delete from asaas_dlq_alerts;\n");
  const ledger = createPgDlqAlertLedger(asyncSql);
  const key = dlqAlertIdempotencyKey("evt_pgclaim001");
  const got = await Promise.all(Array.from({ length: 20 }, (_, i) => ledger.claim(key, "evt_pgclaim001", `drain-${i}`)));
  const winners = got.filter((g) => g.claimed);
  assert.equal(winners.length, 1, JSON.stringify(got));
  const owner = `drain-${got.findIndex((g) => g.claimed)}`;
  assert.equal(row(key)?.claim_owner, owner);
  assert.equal(await ledger.markSent(key, "intruso"), false, "só o dono da reivindicação marca");
  assert.equal(await ledger.markSent(key, owner), true);
  const after = await Promise.all(Array.from({ length: 10 }, (_, i) => ledger.claim(key, "evt_pgclaim001", `late-${i}`)));
  assert.equal(after.filter((g) => g.claimed).length, 0);
  assert.ok(after.every((g) => g.state === "sent"));
  assert.deepEqual({ state: row(key)?.state, attempts: row(key)?.attempts }, { state: "sent", attempts: "1" });
});

test("A2 8 drenagens CONCORRENTES, e-mail falha e depois volta: exatamente UM alerta entregue; drenagens seguintes não reenviam", { skip: SKIP }, async () => {
  psqlRaw("delete from asaas_dlq_alerts;\n");
  const kv = sharedKv();
  await queue(kv, "evt_pgdrain001");
  const ledger = createPgDlqAlertLedger(asyncSql);
  const mail = mailer({ failFirst: 1 });
  const opts = (i) => ({ now: Date.now(), maxAttempts: 1, logger: quiet, replay: unresolved, alert: mail.alert, alertLedger: ledger, owner: `drain-${i}-${Date.now()}`, alertBaseBackoffMs: 400, alertClaimMs: 5_000, alertSendTimeoutMs: 2_000 });
  const first = await Promise.all(Array.from({ length: 8 }, (_, i) => drainAsaasWebhookReview(kv, opts(i))));
  assert.equal(first.reduce((n, o) => n + o.dead_lettered, 0) >= 1, true);
  assert.equal(mail.sent.length, 0, "1ª tentativa falhou");
  assert.equal(kv.m.has(ASAAS_WEBHOOK_REVIEW_PREFIX + "evt_pgdrain001"), false, "item saiu da fila");
  assert.ok(kv.m.has(ASAAS_WEBHOOK_DLQ_ALERT_PREFIX + "evt_pgdrain001"), "pendência persistida (o defeito perdia o alerta aqui)");
  assert.equal(row(dlqAlertIdempotencyKey("evt_pgdrain001"))?.state, "pending");
  await sleep(500); // recuo (400 ms) vencido no banco e no KV
  const second = await Promise.all(Array.from({ length: 8 }, (_, i) => drainAsaasWebhookReview(kv, opts(i + 100))));
  assert.equal(second.reduce((n, o) => n + o.alerted, 0), 1, JSON.stringify(second.map((o) => [o.alerted, o.alert_waiting, o.alert_errors])));
  assert.equal(mail.sent.length, 1, "exatamente um e-mail entregue");
  assert.ok(mail.calls.every((c) => c.idempotency_key === "asaas-dlq-alert-v1-evt_pgdrain001"));
  assert.equal(row(dlqAlertIdempotencyKey("evt_pgdrain001"))?.state, "sent");
  assert.equal(JSON.parse(kv.m.get(ASAAS_WEBHOOK_DLQ_PREFIX + "evt_pgdrain001") || "null")?.alert?.state, "sent");
  await sleep(500);
  const third = await Promise.all(Array.from({ length: 6 }, (_, i) => drainAsaasWebhookReview(kv, opts(i + 200))));
  assert.equal(third.reduce((n, o) => n + o.alerted, 0), 0);
  assert.equal(mail.sent.length, 1);
});

test("A3 queda depois do envio e antes do registro: reivindicação viva bloqueia; vencida, reenvia com a MESMA chave", { skip: SKIP }, async () => {
  psqlRaw("delete from asaas_dlq_alerts;\n");
  const ledger = createPgDlqAlertLedger(asyncSql);
  const key = dlqAlertIdempotencyKey("evt_pgcrash001");
  assert.equal((await ledger.claim(key, "evt_pgcrash001", "morto", { claimMs: 600 })).claimed, true);
  // "morto" enviou e caiu sem markSent/markFailed.
  const during = await Promise.all(Array.from({ length: 5 }, (_, i) => ledger.claim(key, "evt_pgcrash001", `vivo-${i}`, { claimMs: 600 })));
  assert.equal(during.filter((g) => g.claimed).length, 0, "reivindicação viva: ninguém reenvia");
  await sleep(700);
  const later = await Promise.all(Array.from({ length: 5 }, (_, i) => ledger.claim(key, "evt_pgcrash001", `vivo2-${i}`, { claimMs: 600 })));
  assert.equal(later.filter((g) => g.claimed).length, 1, "reivindicação vencida: exatamente um retoma (mesma chave de idempotência)");
  assert.equal(row(key)?.attempts, "2");
});

test("A4 livro-razão ausente (tabela não aplicada) => nenhum envio pela reivindicação, erro contado, pendência continua", { skip: SKIP }, async () => {
  psqlRaw("drop table if exists asaas_dlq_alerts;\n");
  try {
    const kv = sharedKv();
    await queue(kv, "evt_pgnotab001");
    const mail = mailer();
    const out = await drainAsaasWebhookReview(kv, { now: Date.now(), maxAttempts: 1, logger: quiet, replay: unresolved, alert: mail.alert, alertLedger: createPgDlqAlertLedger(asyncSql) });
    assert.deepEqual({ dlq: out.dead_lettered, alerted: out.alerted, alert_errors: out.alert_errors }, { dlq: 1, alerted: 0, alert_errors: 1 });
    assert.equal(mail.calls.length, 0);
    assert.equal(JSON.parse(kv.m.get(ASAAS_WEBHOOK_DLQ_ALERT_PREFIX + "evt_pgnotab001") || "null")?.state, "pending");
  } finally {
    psqlRaw(DDL());
  }
});
