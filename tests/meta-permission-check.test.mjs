// DEC-23: teste de permissão da Meta (somente leitura). fetch mockado; nenhuma chamada de rede real.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { readTextNormalized } from "./helpers/text.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runCheck, redact, EXPECTED, GRAPH } from "../scripts/channels/meta-permission-check.mjs";

const SRC_URL = new URL("../scripts/channels/meta-permission-check.mjs", import.meta.url);
const USER_TOKEN = "tok-sysuser-SENTINEL-0001-abcdef";
const PAGE_TOKEN = "tok-page-SENTINEL-0002-uvwxyz";
const ENV = { META_ACCESS_TOKEN: USER_TOKEN, META_PAGE_ID: EXPECTED.page_id, INSTAGRAM_BUSINESS_ACCOUNT_ID: EXPECTED.ig_id };

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status, error) => ({ ok: false, status, json: async () => ({ error }) });

function graphMock(over = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ url: String(url), path: u.pathname.replace("/v21.0", ""), method: init.method || "GET", auth: init.headers?.authorization });
    const p = u.pathname.replace("/v21.0", "");
    const key = p === "/me" ? "me" : p === "/me/accounts" ? "accounts" : p === "/me/permissions" ? "perms" : p === `/${EXPECTED.page_id}` && u.searchParams.get("fields") === "access_token" ? "pageField"
      : p === `/${EXPECTED.page_id}` ? "page" : p === `/${EXPECTED.ig_id}` ? "ig" : p.endsWith("/content_publishing_limit") ? "quota" : p === "/debug_token" ? "debug" : "unknown";
    if (over[key]) return over[key](u);
    switch (key) {
      case "me": return ok({ id: "61500000000001", name: "zevanory-publisher" });
      case "page": return ok({ id: EXPECTED.page_id, name: "Zevanory", instagram_business_account: { id: EXPECTED.ig_id } });
      case "perms": return ok({ data: [...EXPECTED.required_permissions, "business_management"].map((permission) => ({ permission, status: "granted" })).concat([{ permission: "publish_video", status: "declined" }]) });
      case "accounts": return ok({ data: [{ id: EXPECTED.page_id, access_token: PAGE_TOKEN }] });
      case "pageField": return ok({ id: EXPECTED.page_id, access_token: PAGE_TOKEN });
      case "ig": return ok({ id: EXPECTED.ig_id, username: "zevanory_" });
      case "quota": return ok({ data: [{ quota_usage: 0, config: { quota_total: 100, quota_duration: 86400 } }] });
      case "debug": return ok({ data: { app_id: EXPECTED.app_id, type: "SYSTEM_USER", is_valid: true, expires_at: 0, data_access_expires_at: 0, scopes: ["instagram_basic", "instagram_content_publish", "pages_manage_posts", "pages_show_list"], user_id: "61500000000001" } });
      default: return fail(404, { message: "unexpected path " + p });
    }
  };
  return { calls, fetchImpl };
}

async function run(mod, env, fetchImpl) {
  const out = [], masks = [], sums = [], order = [];
  const wrapped = async (...a) => { order.push("fetch"); return fetchImpl(...a); };
  const res = await mod.runCheck({ env, fetchImpl: wrapped, log: (l) => out.push(String(l)), mask: (v) => { order.push("mask"); masks.push(String(v)); }, summary: (s) => sums.push(String(s)) });
  return { ...res, out: out.join("\n"), summary: sums.join("\n"), masks, order };
}

// Detector usado em todos os testes: qualquer valor de token na saída visível (log + step summary) reprova.
export function leakedTokens(text, tokens = [USER_TOKEN, PAGE_TOKEN]) {
  return tokens.filter((t) => text.includes(t) || text.includes(encodeURIComponent(t)));
}

