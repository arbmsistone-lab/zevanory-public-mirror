// Epaminondas sem PIN: passe do painel de uso único -> sessão curta do chat (worker/owner-panel-bridge.mjs).
// Sem rede: banco falso compartilhado com a suíte do PIN (tests/helpers/owner-chat-fakes.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import * as chat from "../worker/owner-chat.mjs";
import * as bridge from "../worker/owner-panel-bridge.mjs";
import { OAUTH_BRIDGE_KV_KEY } from "../worker/owner-oauth.mjs";
import { sha256Hex } from "../worker/owner-pin.mjs";
import { fakeSql } from "./helpers/owner-chat-fakes.mjs";

const ORIGIN = "https://zevanory.api.br";
const KEY = "k".repeat(48);
const memKv = (init = {}) => { const d = new Map(Object.entries(init)); return { d, get: async (k) => (d.has(k) ? d.get(k) : null), put: async (k, v) => { d.set(k, String(v)); }, delete: async (k) => { d.delete(k); }, list: async () => ({ keys: [], list_complete: true }) }; };
function harness({ env: extra = {}, kv = memKv(), sql = fakeSql(), authority } = {}) {
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "x", OWNER_CHAT_PIN: "482915", OWNER_OAUTH_BRIDGE_SECRET: KEY, ...extra };
  const deps = { isAdminAuthorized: () => false, sqlFactory: () => sql, snapshot: async () => ({ day: "2026-11-27", today: [] }), ...(authority ? { sessionAuthority: authority } : {}) };
  return { sql, kv, env, call: (r) => chat.handleOwnerChat(r, env, deps) };
}
let n = 0;
async function ticket({ key = KEY, ts = Date.now(), exp = Date.now() + 3600_000, nonce } = {}) {
  nonce = nonce || ("n" + String(++n).padStart(4, "0")).padEnd(43, "x");
  const t = { ts: String(ts), nonce, exp: String(exp) };
  return { ...t, sig: await bridge.ticketSignature(key, t) };
}
const post = (h, path, body, extra = {}) => h.call(new Request(ORIGIN + path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
  headers: { origin: ORIGIN, "x-owner-chat": "1", "content-type": "application/json", ...extra } }));
const exchange = (h, t, extra) => post(h, bridge.PANEL_SESSION_PATH, t, extra);
const cookies = (r) => (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get("set-cookie")].filter(Boolean));
const sessionCookie = (r) => cookies(r).find((c) => c.startsWith("zv_owner_chat=")) || "";
const feed = (h, cookie) => h.call(new Request(ORIGIN + "/api/admin/owner-chat/feed", { headers: cookie ? { cookie } : {} }));

test("[BR1] passe válido abre sessão curta (até 5 min) no cookie HttpOnly/Secure/Strict; a sessão lê o feed", async () => {
  const h = harness();
  const r = await exchange(h, await ticket());
  assert.equal(r.status, 200, "[BR1] troca aceita");
  const body = await r.json(); assert.equal(body.ok, true); assert.equal(body.expires_in, 300, "[BR1] 5 min");
  const c = sessionCookie(r);
  assert.match(c, /^zv_owner_chat=[0-9a-f]{64}; Path=\/; Max-Age=300; HttpOnly; Secure; SameSite=Strict$/, "[BR1] cookie");
  const cookie = c.split(";")[0];
  assert.equal((await feed(h, cookie)).status, 200, "[BR1] feed com a sessão do painel");
  h.sql.tick(301_000);
  assert.equal((await feed(h, cookie)).status, 401, "[BR1] vencida em 5 min sem renovação");
  assert.equal((await feed(h)).status, 401, "[BR1] sem cookie continua 401");
});

test("[BR2] passe de uso único: a 2ª troca do mesmo passe é recusada e não cria sessão", async () => {
  const h = harness(); const t = await ticket();
  assert.equal((await exchange(h, t)).status, 200);
  const before = h.sql.sessions.size;
  const again = await exchange(h, t);
  assert.equal(again.status, 401, "[BR2] reuso recusado"); assert.deepEqual(await again.json(), { error: "ticket_used" });
  assert.equal(sessionCookie(again), "", "[BR2] sem cookie no reuso"); assert.equal(h.sql.sessions.size, before, "[BR2] nenhuma linha nova");
  const marker = h.sql.sessions.get(await sha256Hex("panel-ticket:" + t.nonce));
  assert.ok(marker && marker.revoked !== null, "[BR2] marcador já revogado (nunca vale como sessão)");
});

test("[BR3] passe adulterado, fora da janela de 60 s, de sessão do painel vencida ou mal formado: 401 sem sessão", async () => {
  const h = harness(); const now = Date.now();
  const cases = [
    [{ ...(await ticket()), exp: String(now + 7200_000) }, "ticket_invalid"],
    [{ ...(await ticket()), nonce: "z".repeat(43) }, "ticket_invalid"],
    [await ticket({ key: "x".repeat(48) }), "ticket_invalid"],
    [await ticket({ ts: now - 61_000 }), "ticket_expired"],
    [await ticket({ ts: now + 61_000 }), "ticket_expired"],
    [await ticket({ exp: now - 1000 }), "panel_session_expired"],
    [await ticket({ exp: now + 10_000 }), "panel_session_expired"],
    [await ticket({ exp: now + 14 * 3600_000 }), "ticket_invalid"],
    [{ ts: "1", nonce: "a", exp: "1", sig: "b" }, "ticket_invalid"],
    [{}, "ticket_invalid"],
  ];
  for (const [t, reason] of cases) {
    const r = await exchange(h, t);
    assert.equal(r.status, 401, "[BR3] " + reason); assert.deepEqual(await r.json(), { error: reason }, "[BR3] motivo " + reason);
    assert.equal(sessionCookie(r), "", "[BR3] sem cookie");
  }
  assert.equal([...h.sql.sessions.values()].filter((x) => x.revoked === null).length, 0, "[BR3] nenhuma sessão válida criada");
  assert.equal((await exchange(h, "{nao json")).status, 400, "[BR3] corpo inválido");
});

