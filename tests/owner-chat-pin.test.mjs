import test from "node:test";
import assert from "node:assert/strict";
import * as chat from "../worker/owner-chat.mjs";
import * as pin from "../worker/owner-pin.mjs";
import * as sess from "../worker/owner-session.mjs";
import { fakeSql } from "./helpers/owner-chat-fakes.mjs";

const ORIGIN = "https://zevanory.api.br";
function memKv(init = {}) {
  const data = new Map(Object.entries(init)); let reads = 0;
  return { data, get reads() { return reads; },
    get: async (k) => { reads++; return data.has(k) ? data.get(k) : null; },
    put: async (k, v) => { data.set(k, String(v)); },
    delete: async (k) => { data.delete(k); },
    list: async ({ prefix = "" } = {}) => ({ keys: [...data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) };
}
// Um banco falso por harness (a sessão precisa sobreviver entre chamadas, como no PostgreSQL real).
function harness({ PIN = "482915", kv = memKv(), sql = fakeSql(), authority, db = true } = {}) {
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv, ...(db ? { DATABASE_URL: "x" } : {}), ...(PIN === null ? {} : { OWNER_CHAT_PIN: PIN }) };
  let factory = 0;
  const deps = { isAdminAuthorized: (r) => r.headers.get("authorization") === "Basic ok", sqlFactory: () => { factory++; return sql; }, snapshot: async () => ({ day: "2026-11-26", today: [] }), ...(authority ? { sessionAuthority: authority } : {}) };
  return { kv, sql, env, get factory() { return factory; }, call: (r) => chat.handleOwnerChat(r, env, deps) };
}
const login = (h, value, { ip = "1.1.1.1", origin = ORIGIN, header = "1", cookie } = {}) => h.call(new Request(ORIGIN + "/api/admin/owner-chat/pin", {
  method: "POST", body: JSON.stringify({ pin: value }),
  headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...(origin ? { origin } : {}), ...(header ? { "x-owner-chat": header } : {}), ...(cookie ? { cookie } : {}) } }));