test("caminho feliz: todos os itens ok, JSON curto, token mascarado antes da 1a chamada e nunca impresso", async () => {
  const { calls, fetchImpl } = graphMock();
  const r = await run({ runCheck }, ENV, fetchImpl);
  assert.equal(r.exitCode, 0);
  assert.equal(r.report.ok, true);
  for (const k of ["me", "page", "page_token", "permissions", "instagram", "publishing_limit", "debug_token"]) assert.equal(r.report.items[k].ok, true, k);
  assert.deepEqual(r.report.failed, []);
  assert.equal(r.report.items.page.linked_instagram_matches, true);
  assert.deepEqual(r.report.items.permissions.warnings, ["publish_video_not_granted"]);
  assert.equal(r.report.items.page_token.obtained, true);
  assert.equal(r.report.items.instagram.username, "zevanory_");
  assert.equal(r.report.items.publishing_limit.quota_total, 100);
  assert.equal(r.report.items.debug_token.expires_at, 0);
  assert.equal(r.report.items.debug_token.has_publish_video, false);
  assert.equal(r.report.items.debug_token.app_id_matches_expected, true);
  assert.equal(r.report.app_identity, "COMPROVADA");
  assert.equal(r.report.pronto_para_prova, true);
  assert.equal(r.report.published, false);
  assert.deepEqual(leakedTokens(r.out + r.summary), []);
  assert.ok(!JSON.stringify(r.report).includes("user_id"), "sem user_id do debug_token");
  assert.equal(r.order[0], "mask", "::add-mask:: antes de qualquer fetch");
  assert.deepEqual(r.masks, [USER_TOKEN, PAGE_TOKEN]);
  assert.ok(r.out.split("\n").length === 1 && r.out.length < 1500, "uma linha JSON curta");
  JSON.parse(r.out);
  assert.match(r.summary, /somente leitura/);
  assert.ok(calls.length >= 5);
});

test("somente leitura: só GET, só graph v21.0, autenticação no Authorization (debug_token também leva input_token), nenhum endpoint de publicação", async () => {
  const { calls, fetchImpl } = graphMock();
  await run({ runCheck }, ENV, fetchImpl);
  for (const c of calls) {
    assert.equal(c.method, "GET");
    assert.ok(c.url.startsWith(GRAPH + "/"), c.url);
    assert.equal(c.auth, "Bearer " + USER_TOKEN);
    assert.doesNotMatch(c.url, /access_token=/);
    if (c.path === "/debug_token") assert.ok(c.url.includes("input_token="), "debug_token envia o token inspecionado em input_token");
    else assert.ok(!c.url.includes(USER_TOKEN) && !c.url.includes(encodeURIComponent(USER_TOKEN)), "token fora da URL: " + c.path);
    assert.doesNotMatch(c.path, /\/(media|media_publish|feed|photos|videos|comments|messages)\b/);
  }
  const src = readTextNormalized(SRC_URL);
  assert.doesNotMatch(src, /method:\s*"(POST|PUT|DELETE|PATCH)"/);
  assert.doesNotMatch(src, /media_publish|\/feed\b/);
});

test("mensagem de erro da API que ecoa o token é redigida (log e summary)", async () => {
  const echo = () => fail(400, { type: "OAuthException", code: 190, message: `Invalid token ${USER_TOKEN} access_token=${USER_TOKEN}` });
  const { fetchImpl } = graphMock({ me: echo, ig: echo });
  const r = await run({ runCheck }, ENV, fetchImpl);
  assert.equal(r.exitCode, 1);
  assert.equal(r.report.items.me.ok, false);
  assert.match(r.report.items.me.error, /http_400 OAuthException code_190/);
  assert.deepEqual(leakedTokens(r.out + r.summary), []);
  assert.deepEqual(r.report.failed, ["me", "instagram"]);
});

test("token da Página: fallback por ?fields=access_token; ausência registra false sem derrubar o resto", async () => {
  let m = graphMock({ accounts: () => ok({ data: [] }) });
  let r = await run({ runCheck }, ENV, m.fetchImpl);
  assert.equal(r.report.items.page_token.obtained, true);
  assert.equal(r.report.items.page_token.via, "page_field");
  assert.deepEqual(leakedTokens(r.out + r.summary), []);
  m = graphMock({ accounts: () => fail(403, { code: 200, message: "Permissions error" }), pageField: () => ok({ id: EXPECTED.page_id }) });
  r = await run({ runCheck }, ENV, m.fetchImpl);
  assert.equal(r.report.items.page_token.obtained, false);
  assert.match(r.report.items.page_token.error, /me_accounts: http_403/);
  assert.equal(r.report.items.instagram.ok, true);
  assert.equal(r.exitCode, 1);
});

test("debug_token falhando é opcional e não reprova", async () => {
  const { fetchImpl } = graphMock({ debug: () => fail(400, { code: 100, message: "(#100) You must provide an app access token" }) });
  const r = await run({ runCheck }, ENV, fetchImpl);
  assert.equal(r.exitCode, 0);
  assert.equal(r.report.items.debug_token.ok, false);
  assert.equal(r.report.items.debug_token.optional, true);
  assert.equal(r.report.app_identity, "NAO_COMPROVADA");
  assert.equal(r.report.pronto_para_prova, false);
});

