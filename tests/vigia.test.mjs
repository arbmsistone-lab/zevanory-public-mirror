import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readTextNormalized } from "./helpers/text.mjs";
import { fakeSql } from "./helpers/owner-chat-fakes.mjs";
import * as vigia from "../worker/vigia.mjs";
import * as inc from "../worker/vigia-incidents.mjs";
import * as watch from "../scripts/vigia/actions-watch.mjs";
import * as chat from "../worker/owner-chat.mjs";

const T = Date.parse("2026-11-12T23:10:00Z"); // 20:10 em São Paulo
const HOUR = 3600000;
const FAR = T + 1000 * HOUR; // "agora" dos testes diretos do motor (evidências sintéticas não ficam no futuro)
function memKv(init = {}) { const data = new Map(Object.entries(init)); return { data, get: async (k) => (data.has(k) ? data.get(k) : null), put: async (k, v) => { data.set(k, String(v)); } }; }
const beat = (at, tasks) => JSON.stringify({ finishedAt: new Date(at).toISOString(), tasks });
const PUB = { today: [{ channel: "blog", status: "publicado", at: new Date(T - HOUR).toISOString() }, { channel: "bluesky", status: "publicado", at: new Date(T - HOUR).toISOString() }] };
const run = (kv, sql, at, snap = PUB) => chat.runOwnerChatSentinel({ ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "x" }, new Date(at), { sqlFactory: () => sql, snapshot: async () => snap });
const bodies = (sql, re) => sql.rows.filter((r) => re.test(r.body));
const NURTURE = "ciclo:falha:nurture";
// Segredos SINTÉTICOS montados em tempo de execução: o literal com formato de credencial não existe no código-fonte
// (a varredura de segredos do repositório continua limpa).
const SK = ["sk", "live", ""].join("_"), GHP = ["gh", "p_"].join("");
const ps = (em, resultado, extra = {}) => JSON.stringify({ em: new Date(em).toISOString(), resultado, codigo: resultado === "ok" ? "completed" : resultado === "inconclusivo" ? "post_sale_inconclusive" : "reconciliation_pending", pendentes: resultado === "reconciliacao_pendente" ? 2 : 0, ...extra });

test("NC-CX-1031-01: chave apagada não resolve; só sucesso real posterior resolve", async () => {
  const kv = memKv({ "zpc:creative-autonomy:paused:v1": "0", [vigia.CRON_BEAT_KEY]: beat(T, { nurture: "fail:timeout" }) }), sql = fakeSql();
  await run(kv, sql, T);
  assert.equal(bodies(sql, /PROBLEMA.*nurture/).length, 1);
  kv.data.delete(vigia.CRON_BEAT_KEY);
  await run(kv, sql, T + HOUR);
  assert.equal(bodies(sql, /RESOLVIDO/).length, 0, "ausência não é saúde");
  kv.data.set(vigia.CRON_BEAT_KEY, beat(T + 2 * HOUR, { nurture: "ok" }));
  await run(kv, sql, T + 2 * HOUR);
  assert.equal(bodies(sql, /RESOLVIDO.*nurture/).length, 1);
});

test("NC-CX-1031-01: pós-venda vencido, contraditório ou com campo a mais nunca vira RESOLVIDO", async () => {
  const kv = memKv({ "zpc:creative-autonomy:paused:v1": "0", [vigia.POST_SALE_STATUS_KEY]: ps(T, "reconciliacao_pendente") }), sql = fakeSql();
  await run(kv, sql, T);
  assert.equal(bodies(sql, /PROBLEMA.*pós-venda/).length, 1);
  await run(kv, sql, T + 4 * HOUR); // mesmo estado, vencido = desconhecido
  const contraditorios = [
    ps(T + 5 * HOUR, "ok", { pendentes: 3 }), // "ok" com pendentes
    ps(T + 5 * HOUR, "ok", { codigo: "reconciliation_pending" }), // "ok" com código de falha
    ps(T + 5 * HOUR, "inconclusivo", { codigo: "completed" }),
    ps(T + 5 * HOUR, "reconciliacao_pendente", { pendentes: 0 }),
    JSON.stringify({ ...JSON.parse(ps(T + 5 * HOUR, "ok")), extra: 1 }),
    JSON.stringify({ ...JSON.parse(ps(T + 5 * HOUR, "ok")), em: "2026-11-13T04:10:00+00:00" }), // não canônico
    ps(T + 9 * HOUR, "ok"), // futuro
  ];
  for (const c of contraditorios) { kv.data.set(vigia.POST_SALE_STATUS_KEY, c); await run(kv, sql, T + 5 * HOUR); }
  assert.equal(bodies(sql, /RESOLVIDO/).length, 0);
  assert.equal(bodies(sql, /pós-venda está ilegível/).length, 1, "contradição vira falha de leitura, uma vez");
  kv.data.set(vigia.POST_SALE_STATUS_KEY, ps(T + 6 * HOUR, "ok"));
  await run(kv, sql, T + 6 * HOUR);
  assert.equal(bodies(sql, /RESOLVIDO.*pós-venda/).length, 2, "pendência e leitura resolvidas com evidência real");
  assert.equal(vigia.validPostSaleStatus(JSON.parse(ps(T, "ok")), T), true);
});