test("[BR4] sessão do chat nunca dura além da sessão do painel", async () => {
  const h = harness();
  const r = await exchange(h, await ticket({ exp: Date.now() + 90_000 }));
  assert.equal(r.status, 200); const { expires_in } = await r.json();
  assert.ok(expires_in <= 90 && expires_in >= 85, "[BR4] ttl limitado ao painel: " + expires_in);
  assert.match(sessionCookie(r), new RegExp("Max-Age=" + expires_in + ";"), "[BR4] cookie com o mesmo prazo");
});

test("[BR5] renovação: sessão nova e a anterior deste navegador revogada; sair revoga no servidor na hora", async () => {
  const h = harness();
  const c1 = sessionCookie(await exchange(h, await ticket())).split(";")[0];
  const r2 = await exchange(h, await ticket(), { cookie: c1 });
  const c2 = sessionCookie(r2).split(";")[0];
  assert.notEqual(c1, c2, "[BR5] token novo");
  assert.equal((await feed(h, c1)).status, 401, "[BR5] anterior revogada");
  assert.equal((await feed(h, c2)).status, 200, "[BR5] nova vale");
  const out = await post(h, "/api/admin/owner-chat/logout", {}, { cookie: c2 });
  assert.equal(out.status, 200); assert.equal((await out.json()).revoked, true, "[BR5] logout confirmado");
  assert.equal((await feed(h, c2)).status, 401, "[BR5] depois de sair, nada passa");
  const send = await post(h, "/api/admin/owner-chat/message", { text: "status" }, { cookie: c2 });
  assert.equal(send.status, 401, "[BR5] envio recusado no servidor");
});

test("[BR6] fronteiras: outra origem ou sem cabeçalho = 403; GET = 405; fase de manutenção, sem banco ou sem chave = 503", async () => {
  const h = harness(); const t = await ticket();
  assert.equal((await exchange(h, t, { origin: "https://controle.zevanory.api.br" })).status, 403, "[BR6] origem do painel não chama direto");
  assert.equal((await exchange(h, t, { origin: "https://evil.example" })).status, 403, "[BR6] outra origem");
  assert.equal((await exchange(h, t, { "x-owner-chat": "0" })).status, 403, "[BR6] sem cabeçalho");
  assert.equal((await h.call(new Request(ORIGIN + bridge.PANEL_SESSION_PATH))).status, 405, "[BR6] GET");
  assert.equal((await exchange(harness({ authority: "maintenance" }), await ticket())).status, 503, "[BR6] manutenção");
  assert.equal((await exchange(harness({ env: { DATABASE_URL: "" } }), await ticket())).status, 503, "[BR6] sem banco");
  const noKey = harness({ env: { OWNER_OAUTH_BRIDGE_SECRET: "" } });
  assert.equal((await exchange(noKey, await ticket())).status, 503, "[BR6] sem chave da ponte");
  // Chave guardada no KV pelo bootstrap (mesmo valor do painel) também serve.
  const kvKey = harness({ env: { OWNER_OAUTH_BRIDGE_SECRET: "" }, kv: memKv({ [OAUTH_BRIDGE_KV_KEY]: KEY }) });
  assert.equal((await exchange(kvKey, await ticket())).status, 200, "[BR6] chave do KV");
  const dbDown = harness(); dbDown.sql.sfail.create = true;
  assert.equal((await exchange(dbDown, await ticket())).status, 503, "[BR6] banco falhando não abre sessão");
});

test("[BR7] o rótulo do passe é exclusivo do chat: assinatura do OAuth com a mesma chave não vale aqui", async () => {
  const enc = new TextEncoder(); const t = { ts: String(Date.now()), nonce: "o".repeat(43), exp: String(Date.now() + 3600_000) };
  const k = await crypto.subtle.importKey("raw", enc.encode(KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const raw = await crypto.subtle.sign("HMAC", k, enc.encode(["zpc-oauth-v1", "start", "youtube", t.ts, t.nonce].join("\n")));
  const sig = btoa(String.fromCharCode(...new Uint8Array(raw))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const r = await exchange(harness(), { ...t, sig });
  assert.equal(r.status, 401, "[BR7] domínio separado");
});

test("[BR8] página do chat: aceita renovação e encerramento só da origem do painel; esconde o Sair dentro do painel", () => {
  const s = chat.OWNER_CHAT_PAGE; const js = s.slice(s.indexOf("<script>") + 8, s.lastIndexOf("</script>"));
  assert.match(js, /if\(e\.origin!=='https:\/\/controle\.zevanory\.api\.br'\|\|e\.source!==window\.parent\|\|!e\.data\)return;if\(e\.data\.type==='zv-owner-chat:ticket'&&e\.data\.ticket\)renovar\(e\.data\.ticket\);else if\(e\.data\.type==='zv-owner-chat:logout'\)sair\(\);/, "[BR8] origem fixa");
  assert.match(js, /fetch\('\/api\/admin\/owner-chat\/panel-session'/, "[BR8] renovação pela rota da ponte");
  assert.match(js, /if\(window\.parent!==window\)\{sairB\.hidden=true;/, "[BR8] Sair escondido no painel");
  assert.doesNotThrow(() => new Function(js));
});
