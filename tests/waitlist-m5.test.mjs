// M5 (reauditoria do PR #946): idempotência do aviso da lista de espera (worker/waitlist.mjs), sem banco, para rodar na
// suíte Node completa (Linux e Windows). A mesma prova com PostgreSQL REAL está em tests/integration/waitlist-postgres.test.mjs
// (P10-P12) e reproduz a ferramenta do auditor (tools/m5-test.mjs). Aqui o banco é um modelo em memória das consultas do
// job de aviso, e o provedor é o modelo do Resend: Idempotency-Key retida por 24 h, 409 para a mesma chave com outro
// payload, e um modo "entrega e responde 500". Rótulos [Mn.k].
import { test } from "node:test";
import assert from "node:assert/strict";
import { runWaitlistNotify, handleWaitlist, noticeDecision, WAITLIST_PRODUCTS, NOTICE_RETRY_HOURS, NOTICE_IN_PROGRESS_MINUTES, NOTICE_STATES, ERASURE_STATES, WAITLIST_HAS_DATA_KEY, WAITLIST_CONSENT_VERSION } from "../worker/waitlist.mjs";

import { db, provider, waitlistEnv as env, H } from "./helpers/waitlist-model.mjs";
const P = Object.keys(WAITLIST_PRODUCTS).sort();

test("M5 aviso congelado: sem laço de 409 depois de entrega com erro; sem 2º envio além da janela de 24 h; 409 encerra", async () => {
  assert.ok(NOTICE_RETRY_HOURS < 24, "[M5.0] novas tentativas só dentro da janela de retenção da chave no provedor");
  const e = env();
  // CASE_D do auditor: entrega + 500, e o mesmo contato confirma um 2º produto antes da próxima execução.
  { const d = db(), pv = provider(); d.add("a@ex.com", P[0]);
    pv.deliverThenFail = true; await runWaitlistNotify(e, { sqlFactory: d.sqlFactory, salesOpen: true, fetchImpl: pv.fetchImpl }); pv.deliverThenFail = false;
    d.add("a@ex.com", P[1]);
    for (let i = 0; i < 3; i++) await runWaitlistNotify(e, { sqlFactory: d.sqlFactory, salesOpen: true, fetchImpl: pv.fetchImpl });
    assert.equal(d.rows.length, 0, "[M5.1] nenhum registro preso");
    assert.equal(pv.inbox.length, 2, "[M5.2] uma entrega por produto");
    assert.ok(pv.inbox[1].text.includes(WAITLIST_PRODUCTS[P[1]]) && !pv.inbox[1].text.includes(WAITLIST_PRODUCTS[P[0]]), "[M5.3] o 2º aviso traz só o produto novo");
    const sigs = new Map(); for (const c of pv.calls) { assert.equal(sigs.get(c.key) ?? c.sig, c.sig, "[M5.4] mesma chave, mesmo payload"); sigs.set(c.key, c.sig); } }
  // CASE_A do auditor: a exclusão falha depois do envio e a próxima execução ocorre além da janela do provedor.
  { const d = db(), pv = provider(); d.add("b@ex.com", P[0]); d.failDelete = true;
    await assert.rejects(runWaitlistNotify(e, { sqlFactory: d.sqlFactory, salesOpen: true, fetchImpl: pv.fetchImpl }), /db_down/);
    d.failDelete = false; d.now += 25 * H; pv.clock += 25 * H;
    await runWaitlistNotify(e, { sqlFactory: d.sqlFactory, salesOpen: true, fetchImpl: pv.fetchImpl });
    assert.equal(pv.inbox.length, 1, "[M5.5] uma única entrega");
    assert.equal(pv.calls.length, 1, "[M5.6] já enviado: a próxima execução só apaga");
    assert.equal(d.rows.length, 0, "[M5.7]"); }
  // Resultado incerto por mais de NOTICE_RETRY_HOURS: nada de chave nova; dados apagados com registro.
  { const d = db(), pv = provider(); d.add("c@ex.com", P[2]);
    pv.deliverThenFail = true; await runWaitlistNotify(e, { sqlFactory: d.sqlFactory, salesOpen: true, fetchImpl: pv.fetchImpl }); pv.deliverThenFail = false;
    d.now += 24 * H; pv.clock += 25 * H;
    await runWaitlistNotify(e, { sqlFactory: d.sqlFactory, salesOpen: true, fetchImpl: pv.fetchImpl });
    assert.equal(pv.inbox.length, 1, "[M5.8] sem 2ª entrega fora da janela");
    assert.ok(d.events.some((x) => x.event === "notice_unknown_and_erased"), "[M5.9]");
    assert.equal(d.rows.length, 0, "[M5.10]"); }
  // 409 só conta como entregue quando o provedor confirma a chave já usada (invalid_idempotent_request).
  { const d = db(); d.add("d@ex.com", P[0]); let calls = 0;
    const conflict = async () => { calls += 1; return new Response('{"name":"invalid_idempotent_request"}', { status: 409 }); };
    const out = await runWaitlistNotify(e, { sqlFactory: d.sqlFactory, salesOpen: true, fetchImpl: conflict });
    assert.deepEqual([out.failed, d.rows.length, calls, d.notices[0].state], [0, 0, 1, "confirmed"], "[M5.11] chave confirmada pelo provedor encerra sem laço"); }
  // 409 sem a confirmação da chave: resultado desconhecido; nada é apagado e a próxima tentativa repete a mesma chave.
  { const d = db(); d.add("d2@ex.com", P[0]); const keys = [];
    const odd = async (u, init) => { keys.push(init.headers["idempotency-key"]); return new Response('{"name":"rate_limit"}', { status: 409 }); };
    const out = await runWaitlistNotify(e, { sqlFactory: d.sqlFactory, salesOpen: true, fetchImpl: odd });
    assert.deepEqual([out.failed, d.rows.length, d.notices[0].state], [1, 1, "unconfirmed"], "[M5.12] 409 desconhecido não vira entregue");
    d.now += 2 * H; await runWaitlistNotify(e, { sqlFactory: d.sqlFactory, salesOpen: true, fetchImpl: odd });
    assert.equal(new Set(keys).size, 1, "[M5.12a] sempre a mesma chave"); }
  // concurrent_idempotent_requests: outra requisição com a mesma chave em curso -> fica em curso, não confirma nem apaga.
  { const d = db(); d.add("d3@ex.com", P[0]);
    const busy = async () => new Response('{"name":"concurrent_idempotent_requests"}', { status: 409 });
    const out = await runWaitlistNotify(e, { sqlFactory: d.sqlFactory, salesOpen: true, fetchImpl: busy });
    assert.deepEqual([out.inProgress, d.rows.length, d.notices[0].state], [1, 1, "attempting"], "[M5.13] chave em uso: em curso"); }
});

