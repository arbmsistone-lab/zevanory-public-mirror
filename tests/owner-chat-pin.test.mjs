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

test("E3/E3b: página do chat — Sair com confirmação do servidor, 401 encerra, respostas atrasadas não desenham, Esc avisa o painel", () => {
  const s = chat.OWNER_CHAT_PAGE; const js = s.slice(s.indexOf("<script>") + 8, s.lastIndexOf("</script>"));
  assert.match(s, /<button id="sair" type="button" class="sair">Sair<\/button>/);
  assert.match(s, /<div id="fim" role="status" hidden><p id="fimmsg"><\/p><button id="retry" type="button" hidden>/);
  // CA-08: encerramento local aborta pedidos e bloqueia o desenho.
  assert.match(js, /function encerrar\(\)\{if\(ended\)return;ended=true;clearInterval\(iv\);ctl\.abort\(\);log\.replaceChildren\(\);nodes\.clear\(\);/);
  assert.match(js, /function add\(m\)\{if\(ended\|\|!m\|\|nodes\.has\(m\.id\)\)return;/);
  for (const path of ["feed", "message", "action"]) {
    assert.match(js, new RegExp("fetch\\('/api/admin/owner-chat/" + path + "[^;]*signal:ctl\\.signal\\}\\);"), "abortável: " + path);
    assert.match(js, new RegExp("fetch\\('/api/admin/owner-chat/" + path + "[^]*?if\\(r\\.status===401\\)return fim\\(\\);"), "401 encerra: " + path);
  }
  // CA-09: só "encerrada" com 2xx e ok:true; caso contrário, aviso e nova tentativa, sem voltar a consultar.
  assert.match(js, /confirmed=r\.ok&&j\.ok===true;/);
  assert.match(js, /signal:AbortSignal\.timeout\(8000\)/);
  assert.match(js, /if\(confirmed\)\{pend\.clear\(\);fimMsg\.textContent='Sessão encerrada\.';location\.replace\('\/admin\/proprietario'\);return;\}/);
  assert.match(js, /A sessão pode continuar válida/);
  // CA-10: Esc avisa só a origem do painel.
  assert.match(js, /window\.parent\.postMessage\(\{type:'zv-owner-chat:escape'\},'https:\/\/controle\.zevanory\.api\.br'\)/);
  assert.match(pin.PIN_PAGE, /window\.parent\.postMessage\(\{type:"zv-owner-chat:escape"\},"https:\/\/controle\.zevanory\.api\.br"\)/);
  assert.doesNotThrow(() => new Function(js));
});

test("E3b/CA-11: API do chat recusa outra origem ANTES de PIN, sessão, KV ou banco; mesma origem e ausência de Origin seguem", async () => {
  let sqlCalls = 0; const kv = memKv();
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "x", OWNER_CHAT_PIN: "482915" };
  const deps = { isAdminAuthorized: (r) => r.headers.get("authorization") === "Basic ok", sqlFactory: () => { sqlCalls++; return fakeSql(); }, snapshot: async () => ({ day: "2026-11-26", today: [] }) };
  const call = (path, headers = {}, method = "GET", body) => chat.handleOwnerChat(new Request(ORIGIN + path, { method, headers, body }), env, deps);
  for (const [path, method] of [["/api/admin/owner-chat/feed", "GET"], ["/api/admin/owner-chat/message", "POST"], ["/api/admin/owner-chat/action", "POST"], ["/api/admin/owner-chat/pin", "POST"], ["/api/admin/owner-chat/logout", "POST"], ["/api/admin/owner-chat/feed", "OPTIONS"]]) {
    for (const h of [{ origin: "https://outro.zevanory.api.br" }, { origin: "https://evil.example.test" }, { "sec-fetch-site": "same-site" }, { "sec-fetch-site": "cross-site" }, { origin: "null" }]) {
      const r = await call(path, { authorization: "Basic ok", "x-owner-chat": "1", "content-type": "application/json", ...h }, method, method === "POST" ? "{}" : undefined);
      assert.equal(r.status, 403, path + " " + JSON.stringify(h)); assert.deepEqual(await r.json(), { error: "forbidden" });
    }
  }
  assert.equal(kv.reads, 0, "nenhuma leitura de KV"); assert.equal(sqlCalls, 0, "nenhum acesso ao banco");
  // Legítimos: mesma origem, sem Origin (cliente antigo) e navegação direta (none) seguem para a autenticação normal.
  assert.equal((await call("/api/admin/owner-chat/feed", { authorization: "Basic ok", "sec-fetch-site": "same-origin" })).status, 200);
  assert.equal((await call("/api/admin/owner-chat/feed", { authorization: "Basic ok" })).status, 200);
  assert.equal((await call("/api/admin/owner-chat/feed", { authorization: "Basic ok", "sec-fetch-site": "none" })).status, 200);
  assert.equal((await call("/api/admin/owner-chat/feed", { origin: ORIGIN, "sec-fetch-site": "same-origin" })).status, 401, "mesma origem sem sessão continua 401");
  // A página e o app (navegação do iframe do painel, same-site) não são bloqueados por esta regra.
  assert.equal((await call("/admin/proprietario", { "sec-fetch-site": "same-site" })).status, 200);
  assert.equal((await call("/api/admin/owner-chat/app", { "sec-fetch-site": "same-site" })).status, 200);
});

test("CA-09.1: logout só confirma com a sessão excluída E conferida; falha do KV = 503 sem apagar o cookie; repetir funciona", async () => {
  const out = (h, c) => h.call(new Request(ORIGIN + "/api/admin/owner-chat/logout", { method: "POST", headers: { origin: ORIGIN, "x-owner-chat": "1", ...(c ? { cookie: c } : {}) } }));
  // delete lança erro (falha interna do KV)
  const kv1 = memKv(); const h1 = harness({ kv: kv1 }); const c1 = cookieOf(await login(h1, "482915"));
  const del = kv1.delete; kv1.delete = async () => { throw new Error("kv indisponível"); };
  let r = await out(h1, c1);
  assert.equal(r.status, 503); assert.deepEqual(await r.json(), { ok: false, error: "revoke_unconfirmed" });
  assert.equal(r.headers.get("set-cookie"), null, "não apaga o cookie: a nova tentativa precisa do token");
  assert.equal((await get(h1, "/api/admin/owner-chat/feed", c1)).status, 200, "a sessão de fato continua válida");
  kv1.delete = del; r = await out(h1, c1);
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, revoked: true }); assert.match(r.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await get(h1, "/api/admin/owner-chat/feed", c1)).status, 401, "token anterior recusado após confirmação");
  // logout repetido com o mesmo token: idempotente
  r = await out(h1, c1); assert.equal(r.status, 200); assert.equal((await r.json()).ok, true);
  // exclusão "aceita" mas o valor continua lá (consistência eventual): não confirma
  const kv2 = memKv(); const h2 = harness({ kv: kv2 }); const c2 = cookieOf(await login(h2, "482915"));
  kv2.delete = async () => {}; r = await out(h2, c2); assert.equal(r.status, 503); assert.equal((await r.json()).ok, false);
  // leitura de conferência com erro: não confirma
  const kv3 = memKv(); const h3 = harness({ kv: kv3 }); const c3 = cookieOf(await login(h3, "482915"));
  const g3 = kv3.get; kv3.delete = async (k) => { kv3.data.delete(k); kv3.get = async () => { throw new Error("kv"); }; };
  r = await out(h3, c3); assert.equal(r.status, 503); kv3.get = g3;
  // KV ausente ou sem delete: não confirma
  for (const env of [{ OWNER_CHAT_PIN: "482915" }, { OWNER_CHAT_PIN: "482915", ZEVANORY_PRIVATE_ARTIFACTS: { get: async () => "1" } }]) {
    const res = await chat.handleOwnerChat(new Request(ORIGIN + "/api/admin/owner-chat/logout", { method: "POST", headers: { origin: ORIGIN, "x-owner-chat": "1", cookie: "zv_owner_chat=" + "b".repeat(64) } }), env, {});
    assert.equal(res.status, 503); assert.equal(res.headers.get("set-cookie"), null);
  }
  // sem cookie: nada a revogar neste navegador
  r = await out(harness()); assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, revoked: false, reason: "no_session" });
  // sessão que já expirou no KV: exclusão conferida, confirma
  const kv4 = memKv(); const h4 = harness({ kv: kv4 }); const c4 = cookieOf(await login(h4, "482915"));
  for (const k of [...kv4.data.keys()]) if (k.includes("pin-session")) kv4.data.delete(k);
  r = await out(h4, c4); assert.equal(r.status, 200); assert.equal((await r.json()).revoked, true);
});

test("CA-09.1: trava local persistente — Sair marca pendente, recarregar abre encerrado e tenta de novo; confirmação ou novo login liberam", () => {
  const s = chat.OWNER_CHAT_PAGE; const js = s.slice(s.indexOf("<script>") + 8, s.lastIndexOf("</script>"));
  assert.match(js, /const PEND='zv_owner_chat_logout_pending'/);
  assert.match(js, /async function sair\(\)\{pend\.set\(\);encerrar\(\);/);
  assert.match(js, /if\(confirmed\)\{pend\.clear\(\);/);
  assert.match(js, /if\(pend\.on\(\)\)\{sair\(\);\}else\{document\.addEventListener\('visibilitychange',poll\);poll\(\);iv=setInterval\(poll,5000\);\}/);
  assert.match(pin.PIN_PAGE, /if\(r\.ok\)\{try\{localStorage\.removeItem\("zv_owner_chat_logout_pending"\)\}catch\{\}location\.replace/);
});
