import test from "node:test";
import assert from "node:assert/strict";
import * as chat from "../worker/owner-chat.mjs";
import * as pin from "../worker/owner-pin.mjs";
import { fakeSql } from "./helpers/owner-chat-fakes.mjs";

const ORIGIN = "https://zevanory.api.br";
function memKv() {
  const data = new Map(); let reads = 0;
  return { data, get reads() { return reads; },
    get: async (k) => { reads++; return data.has(k) ? data.get(k) : null; },
    put: async (k, v) => { data.set(k, String(v)); },
    delete: async (k) => { data.delete(k); } };
}
function harness({ PIN = "482915", kv = memKv() } = {}) {
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "x", ...(PIN === null ? {} : { OWNER_CHAT_PIN: PIN }) };
  const deps = { isAdminAuthorized: (r) => r.headers.get("authorization") === "Basic ok", sqlFactory: () => fakeSql(), snapshot: async () => ({ day: "2026-11-26", today: [] }) };
  return { kv, env, call: (r) => chat.handleOwnerChat(r, env, deps) };
}
const login = (h, value, { ip = "1.1.1.1", origin = ORIGIN, header = "1" } = {}) => h.call(new Request(ORIGIN + "/api/admin/owner-chat/pin", {
  method: "POST", body: JSON.stringify({ pin: value }),
  headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...(origin ? { origin } : {}), ...(header ? { "x-owner-chat": header } : {}) } }));
const cookieOf = (res) => (res.headers.get("set-cookie") || "").split(";")[0];
const get = (h, path, cookie) => h.call(new Request(ORIGIN + path, { headers: cookie ? { cookie } : {} }));

test("PIN desligado (sem segredo ou fora do formato): comportamento antigo, Basic com 401 e WWW-Authenticate", async () => {
  for (const PIN of [null, "12345", "1234567", "abcdef", " 123456"]) {
    const h = harness({ PIN });
    const r = await get(h, "/admin/proprietario");
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate") || "", /Basic/);
    assert.equal((await login(h, "123456")).status, 404);
    assert.equal(h.kv.reads, 0);
  }
});

test("PIN ligado: página sem sessão mostra o formulário de PIN (200, CSP, noindex), API sem sessão dá 401 sem Basic", async () => {
  const h = harness();
  const page = await get(h, "/admin/proprietario");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /PIN de 6 dígitos/);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors https:\/\/controle\.zevanory\.api\.br(;|$)/);
  assert.equal(page.headers.get("x-robots-tag"), "noindex, nofollow");
  // Só o painel (controle.zevanory.api.br) pode enquadrar o chat; nenhuma outra origem.
  assert.equal(page.headers.get("x-frame-options"), null);
  assert.equal((page.headers.get("content-security-policy").match(/frame-ancestors ([^;]*)/) || [])[1], "https://controle.zevanory.api.br");
  const api = await get(h, "/api/admin/owner-chat/feed");
  assert.equal(api.status, 401);
  assert.equal(api.headers.get("www-authenticate"), null);
});

test("PIN correto: cookie HttpOnly+Secure+SameSite=Strict de 12 h; sessão abre o feed; KV guarda só o hash do token", async () => {
  const h = harness();
  const r = await login(h, "482915");
  assert.equal(r.status, 200);
  const sc = r.headers.get("set-cookie");
  assert.match(sc, /HttpOnly/); assert.match(sc, /Secure/); assert.match(sc, /SameSite=Strict/); assert.match(sc, /Max-Age=43200/);
  const token = cookieOf(r).split("=")[1];
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.ok(![...h.kv.data.keys()].some((k) => k.includes(token)), "token puro nunca vai para o KV");
  assert.ok(![...h.kv.data.values()].some((v) => v.includes("482915")), "PIN nunca vai para o KV");
  const feed = await get(h, "/api/admin/owner-chat/feed", cookieOf(r));
  assert.equal(feed.status, 200);
  const page = await get(h, "/admin/proprietario", cookieOf(r));
  assert.equal(page.status, 302);
});

test("PIN errado: 401 com tentativas restantes; 5 erros bloqueiam o IP (429) até mesmo com o PIN certo; outro IP segue", async () => {
  const h = harness();
  for (let i = 1; i <= 5; i++) {
    const r = await login(h, "000000");
    assert.equal(r.status, 401);
    assert.equal((await r.json()).restantes, 5 - i);
  }
  assert.equal((await login(h, "482915")).status, 429);
  assert.equal((await login(h, "482915", { ip: "2.2.2.2" })).status, 200);
});