test("M6 estados explícitos do aviso: confirmada, não confirmada, em curso, nova tentativa segura, expirada, exclusão pedida e confirmada", async () => {
  assert.deepEqual(NOTICE_STATES, ["attempting", "unconfirmed", "confirmed", "expired"], "[M6.0]");
  assert.deepEqual(ERASURE_STATES, [null, "requested", "confirmed"], "[M6.0a]");
  assert.equal(noticeDecision({ state: "confirmed", stale: true }), "confirmed", "[M6.1] entrega confirmada nunca é reenviada");
  assert.equal(noticeDecision({ state: "expired" }), "expired", "[M6.2]");
  assert.equal(noticeDecision({ state: "attempting", attempt_recent: true, stale: false }), "in_progress", "[M6.3] tentativa em curso: ninguém reenvia");
  assert.equal(noticeDecision({ state: "attempting", attempt_recent: false, stale: false }), "safe_retry", "[M6.4] tentativa abandonada dentro da janela: mesma chave, mesmo payload");
  assert.equal(noticeDecision({ state: "unconfirmed", stale: false }), "safe_retry", "[M6.5]");
  assert.equal(noticeDecision({ state: "unconfirmed", stale: true }), "expired", "[M6.6] fora da janela: expira, sem chave nova");
  assert.equal(noticeDecision({ state: "attempting", attempt_recent: false, stale: "t" }), "expired", "[M6.7] valor do PostgreSQL ('t')");
  assert.ok(NOTICE_IN_PROGRESS_MINUTES < 60, "[M6.8] em curso dura menos que a devolução da reserva (1 h)");
  const e = env();
  // Queda no meio da tentativa: fica 'attempting'; outra execução logo depois NÃO envia (em curso); depois de 1 h a reserva
  // volta e a nova tentativa é segura (mesma chave e payload) e entrega uma única vez.
  { const d = db(), pv = provider(); d.add("e@ex.com", P[0]); d.crashInAttempt = true;
    await assert.rejects(runWaitlistNotify(e, { sqlFactory: d.sqlFactory, salesOpen: true, fetchImpl: pv.fetchImpl }), /crash_mid_attempt/);
    d.crashInAttempt = false;
    assert.equal(d.notices[0].state, "attempting", "[M6.9]");
    for (const r of d.rows) r.status = "confirmed"; // reserva devolvida à mão (outra execução enxerga o contato)
    const busy = await runWaitlistNotify(e, { sqlFactory: d.sqlFactory, salesOpen: true, fetchImpl: pv.fetchImpl });
    assert.deepEqual([busy.inProgress, pv.calls.length, d.rows.length], [1, 0, 1], "[M6.10] tentativa em curso: nada enviado, nada apagado");
    d.now += 2 * H; pv.clock += 2 * H;
    await runWaitlistNotify(e, { sqlFactory: d.sqlFactory, salesOpen: true, fetchImpl: pv.fetchImpl });
    assert.deepEqual([pv.inbox.length, d.notices[0].state, d.notices[0].erasure, d.rows.length], [1, "confirmed", "confirmed", 0], "[M6.11] entrega confirmada e exclusão confirmada"); }
  // Exclusão pedida e não concluída: continua 'requested'; a próxima execução só apaga.
  { const d = db(), pv = provider(); d.add("f@ex.com", P[1]); d.failDelete = true;
    await assert.rejects(runWaitlistNotify(e, { sqlFactory: d.sqlFactory, salesOpen: true, fetchImpl: pv.fetchImpl }), /db_down/);
    assert.deepEqual([d.notices[0].state, d.notices[0].erasure], ["confirmed", "requested"], "[M6.12] exclusão pedida");
    d.failDelete = false; d.now += 2 * H;
    await runWaitlistNotify(e, { sqlFactory: d.sqlFactory, salesOpen: true, fetchImpl: pv.fetchImpl });
    assert.deepEqual([pv.calls.length, d.notices[0].erasure, d.rows.length], [1, "confirmed", 0], "[M6.13] exclusão confirmada sem novo envio"); }
  // Saída pela pessoa com aviso não confirmado: sem registro, nenhuma nova tentativa acontece.
  { const d = db(), pv = provider(); d.add("g@ex.com", P[0]); pv.deliverThenFail = true;
    await runWaitlistNotify(e, { sqlFactory: d.sqlFactory, salesOpen: true, fetchImpl: pv.fetchImpl }); pv.deliverThenFail = false;
    d.rows = []; for (const n of d.notices) n.erasure = "confirmed"; // efeito de /lista-de-espera/sair (P7 prova a rota com PostgreSQL)
    d.now += H;
    await runWaitlistNotify(e, { sqlFactory: d.sqlFactory, salesOpen: true, fetchImpl: pv.fetchImpl });
    assert.equal(pv.calls.length, 1, "[M6.14] retry nunca alcança quem pediu a exclusão"); }
});