test("NC-CX-1031-01: canal só resolve com publicação de data válida, de hoje e posterior; snapshot ausente não resolve", async () => {
  const kv = memKv({ "zpc:creative-autonomy:paused:v1": "1" }), sql = fakeSql();
  const blogOk = { channel: "blog", status: "publicado", at: new Date(T).toISOString() };
  await run(kv, sql, T, { today: [{ channel: "bluesky", status: "pausado" }, blogOk] });
  assert.equal(bodies(sql, /CANAL PARADO.*bluesky/).length, 1);
  await run(kv, sql, T + HOUR, null);
  for (const at of [undefined, null, "", "ontem", new Date(T - 30 * HOUR).toISOString(), new Date(T + 5 * HOUR).toISOString()])
    await run(kv, sql, T + HOUR + 60000, { today: [{ channel: "bluesky", status: "publicado", at }, blogOk] });
  assert.equal(bodies(sql, /RESOLVIDO/).length, 0, "publicado sem data válida = desconhecido");
  await run(kv, sql, T + 2 * HOUR, { today: [{ channel: "bluesky", status: "publicado", at: new Date(T + 2 * HOUR).toISOString() }, blogOk] });
  assert.equal(bodies(sql, /RESOLVIDO.*bluesky/).length, 1);
});

test("NC-CX-1031-01: workflow com falha que envelhece vira desconhecido; resumo vencido é falha de observação", () => {
  const sum = (workflows, at = T) => ({ state: "ok", value: { schema: 2, at: new Date(at).toISOString(), workflows } });
  assert.ok(vigia.observeActions(sum({ "p18-commercial-check.yml": { state: "falha", run_id: 7, at: new Date(T - 600000).toISOString() } }), T).some((o) => o.key === "github:p18-commercial-check.yml" && o.health === "falha"));
  assert.ok(!vigia.observeActions(sum({ "p18-commercial-check.yml": { state: "desconhecido" } }), T).some((o) => o.key === "github:p18-commercial-check.yml"));
  assert.ok(vigia.observeActions(sum({}, T - 4 * HOUR), T).some((o) => o.key === "vigia:sem-dados:github" && o.health === "falha"));
});

