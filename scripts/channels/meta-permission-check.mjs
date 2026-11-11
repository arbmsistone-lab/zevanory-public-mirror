// DEC-23 (plano-mestre, seção 9): teste de permissão da Meta Graph API ANTES da ativação contínua.
// Somente leitura: só faz GET. Não publica nada, não cria contêiner de mídia, não grava em lugar nenhum
// além do log e do step summary. O token do usuário de sistema vem de env (META_ACCESS_TOKEN) e é mascarado
// com ::add-mask:: antes da primeira chamada. A autenticação usa o cabeçalho Authorization. A chamada
// /debug_token TAMBÉM envia o token inspecionado no parâmetro input_token da URL: nenhuma URL é registrada
// (nem em sucesso nem em erro) e mensagens de erro passam por redact(), que remove input_token/access_token.
// Se o app_id não puder ser verificado, app_identity = "NAO_COMPROVADA" e pronto_para_prova = false: isso
// NÃO constitui aprovação para publicação.
// Página e Instagram precisam ser EXATAMENTE os da ZEVANORY (EXPECTED); divergência reprova antes da API.
// O token da Página, se obtido, também é mascarado na hora e descartado: só registramos true/false.
// Saída: um JSON curto (ok/falha por item + mensagem de erro da API), sem token e sem dados pessoais.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const GRAPH = "https://graph.facebook.com/v21.0";
export const EXPECTED = Object.freeze({
  system_user: "zevanory-publisher",
  app_id: "1376083860957077",
  page_id: "1249902628211703",
  ig_id: "17841434063364846",
  ig_username: "zevanory_",
  // NC-1: o app do WhatsApp (desativado pela Meta em 10/10) nunca pode ser o dono deste token.
  forbidden_app_ids: Object.freeze(["1071149631917061"]),
  // NC-2: permissões que precisam estar "granted" em /me/permissions; publish_video só gera aviso.
  required_permissions: Object.freeze(["instagram_basic", "instagram_content_publish", "pages_show_list", "pages_read_engagement", "pages_manage_posts"]),
  warn_permissions: Object.freeze(["publish_video"]),
});
const REQUIRED_ENV = ["META_ACCESS_TOKEN", "META_PAGE_ID", "INSTAGRAM_BUSINESS_ACCOUNT_ID"];