test("username do Instagram diferente, cota sem número e /me de outro usuário reprovam", async () => {
  const { fetchImpl } = graphMock({ ig: () => ok({ id: EXPECTED.ig_id, username: "outra_conta" }), quota: () => ok({ data: [] }), me: () => ok({ id: "1", name: "Outro Usuario" }) });
  const r = await run({ runCheck }, ENV, fetchImpl);
  assert.equal(r.exitCode, 1);
  assert.deepEqual(r.report.failed, ["me", "instagram", "publishing_limit"]);
});

test("env ausente: falha sem nenhuma chamada", async () => {
  const { calls, fetchImpl } = graphMock();
  const r = await run({ runCheck }, { META_ACCESS_TOKEN: USER_TOKEN }, fetchImpl);
  assert.equal(r.exitCode, 1);
  assert.match(r.report.error, /missing_env:META_PAGE_ID,INSTAGRAM_BUSINESS_ACCOUNT_ID/);
  assert.equal(calls.length, 0);
  assert.deepEqual(leakedTokens(r.out + r.summary), []);
});

test("redact remove segredos conhecidos, tokens com cara de Meta e parâmetros de token", () => {
  assert.equal(redact("x abcdSECRET y", ["abcdSECRET"]), "x [redacted] y");
  assert.equal(redact("EAA" + "B".repeat(20) + " ok", []), "[redacted] ok");
  assert.equal(redact("u?input_token=zzz&b=1", []), "u?input_token=[redacted]&b=1");
});

// Mutantes: versões quebradas do script, gravadas num diretório temporário. O detector precisa reprová-las;
// se algum mutante sobreviver (sem vazamento detectado), o próprio teste falha.
const MUTANTS = [
  ["imprime o token da Página", [["pageToken = null; // descartado", "log(pageToken); pageToken = null; // descartado"]]],
  ["imprime o token do usuário no step summary", [['"## Meta permission check (somente leitura, nada publicado)"', '"## Meta permission check " + secrets[0]']]],
  ["sem redação e sem barreira final", [['let s = String(text ?? "");', 'return String(text ?? "");'], ["const leaked = secrets.some((s) => s && json.includes(s));", "const leaked = false;"]]],
];