test("NC-CX-1031-01 r3: saúde datada no futuro (ciclo, resumo, workflow) nunca resolve; saúde real posterior resolve", async () => {
  const TOMORROW = T + 24 * HOUR;
  // ciclo horário
  const kv = memKv({ "zpc:creative-autonomy:paused:v1": "0", [vigia.CRON_BEAT_KEY]: beat(T, { nurture: "fail:timeout" }) }), sql = fakeSql();
  await run(kv, sql, T);
  kv.data.set(vigia.CRON_BEAT_KEY, beat(TOMORROW, { nurture: "ok" }));
  await run(kv, sql, T + 60000); await run(kv, sql, T + HOUR);
  assert.equal(bodies(sql, /RESOLVIDO/).length, 0, "ciclo datado amanhã");
  assert.ok(vigia.observeCron({ state: "ok", value: JSON.parse(beat(TOMORROW, { nurture: "ok" })) }, T).every((o) => o.health === "falha"));
  kv.data.set(vigia.CRON_BEAT_KEY, beat(T + 2 * HOUR, { nurture: "ok" }));
  await run(kv, sql, T + 2 * HOUR);
  assert.equal(bodies(sql, /RESOLVIDO.*nurture/).length, 1);
  // workflow do GitHub: resumo futuro e workflow futuro
  const sum = (at, wfAt, state) => JSON.stringify({ schema: 2, at: new Date(at).toISOString(), workflows: { [P18]: { state, run_id: 9, at: new Date(wfAt).toISOString() } } });
  const kv2 = memKv({ "zpc:creative-autonomy:paused:v1": "0", [vigia.VIGIA_ACTIONS_KEY]: sum(T, T - 60000, "falha") }), sql2 = fakeSql();
  await run(kv2, sql2, T);
  assert.equal(bodies(sql2, /PROBLEMA.*p18/).length, 1);
  for (const [a, w] of [[TOMORROW, TOMORROW], [T + HOUR, TOMORROW], [T + HOUR, T + 2 * HOUR]]) { kv2.data.set(vigia.VIGIA_ACTIONS_KEY, sum(a, w, "saudavel")); await run(kv2, sql2, T + HOUR); }
  assert.equal(bodies(sql2, /RESOLVIDO/).length, 0, "resumo/workflow no futuro ou depois do próprio resumo");
  kv2.data.set(vigia.VIGIA_ACTIONS_KEY, sum(T + HOUR, T + 30 * 60000, "saudavel")); await run(kv2, sql2, T + HOUR);
  assert.equal(bodies(sql2, /RESOLVIDO.*p18/).length, 1);
  // segunda barreira no motor: saúde futura de qualquer origem é descartada
  const sql3 = fakeSql(), kv3 = memKv(), ins = (db, m) => chat.insertOwnerMessage(db, m);
  await inc.runIncidents({ sql: sql3, kv: kv3, observations: [{ key: "x", health: "falha", at: T, text: "x" }], insertMessage: ins, now: T });
  await inc.runIncidents({ sql: sql3, kv: kv3, observations: [{ key: "x", health: "saudavel", at: TOMORROW }], insertMessage: ins, now: T + 60000 });
  assert.equal(sql3.vstate.get("x").aberto, true);
  // coletor: run com data futura é ignorado (vale o run real anterior)
  const g = gh({ runs: { [P18]: [[R(50, "success", { ago: -24 * HOUR }), R(49, "failure")]] } });
  assert.equal((await watch.watchActions({ token: "t", now: T, fetchImpl: g.fetchImpl })).workflows[P18].state, "falha");
});

test("NC-CX-1031-02: concorrência = uma ocorrência e um aviso; reabrir com falha nova cria nova ocorrência", async () => {
  const sql = fakeSql();
  const mk = () => memKv({ "zpc:creative-autonomy:paused:v1": "0", [vigia.CRON_BEAT_KEY]: beat(T, { nurture: "fail:timeout" }) });
  await Promise.all([run(mk(), sql, T), run(mk(), sql, T + 1000)]);
  assert.equal(sql.vstate.get(NURTURE).gen, 1); assert.equal(bodies(sql, /PROBLEMA.*nurture/).length, 1);
  const kv = mk();
  kv.data.set(vigia.CRON_BEAT_KEY, beat(T + HOUR, { nurture: "ok" })); await run(kv, sql, T + HOUR);
  kv.data.set(vigia.CRON_BEAT_KEY, beat(T + 2 * HOUR, { nurture: "fail:timeout" })); await run(kv, sql, T + 2 * HOUR);
  assert.equal(sql.vstate.get(NURTURE).gen, 2); assert.equal(bodies(sql, /PROBLEMA.*nurture/).length, 2);
});

