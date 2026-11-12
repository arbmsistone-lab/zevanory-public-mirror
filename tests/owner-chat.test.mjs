import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readTextNormalized } from "./helpers/text.mjs";
import * as chat from "../worker/owner-chat.mjs";

const ORIGIN = "https://zevanory.api.br";
const PAUSE = "zpc:creative-autonomy:paused:v1";
const auth = (req) => req.headers.get("authorization") === "Basic ok";

// KV em memória com contagem de leituras/escritas e falha opcional.
function memKv(init = {}, { failGet = () => false, failPut = () => false } = {}) {
  const data = new Map(Object.entries(init)); const writes = []; let reads = 0;
  return { data, writes, get reads() { return reads; },
    get: async (k) => { reads++; if (failGet(k)) throw new Error("kv"); return data.has(k) ? data.get(k) : null; },
    put: async (k, v) => { if (failPut(k)) throw new Error("kv"); writes.push(k); data.set(k, String(v)); } };
}
// Banco falso que reproduz a semântica das consultas marcadas (chave única, UPDATE condicional atômico).
function fakeSql() {
  const rows = []; let seq = 0; const ai = new Map(); const log = []; let clock = Date.parse("2026-11-12T23:00:00Z");
  const out = (r) => ({ id: String(r.id), created_at: new Date(r.created_at).toISOString(), sender: r.sender, kind: r.kind, body: r.body, action_type: r.action_type, action_expires_at: r.action_expires_at ? new Date(r.action_expires_at).toISOString() : null, action_state: r.action_state });
  return { rows, log, tick: (ms) => { clock += ms; }, query: async (text, p = []) => {
    const tag = (/\/\*owner-chat:([a-z-]+)\*\//.exec(text) || [])[1] || (/create table/.test(text) ? "ddl" : "?");
    log.push(tag);
    if (tag === "ddl") return [];
    if (tag === "insert") {
      if (p[5] !== null && rows.some((r) => r.dedupe_key === p[5])) { seq++; return []; }
      const r = { id: ++seq, created_at: clock, sender: p[0], kind: p[1], body: p[2], action_type: p[3], action_expires_at: p[3] ? clock + p[4] * 1000 : null, action_state: p[3] ? "proposta" : null, dedupe_key: p[5] };
      rows.push(r); return [out(r)];
    }
    if (tag === "feed") return rows.slice().sort((a, b) => b.id - a.id).slice(0, p[0]).map(out);
    if (tag === "claim") { const r = rows.find((x) => String(x.id) === p[0] && x.action_state === "proposta" && x.action_expires_at > clock); if (!r) return []; r.action_state = "executando"; return [{ action_type: r.action_type }]; }
    if (tag === "action-state") { const r = rows.find((x) => String(x.id) === p[0] && x.action_type); return r ? [{ action_state: r.action_state, live: r.action_expires_at > clock }] : []; }
    if (tag === "settle") { const r = rows.find((x) => String(x.id) === p[0] && x.action_state === "executando"); if (r) r.action_state = p[1]; return []; }
    if (tag === "ai-reserve") { const n = ai.get(p[0]) || 0; if (n >= p[1]) return []; ai.set(p[0], n + 1); return [{ n: n + 1 }]; }
    if (tag === "retention") { const before = rows.length; for (let i = rows.length - 1; i >= 0; i--) if (rows[i].created_at < clock - 180 * 86400000) rows.splice(i, 1); return [{ n: before - rows.length }]; }
    if (tag === "retention-ai") { let n = 0; for (const d of [...ai.keys()]) if (Date.parse(d) < clock - 60 * 86400000) { ai.delete(d); n++; } return [{ n }]; }
    throw new Error("consulta desconhecida: " + text.slice(0, 60));
  } };
}
const snap = (rows) => async () => ({ day: "2026-11-12", today: rows });
function harness({ kv = memKv({ [PAUSE]: "0" }), sql = fakeSql(), rows = [], ai } = {}) {
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "x", ...(ai ? { AI: ai } : {}) };
  let factory = 0;
  const deps = { isAdminAuthorized: auth, sqlFactory: () => { factory++; return sql; }, snapshot: snap(rows) };
  return { kv, sql, env, deps, get factory() { return factory; }, call: (r) => chat.handleOwnerChat(r, env, deps) };
}
const req = (path, { method = "GET", body, headers = {} } = {}) => new Request(ORIGIN + path, { method, body: body ? JSON.stringify(body) : undefined, headers: { authorization: "Basic ok", ...(method === "POST" ? { origin: ORIGIN, "x-owner-chat": "1", "content-type": "application/json" } : {}), ...headers } });
const send = async (h, text) => (await (await h.call(req("/api/admin/owner-chat/message", { method: "POST", body: { text } }))).json()).messages;

