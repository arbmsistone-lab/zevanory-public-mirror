import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as chat from "../worker/owner-chat.mjs";

const ORIGIN = "https://zevanory.api.br";
const auth = (req) => req.headers.get("authorization") === "Basic ok";
function memKv(init = {}, { failGet = () => false } = {}) {
  const data = new Map(Object.entries(init)); const writes = []; let reads = 0;
  return { data, writes, get reads() { return reads; },
    get: async (k) => { reads++; if (failGet(k)) throw new Error("kv"); return data.has(k) ? data.get(k) : null; },
    put: async (k, v) => { writes.push(k); data.set(k, String(v)); } };
}
const snap = (rows) => async () => ({ day: "2026-11-12", today: rows });
const at = (iso) => () => new Date(iso);
const req = (path, { method = "GET", body, headers = {} } = {}) => new Request(ORIGIN + path, { method, body: body ? JSON.stringify(body) : undefined, headers: { authorization: "Basic ok", ...(method === "POST" ? { origin: ORIGIN, "x-owner-chat": "1", "content-type": "application/json" } : {}), ...headers } });
const call = (r, kv, { now = at("2026-11-12T23:00:00Z"), rows = [], ai } = {}) => chat.handleOwnerChat(r, { ZEVANORY_PRIVATE_ARTIFACTS: kv, ...(ai ? { AI: ai } : {}) }, { isAdminAuthorized: auth, now, deps: { snapshot: snap(rows) } });
const PAUSE = "zpc:creative-autonomy:paused:v1";

test("401 antes de qualquer leitura de KV, em página e API", async () => {
  const kv = memKv();
  for (const p of ["/admin/proprietario", "/api/admin/owner-chat/feed", "/api/admin/owner-chat/message"]) {
    const r = await call(new Request(ORIGIN + p, { method: p.endsWith("message") ? "POST" : "GET" }), kv);
    assert.equal(r.status, 401); assert.match(r.headers.get("www-authenticate"), /Basic/);
  }
  assert.equal(kv.reads, 0); assert.equal(kv.writes.length, 0);
});

test("rotas de fora retornam null (não capturam outras URLs)", async () => {
  assert.equal(await call(new Request(ORIGIN + "/api/admin/snapshot"), memKv()), null);
});

test("página autenticada com CSP restrita e noindex", async () => {
  const r = await call(req("/admin/proprietario"), memKv());
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(r.headers.get("x-robots-tag"), /noindex/);
  assert.match(await r.text(), /Chat do Proprietário/);
});

test("POST sem cabeçalho próprio ou de outra origem é 403 e nada é gravado", async () => {
  const kv = memKv();
  const a = await call(req("/api/admin/owner-chat/message", { method: "POST", body: { text: "status" }, headers: { "x-owner-chat": "0" } }), kv);
  const b = await call(req("/api/admin/owner-chat/message", { method: "POST", body: { text: "status" }, headers: { origin: "https://evil.example" } }), kv);
  assert.equal(a.status, 403); assert.equal(b.status, 403); assert.equal(kv.writes.length, 0);
});

test("status responde com dados reais e grava a conversa numa única chave", async () => {
  const kv = memKv({ [PAUSE]: "0" });
  const r = await call(req("/api/admin/owner-chat/message", { method: "POST", body: { text: "qual o status de hoje?" } }), kv, { rows: [{ channel: "bluesky", status: "publicado", link: "https://bsky.app/x" }, { channel: "blog", status: "rascunho", error: "draft_only_publication_disabled" }] });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.messages.length, 2);
  assert.match(j.messages[1].text, /bluesky: publicado — https:\/\/bsky\.app\/x/);
  assert.match(j.messages[1].text, /blog: rascunho \(draft_only_publication_disabled\)/);
  assert.deepEqual([...new Set(kv.writes)], [chat.OWNER_CHAT_THREAD_KEY]);
});

test("vendas sem livro: diz que não há venda; livro ilegível: não chuta número", async () => {
  let r = await call(req("/api/admin/owner-chat/message", { method: "POST", body: { text: "vendeu algo?" } }), memKv());
  assert.match((await r.json()).messages[1].text, /Ainda não há nenhuma venda/);
  r = await call(req("/api/admin/owner-chat/message", { method: "POST", body: { text: "vendas" } }), memKv({ "zpc:sales:v1:summary": "{quebrado" }));
  assert.match((await r.json()).messages[1].text, /ilegível/);
});