test("NC-CX-1031-02: falha antiga atrasada não reabre incidente resolvido; saúde e falha no mesmo lote = falha", async () => {
  const sql = fakeSql(), kv = memKv(), ins = (db, m) => chat.insertOwnerMessage(db, m);
  const R = (obs) => inc.runIncidents({ sql, kv, observations: obs, insertMessage: ins, now: FAR });
  await R([{ key: "k", health: "falha", at: T, text: "x" }]);
  await R([{ key: "k", health: "saudavel", at: T + HOUR }]);
  assert.equal(sql.vstate.get("k").aberto, false);
  await R([{ key: "k", health: "falha", at: T + 30 * 60000, text: "x" }]); // evidência anterior à resolução
  assert.equal(sql.vstate.get("k").aberto, false); assert.equal(sql.vstate.get("k").gen, 1);
  await R([{ key: "k", health: "falha", at: T + 2 * HOUR, text: "x" }]);
  assert.equal(sql.vstate.get("k").gen, 2);
  await R([{ key: "k", health: "saudavel", at: T + 3 * HOUR }, { key: "k", health: "falha", at: T + 3 * HOUR, text: "x" }]);
  assert.equal(sql.vstate.get("k").aberto, true, "lote ambíguo não resolve");
  // reabrir espera a entrega do RESOLVIDO anterior
  const sql2 = fakeSql(), kv2 = memKv();
  let failResolve = true;
  const ins2 = async (db, m) => { if (failResolve && m.dedupe.startsWith("vigia:resolver")) throw new Error("db"); return chat.insertOwnerMessage(db, m); };
  const R2 = (obs) => inc.runIncidents({ sql: sql2, kv: kv2, observations: obs, insertMessage: ins2, now: FAR }).catch(() => null);
  await R2([{ key: "k", health: "falha", at: T, text: "x" }]);
  await R2([{ key: "k", health: "saudavel", at: T + HOUR }]);
  await R2([{ key: "k", health: "falha", at: T + 2 * HOUR, text: "x" }]);
  assert.equal(sql2.vstate.get("k").gen, 1, "não reabre com RESOLVIDO pendente");
  failResolve = false;
  await R2([{ key: "k", health: "falha", at: T + 3 * HOUR, text: "x" }]);
  await R2([{ key: "k", health: "falha", at: T + 3 * HOUR + 1, text: "x" }]);
  assert.equal(sql2.vstate.get("k").gen, 2);
  assert.equal(bodies(sql2, /RESOLVIDO/).length, 1);
  assert.equal(bodies(sql2, /PROBLEMA/).length, 2);
});

test("NC-CX-1031-03: falha em qualquer ponto do aviso não perde nem duplica a confirmação", async () => {
  for (const point of ["vigia-resolve-msg", "notified-resolve", "hint"]) {
    const kv = memKv({ "zpc:creative-autonomy:paused:v1": "0", [vigia.CRON_BEAT_KEY]: beat(T, { nurture: "fail:timeout" }) }), sql = fakeSql();
    await run(kv, sql, T);
    kv.data.set(vigia.CRON_BEAT_KEY, beat(T + HOUR, { nurture: "ok" }));
    const q = sql.query, put = kv.put;
    sql.query = async (t, p) => { if (point === "vigia-resolve-msg" && /owner-chat:insert/.test(t) && String(p?.[5]).startsWith("vigia:resolver")) throw new Error("db"); if (point === "notified-resolve" && /vigia:notified-resolve/.test(t)) throw new Error("db"); return q(t, p); };
    if (point === "hint") kv.put = async (k, v) => { if (k === inc.VIGIA_HINT_KEY && JSON.parse(v).pending === false) throw new Error("kv"); return put(k, v); };
    await run(kv, sql, T + HOUR).catch(() => null);
    sql.query = q; kv.put = put;
    await run(kv, sql, T + HOUR + 1000);
    await run(kv, sql, T + 2 * HOUR);
    assert.equal(bodies(sql, /RESOLVIDO.*nurture/).length, 1, point);
  }
});

test("NC-CX-1031-04: nada sensível chega ao texto, ao estado nem à resposta de status", async () => {
  const S = ["SYNTHETIC_SECRET", "SYN_TOK", "hunter2", SK, "x@y.com", "99999", "123.456.789", "Bearer", GHP, "synthsecret"];
  const dirty = "fail:Authorization Bearer SYNTHETIC_SECRET_ABC123 token=SYN_TOK password=hunter2 " + SK + "SYN x@y.com +55 11 99999-9999 123.456.789-00";
  const kv = memKv({ "zpc:creative-autonomy:paused:v1": "0",
    [vigia.CRON_BEAT_KEY]: beat(T, { nurture: dirty, [SK + "synthsecret_abc123"]: "fail:x", "evil Bearer SYN": "fail:x", [GHP + "synthsecret0123456789"]: "fail:timeout" }),
    [vigia.VIGIA_ACTIONS_KEY]: JSON.stringify({ schema: 2, at: new Date(T).toISOString(), workflows: { "p18-commercial-check.yml": { state: "falha", run_id: 123, at: new Date(T).toISOString(), url: "https://github.com/x/actions/runs/123?token=SYNTHETIC_SECRET_URL" } } }) });
  const snap = { today: [{ channel: "bluesky", status: "erro", error: GHP + "synthsecret0123456789abcdef", link: "https://bsky.app/p?token=SYNTHETIC_SECRET_Q" }, { channel: "blog", status: "token " + SK + "synthsecret", error: null }] };
  const sql = fakeSql();
  await run(kv, sql, T, snap);
  const all = JSON.stringify([sql.rows, [...sql.vstate.values()]]);
  for (const s of S) assert.ok(!all.includes(s), s);
  assert.ok(all.includes("actions/runs/123")); assert.match(all, /tarefa automática não identificada/);
  assert.equal(new Set([...sql.vstate.keys()].filter((k) => k.startsWith("ciclo:falha:desconhecida_"))).size, 3, "tarefas desconhecidas não colidem");
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "x" };
  const h = await chat.handleOwnerChat(new Request("https://zevanory.api.br/api/admin/owner-chat/message", { method: "POST", body: JSON.stringify({ text: "status" }), headers: { origin: "https://zevanory.api.br", "x-owner-chat": "1", "content-type": "application/json" } }), env, { isAdminAuthorized: () => true, sqlFactory: () => sql, snapshot: async () => snap });
  const reply = JSON.stringify(await h.json());
  for (const s of S) assert.ok(!reply.includes(s), "status: " + s);
  assert.match(reply, /bsky\.app\/p/);
  assert.equal(vigia.errorCategory("ECONNRESET token=abc"), "erro não classificado");
});