// Remove qualquer segredo conhecido de um texto (defesa em profundidade sobre mensagens da API).
export function redact(text, secrets) {
  let s = String(text ?? "");
  for (const v of secrets) if (v && v.length >= 4) s = s.split(v).join("[redacted]");
  // Qualquer coisa com cara de token da Meta (EAA...) ou parâmetro access_token também sai.
  // Nenhuma URL é registrada (a do debug_token carrega o token em input_token).
  s = s.replace(/https?:\/\/[^\s"']+/gi, "[url]");
  return s.replace(/EAA[A-Za-z0-9]{10,}/g, "[redacted]").replace(/(access_token|input_token)=[^&\s"]+/gi, "$1=[redacted]").slice(0, 200);
}

async function graphGet(fetchImpl, token, path, secrets) {
  let res;
  try {
    res = await fetchImpl(GRAPH + path, { method: "GET", headers: { authorization: "Bearer " + token } });
  } catch (e) {
    return { ok: false, error: redact("network: " + (e?.message || e), secrets) };
  }
  const body = (await res.json().catch(() => null)) ?? {};
  if (!res.ok || body?.error) {
    const er = body?.error || {};
    const parts = [`http_${res.status}`, er.type, er.code != null ? `code_${er.code}` : null, er.error_subcode != null ? `sub_${er.error_subcode}` : null, er.message];
    return { ok: false, error: redact(parts.filter(Boolean).join(" "), secrets) };
  }
  return { ok: true, body };
}

/**
 * Roda as verificações. Injeções: env, fetchImpl, log (linhas de relatório), mask (só ::add-mask::),
 * summary (texto do step summary). Retorna { report, exitCode }.
 */
export async function runCheck({ env = process.env, fetchImpl = globalThis.fetch, log = console.log, mask = (v) => process.stdout.write(`::add-mask::${v}\n`), summary = () => {} } = {}) {
  const secrets = [];
  const token = env.META_ACCESS_TOKEN || "";
  if (token) { secrets.push(token); mask(token); } // máscara ANTES de qualquer chamada
  const report = { schema: "meta-permission-check/v1", graph: "v21.0", read_only: true, published: false, app_identity: "NAO_COMPROVADA", pronto_para_prova: false, items: {} };
  try {
    return await checks({ env, fetchImpl, log, mask, summary, secrets, token, report });
  } catch (e) {
    // NC-4: exceção inesperada (resposta malformada etc.) vira falha com relatório, nunca stack com dados.
    report.ok = false;
    report.error = "exception: " + redact(e?.message || e, secrets);
    return finish(report, 1, log, summary, secrets);
  }
}

async function checks({ env, fetchImpl, log, mask, summary, secrets, token, report }) {
  const missing = REQUIRED_ENV.filter((n) => !env[n]);
  if (missing.length) {
    report.ok = false;
    report.error = "missing_env:" + missing.join(",");
    return finish(report, 1, log, summary, secrets);
  }
  const pageId = String(env.META_PAGE_ID).trim();
  const igId = String(env.INSTAGRAM_BUSINESS_ACCOUNT_ID).trim();
  // NC-F1-A6-01: IDs divergentes dos da ZEVANORY reprovam ANTES de qualquer chamada à API.
  const idMismatch = [];
  if (pageId !== EXPECTED.page_id) idMismatch.push("page_id");
  if (igId !== EXPECTED.ig_id) idMismatch.push("ig_id");
  if (idMismatch.length) {
    report.ok = false;
    report.failed = idMismatch;
    report.error = "id_mismatch:" + idMismatch.join(",");
    return finish(report, 1, log, summary, secrets);
  }
  const it = report.items;

  // 1. Token válido e do usuário de sistema.
  const me = await graphGet(fetchImpl, token, "/me?fields=id,name", secrets);
  it.me = me.ok
    ? { ok: !!me.body.id && String(me.body.name || "").toLowerCase() === EXPECTED.system_user, name: String(me.body.name || "").slice(0, 60) || null, expected: EXPECTED.system_user }
    : { ok: false, error: me.error };

  // 2. Página + token da Página (só true/false).
  // NC-3: a Página precisa estar ligada exatamente à conta do Instagram configurada.
  const page = await graphGet(fetchImpl, token, `/${encodeURIComponent(pageId)}?fields=id,name,instagram_business_account`, secrets);
  if (page.ok) {
    const linked = page.body.instagram_business_account?.id != null ? String(page.body.instagram_business_account.id) : null;
    const linkedOk = linked === igId;
    it.page = { ok: String(page.body.id) === pageId && linkedOk, id_matches_expected: pageId === EXPECTED.page_id, name: String(page.body.name || "").slice(0, 60) || null, linked_instagram_matches: linkedOk, ...(linkedOk ? {} : { error: linked ? "instagram_business_account_mismatch" : "instagram_business_account_missing" }) };
  } else it.page = { ok: false, error: page.error };
  let pageToken = null, pageTokenVia = null, pageTokenError = null;
  const accounts = await graphGet(fetchImpl, token, "/me/accounts?fields=id,access_token&limit=100", secrets);
  const accountsMalformed = accounts.ok && !Array.isArray(accounts.body.data);
  if (accountsMalformed) pageTokenError = "me_accounts: invalid_data_array";
  else if (accounts.ok) {
    const row = accounts.body.data.find((p) => String(p?.id) === pageId);
    if (row?.access_token) { pageToken = String(row.access_token); pageTokenVia = "me_accounts"; }
  } else pageTokenError = "me_accounts: " + accounts.error;
  if (!pageToken && !accountsMalformed) {
    const direct = await graphGet(fetchImpl, token, `/${encodeURIComponent(pageId)}?fields=access_token`, secrets);
    if (direct.ok && direct.body.access_token) { pageToken = String(direct.body.access_token); pageTokenVia = "page_field"; }
    else if (!direct.ok) pageTokenError = [pageTokenError, "page_field: " + direct.error].filter(Boolean).join(" | ").slice(0, 200);
  }
  if (pageToken) { secrets.push(pageToken); mask(pageToken); }
  it.page_token = { ok: !!pageToken, obtained: !!pageToken, via: pageTokenVia, ...(pageToken ? {} : { error: pageTokenError || "not_returned" }) };
  pageToken = null; // descartado: nunca é usado nem impresso

  // NC-2: permissões concedidas ao usuário de sistema.
  const perms = await graphGet(fetchImpl, token, "/me/permissions", secrets);
  if (perms.ok) {
    const granted = new Set((Array.isArray(perms.body.data) ? perms.body.data : []).filter((p) => p?.status === "granted").map((p) => String(p.permission)));
    const missing = EXPECTED.required_permissions.filter((n) => !granted.has(n));
    const warnings = EXPECTED.warn_permissions.filter((n) => !granted.has(n)).map((n) => n + "_not_granted");
    it.permissions = { ok: missing.length === 0, missing, warnings, has_publish_video: granted.has("publish_video"), ...(missing.length ? { error: "missing_permissions:" + missing.join(",") } : {}) };
  } else it.permissions = { ok: false, error: perms.error };

  // 3. Conta do Instagram.
  const ig = await graphGet(fetchImpl, token, `/${encodeURIComponent(igId)}?fields=id,username`, secrets);
  it.instagram = ig.ok
    ? { ok: String(ig.body.id) === igId && ig.body.username === EXPECTED.ig_username, username: ig.body.username ?? null, expected: EXPECTED.ig_username, id_matches_expected: igId === EXPECTED.ig_id }
    : { ok: false, error: ig.error };

  // 4. Cota de publicação (só leitura).
  const q = await graphGet(fetchImpl, token, `/${encodeURIComponent(igId)}/content_publishing_limit?fields=quota_usage,config`, secrets);
  if (q.ok) {
    const row = (q.body.data || [])[0] || {};
    it.publishing_limit = { ok: typeof row.quota_usage === "number", quota_usage: row.quota_usage ?? null, quota_total: row.config?.quota_total ?? null, quota_duration: row.config?.quota_duration ?? null };
  } else it.publishing_limit = { ok: false, error: q.error };

  // 5. debug_token (opcional: falha aqui não reprova, mas deixa a identidade do app NAO_COMPROVADA).
  // A URL leva o token inspecionado em input_token: ela nunca é registrada; erros passam por redact().
  const dbg = await graphGet(fetchImpl, token, `/debug_token?input_token=${encodeURIComponent(token)}`, secrets);
  if (dbg.ok) {
    const d = dbg.body.data || {};
    const scopes = Array.isArray(d.scopes) ? d.scopes.map(String).sort() : [];
    it.debug_token = {
      ok: d.is_valid === true && d.type === "SYSTEM_USER" && d.expires_at === 0, optional: true, is_valid: d.is_valid ?? null, type: d.type ?? null,
      app_id_matches_expected: d.app_id != null ? String(d.app_id) === EXPECTED.app_id : null,
      app_id_forbidden: d.app_id != null ? EXPECTED.forbidden_app_ids.includes(String(d.app_id)) : null,
      expires_at: d.expires_at ?? null, data_access_expires_at: d.data_access_expires_at ?? null,
      scopes, has_instagram_content_publish: scopes.includes("instagram_content_publish"), has_pages_manage_posts: scopes.includes("pages_manage_posts"), has_publish_video: scopes.includes("publish_video"),
    };
  } else it.debug_token = { ok: false, optional: true, error: dbg.error };

  const required = ["me", "page", "page_token", "permissions", "instagram", "publishing_limit"];
  report.failed = required.filter((k) => it[k]?.ok !== true);
  // NC-1: debug_token é opcional, mas se informar um app_id diferente do esperado (ou o do WhatsApp), reprova.
  const dt = it.debug_token;
  if (dt && (dt.app_id_matches_expected === false || dt.app_id_forbidden === true)) report.failed.push("app_id");
  // Campos nativos do debug_token: nunca confiar em um eventual never_expires da resposta.
  if (dbg.ok && dt?.ok !== true) report.failed.push("token_identity");
  report.ok = report.failed.length === 0;
  // NC-F1-A6-03: app certo + is_valid true + type SYSTEM_USER + expires_at numérico zero.
  // expires_at=0 é "sem expiração"; não se usa campo never_expires da resposta.
  // data_access_expires_at é apenas informado, nunca usado para aprovar.
  // Referências: https://developers.facebook.com/docs/graph-api/reference/debug_token/
  // https://github.com/meta/agentic-tools/blob/main/plugins/devtools/skills/debug-access-token/SKILL.md
  report.app_identity = dt?.ok === true && dt?.app_id_matches_expected === true && dt?.app_id_forbidden === false ? "COMPROVADA"
    : report.failed.includes("app_id") ? "DIVERGENTE" : "NAO_COMPROVADA";
  report.pronto_para_prova = report.ok && report.app_identity === "COMPROVADA";
  return finish(report, report.ok ? 0 : 1, log, summary, secrets);
}

function finish(report, exitCode, log, summary, secrets) {
  const json = JSON.stringify(report);
  // Última barreira: se um segredo escapou para o relatório, não imprime o relatório.
  const leaked = secrets.some((s) => s && json.includes(s));
  const line = leaked ? JSON.stringify({ schema: report.schema, ok: false, error: "report_suppressed_secret_detected" }) : json;
  log(line);
  const icon = (o) => (o ? "ok" : "falha");
  const rows = leaked ? [] : Object.entries(report.items || {}).map(([k, v]) => `| ${k} | ${icon(v.ok)}${v.optional ? " (opcional)" : ""} | ${String(v.error || "").replace(/\|/g, "/")} |`);
  summary(["## Meta permission check (somente leitura, nada publicado)", "", `Resultado: **${report.ok && !leaked ? "ok" : "falha"}** | identidade do app: **${report.app_identity ?? "NAO_COMPROVADA"}** | pronto para prova: **${report.pronto_para_prova === true && !leaked ? "sim" : "não"}**`, "", "| item | status | erro da API |", "|---|---|---|", ...rows, "", "```json", line, "```", ""].join("\n"));
  return { report: leaked ? JSON.parse(line) : report, exitCode: leaked ? 1 : exitCode };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  const { exitCode } = await runCheck({ summary: (t) => { if (summaryPath) appendFileSync(summaryPath, t + "\n"); } });
  process.exit(exitCode);
}