test("pausar/retomar: proposta com botão, execução única, expira em 10 min", async () => {
  const kv = memKv({ [PAUSE]: "1" });
  const r = await call(req("/api/admin/owner-chat/message", { method: "POST", body: { text: "retomar a publicação" } }), kv);
  const proposal = (await r.json()).messages[1];
  assert.equal(proposal.action.type, "retomar_criativos");
  assert.equal(kv.data.get(PAUSE), "1", "proposta sozinha não executa");
  const ok = await call(req("/api/admin/owner-chat/action", { method: "POST", body: { id: proposal.id } }), kv);
  assert.equal(ok.status, 200); assert.equal(kv.data.get(PAUSE), "0");
  const again = await call(req("/api/admin/owner-chat/action", { method: "POST", body: { id: proposal.id } }), kv);
  assert.equal(again.status, 409);
  const kv2 = memKv({ [PAUSE]: "0" });
  const p2 = (await (await call(req("/api/admin/owner-chat/message", { method: "POST", body: { text: "pausar tudo" } }), kv2)).json()).messages[1];
  const late = await call(req("/api/admin/owner-chat/action", { method: "POST", body: { id: p2.id } }), kv2, { now: at("2026-11-12T23:20:00Z") });
  assert.equal(late.status, 410); assert.equal(kv2.data.get(PAUSE), "0");
});

test("sentinela: canal pausado depois do horário vira CANAL PARADO com motivo, sem duplicar", async () => {
  const kv = memKv({ [PAUSE]: "1" });
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv };
  const deps = { snapshot: snap([{ channel: "bluesky", status: "pausado", error: "creative_autopublish_paused" }, { channel: "blog", status: "rascunho", error: "draft_only_publication_disabled" }]) };
  const now = new Date("2026-11-12T23:10:00Z"); // 20h10 em São Paulo
  const out = await chat.runOwnerChatSentinel(env, now, deps);
  assert.equal(out.alerts, 2);
  const t = JSON.parse(kv.data.get(chat.OWNER_CHAT_THREAD_KEY));
  const bsky = t.messages.find((m) => /bluesky/.test(m.text));
  assert.equal(bsky.kind, "alerta"); assert.match(bsky.text, /PAUSADA/); assert.match(bsky.text, /retomar/);
  const writes = kv.writes.length;
  assert.equal((await chat.runOwnerChatSentinel(env, new Date("2026-11-12T23:40:00Z"), deps)).alerts, 0);
  assert.equal(kv.writes.length, writes, "sem novidade, sem escrita");
});

test("sentinela: antes do horário esperado não alerta; canal publicado não alerta", async () => {
  const kv = memKv({ [PAUSE]: "0" });
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv };
  assert.equal((await chat.runOwnerChatSentinel(env, new Date("2026-11-12T12:00:00Z"), { snapshot: snap([]) })).alerts, 0);
  assert.equal((await chat.runOwnerChatSentinel(env, new Date("2026-11-12T23:10:00Z"), { snapshot: snap([{ channel: "bluesky", status: "publicado" }, { channel: "blog", status: "publicado" }]) })).alerts, 0);
});

test("sentinela: venda nova aprovada vira aviso uma única vez", async () => {
  const summary = (n) => JSON.stringify({ schema: "zevanory-sales/v1", totals: { approved: n, grossCents: 9700 * n }, byDay: { "2026-11-12": { approved: n, grossCents: 9700 * n } } });
  const kv = memKv({ [PAUSE]: "0", "zpc:sales:v1:summary": summary(1) });
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv }, deps = { snapshot: snap([{ channel: "bluesky", status: "publicado" }, { channel: "blog", status: "publicado" }]) };
  await chat.runOwnerChatSentinel(env, new Date("2026-11-12T15:00:00Z"), deps);
  await chat.runOwnerChatSentinel(env, new Date("2026-11-12T15:30:00Z"), deps);
  const t = JSON.parse(kv.data.get(chat.OWNER_CHAT_THREAD_KEY));
  assert.equal(t.messages.filter((m) => m.kind === "venda").length, 1);
  assert.match(t.messages.find((m) => m.kind === "venda").text, /R\$\s?97,00/);
});

test("conversa ilegível: cópia preservada em quarentena e conversa reiniciada com aviso", async () => {
  const kv = memKv({ [chat.OWNER_CHAT_THREAD_KEY]: "{lixo" });
  const r = await call(req("/api/admin/owner-chat/message", { method: "POST", body: { text: "ajuda" } }), kv);
  assert.equal(r.status, 200);
  const q = [...kv.data.keys()].find((k) => k.startsWith(chat.OWNER_CHAT_QUARANTINE_PREFIX));
  assert.ok(q); assert.equal(kv.data.get(q), "{lixo");
  const t = JSON.parse(kv.data.get(chat.OWNER_CHAT_THREAD_KEY));
  assert.match(t.messages[0].text, /ilegível/);
});

test("feed com erro de leitura do KV: 503 e nenhuma escrita", async () => {
  const kv = memKv({}, { failGet: (k) => k === chat.OWNER_CHAT_THREAD_KEY });
  const r = await call(req("/api/admin/owner-chat/feed"), kv);
  assert.equal(r.status, 503); assert.equal(kv.writes.length, 0);
});