// GitHub simulado: depois do POST, a 2ª tentativa existe (attempts/2 = 200 e run_attempt 2), a menos que "stale".
function gh({ runs = {}, run = {}, post = 201, failList = false, stale = false, attempts = null } = {}) {
  const posts = [], done = new Set();
  const fetchImpl = async (url, opts = {}) => {
    const rid = /\/actions\/runs\/(\d+)/.exec(url)?.[1];
    if (opts.method === "POST") { posts.push(url); if (post === "throw") { done.add(rid); throw new Error("timeout"); } if (post < 300) done.add(rid); return new Response(null, { status: post }); }
    if (/\/attempts\/2$/.test(url)) return new Response("{}", { status: attempts ?? (done.has(rid) && !stale ? 200 : 404) });
    if (failList) return new Response("{}", { status: 502 });
    if (/\/actions\/runs\/(\d+)$/.test(url)) { const b = run[rid] || {}; return Response.json(done.has(rid) && !stale ? { ...b, run_attempt: 2, status: "queued", conclusion: null } : b); }
    const wf = /workflows\/([^/]+)\/runs/.exec(url)?.[1], page = Number(/[?&]page=(\d+)/.exec(url)?.[1] || 1);
    return Response.json({ workflow_runs: (runs[wf] || [])[page - 1] || [] });
  };
  return { posts, fetchImpl };
}
const R = (id, conclusion, { branch = "gh-pages", event = "schedule", attempt = 1, ago = 600000 } = {}) => ({ id, conclusion, event, head_branch: branch, run_attempt: attempt, status: "completed", created_at: new Date(T - ago).toISOString() });
const P18 = "p18-commercial-check.yml";