test("401 antes de qualquer KV ou banco, em todas as rotas (NC-07)", async () => {
  const h = harness({ kv: memKv() });
  for (const [p, m] of [["/admin/proprietario", "GET"], ["/api/admin/owner-chat/app", "GET"], ["/api/admin/owner-chat/feed", "GET"], ["/api/admin/owner-chat/message", "POST"], ["/api/admin/owner-chat/action", "POST"]]) {
    const r = await h.call(new Request(ORIGIN + p, { method: m }));
    assert.equal(r.status, 401, p); assert.match(r.headers.get("www-authenticate"), /Basic/);
  }
  assert.equal(h.kv.reads, 0); assert.equal(h.factory, 0);
});

test("integração: a rota é despachada antes da leitura do interruptor de vendas no Worker central (NC-07)", () => {
  const src = readTextNormalized(new URL("../worker/cloudflare-worker.compat.mjs", import.meta.url));
  const route = src.indexOf("if (isOwnerChatPath(new URL(request.url).pathname)) return handleOwnerChat(");
  const sales = src.indexOf("applySalesSwitch(await readSalesSwitch(normalized));");
  assert.ok(route > 0 && sales > 0 && route < sales);
});

test("rotas de fora não são capturadas; /admin/proprietario redireciona para a página fora da injeção pública", async () => {
  const h = harness();
  assert.equal(await h.call(req("/api/admin/snapshot")), null);
  const r = await h.call(req("/admin/proprietario"));
  assert.equal(r.status, 302); assert.equal(r.headers.get("location"), "/api/admin/owner-chat/app");
  const p = await h.call(req("/api/admin/owner-chat/app"));
  assert.equal(p.status, 200); assert.match(p.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(p.headers.get("x-robots-tag"), /noindex/); assert.match(await p.text(), /Chat do Proprietário/);
});

test("CSRF: sem cabeçalho próprio ou de outra origem = 403, sem banco", async () => {
  const h = harness();
  const a = await h.call(req("/api/admin/owner-chat/message", { method: "POST", body: { text: "status" }, headers: { "x-owner-chat": "0" } }));
  const b = await h.call(req("/api/admin/owner-chat/message", { method: "POST", body: { text: "status" }, headers: { origin: "https://evil.example" } }));
  assert.equal(a.status, 403); assert.equal(b.status, 403); assert.equal(h.sql.rows.length, 0);
});

test("status com dados reais; cada mensagem é uma linha própria no banco", async () => {
  const h = harness({ rows: [{ channel: "bluesky", status: "publicado", link: "https://bsky.app/x" }, { channel: "blog", status: "rascunho", error: "draft_only_publication_disabled" }] });
  const m = await send(h, "qual o status de hoje?");
  assert.equal(m.length, 2);
  assert.match(m[1].text, /bluesky: publicado — https:\/\/bsky\.app\/x/);
  assert.match(m[1].text, /blog: rascunho \(draft_only_publication_disabled\)/);
  assert.equal(h.sql.rows.length, 2);
});

test("gravações concorrentes não apagam mensagens nem alertas (NC-01)", async () => {
  const h = harness({ kv: memKv({ [PAUSE]: "1" }), rows: [{ channel: "bluesky", status: "pausado" }] });
  const sentinel = () => chat.runOwnerChatSentinel(h.env, new Date("2026-11-12T23:10:00Z"), { sqlFactory: h.deps.sqlFactory, snapshot: h.deps.snapshot });
  await Promise.all([send(h, "status"), sentinel(), send(h, "vendas"), sentinel()]);
  const kinds = h.sql.rows.map((r) => r.sender + ":" + r.kind);
  assert.equal(kinds.filter((k) => k === "owner:chat").length, 2);
  assert.equal(h.sql.rows.filter((r) => r.kind === "alerta" && /bluesky/.test(r.body)).length, 1, "alerta único mesmo com duas sentinelas");
});

test("vendas: sem livro, livro ilegível e livro com valor inválido nunca viram número falso (NC-04)", async () => {
  assert.match((await send(harness(), "vendeu algo?"))[1].text, /Ainda não há nenhuma venda/);
  for (const bad of ["{quebrado", JSON.stringify({ totals: { approved: "2" } }), JSON.stringify({ totals: { approved: 1, grossCents: "x" } }), JSON.stringify({ totals: { approved: 1, grossCents: 100 }, byDay: { "2026-11-12": { approved: 1, grossCents: -5 } } })]) {
    const t = (await send(harness({ kv: memKv({ [PAUSE]: "0", "zpc:sales:v1:summary": bad }) }), "vendas"))[1].text;
    assert.match(t, /ilegível/); assert.doesNotMatch(t, /NaN/);
  }
});

test("ação: proposta, execução única mesmo com cliques simultâneos, expiração (NC-02)", async () => {
  const h = harness({ kv: memKv({ [PAUSE]: "1" }) });
  const proposal = (await send(h, "retomar a publicação"))[1];
  assert.equal(proposal.action.type, "retomar_criativos"); assert.equal(h.kv.data.get(PAUSE), "1");
  const [a, b] = await Promise.all([1, 2].map(() => h.call(req("/api/admin/owner-chat/action", { method: "POST", body: { id: proposal.id } }))));
  assert.deepEqual([a.status, b.status].sort(), [200, 409]); assert.equal(h.kv.data.get(PAUSE), "0");
  const h2 = harness();
  const p2 = (await send(h2, "pausar tudo"))[1];
  h2.sql.tick(11 * 60 * 1000);
  assert.equal((await h2.call(req("/api/admin/owner-chat/action", { method: "POST", body: { id: p2.id } }))).status, 410);
  assert.equal(h2.kv.data.get(PAUSE), "0");
});

test("ação que falha ao gravar: responde erro, fica 'falhou' e NÃO pode ser repetida (NC-02)", async () => {
  const kv = memKv({ [PAUSE]: "1" }, { failPut: (k) => k === PAUSE });
  const h = harness({ kv });
  const p = (await send(h, "retomar"))[1];
  const r = await h.call(req("/api/admin/owner-chat/action", { method: "POST", body: { id: p.id } }));
  assert.equal(r.status, 502); assert.match((await r.json()).messages[0].text, /Não consegui/);
  assert.equal(h.sql.rows.find((x) => String(x.id) === p.id).action_state, "falhou");
  assert.equal((await h.call(req("/api/admin/owner-chat/action", { method: "POST", body: { id: p.id } }))).status, 409);
});

test("feed: últimas mensagens por id (sem cursor que esconda commit fora de ordem) e marcador evita o banco (NC-05)", async () => {
  const h = harness();
  await send(h, "status");
  const r1 = await (await h.call(req("/api/admin/owner-chat/feed"))).json();
  assert.equal(r1.messages.length, 2); assert.ok(r1.v);
  // linha com id menor gravada depois (commit fora de ordem) aparece no feed seguinte
  h.sql.rows.push({ id: 0, created_at: Date.now(), sender: "zevanory", kind: "alerta", body: "tardio", action_type: null, action_expires_at: null, action_state: null, dedupe_key: "x" });
  await h.kv.put(chat.OWNER_CHAT_VERSION_KEY, "outro");
  const r2 = await (await h.call(req("/api/admin/owner-chat/feed?v=" + r1.v))).json();
  assert.ok(r2.messages.some((m) => m.text === "tardio"));
  const before = h.sql.log.length;
  const same = await (await h.call(req("/api/admin/owner-chat/feed?v=outro"))).json();
  assert.equal(same.same, true); assert.equal(h.sql.log.length, before, "versão igual não consulta o banco");
});

test("sentinela: canal pausado vira CANAL PARADO com motivo; sem novidade não acorda o banco", async () => {
  const h = harness({ kv: memKv({ [PAUSE]: "1" }), rows: [{ channel: "bluesky", status: "pausado", error: "creative_autopublish_paused" }, { channel: "blog", status: "rascunho", error: "draft_only_publication_disabled" }] });
  const o = { sqlFactory: h.deps.sqlFactory, snapshot: h.deps.snapshot };
  assert.equal((await chat.runOwnerChatSentinel(h.env, new Date("2026-11-12T23:10:00Z"), o)).alerts, 2);
  const bsky = h.sql.rows.find((r) => /bluesky/.test(r.body));
  assert.equal(bsky.kind, "alerta"); assert.match(bsky.body, /PAUSADA/); assert.match(bsky.body, /retomar/);
  const before = h.sql.log.length;
  assert.equal((await chat.runOwnerChatSentinel(h.env, new Date("2026-11-12T23:40:00Z"), o)).alerts, 0);
  assert.equal(h.sql.log.length, before);
});

test("sentinela: antes do horário e canal publicado não alertam; venda nova avisada uma vez", async () => {
  const h = harness();
  assert.equal((await chat.runOwnerChatSentinel(h.env, new Date("2026-11-12T12:00:00Z"), { sqlFactory: h.deps.sqlFactory, snapshot: snap([]) })).alerts, 0);
  const summary = JSON.stringify({ totals: { approved: 1, grossCents: 9700 }, byDay: { "2026-11-12": { approved: 1, grossCents: 9700 } } });
  const h2 = harness({ kv: memKv({ [PAUSE]: "0", "zpc:sales:v1:summary": summary }), rows: [{ channel: "bluesky", status: "publicado" }, { channel: "blog", status: "publicado" }] });
  const o = { sqlFactory: h2.deps.sqlFactory, snapshot: h2.deps.snapshot };
  await chat.runOwnerChatSentinel(h2.env, new Date("2026-11-12T23:10:00Z"), o);
  await chat.runOwnerChatSentinel(h2.env, new Date("2026-11-12T23:40:00Z"), o);
  const v = h2.sql.rows.filter((r) => r.kind === "venda");
  assert.equal(v.length, 1); assert.match(v[0].body, /R\$\s?97,00/);
});

test("IA só classifica; texto exibido é sempre determinístico (NC-03)", async () => {
  const lies = { run: async () => ({ response: "Você vendeu 37 kits hoje e o Bluesky publicou 5 vezes." }) };
  const t = (await send(harness({ ai: lies }), "me fala um resumo da semana"))[1].text;
  assert.match(t, /não vou inventar/); assert.doesNotMatch(t, /37|5 vezes/);
  const ok = { run: async () => ({ response: "vendas" }) };
  assert.match((await send(harness({ ai: ok }), "como foi a grana?"))[1].text, /nenhuma venda/);
});

test("cota da IA reservada no banco antes da chamada: no máximo 40 por dia (NC-06)", async () => {
  let calls = 0; const sql = fakeSql();
  const env = { AI: { run: async () => { calls++; return { response: "status" }; } } };
  for (let i = 0; i < chat.AI_DAILY_LIMIT + 5; i++) await chat.classifyWithAi(env, sql, "algo", "2026-11-12");
  assert.equal(calls, chat.AI_DAILY_LIMIT);
  const failing = { query: async () => { throw new Error("db"); } };
  await chat.classifyWithAi(env, failing, "algo", "2026-11-12");
  assert.equal(calls, chat.AI_DAILY_LIMIT, "sem reserva confirmada, sem chamada");
});

test("intenções básicas", () => {
  assert.equal(chat.intentOf("Retomar"), "retomar"); assert.equal(chat.intentOf("pausar tudo"), "pausar");
  assert.equal(chat.intentOf("quanto vendeu?"), "vendas"); assert.equal(chat.intentOf("o que está parado"), "problemas");
  assert.equal(chat.intentOf("status"), "status"); assert.equal(chat.intentOf("bom dia"), "livre");
});

test("NC-G6-1030-08: falha ao atualizar o marcador não esconde mensagem além do prazo declarado", async () => {
  const kv = memKv({ [PAUSE]: "0" });
  const h = harness({ kv });
  const v0 = (await (await h.call(req("/api/admin/owner-chat/feed"))).json()).v;
  kv.put = async (k, v) => { if (k === chat.OWNER_CHAT_VERSION_KEY) throw new Error("kv"); kv.data.set(k, String(v)); };
  const r = await h.call(req("/api/admin/owner-chat/message", { method: "POST", body: { text: "status" } }));
  assert.equal(r.status, 200);
  // com o marcador antigo, o atalho pode responder "same"; a leitura completa (sem v) SEMPRE vai ao banco:
  const full = await (await h.call(req("/api/admin/owner-chat/feed"))).json();
  assert.equal(full.messages.length, 2);
  assert.ok(chat.FEED_MAX_STALE_MS <= 30000);
  const page = await (await h.call(req("/api/admin/owner-chat/app"))).text();
  assert.match(page, new RegExp("Date.now\\(\\)-full>=" + chat.FEED_MAX_STALE_MS));
  void v0;
});

test("NC-G6-1030-08: versões são únicas mesmo no mesmo milissegundo", async () => {
  const kv = memKv(); const h = harness({ kv }); const seen = new Set();
  for (let i = 0; i < 5; i++) { await send(h, "ajuda"); seen.add(kv.data.get(chat.OWNER_CHAT_VERSION_KEY)); }
  assert.equal(seen.size, 5);
});

test("NC-G6-1030-09: retenção roda sem alerta nem venda e apaga só o vencido", async () => {
  const sql = fakeSql();
  sql.rows.push({ id: 1, created_at: Date.parse("2026-01-01T00:00:00Z"), sender: "zevanory", kind: "chat", body: "velha", action_type: null, action_state: null, dedupe_key: null });
  sql.rows.push({ id: 2, created_at: Date.parse("2026-11-12T22:00:00Z"), sender: "zevanory", kind: "chat", body: "nova", action_type: null, action_state: null, dedupe_key: null });
  const out = await chat.runOwnerChatRetention({ DATABASE_URL: "x" }, { sqlFactory: () => sql });
  assert.deepEqual([out.ok, out.messages], [true, 1]); assert.deepEqual(sql.rows.map((r) => r.body), ["nova"]);
  const fail = await chat.runOwnerChatRetention({ DATABASE_URL: "x" }, { sqlFactory: () => ({ query: async () => { throw new Error("db"); } }) });
  assert.deepEqual(fail, { ok: false, code: "retention_failed" });
  const src = readTextNormalized(new URL("../worker/cloudflare-worker.compat.mjs", import.meta.url));
  assert.match(src, /getUTCHours\(\) === 6\) tasks\.push\(runOwnerChatRetention\(/);
});

test("NC-G6-1030-10: blog fora da agenda não é CANAL PARADO; dia previsto atrasado é", () => {
  const f = (status) => chat.findStoppedChannels({ day: "2026-11-12", hour: 20, pause: "ativa", snap: { today: [{ channel: "blog", status }, { channel: "bluesky", status: "publicado" }] } });
  assert.deepEqual(f("fora_da_agenda"), []);
  assert.equal(f("erro")[0].channel, "blog");
  assert.equal(f("rascunho")[0].channel, "blog");
});

test("ordem aceita pelo KV aparece como executada, mesmo que a releitura imediata venha defasada", async () => {
  const kv = memKv({ [PAUSE]: "1" });
  const realGet = kv.get; kv.get = async (k) => (k === PAUSE ? "1" : realGet(k)); // leitura defasada
  const h = harness({ kv });
  const p = (await send(h, "retomar"))[1];
  const r = await h.call(req("/api/admin/owner-chat/action", { method: "POST", body: { id: p.id } }));
  assert.equal(r.status, 200); assert.equal(kv.data.get(PAUSE), "0");
});

// Mutantes: cada um reverte uma garantia e precisa ser detectado.
const SRC = fileURLToPath(new URL("../worker/owner-chat.mjs", import.meta.url));
async function mutant(name, from, to, check) {
  const src = readTextNormalized(SRC);
  assert.ok(src.includes(from), "âncora do mutante " + name);
  const path = SRC.replace(/owner-chat\.mjs$/, `owner-chat.mutant-${name}.mjs`);
  await writeFile(path, src.replace(from, to));
  try { const m = await import(pathToFileURL(path).href + "?" + Date.now()); assert.equal(await check(m), false, "mutante sobreviveu: " + name); }
  finally { await rm(path, { force: true }); }
}
test("mutantes morrem", async () => {
  const H = (m, opts = {}) => { const h = harness(opts); return { ...h, call: (r) => m.handleOwnerChat(r, h.env, h.deps) }; };
  await mutant("sem-auth", "if (typeof isAdminAuthorized !== \"function\" || !isAdminAuthorized(request, env)) return unauthorized();", "", async (m) =>
    (await H(m).call(new Request(ORIGIN + "/api/admin/owner-chat/feed"))).status === 401);
  await mutant("sem-csrf", "if (request.method !== \"POST\" || !sameOrigin(request, url))", "if (request.method !== \"POST\")", async (m) =>
    (await H(m).call(req("/api/admin/owner-chat/message", { method: "POST", body: { text: "status" }, headers: { origin: "https://evil.example" } }))).status === 403);
  await mutant("acao-sem-trava", "and action_state = 'proposta' and action_expires_at > now() returning action_type", "and action_expires_at > now() returning action_type", async (m) => {
    // o falso reproduz a trava pelo SQL: sem a cláusula, a linha volta a ser reivindicável
    const h = H(m, { kv: memKv({ [PAUSE]: "1" }) });
    const sql = h.sql, orig = sql.query;
    sql.query = async (t, p) => (/owner-chat:claim/.test(t) && !/action_state = 'proposta'/.test(t) ? [{ action_type: "retomar_criativos" }] : orig(t, p));
    const p = (await (await h.call(req("/api/admin/owner-chat/message", { method: "POST", body: { text: "retomar" } }))).json()).messages[1];
    await h.call(req("/api/admin/owner-chat/action", { method: "POST", body: { id: p.id } }));
    return (await h.call(req("/api/admin/owner-chat/action", { method: "POST", body: { id: p.id } }))).status === 409;
  });
  await mutant("ia-escreve", "  return { text: UNKNOWN };", "  return { text: String((await env.AI?.run?.(AI_MODEL, { messages: [] }))?.response || UNKNOWN) };", async (m) => {
    const h = H(m, { ai: { run: async () => ({ response: "mentira" }) } });
    const t = (await (await h.call(req("/api/admin/owner-chat/message", { method: "POST", body: { text: "resumo" } }))).json()).messages[1].text;
    return /não vou inventar/.test(t);
  });
  await mutant("sem-cota", "if (!(await reserveAi(sql, day).catch(() => false))) return \"livre\";", "", async (m) => {
    let calls = 0; const env = { AI: { run: async () => { calls++; return { response: "status" }; } } }; const sql = fakeSql();
    for (let i = 0; i < m.AI_DAILY_LIMIT + 3; i++) await m.classifyWithAi(env, sql, "x", "2026-11-12");
    return calls === m.AI_DAILY_LIMIT;
  });
  await mutant("vendas-sem-validacao", "if (validSalesSummary(v)) return { ok: true, value: v };", "if (v) return { ok: true, value: v };", async (m) => {
    const h = H(m, { kv: memKv({ [PAUSE]: "0", "zpc:sales:v1:summary": JSON.stringify({ totals: { approved: 1, grossCents: "x" } }) }) });
    const t = (await (await h.call(req("/api/admin/owner-chat/message", { method: "POST", body: { text: "vendas" } }))).json()).messages[1].text;
    return !/NaN/.test(t);
  });
  await mutant("agenda-ignorada", "if ([\"publicado\", \"fora_da_agenda\", \"desligado\"].includes(row?.status)) continue;", "if (row?.status === \"publicado\") continue;", async (m) =>
    m.findStoppedChannels({ day: "2026-11-12", hour: 20, pause: "ativa", snap: { today: [{ channel: "blog", status: "fora_da_agenda" }, { channel: "bluesky", status: "publicado" }] } }).length === 0);
  await mutant("pausa-sem-motivo", "facts.pause === \"pausada\" ? \"pausado\"", "false ? \"pausado\"", async (m) =>
    /PAUSADA/.test(m.findStoppedChannels({ day: "2026-11-12", hour: 20, pause: "pausada", snap: { today: [{ channel: "bluesky", status: "sem dados" }] } }).find((s) => s.channel === "bluesky")?.text || ""));
});