for (const [name, edits] of MUTANTS) {
  test(`mutante morto pelo detector de vazamento: ${name}`, async () => {
    let src = readTextNormalized(SRC_URL);
    for (const [from, to] of edits) { assert.ok(src.includes(from), "âncora do mutante presente: " + from); src = src.replace(from, to); }
    const dir = mkdtempSync(join(tmpdir(), "meta-mut-"));
    try {
      const file = join(dir, "m.mjs");
      writeFileSync(file, src);
      const mod = await import(pathToFileURL(file).href);
      const echo = () => fail(400, { code: 190, message: `bad ${USER_TOKEN}` });
      const { fetchImpl } = graphMock(name.startsWith("sem redação") ? { me: echo } : {});
      const r = await run(mod, ENV, fetchImpl);
      assert.notDeepEqual(leakedTokens(r.out + r.summary), [], "mutante sobreviveu: token não detectado na saída");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("barreira final: relatório que contivesse o token é suprimido e reprova", async () => {
  const src = readTextNormalized(SRC_URL);
  const from = 'const report = { schema: "meta-permission-check/v1",';
  assert.ok(src.includes(from));
  const dir = mkdtempSync(join(tmpdir(), "meta-bar-"));
  try {
    const file = join(dir, "m.mjs");
    writeFileSync(file, src.replace(from, 'const report = { t: token, schema: "meta-permission-check/v1",'));
    const mod = await import(pathToFileURL(file).href);
    const r = await run(mod, ENV, graphMock().fetchImpl);
    assert.deepEqual(leakedTokens(r.out + r.summary), []);
    assert.equal(r.exitCode, 1);
    assert.match(r.out, /report_suppressed_secret_detected/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- Correções da auditoria independente (PASS COM CORREÇÕES no 48abe10): NC-1..NC-4, cada uma com cenário e mutante.
const WHATSAPP_APP = "1071149631917061";
const dbgWith = (app_id) => () => ok({ data: { app_id, type: "SYSTEM_USER", is_valid: true, expires_at: 0, scopes: [] } });
const SCENARIOS = {
  // NC-1
  "app_id diferente do esperado reprova": async (mod) => { const r = await run(mod, ENV, graphMock({ debug: dbgWith("999") }).fetchImpl); return r.exitCode === 1 && r.report.ok === false && r.report.failed.includes("app_id"); },
  "app_id do WhatsApp reprova": async (mod) => { const r = await run(mod, ENV, graphMock({ debug: dbgWith(WHATSAPP_APP) }).fetchImpl); return r.exitCode === 1 && r.report.failed.includes("app_id") && r.report.items.debug_token.app_id_forbidden === true; },
  // NC-2
  "permissão obrigatória ausente reprova": async (mod) => {
    const r = await run(mod, ENV, graphMock({ perms: () => ok({ data: [{ permission: "instagram_basic", status: "granted" }, { permission: "instagram_content_publish", status: "declined" }, { permission: "pages_show_list", status: "granted" }, { permission: "pages_read_engagement", status: "granted" }] }) }).fetchImpl);
    return r.exitCode === 1 && r.report.failed.includes("permissions") && r.report.items.permissions.missing.join() === "instagram_content_publish,pages_manage_posts";
  },
  "/me/permissions com erro reprova": async (mod) => { const r = await run(mod, ENV, graphMock({ perms: () => fail(403, { code: 10, message: "denied" }) }).fetchImpl); return r.exitCode === 1 && r.report.failed.includes("permissions"); },
  "publish_video ausente só avisa": async (mod) => { const r = await run(mod, ENV, graphMock().fetchImpl); return r.exitCode === 0 && r.report.items.permissions?.warnings?.includes("publish_video_not_granted") === true; },
  // NC-3
  "Página ligada a outro Instagram reprova": async (mod) => { const r = await run(mod, ENV, graphMock({ page: () => ok({ id: EXPECTED.page_id, name: "Zevanory", instagram_business_account: { id: "17840000000000000" } }) }).fetchImpl); return r.exitCode === 1 && r.report.failed.includes("page"); },
  "Página sem Instagram ligado reprova": async (mod) => { const r = await run(mod, ENV, graphMock({ page: () => ok({ id: EXPECTED.page_id, name: "Zevanory" }) }).fetchImpl); return r.exitCode === 1 && r.report.items.page.error === "instagram_business_account_missing"; },
  "pede o campo instagram_business_account": async (mod) => { const m = graphMock(); await run(mod, ENV, m.fetchImpl); return m.calls.some((c) => c.path === "/" + EXPECTED.page_id && /fields=id%2Cname%2Cinstagram_business_account|fields=id,name,instagram_business_account/.test(c.url)); },
  // NC-4
  "json() nulo vira item com falha, sem exceção": async (mod) => { const r = await run(mod, ENV, graphMock({ me: () => ({ ok: true, status: 200, json: async () => null }) }).fetchImpl); return r.exitCode === 1 && r.report.items.me?.ok === false && r.report.error === undefined; },
  "exceção inesperada vira relatório com erro redigido": async (mod) => {
    const boom = () => ({ ok: true, status: 200, json: async () => ({ get error() { throw new Error("boom " + USER_TOKEN); } }) });
    let r; try { r = await run(mod, ENV, graphMock({ quota: boom }).fetchImpl); } catch { return false; }
    return r.exitCode === 1 && /^exception: boom \[redacted\]/.test(r.report.error || "") && leakedTokens(r.out + r.summary).length === 0;
  },
};
const ORIGINAL = { runCheck };
for (const [name, sc] of Object.entries(SCENARIOS)) test(`auditoria: ${name}`, async () => assert.equal(await sc(ORIGINAL), true));

const AUDIT_MUTANTS = [
  ["NC-1 app_id não reprova", [['if (dt && (dt.app_id_matches_expected === false || dt.app_id_forbidden === true)) report.failed.push("app_id");', ""]], ["app_id diferente do esperado reprova", "app_id do WhatsApp reprova"]],
  ["NC-1 lista do WhatsApp ignorada", [['dt.app_id_matches_expected === false || dt.app_id_forbidden === true', "dt.app_id_matches_expected === false"], ['app_id_matches_expected: d.app_id != null ? String(d.app_id) === EXPECTED.app_id : null,', 'app_id_matches_expected: true,']], ["app_id do WhatsApp reprova"]],
  ["NC-2 permissions fora dos obrigatórios", [['const required = ["me", "page", "page_token", "permissions", "instagram", "publishing_limit"];', 'const required = ["me", "page", "page_token", "instagram", "publishing_limit"];']], ["permissão obrigatória ausente reprova", "/me/permissions com erro reprova"]],
  ["NC-2 publish_video vira obrigatório", [['required_permissions: Object.freeze(["instagram_basic",', 'required_permissions: Object.freeze(["publish_video", "instagram_basic",']], ["publish_video ausente só avisa"]],
  ["NC-3 vínculo não exigido", [["const linkedOk = linked === igId;", "const linkedOk = true;"]], ["Página ligada a outro Instagram reprova", "Página sem Instagram ligado reprova"]],
  ["NC-3 campo não pedido", [["?fields=id,name,instagram_business_account`", "?fields=id,name`"]], ["pede o campo instagram_business_account"]],
  ["NC-4 json nulo volta a quebrar", [["const body = (await res.json().catch(() => null)) ?? {};", "const body = await res.json().catch(() => ({}));"]], ["json() nulo vira item com falha, sem exceção"]],
  ["NC-4 sem try/catch", [["    return await checks({ env, fetchImpl, log, mask, summary, secrets, token, report });\n  } catch (e) {", "    return await checks({ env, fetchImpl, log, mask, summary, secrets, token, report });\n  } catch (e) { throw e;"]], ["exceção inesperada vira relatório com erro redigido"]],
];
for (const [name, edits, killers] of AUDIT_MUTANTS) {
  test(`mutante da auditoria morto: ${name}`, async () => {
    let src = readTextNormalized(SRC_URL);
    for (const [from, to] of edits) { assert.ok(src.includes(from), "âncora do mutante presente: " + from); src = src.replace(from, to); }
    const dir = mkdtempSync(join(tmpdir(), "meta-aud-"));
    try {
      const file = join(dir, "m.mjs");
      writeFileSync(file, src);
      const mod = await import(pathToFileURL(file).href);
      const verdicts = [];
      for (const k of killers) verdicts.push(await SCENARIOS[k](mod));
      assert.ok(verdicts.some((v) => v === false), `mutante sobreviveu a: ${killers.join(" | ")}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

// ---- Contra-auditoria GPT-6 (NO-GO no 26fa2e2): NC-F1-A6-01 e NC-F1-A6-02, cada uma com cenário e mutante.
const ODD_TOKEN = "tok/sentinel+0003=x?y";
const DBG_URL_RX = /debug_token\?input_token=(?!\[redacted\])/;
const visible = (r) => r.out + "\n" + r.summary;
const A6 = {
  // NC-F1-A6-01
  "Página fictícia reprova antes da API": async (mod) => { const m = graphMock(); const r = await run(mod, { ...ENV, META_PAGE_ID: "1111111111111111" }, m.fetchImpl); return r.exitCode === 1 && r.report.ok === false && r.report.failed?.join() === "page_id" && m.calls.length === 0; },
  "Instagram fictício reprova antes da API": async (mod) => { const m = graphMock(); const r = await run(mod, { ...ENV, INSTAGRAM_BUSINESS_ACCOUNT_ID: "17840000000000001" }, m.fetchImpl); return r.exitCode === 1 && r.report.ok === false && r.report.failed?.join() === "ig_id" && m.calls.length === 0; },
  "Página e Instagram fictícios (mock coerente) reprovam": async (mod) => {
    const P = "2222222222222222", I = "17849999999999999";
    const fetchImpl = async (url) => { const u = new URL(String(url)); const p = u.pathname.replace("/v21.0", "");
      if (p === "/" + P && u.searchParams.get("fields") !== "access_token") return ok({ id: P, name: "Fake", instagram_business_account: { id: I } });
      if (p === "/" + I) return ok({ id: I, username: "zevanory_" });
      if (p === "/me/accounts") return ok({ data: [{ id: P, access_token: PAGE_TOKEN }] });
      if (p === `/${I}/content_publishing_limit`) return ok({ data: [{ quota_usage: 0, config: { quota_total: 100 } }] });
      return graphMock().fetchImpl(url); };
    const r = await run(mod, { ...ENV, META_PAGE_ID: P, INSTAGRAM_BUSINESS_ACCOUNT_ID: I }, fetchImpl);
    return r.exitCode === 1 && r.report.ok === false && r.report.pronto_para_prova === false;
  },
  // NC-F1-A6-02
  "debug_token falhando: NAO_COMPROVADA e pronto_para_prova false": async (mod) => { const r = await run(mod, ENV, graphMock({ debug: () => fail(400, { code: 100, message: "app token required" }) }).fetchImpl); return r.report.app_identity === "NAO_COMPROVADA" && r.report.pronto_para_prova === false && /NAO_COMPROVADA/.test(r.summary); },
  "debug_token sem app_id: NAO_COMPROVADA": async (mod) => { const r = await run(mod, ENV, graphMock({ debug: () => ok({ data: { is_valid: true, scopes: [] } }) }).fetchImpl); return r.report.app_identity === "NAO_COMPROVADA" && r.report.pronto_para_prova === false; },
  "URL do debug_token nunca é registrada (erro de rede com a URL)": async (mod) => {
    const env = { ...ENV, META_ACCESS_TOKEN: ODD_TOKEN };
    const fetchImpl = async (url, init) => { if (String(url).includes("/debug_token")) throw new Error(`request to ${url} failed, reason: ECONNRESET`); return graphMock().fetchImpl(url, init); };
    const r = await run(mod, env, fetchImpl);
    const v = visible(r);
    return leakedTokens(v, [ODD_TOKEN]).length === 0 && !DBG_URL_RX.test(v) && !v.includes("graph.facebook.com") && r.report.app_identity === "NAO_COMPROVADA";
  },
  "input_token fora de URL também é redigido": async (mod) => {
    const env = { ...ENV, META_ACCESS_TOKEN: ODD_TOKEN };
    const r = await run(mod, env, graphMock({ debug: () => fail(400, { code: 190, message: "bad input_token=" + encodeURIComponent(ODD_TOKEN) }) }).fetchImpl);
    return leakedTokens(visible(r), [ODD_TOKEN]).length === 0;
  },
};
for (const [name, sc] of Object.entries(A6)) test(`contra-auditoria A6: ${name}`, async () => assert.equal(await sc({ runCheck }), true));

const A6_MUTANTS = [
  ["A6-01 sem checagem do page_id", [['if (pageId !== EXPECTED.page_id) idMismatch.push("page_id");', ""]], ["Página fictícia reprova antes da API"]],
  ["A6-01 sem checagem do ig_id", [['if (igId !== EXPECTED.ig_id) idMismatch.push("ig_id");', ""]], ["Instagram fictício reprova antes da API"]],
  ["A6-01 checagem só depois da API", [["  if (idMismatch.length) {\n    report.ok = false;", "  if (false) {\n    report.ok = false;"]], ["Página fictícia reprova antes da API", "Página e Instagram fictícios (mock coerente) reprovam"]],
  ["A6-02 identidade sempre comprovada", [['report.app_identity = dt?.ok === true && dt?.app_id_matches_expected === true && dt?.app_id_forbidden === false ? "COMPROVADA"', 'report.app_identity = true ? "COMPROVADA"']], ["debug_token falhando: NAO_COMPROVADA e pronto_para_prova false", "debug_token sem app_id: NAO_COMPROVADA"]],
  ["A6-02 pronto_para_prova = ok", [['report.pronto_para_prova = report.ok && report.app_identity === "COMPROVADA";', "report.pronto_para_prova = report.ok;"]], ["debug_token falhando: NAO_COMPROVADA e pronto_para_prova false"]],
  ["A6-02 URL registrada", [[String.raw`s = s.replace(/https?:\/\/[^\s"']+/gi, "[url]");`, ""]], ["URL do debug_token nunca é registrada (erro de rede com a URL)"]],
  ["A6-02 input_token sem redação", [[String.raw`(access_token|input_token)=[^&\s"]+`, String.raw`(access_token)=[^&\s"]+`]], ["input_token fora de URL também é redigido"]],
];
for (const [name, edits, killers] of A6_MUTANTS) {
  test(`mutante da contra-auditoria A6 morto: ${name}`, async () => {
    let src = readTextNormalized(SRC_URL);
    for (const [from, to] of edits) { assert.ok(src.includes(from), "âncora do mutante presente: " + from); src = src.replace(from, to); }
    const dir = mkdtempSync(join(tmpdir(), "meta-a6-"));
    try {
      const file = join(dir, "m.mjs");
      writeFileSync(file, src);
      const mod = await import(pathToFileURL(file).href);
      const verdicts = [];
      for (const k of killers) verdicts.push(await A6[k](mod));
      assert.ok(verdicts.some((v) => v === false), `mutante sobreviveu a: ${killers.join(" | ")}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