test("NC-CX-1031-05: perda do diário não permite segundo pedido (cópia no resumo e 2ª tentativa no GitHub)", async () => {
  const f = R(1, "failure"), mk = (o = {}) => gh({ runs: { [P18]: [[f]], "command-center-snapshot.yml": [[R(2, "failure")]] }, run: { 1: f, 2: R(2, "failure") }, ...o });
  // normal: lista atrasada não repete
  const kv = memKv(), g = mk();
  const a = await watch.watchActions({ token: "t", now: T, fetchImpl: g.fetchImpl, ledger: kv });
  const b = await watch.watchActions({ token: "t", now: T + 1800000, fetchImpl: g.fetchImpl, ledger: kv, previous: a });
  assert.equal(g.posts.length, 1); assert.equal(a.workflows[P18].rerun, "feita"); assert.equal(b.workflows[P18].rerun, "feita");
  assert.ok(!g.posts.some((u) => /runs\/2\//.test(u)), "snapshot fora da lista");
  // diário perdido + GitHub simulado atrasado (continua attempt 1 e sem attempts/2): a cópia no resumo segura
  const g2 = mk({ stale: true }), kv2 = memKv();
  const a2 = await watch.watchActions({ token: "t", now: T, fetchImpl: g2.fetchImpl, ledger: kv2 });
  kv2.data.delete(watch.RERUN_LEDGER_KEY);
  const b2 = await watch.watchActions({ token: "t", now: T + 1800000, fetchImpl: g2.fetchImpl, ledger: kv2, previous: a2 });
  assert.equal(g2.posts.length, 1); assert.equal(b2.workflows[P18].rerun, "feita");
  // diário E resumo perdidos: o GitHub (2ª tentativa existe) segura
  const g3 = mk(), kv3 = memKv();
  await watch.watchActions({ token: "t", now: T, fetchImpl: g3.fetchImpl, ledger: kv3 });
  kv3.data.delete(watch.RERUN_LEDGER_KEY);
  await watch.watchActions({ token: "t", now: T + 1800000, fetchImpl: g3.fetchImpl, ledger: kv3, previous: null });
  assert.equal(g3.posts.length, 1);
  const g3b = mk({ attempts: 200 });
  await watch.watchActions({ token: "t", now: T, fetchImpl: g3b.fetchImpl, ledger: memKv() });
  assert.equal(g3b.posts.length, 0, "attempts/2 existente = já repetido");
  // qualquer dúvida = não pede
  for (const [o, prev, ledgerRaw, expect] of [[{ attempts: 500 }, null, null, "nao_conferida"], [{}, "ilegivel", null, "registro_ilegivel"], [{}, null, "{ilegível", "registro_ilegivel"]]) {
    const gx = mk(o), kx = memKv(ledgerRaw ? { [watch.RERUN_LEDGER_KEY]: ledgerRaw } : {});
    const sx = await watch.watchActions({ token: "t", now: T, fetchImpl: gx.fetchImpl, ledger: kx, previous: prev });
    assert.equal(gx.posts.length, 0); assert.equal(sx.workflows[P18].rerun, expect);
  }
  const old = R(5, "failure", { ago: 7 * HOUR }), go = gh({ runs: { [P18]: [[old]] }, run: { 5: old } });
  await watch.watchActions({ token: "t", now: T, fetchImpl: go.fetchImpl, ledger: memKv() });
  assert.equal(go.posts.length, 0, "run antigo não é repetido");
  assert.deepEqual([...watch.RERUN_ALLOWLIST], [P18]);
});

test("NC-CX-1031-05: timeout = incerta e 409 = recusada, sem novo pedido", async () => {
  const f = R(1, "failure");
  const g = gh({ runs: { [P18]: [[f]] }, run: { 1: f }, post: "throw", stale: true }), kv = memKv();
  const a = await watch.watchActions({ token: "t", now: T, fetchImpl: g.fetchImpl, ledger: kv });
  const b = await watch.watchActions({ token: "t", now: T + 1800000, fetchImpl: g.fetchImpl, ledger: kv, previous: a });
  assert.equal(g.posts.length, 1); assert.equal(b.workflows[P18].rerun, "incerta");
  const g2 = gh({ runs: { [P18]: [[f]] }, run: { 1: f }, post: 409 }), kv2 = memKv();
  const c = await watch.watchActions({ token: "t", now: T, fetchImpl: g2.fetchImpl, ledger: kv2 });
  await watch.watchActions({ token: "t", now: T + 1800000, fetchImpl: g2.fetchImpl, ledger: kv2, previous: c });
  assert.equal(g2.posts.length, 1); assert.equal(c.workflows[P18].rerun, "recusada");
});

test("NC-CX-1031-06: sucesso de outra branch não esconde falha da gh-pages; página seguinte; API incompleta = desconhecido", async () => {
  const filler = Array.from({ length: 20 }, (_, i) => R(100 + i, "success", { branch: "feature-x", ago: 1000 }));
  const g = gh({ runs: { "central-production-integrity-audit.yml": [[R(9, "success", { branch: "feature-unrelated", event: "workflow_dispatch", ago: 1000 }), R(8, "failure")]], "p18-external-monitor.yml": [filler, [R(7, "failure")]] } });
  const s = await watch.watchActions({ token: "t", now: T, fetchImpl: g.fetchImpl });
  assert.equal(s.workflows["central-production-integrity-audit.yml"].state, "falha");
  assert.equal(s.workflows["p18-external-monitor.yml"].state, "falha");
  const bad = await watch.watchActions({ token: "t", now: T, fetchImpl: gh({ failList: true }).fetchImpl });
  assert.ok(Object.values(bad.workflows).every((w) => w.state === "desconhecido"));
});

test("workflow do vigia: serializado, só actions:write, ações fixadas por SHA, sem publicação nem deploy", () => {
  const y = readTextNormalized(new URL("../.github/workflows/vigia-actions.yml", import.meta.url));
  assert.match(y, /cancel-in-progress: false/); assert.match(y, /actions: write/);
  assert.doesNotMatch(y, /contents: write|issues: write|pull-requests: write|wrangler|short-crosspost|youtube-daily-short\.yml/);
  assert.match(y, /actions\/checkout@[0-9a-f]{40}/); assert.match(y, /actions\/setup-node@[0-9a-f]{40}/);
});

const SRC = { watch: fileURLToPath(new URL("../scripts/vigia/actions-watch.mjs", import.meta.url)), inc: fileURLToPath(new URL("../worker/vigia-incidents.mjs", import.meta.url)), vig: fileURLToPath(new URL("../worker/vigia.mjs", import.meta.url)) };
async function mutant(file, name, from, to, check) {
  const src = readTextNormalized(SRC[file]); assert.ok(src.includes(from), "âncora " + name);
  const path = SRC[file].replace(/\.mjs$/, `.mutant-${name}.mjs`);
  await writeFile(path, src.replace(from, to));
  try { const m = await import(pathToFileURL(path).href + "?" + Date.now()); assert.equal(await check(m), false, "mutante sobreviveu: " + name); } finally { await rm(path, { force: true }); }
}
// O banco falso aplica as condições do SQL de produção; para mutantes de SQL, o falso passa a obedecer ao texto mutado.
function sqlObeying(clause, tag, apply) { const sql = fakeSql(), q = sql.query; sql.query = async (t, p) => (t.includes("/*vigia:" + tag + "*/") && !t.includes(clause) ? apply(sql, p) : q(t, p)); return sql; }
test("mutantes morrem", async () => {
  await mutant("watch", "sem-reserva", "if (known) {", "if (false) {", async (m) => {
    const kv = memKv(), f = R(1, "failure"), g = gh({ runs: { [P18]: [[f]] }, run: { 1: f }, stale: true });
    const a = await m.watchActions({ token: "t", now: T, fetchImpl: g.fetchImpl, ledger: kv }); await m.watchActions({ token: "t", now: T, fetchImpl: g.fetchImpl, ledger: kv, previous: a });
    return g.posts.length === 1;
  });
  await mutant("watch", "sem-copia-no-resumo", "const known = book[id] || reruns[id];", "const known = book[id];", async (m) => {
    const kv = memKv(), f = R(1, "failure"), g = gh({ runs: { [P18]: [[f]] }, run: { 1: f }, stale: true });
    const a = await m.watchActions({ token: "t", now: T, fetchImpl: g.fetchImpl, ledger: kv }); kv.data.delete(m.RERUN_LEDGER_KEY);
    await m.watchActions({ token: "t", now: T, fetchImpl: g.fetchImpl, ledger: kv, previous: a });
    return g.posts.length === 1;
  });
  await mutant("watch", "sem-conferir-github", "if (second !== 404) { w.rerun = \"nao_conferida\"; continue; }", "", async (m) => {
    const f = R(1, "failure"), g = gh({ runs: { [P18]: [[f]] }, run: { 1: f }, attempts: 500 });
    await m.watchActions({ token: "t", now: T, fetchImpl: g.fetchImpl, ledger: memKv() });
    return g.posts.length === 0;
  });
  await mutant("watch", "sem-filtro-branch", "r.head_branch === BRANCH && ", "", async (m) => {
    const g = gh({ runs: { "central-production-integrity-audit.yml": [[R(9, "success", { branch: "x", ago: 1000 }), R(8, "failure")]] } });
    return (await m.watchActions({ token: "t", now: T, fetchImpl: g.fetchImpl })).workflows["central-production-integrity-audit.yml"].state === "falha";
  });
  const ins = async () => null;
  await mutant("inc", "resolve-sem-evidencia-posterior", "where problem_key = $1 and aberto and opened_evidence_at < ${TS(2)} returning gen", "where problem_key = $1 and aberto returning gen", async (m) => {
    const sql = sqlObeying("opened_evidence_at <", "resolve", (db, p) => { const s = db.vstate.get(p[0]); if (!s || !s.aberto) return []; Object.assign(s, { aberto: false, resolved_evidence_at: p[1], resolve_notified: false }); return [{ gen: s.gen }]; });
    await m.runIncidents({ sql, kv: memKv(), observations: [{ key: "k", health: "falha", at: T, text: "x" }], insertMessage: ins, now: FAR });
    await m.runIncidents({ sql, kv: memKv(), observations: [{ key: "k", health: "saudavel", at: T - 1000 }], insertMessage: ins, now: FAR });
    return sql.vstate.get("k").aberto === true;
  });
  await mutant("inc", "reabre-com-falha-antiga", " and s.resolved_evidence_at < excluded.opened_evidence_at", "", async (m) => {
    const sql = sqlObeying("s.resolved_evidence_at < excluded", "open", (db, p) => { const s = db.vstate.get(p[0]); if (!s) { db.vstate.set(p[0], { problem_key: p[0], gen: 1, aberto: true, opened_at: T, opened_evidence_at: p[1], resolved_evidence_at: null, open_text: p[2], open_notified: false, resolve_notified: false }); return [{ gen: 1 }]; } if (s.aberto || !s.open_notified || !s.resolve_notified) return []; Object.assign(s, { gen: s.gen + 1, aberto: true, opened_evidence_at: p[1], resolved_evidence_at: null, open_notified: false, resolve_notified: false }); return [{ gen: s.gen }]; });
    const kv = memKv(), go = (o) => m.runIncidents({ sql, kv, observations: [o], insertMessage: ins, now: FAR });
    await go({ key: "k", health: "falha", at: T, text: "x" }); await go({ key: "k", health: "saudavel", at: T + HOUR }); await go({ key: "k", health: "falha", at: T + 60000, text: "x" });
    return sql.vstate.get("k").gen === 1;
  });
  await mutant("inc", "lote-ambiguo-resolve", "for (const k of failing.keys()) healthy.delete(k);", "", async (m) => {
    const sql = fakeSql(), kv = memKv();
    await m.runIncidents({ sql, kv, observations: [{ key: "k", health: "falha", at: T, text: "x" }], insertMessage: ins, now: FAR });
    await m.runIncidents({ sql, kv, observations: [{ key: "k", health: "falha", at: T + HOUR, text: "x" }, { key: "k", health: "saudavel", at: T + HOUR }], insertMessage: ins, now: FAR });
    return sql.vstate.get("k").aberto === true;
  });
  await mutant("vig", "ciclo-aceita-futuro", "if (!validAt(at, now)) return [{ key: \"vigia:sem-dados:ciclo\"", "if (!Number.isFinite(at)) return [{ key: \"vigia:sem-dados:ciclo\"", async (m) =>
    m.observeCron({ state: "ok", value: { finishedAt: new Date(T + 24 * HOUR).toISOString(), tasks: { nurture: "ok" } } }, T).every((o) => o.health === "falha"));
  await mutant("vig", "workflow-aceita-futuro", "if (!validAt(runAt, now) || runAt > at) continue;", "if (!Number.isFinite(runAt)) continue;", async (m) =>
    !m.observeActions({ state: "ok", value: { schema: 2, at: new Date(T).toISOString(), workflows: { [P18]: { state: "saudavel", run_id: 1, at: new Date(T + 24 * HOUR).toISOString() } } } }, T).some((o) => o.key === "github:" + P18));
  await mutant("inc", "motor-aceita-futuro", "const healthy = all.filter((o) => o.at <= now + 5 * 60000);", "const healthy = all;", async (m) => {
    const sql = fakeSql(), kv = memKv();
    await m.runIncidents({ sql, kv, observations: [{ key: "x", health: "falha", at: T, text: "x" }], insertMessage: ins, now: T });
    await m.runIncidents({ sql, kv, observations: [{ key: "x", health: "saudavel", at: T + 24 * HOUR }], insertMessage: ins, now: T });
    return sql.vstate.get("x").aberto === true;
  });
  await mutant("watch", "coletor-aceita-futuro", " && Date.parse(r.created_at) <= now + 5 * 60000", "", async (m) => {
    const g = gh({ runs: { [P18]: [[R(50, "success", { ago: -24 * HOUR }), R(49, "failure")]] } });
    return (await m.watchActions({ token: "t", now: T, fetchImpl: g.fetchImpl })).workflows[P18].state === "falha";
  });
  await mutant("vig", "categoria-copia-texto", "return \"erro não classificado\";", "return d;", async (m) => !m.errorCategory("bearer xyz").includes("xyz"));
  await mutant("vig", "tarefa-copia-nome", "const taskLabel = (t) => (KNOWN_TASKS.includes(t) ? `\"${t}\"` : \"não identificada\");", "const taskLabel = (t) => `\"${t}\"`;", async (m) =>
    !JSON.stringify(m.observeCron({ state: "ok", value: { finishedAt: new Date(T).toISOString(), tasks: { [SK + "synth"]: "fail:x" } } }, T)).includes(SK));
});