test("limite global: 20 erros por hora (IPs diferentes) bloqueiam qualquer login por PIN; Basic continua valendo", async () => {
  const h = harness();
  for (let i = 0; i < 20; i++) assert.equal((await login(h, "111111", { ip: "10.0.0." + i })).status, 401);
  assert.equal((await login(h, "482915", { ip: "9.9.9.9" })).status, 429);
  const basic = await h.call(new Request(ORIGIN + "/api/admin/owner-chat/feed", { headers: { authorization: "Basic ok" } }));
  assert.equal(basic.status, 200);
});

test("CSRF: login sem Origin igual ou sem x-owner-chat dá 403 e não conta tentativa nem cria sessão", async () => {
  const h = harness();
  assert.equal((await login(h, "482915", { origin: "https://evil.example" })).status, 403);
  assert.equal((await login(h, "482915", { header: null })).status, 403);
  assert.equal((await login(h, "482915", { origin: null })).status, 403);
  assert.equal(h.kv.data.size, 0);
});

test("cookie forjado, de outro formato ou sessão apagada não abre nada; sair apaga a sessão", async () => {
  const h = harness();
  assert.equal((await get(h, "/api/admin/owner-chat/feed", "zv_owner_chat=" + "a".repeat(64))).status, 401);
  assert.equal((await get(h, "/api/admin/owner-chat/feed", "zv_owner_chat=nao-hex")).status, 401);
  const c = cookieOf(await login(h, "482915"));
  assert.equal((await get(h, "/api/admin/owner-chat/feed", c)).status, 200);
  const out = await h.call(new Request(ORIGIN + "/api/admin/owner-chat/logout", { method: "POST", headers: { origin: ORIGIN, "x-owner-chat": "1", cookie: c } }));
  assert.equal(out.status, 200);
  assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await get(h, "/api/admin/owner-chat/feed", c)).status, 401);
});

test("PIN de outro tamanho ou com letras é recusado sem comparar", async () => {
  const h = harness();
  for (const v of ["48291", "4829150", "48291a", "", null]) assert.equal((await login(h, v, { ip: "3.3.3." + String(v).length })).status, 401);
});

test("mensagem enviada com sessão de PIN exige CSRF como antes (403 sem x-owner-chat)", async () => {
  const h = harness();
  const c = cookieOf(await login(h, "482915"));
  const r = await h.call(new Request(ORIGIN + "/api/admin/owner-chat/message", { method: "POST", body: JSON.stringify({ text: "status" }), headers: { cookie: c, origin: ORIGIN, "content-type": "application/json" } }));
  assert.equal(r.status, 403);
});

test("pinConfigured: só exatamente 6 dígitos", () => {
  assert.equal(pin.pinConfigured({ OWNER_CHAT_PIN: "000000" }), true);
  for (const v of [undefined, "", "12345", "1234567", "12345a", 123456]) assert.equal(pin.pinConfigured({ OWNER_CHAT_PIN: v }), v === 123456);
});

test("chat público do site não é injetado nas páginas /admin/ (tela de PIN), mas continua nas páginas públicas", async () => {
  const { injectInstitutionalChat } = await import("../worker/r120-chat-institutional.mjs");
  const env = { SITE_CHAT_ENABLED: "true" };
  const html = () => new Response("<html><head></head><body>x</body></html>", { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'" } });
  const admin = await injectInstitutionalChat(new Request("https://zevanory.api.br/admin/proprietario"), env, html());
  assert.doesNotMatch(await admin.text(), /site-chat\.js/);
  const pub = await injectInstitutionalChat(new Request("https://zevanory.api.br/solucoes"), env, html());
  assert.match(await pub.text(), /site-chat\.js/);
});

test("E3: página do chat tem 'Sair' (logout com CSRF) e, em qualquer 401, apaga a conversa do DOM e volta à tela de PIN", () => {
  const s = chat.OWNER_CHAT_PAGE; const js = s.slice(s.indexOf("<script>") + 8, s.lastIndexOf("</script>"));
  assert.match(s, /<button id="sair" type="button" class="sair">Sair<\/button>/);
  assert.match(js, /fetch\('\/api\/admin\/owner-chat\/logout',\{method:'POST',headers:H\}\)/);
  assert.match(js, /function fim\(\)\{if\(ended\)return;ended=true;clearInterval\(iv\);log\.replaceChildren\(\);nodes\.clear\(\);q\.value='';location\.replace\('\/admin\/proprietario'\);\}/);
  for (const path of ["feed", "message", "action"]) assert.match(js, new RegExp("fetch\\('/api/admin/owner-chat/" + path + "[^;]*;if\\(r\\.status===401\\)return fim\\(\\);"), path);
  assert.doesNotThrow(() => new Function(js));
});