const cookies = (res) => (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie")].filter(Boolean));
const cookieOf = (res) => cookies(res).find((c) => c.startsWith("zv_owner_chat=")).split(";")[0];
const get = (h, path, cookie) => h.call(new Request(ORIGIN + path, { headers: cookie ? { cookie } : {} }));
const post = (h, path, body, cookie, extra = {}) => h.call(new Request(ORIGIN + path, { method: "POST", body: JSON.stringify(body), headers: { origin: ORIGIN, "x-owner-chat": "1", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...extra } }));
const logout = (h, cookie) => post(h, "/api/admin/owner-chat/logout", {}, cookie);
const hashOf = (c) => pin.sha256Hex(c.split("=")[1]);

test("PIN desligado (sem segredo ou fora do formato): comportamento antigo, Basic com 401 e WWW-Authenticate; sem KV nem banco", async () => {
  for (const PIN of [null, "12345", "1234567", "abcdef", " 123456"]) {
    const h = harness({ PIN });
    const r = await get(h, "/admin/proprietario");
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate") || "", /Basic/);
    assert.equal(h.kv.reads, 0); assert.equal(h.factory, 0);
    assert.equal((await login(h, "123456")).status, 404);
  }
});

test("PIN ligado: página sem sessão mostra o formulário de PIN (200, CSP, noindex), API sem sessão dá 401 sem Basic", async () => {
  const h = harness();
  const page = await get(h, "/admin/proprietario");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /zv-owner-chat:need-ticket/);
  assert.equal(page.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(page.headers.get("x-frame-options"), null);
  assert.equal((page.headers.get("content-security-policy").match(/frame-ancestors ([^;]*)/) || [])[1], "https://controle.zevanory.api.br");
  const api = await get(h, "/api/admin/owner-chat/feed");
  assert.equal(api.status, 401);
  assert.equal(api.headers.get("www-authenticate"), null);
});

test("R1: PIN correto cria a sessão NO BANCO (só o hash) antes do cookie; nada de sessão no KV; cookie 12 h HttpOnly+Secure+Strict", async () => {
  const h = harness();
  const r = await login(h, "482915");
  assert.equal(r.status, 200);
  const sc = cookies(r).find((c) => c.startsWith("zv_owner_chat="));
  assert.match(sc, /HttpOnly/); assert.match(sc, /Secure/); assert.match(sc, /SameSite=Strict/); assert.match(sc, /Max-Age=43200/);
  assert.ok(cookies(r).some((c) => /^zv_owner_chat_end=; .*Max-Age=0/.test(c)), "login apaga a marca de encerramento pendente");
  const token = cookieOf(r).split("=")[1];
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.ok(h.sql.sessions.has(await pin.sha256Hex(token)), "linha da sessão = hash do token");
  assert.ok(!h.sql.sessions.has(token), "token puro nunca vai para o banco");
  assert.ok(![...h.kv.data.keys()].some((k) => k.includes("pin-session")), "nenhuma sessão no KV");
  assert.ok(![...h.kv.data.values()].some((v) => v.includes("482915")), "PIN nunca vai para o KV");
  assert.equal((await get(h, "/api/admin/owner-chat/feed", cookieOf(r))).status, 200);
  assert.equal((await get(h, "/admin/proprietario", cookieOf(r))).status, 302);
});

test("R1: banco fora (criação, verificação) = acesso negado; sem banco configurado = 503 no login", async () => {
  const h = harness(); h.sql.sfail.create = true;
  const r = await login(h, "482915"); assert.equal(r.status, 503); assert.equal(cookies(r).length, 0, "sem sessão no banco, sem cookie");
  h.sql.sfail.create = false; const c = cookieOf(await login(h, "482915", { ip: "7.7.7.7" }));
  h.sql.sfail.check = true;
  assert.equal((await get(h, "/api/admin/owner-chat/feed", c)).status, 401);
  assert.equal((await get(h, "/admin/proprietario", c)).status, 200); assert.match(await (await get(h, "/admin/proprietario", c)).text(), /zv-owner-chat:need-ticket/);
  const nodb = harness({ db: false }); assert.equal((await login(nodb, "482915")).status, 503);
});

test("R1: validade pelo relógio do banco — 12 h menos 1 s vale, 12 h mais 1 s não", async () => {
  const h = harness(); const c = cookieOf(await login(h, "482915"));
  h.sql.tick(12 * 3600e3 - 1000); assert.equal((await get(h, "/api/admin/owner-chat/feed", c)).status, 200);
  h.sql.tick(2000); assert.equal((await get(h, "/api/admin/owner-chat/feed", c)).status, 401);
});

test("R1/R1.1: depois do logout confirmado, leitura, envio e confirmação de ação com o token antigo são recusados e nada é gravado", async () => {
  const h = harness(); const c = cookieOf(await login(h, "482915"));
  const sent = await post(h, "/api/admin/owner-chat/message", { text: "pausar" }, c);
  const proposal = (await sent.json()).messages.find((m) => m.action);
  assert.ok(proposal, "proposta de ação criada");
  const out = await logout(h, c);
  assert.equal(out.status, 200); assert.deepEqual(await out.json(), { ok: true, revoked: true, pending_actions: 0 });
  const rows = h.sql.rows.length;
  assert.equal((await get(h, "/api/admin/owner-chat/feed", c)).status, 401);
  assert.equal((await post(h, "/api/admin/owner-chat/message", { text: "status" }, c)).status, 401);
  assert.equal((await post(h, "/api/admin/owner-chat/action", { id: proposal.id }, c)).status, 401);
  assert.equal(h.sql.rows.length, rows, "nada gravado");
  assert.equal(h.sql.rows.find((r) => String(r.id) === proposal.id).action_state, "proposta", "ação não executada");
});

test("R1.1: ação autorizada ANTES do logout é registrada com a sessão e o logout a informa (sem afirmar que a interrompeu)", async () => {
  const h = harness(); const c = cookieOf(await login(h, "482915"));
  const proposal = (await (await post(h, "/api/admin/owner-chat/message", { text: "pausar" }, c)).json()).messages.find((m) => m.action);
  // Reivindicação autorizada (fica 'executando' com a sessão), mas o efeito ainda não terminou.
  await h.sql.query("/*owner-chat:claim*/", [proposal.id, await hashOf(c)]);
  const out = await logout(h, c);
  assert.deepEqual(await out.json(), { ok: true, revoked: true, pending_actions: 1 });
  h.sql.sfail.pending = true; const c2 = cookieOf(await login(h, "482915", { ip: "8.8.8.8" }));
  assert.deepEqual(await (await logout(h, c2)).json(), { ok: true, revoked: true, pending_actions: null }, "revogada; pendências desconhecidas não viram zero");
});

test("O1: 5 tentativas por IP (a 6ª é 429 mesmo com o PIN certo, sem comparar); PIN certo devolve a reserva; outro IP segue; janela de 15 min", async () => {
  const h = harness();
  assert.equal((await login(h, "000000")).status, 401);
  assert.equal((await login(h, "482915")).status, 200, "PIN certo não conta como erro");
  for (let i = 2; i <= 5; i++) { const r = await login(h, "000000"); assert.equal(r.status, 401); assert.equal((await r.json()).restantes, 5 - i); }
  assert.equal((await login(h, "482915")).status, 429);
  assert.equal((await login(h, "000000")).status, 429);
  assert.deepEqual([...h.sql.attempts].filter(([k]) => k.startsWith("ip:")).map(([, v]) => v.n), [5], "tentativa bloqueada não conta (reserva devolvida)");
  assert.equal((await login(h, "482915", { ip: "2.2.2.2" })).status, 200);
  h.sql.tick(15 * 60e3 + 1000); assert.equal((await login(h, "482915")).status, 200, "15 min depois da última tentativa contada");
});

test("O1: 20 por hora no total (IPs diferentes) bloqueiam qualquer login por PIN; Basic continua; banco fora = 503 sem comparar", async () => {
  const h = harness();
  for (let i = 0; i < 20; i++) assert.equal((await login(h, "111111", { ip: "10.0.0." + i })).status, 401);
  assert.equal((await login(h, "482915", { ip: "9.9.9.9" })).status, 429);
  assert.equal((await h.call(new Request(ORIGIN + "/api/admin/owner-chat/feed", { headers: { authorization: "Basic ok" } }))).status, 200);
  const h2 = harness(); h2.sql.sfail.reserve = true;
  assert.equal((await login(h2, "482915")).status, 503); assert.equal(h2.sql.sessions.size, 0);
});

test("CSRF: login sem Origin igual ou sem x-owner-chat dá 403 e não conta tentativa nem cria sessão", async () => {
  const h = harness();
  assert.equal((await login(h, "482915", { origin: "https://evil.example" })).status, 403);
  assert.equal((await login(h, "482915", { header: null })).status, 403);
  assert.equal((await login(h, "482915", { origin: null })).status, 403);
  assert.equal(h.sql.attempts.size, 0); assert.equal(h.sql.sessions.size, 0);
});

test("logout: confirmado só depois da revogação no banco; falha = 503 sem apagar cookie; repetido e sessão expirada = 200; sem cookie = no_session", async () => {
  const h = harness(); const c = cookieOf(await login(h, "482915"));
  h.sql.sfail.revoke = true;
  let r = await logout(h, c);
  assert.equal(r.status, 503); assert.deepEqual(await r.json(), { ok: false, error: "revoke_unconfirmed" }); assert.equal(cookies(r).length, 0);
  assert.equal((await get(h, "/api/admin/owner-chat/feed", c)).status, 200, "a sessão de fato continua");
  h.sql.sfail.revoke = false; r = await logout(h, c);
  assert.equal(r.status, 200); assert.equal((await r.json()).revoked, true);
  assert.ok(cookies(r).some((x) => /^zv_owner_chat=; .*Max-Age=0/.test(x)) && cookies(r).some((x) => /^zv_owner_chat_end=; .*Max-Age=0/.test(x)));
  assert.equal((await get(h, "/api/admin/owner-chat/feed", c)).status, 401);
  r = await logout(h, c); assert.equal(r.status, 200); assert.equal((await r.json()).ok, true, "idempotente");
  const c2 = cookieOf(await login(h, "482915", { ip: "5.5.5.5" })); h.sql.tick(13 * 3600e3);
  r = await logout(h, c2); assert.equal(r.status, 200); assert.equal((await r.json()).revoked, true, "sessão já expirada");
  r = await logout(harness()); assert.deepEqual(await r.json(), { ok: true, revoked: false, reason: "no_session" });
  r = await logout(harness({ db: false }), "zv_owner_chat=" + "b".repeat(64)); assert.equal(r.status, 503);
});

test("R2: com a marca de encerramento pendente o servidor não entrega nada privado (409) e um GET não revoga; só o POST de logout", async () => {
  const h = harness(); const c = cookieOf(await login(h, "482915"));
  const ce = c + "; zv_owner_chat_end=1";
  const rows = h.sql.rows.length;
  const feed = await get(h, "/api/admin/owner-chat/feed", ce); assert.equal(feed.status, 409); assert.deepEqual(await feed.json(), { error: "logout_pending" });
  assert.equal((await post(h, "/api/admin/owner-chat/message", { text: "status" }, ce)).status, 409);
  assert.equal((await post(h, "/api/admin/owner-chat/action", { id: "1" }, ce)).status, 409);
  assert.equal(h.sql.rows.length, rows, "nada gravado");
  const app = await get(h, "/api/admin/owner-chat/app", ce); assert.equal(app.status, 200);
  assert.doesNotMatch(await app.text(), /SEGREDO|Mensagem privada/, "a página do app não carrega mensagens");
  assert.equal(h.sql.valid(await hashOf(c)), true, "GET nenhum revogou a sessão");
  const out = await logout(h, ce); assert.equal(out.status, 200);
  assert.equal(h.sql.valid(await hashOf(c)), false);
  const again = await login(h, "482915", { ip: "6.6.6.6", cookie: "zv_owner_chat_end=1" });
  assert.ok(cookies(again).some((x) => /^zv_owner_chat_end=; .*Max-Age=0/.test(x)), "novo login libera a marca");
});

test("R1.2: fase A (manutenção) recusa login e toda sessão; sessões antigas do KV são apagadas e nunca valem", async () => {
  const legacy = "zpc:owner-chat:pin-session:v1:" + "c".repeat(64);
  const kv = memKv({ [legacy]: "1", "zpc:owner-chat:versao:v1": "x" });
  const sql = fakeSql();
  const b = harness({ kv, sql }); const c = cookieOf(await login(b, "482915"));
  const a = harness({ kv, sql, authority: "maintenance" });
  assert.equal((await login(a, "482915", { ip: "4.4.4.4" })).status, 503);
  assert.equal((await get(a, "/api/admin/owner-chat/feed", c)).status, 401, "nem a sessão válida no banco vale na fase A");
  assert.match(await (await get(a, "/admin/proprietario", c)).text(), /zv-owner-chat:need-ticket/);
  const purge = await sess.purgeLegacyKvSessions(kv, { force: true });
  assert.equal(purge.deleted, 1); assert.equal(kv.data.has(legacy), false); assert.equal(kv.data.has("zpc:owner-chat:versao:v1"), true, "só o prefixo das sessões antigas");
  // Fase B: cookie com formato antigo cujo hash existia só no KV não vale.
  assert.equal((await get(b, "/api/admin/owner-chat/feed", "zv_owner_chat=" + "c".repeat(64))).status, 401);
});

test("27/11: a tela sem sessão não pede PIN; pede o passe só à origem do painel e troca na rota da ponte", () => {
  assert.doesNotMatch(pin.PIN_PAGE, /<input/, "nenhum campo de PIN");
  assert.doesNotMatch(pin.PIN_PAGE, /owner-chat\/pin/, "a tela não chama o login por PIN");
  assert.match(pin.PIN_PAGE, /window\.parent\.postMessage\(\{type:"zv-owner-chat:need-ticket"\},PANEL\)/);
  assert.match(pin.PIN_PAGE, /e\.origin!==PANEL\|\|e\.source!==window\.parent/);
  assert.match(pin.PIN_PAGE, /fetch\("\/api\/admin\/owner-chat\/panel-session"/);
  assert.match(pin.PIN_PAGE, /O Epaminondas abre dentro do painel/);
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
  assert.match(js, /if\(confirmed\)\{endClear\(\);if\(pa>0\)\{/); assert.match(js, /fimMsg\.textContent='Sessão encerrada\.';location\.replace\('\/admin\/proprietario'\);return;\}/);
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

test("R2/M1: página — marca dupla (cookie + localStorage), 409 repete o logout, aviso honesto sem 'fechar o navegador'; consulta pausada com o chat fechado e sessão validada antes de reaparecer", () => {
  const s = chat.OWNER_CHAT_PAGE; const js = s.slice(s.indexOf("<script>") + 8, s.lastIndexOf("</script>"));
  assert.match(js, /const PEND='zv_owner_chat_logout_pending',END='zv_owner_chat_end';/);
  assert.match(js, /document\.cookie=END\+'=1; Path=\/; Max-Age=43200; Secure; SameSite=Strict'/);
  assert.match(js, /async function sair\(\)\{const marked=endMark\(\);encerrar\(\);/);
  assert.match(js, /if\(endOn\(\)\)\{sair\(\);\}else\{/);
  for (const path of ["feed", "message", "action"]) assert.match(js, new RegExp("fetch\\('/api/admin/owner-chat/" + path + "[^]*?if\\(r\\.status===409&&j\\.error==='logout_pending'\\)return sair\\(\\);"), "409: " + path);
  assert.doesNotMatch(js, /if\(r\.status===409\)return sair\(\);/, "outros 409 (ação em andamento/já usada) não encerram a sessão");
  assert.match(js, /Este navegador não permitiu guardar o pedido de saída/);
  assert.doesNotMatch(s, /[Ff]eche o navegador/);
  assert.match(js, /e\.origin!=='https:\/\/controle\.zevanory\.api\.br'\|\|e\.source!==window\.parent/);
  assert.match(js, /if\(!open\)\{clearInterval\(iv\);iv=0;log\.hidden=true;/);
  assert.match(js, /if\(shown&&g===openGen\)log\.hidden=false;/);
  assert.match(js, /if\(document\.hidden\|\|ended\|\|!shown\)return;if\(inflight\)\{again=true;return;\}inflight=true;/); assert.match(js, /finally\{inflight=false;if\(again\)\{again=false;poll\(\);\}\}/);
  assert.match(pin.PIN_PAGE, /if\(r\.ok\)\{try\{localStorage\.removeItem\("zv_owner_chat_logout_pending"\)\}catch\{\}location\.replace/);
  assert.doesNotThrow(() => new Function(js));
});