test("M7 falha do KV não produz estado de negócio incorreto (lista de espera)", async () => {
  const broken = { get: async () => { throw new Error("kv_down"); }, put: async () => { throw new Error("kv_down"); }, delete: async () => { throw new Error("kv_down"); } };
  // Inscrição: sem o marcador gravado, nada é guardado (503) e nenhum e-mail sai.
  const queries = []; let mails = 0;
  const sqlFactory = () => ({ query: async (q) => { queries.push(q); return []; } });
  const body = `email=a%40b.com&produto=${P[0]}&consentimento=sim&versao_consentimento=${encodeURIComponent(WAITLIST_CONSENT_VERSION)}`;
  const r = await handleWaitlist(new Request("https://zevanory.api.br/lista-de-espera/inscrever", { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } }),
    { DATABASE_URL: "postgres://x", RESEND_API_KEY: "re", LEAD_PRIVACY_SECRET: "k".repeat(40), WAITLIST_ENABLED: "true", ZEVANORY_PRIVATE_ARTIFACTS: broken },
    { sqlFactory, fetchImpl: async () => { mails += 1; return new Response("{}"); }, salesOpen: false });
  assert.equal(r.status, 503, "[M7.1] KV fora: inscrição recusada");
  assert.ok(!queries.some((q) => /insert into zevanory_waitlist \(/.test(q)), "[M7.2] nenhum registro guardado sem o marcador");
  assert.equal(mails, 0, "[M7.3] nenhum e-mail");
  // Lista desligada e KV fora: a retenção roda (só apaga); nunca reserva nem envia.
  const q2 = [];
  const off = await runWaitlistNotify({ DATABASE_URL: "postgres://x", RESEND_API_KEY: "re", ZEVANORY_PRIVATE_ARTIFACTS: broken },
    { sqlFactory: () => ({ query: async (q) => { q2.push(q.replace(/\s+/g, " ").trim()); return []; } }), salesOpen: true, fetchImpl: async () => { throw new Error("rede proibida"); } });
  assert.equal(off.sent, 0, "[M7.4]");
  assert.ok(q2.some((q) => /^delete from zevanory_waitlist w where/.test(q)), "[M7.5] retenção roda na dúvida");
  assert.ok(!q2.some((q) => /status='notifying'|group by email/.test(q)), "[M7.6] nada é reservado nem enviado");
  // Lista ligada e KV fora (marcador de retenção ilegível): o aviso funciona igual, uma entrega por contato.
  const d = db(), pv = provider(); d.add("h@ex.com", P[0]);
  const e = { ...env(), ZEVANORY_PRIVATE_ARTIFACTS: broken };
  await runWaitlistNotify(e, { sqlFactory: d.sqlFactory, salesOpen: true, fetchImpl: pv.fetchImpl });
  await runWaitlistNotify(e, { sqlFactory: d.sqlFactory, salesOpen: true, fetchImpl: pv.fetchImpl });
  assert.deepEqual([pv.inbox.length, d.rows.length], [1, 0], "[M7.7]");
  assert.ok(WAITLIST_HAS_DATA_KEY);
});
