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
    const key = p === "/me" ? "me" : p === "/me/accounts" ? "accounts" : p === `/${EXPECTED.page_id}` && u.searchParams.get("fields") === "access_token" ? "pageField"
      : p === `/${EXPECTED.page_id}` ? "page" : p === `/${EXPECTED.ig_id}` ? "ig" : p.endsWith("/content_publishing_limit") ? "quota" : p === "/debug_token" ? "debug" : "unknown";
    if (over[key]) return over[key](u);
    switch (key) {
      case "me": return ok({ id: "61500000000001", name: "zevanory-publisher" });
      case "page": return ok({ id: EXPECTED.page_id, name: "Zevanory" });
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

test("caminho feliz: 5 itens ok, JSON curto, token mascarado antes da 1a chamada e nunca impresso", async () => {
  const { calls, fetchImpl } = graphMock();
  const r = await run({ runCheck }, ENV, fetchImpl);
  assert.equal(r.exitCode, 0);
  assert.equal(r.report.ok, true);
  for (const k of ["me", "page", "page_token", "instagram", "publishing_limit", "debug_token"]) assert.equal(r.report.items[k].ok, true, k);
  assert.equal(r.report.items.page_token.obtained, true);
  assert.equal(r.report.items.instagram.username, "zevanory_");
  assert.equal(r.report.items.publishing_limit.quota_total, 100);
  assert.equal(r.report.items.debug_token.never_expires, true);
  assert.equal(r.report.items.debug_token.has_publish_video, false);
  assert.equal(r.report.items.debug_token.app_id_matches_expected, true);
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

test("somente leitura: só GET, só graph v21.0, token só no cabeçalho, nenhum endpoint de publicação", async () => {
  const { calls, fetchImpl } = graphMock();
  await run({ runCheck }, ENV, fetchImpl);
  for (const c of calls) {
    assert.equal(c.method, "GET");
    assert.ok(c.url.startsWith(GRAPH + "/"), c.url);
    assert.equal(c.auth, "Bearer " + USER_TOKEN);
    assert.doesNotMatch(c.url, /access_token=/);
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