test("resposta livre da IA com número inventado cai na resposta segura", async () => {
  const ai = { run: async () => ({ response: "Você vendeu 37 kits hoje." }) };
  const r = await call(req("/api/admin/owner-chat/message", { method: "POST", body: { text: "me fala um resumo da semana" } }), memKv({ [PAUSE]: "0" }), { ai });
  assert.match((await r.json()).messages[1].text, /Ainda não sei responder/);
  assert.equal(chat.groundedNumbers("Total 2 vendas", "Vendas aprovadas no total: 2"), true);
  assert.equal(chat.groundedNumbers("Total 37 vendas", "Vendas aprovadas no total: 2"), false);
});

test("intenções básicas", () => {
  assert.equal(chat.intentOf("Retomar"), "retomar");
  assert.equal(chat.intentOf("pausar tudo"), "pausar");
  assert.equal(chat.intentOf("quanto vendeu?"), "vendas");
  assert.equal(chat.intentOf("o que está parado"), "problemas");
  assert.equal(chat.intentOf("status"), "status");
});

// Mutantes: cada um reverte uma garantia e precisa ser detectado.
const SRC = fileURLToPath(new URL("../worker/owner-chat.mjs", import.meta.url));
async function mutant(name, from, to, check) {
  const src = await readFile(SRC, "utf8");
  assert.ok(src.includes(from), "âncora do mutante " + name);
  const path = SRC.replace(/owner-chat\.mjs$/, `owner-chat.mutant-${name}.mjs`);
  await writeFile(path, src.replace(from, to));
  try { const m = await import(path + "?" + Date.now()); assert.equal(await check(m), false, "mutante sobreviveu: " + name); }
  finally { await rm(path, { force: true }); }
}
test("mutantes morrem", async () => {
  await mutant("sem-auth", "if (typeof isAdminAuthorized !== \"function\" || !isAdminAuthorized(request, env)) return unauthorized();", "", async (m) => {
    const r = await m.handleOwnerChat(new Request(ORIGIN + "/api/admin/owner-chat/feed"), { ZEVANORY_PRIVATE_ARTIFACTS: memKv() }, { isAdminAuthorized: auth });
    return r.status === 401;
  });
  await mutant("sem-csrf", "if (request.method !== \"POST\" || !sameOrigin(request, url))", "if (request.method !== \"POST\")", async (m) => {
    const r = await m.handleOwnerChat(req("/api/admin/owner-chat/message", { method: "POST", body: { text: "status" }, headers: { origin: "https://evil.example" } }), { ZEVANORY_PRIVATE_ARTIFACTS: memKv() }, { isAdminAuthorized: auth, deps: { snapshot: snap([]) } });
    return r.status === 403;
  });
  await mutant("acao-repetida", "if (msg.action.used) {", "if (false) {", async (m) => {
    const kv = memKv({ [PAUSE]: "1" }), env = { ZEVANORY_PRIVATE_ARTIFACTS: kv }, o = { isAdminAuthorized: auth, now: at("2026-11-12T23:00:00Z"), deps: { snapshot: snap([]) } };
    const p = (await (await m.handleOwnerChat(req("/api/admin/owner-chat/message", { method: "POST", body: { text: "retomar" } }), env, o)).json()).messages[1];
    await m.handleOwnerChat(req("/api/admin/owner-chat/action", { method: "POST", body: { id: p.id } }), env, o);
    return (await m.handleOwnerChat(req("/api/admin/owner-chat/action", { method: "POST", body: { id: p.id } }), env, o)).status === 409;
  });
  await mutant("sem-quarentena", "await kv.put(OWNER_CHAT_QUARANTINE_PREFIX + now.getTime()", "void (OWNER_CHAT_QUARANTINE_PREFIX + now.getTime()", async (m) => {
    const kv = memKv({ [m.OWNER_CHAT_THREAD_KEY]: "{lixo" });
    await m.readThread(kv, new Date());
    return [...kv.data.keys()].some((k) => k.startsWith(m.OWNER_CHAT_QUARANTINE_PREFIX));
  });
  await mutant("pausa-sem-motivo", "facts.pause === \"pausada\" ? \"pausado\"", "false ? \"pausado\"", async (m) => {
    const f = { day: "2026-11-12", hour: 20, pause: "pausada", sales: { ok: true, value: null }, snap: { today: [{ channel: "bluesky", status: "sem dados" }] } };
    return /PAUSADA/.test(m.findStoppedChannels(f).find((s) => s.channel === "bluesky")?.text || "");
  });
  await mutant("ia-sem-ancoragem", "groundedNumbers(reply, context) &&", "", async (m) => {
    const ai = { run: async () => ({ response: "Você vendeu 37 kits hoje." }) };
    const r = await m.handleOwnerChat(req("/api/admin/owner-chat/message", { method: "POST", body: { text: "resumo" } }), { ZEVANORY_PRIVATE_ARTIFACTS: memKv({ [PAUSE]: "0" }), AI: ai }, { isAdminAuthorized: auth, deps: { snapshot: snap([]) } });
    return !/37/.test((await r.json()).messages[1].text);
  });
});
