#!/usr/bin/env node
// ZEVANORY | Nomes de segredos/bindings do Worker de produção `zevanory`: readback e remoção dirigida dos segredos de
// teste (F2 item 9; roteiro 3.1 seção 7). Usado por production-test-secret-readback.yml e
// production-test-secret-cleanup.yml (coleta em scripts/ci/production-worker-state.sh). Só NOMES:
// `wrangler secret list --format json` = [{name,type}];
// GET /accounts/{id}/workers/scripts/{script}/settings = {success,result:{bindings:[...], ...}}. Dos bindings só se lê
// nome, tipo, as CHAVES do json ZEVANORY_RUNTIME_CONFIG e o texto de ZEVANORY_DEPLOYMENT_ENV (prova do alvo, não é
// segredo). Nenhum valor é impresso; valores de var só entram em hash comparado em memória, nunca impresso.
// Referências (24/10/2026; wrangler 4.143.0, cloudflare/workers-sdk@ac795396, packages/wrangler/src/secret/index.ts):
// `secret list --format json` imprime JSON.stringify([{name,type}]); `secret delete <KEY> --name <worker>` chama
// DELETE /accounts/{id}/workers/scripts/{worker}/secrets/{KEY} e, fora de terminal interativo, confirma sozinho
// (dialogs.ts, fallbackValue = true). `secret delete` só remove segredos: var de texto (plain_text) não sai por ele.
// Cada DELETE publica uma nova versão (annotation workers/triggered_by = "secret", que o wrangler mostra como
// "Secret Change"). GET .../deployments = {success,result:{deployments:[{id,created_on,versions:[{version_id,
// percentage}]}]}} (mais recente = efetivo); GET .../versions/{id} = {success,result:{id,number,annotations,metadata,
// resources:{bindings,script:{etag,handlers},script_runtime:{compatibility_date,compatibility_flags,usage_model}}}}
// (o wrangler usa resources.script.etag como hash do conteúdo do script).
//
// Desenho (Sol): alvo provado; diff esperado impresso ANTES (apagar x manter); conjunto apagado ⊆ allowlist ∩ presentes;
// confirmação digitada = nomes exatos; readback depois; qualquer divergência falha fechado.
// Controles do auditor (Sol 187 + ajustes Sol 189):
//   C1 pré-inventário: o readback imprime TODO (nome, tipo, origem), a versão efetiva, o commit publicado (/api/release),
//      os conjuntos DELETE/KEEP planejados e o INVENTORY_DIGEST. Nunca valores.
//   C2/A2 autorização presa ao estado: documento canônico versionado (INVENTORY_SCHEMA) com conta, script, commit
//      publicado, lista (name,type,origin) e listas DELETE/KEEP; JSON canônico (chaves ordenadas, sem espaço) e SHA-256.
//      A versão efetiva fica FORA do digest (cada DELETE publica uma versão nova) e é um campo autorizado à parte
//      (expected_version_id, obrigatório). O plano recalcula D0 e RECUSA se difere de expected_inventory_digest ou se a
//      versão difere de expected_version_id.
//   Sol 191 transições explícitas: S0 = inventário aprovado (D0); S1 = S0 menos exatamente o 1º nome (D1); S2 = S0 menos
//      os 2 nomes, todo o KEEP com tipos e origens inalterado (D2). D1 e D2 são calculados de S0 no plano, ANTES de
//      qualquer DELETE, e impressos. Antes do DELETE k o inventário vivo tem de dar D(k-1); depois, Dk; senão o próximo
//      DELETE não acontece (CLEANUP_PARTIAL / CONCURRENT_CHANGE, estado preservado). A identidade do código (etag,
//      runtime, commit) é a mesma em todos os estados.
//   C3/A1 serialização: nenhum run ativo de qualquer workflow da matriz docs/ops/zevanory-publisher-matrix.json (inclusive os
//      dois financeiros fora do grupo deploy-zevanory) e versão efetiva = a do plano. Publicadores externos (painel,
//      Workers Builds, outros tokens) não serializáveis: detecção antes e depois de cada DELETE; se a versão andou por
//      outra coisa que não o nosso DELETE (cadeia de deployments, diff de configuração, etag do código), CONCURRENT_CHANGE.
//   C4 falha parcial: um nome por vez; qualquer falha para, imprime CLEANUP_PARTIAL (presentes/ausentes, versão) e falha.
//      Nada é recriado automaticamente.
//   C5/A3 verificação estrita: ADDED_SINCE_PLAN falha; tipo mudado falha; código preservado (etag do script, handlers,
//      compatibility date/flags, usage model, demais settings do script) entre a versão do plano e a final; diff de
//      configuração (bindings da versão, inclusive valor de var por hash) = EXATAMENTE os segredos autorizados;
//      /api/release com commit_sha igual e sales_mode globally-blocked; /api/sales/status com open=false.
//
// CLI (0 = PASS, 1 = FAIL/recusa, 2 = entrada inválida). STATE = --secrets L.json --settings S.json --deployments D.json
// --version-detail V.json [--release R.json] (coletados juntos por production-worker-state.sh):
//   readback  --secrets L.json [--settings S] [--deployments D] [--version-detail V] [--release R] [--strict] [--debt F]
//   plan      STATE --confirmation "<texto>" --expected-digest sha256:<hex> --expected-version <id> --out PLAN.json
//   preflight --plan PLAN.json --deployments D.json --runs RUNS.json [--runs ...] --self-run-id N [--matrix F]
//   step      --phase pre|post --plan PLAN.json --name NOME [--deleted A,B] --expected-version <id> STATE [--out-version F]
//   partial   --plan PLAN.json [STATE] [--reason TXT]                                               (sempre 1)
//   verify    --plan PLAN.json STATE
//   postcheck --plan PLAN.json --release R.json --sales SALES.json
//   version-id --deployments D.json   (imprime a versão única a 100%, ou nada)
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const TARGET = Object.freeze({ account: "1b26415802588185a86c1d4d3ebf5bdb", script: "zevanory", environment: "production" });
export const INVENTORY_SCHEMA = "zev-inventory/v1";
// Regra do readback: nenhum nome contendo _TEST_ ou CERTIFICATION no Worker de produção.
export const FORBIDDEN_IN_PRODUCTION = /_TEST_|CERTIFICATION/;
// Remoção: SÓ estes nomes. Seguros de remover: a produção nunca os lê fora da rota mercadopago_test / piloto sandbox
// (tests/production-payment-credential-isolation.test.mjs P1-P6) e nenhum deploy os regrava.
export const REMOVAL_ALLOWLIST = Object.freeze(["MERCADOPAGO_TEST_ACCESS_TOKEN", "MERCADOPAGO_TEST_WEBHOOK_SECRET"]);
export const CONFIRMATION_PHRASE = REMOVAL_ALLOWLIST.join(",");
// Dívida rastreada (ops/r9-debt.json, fonte única com o gate): nomes que o código/contrato de produção ainda lê.
export const DEFAULT_DEBT_FILE = fileURLToPath(new URL("../../ops/r9-debt.json", import.meta.url));
export const DEFAULT_MATRIX_FILE = fileURLToPath(new URL("../../docs/ops/zevanory-publisher-matrix.json", import.meta.url));
// Estados de run do GitHub Actions que ainda podem publicar (o GET /actions/runs?status= aceita estes cinco).
export const ACTIVE_RUN_STATUSES = Object.freeze(["queued", "in_progress", "waiting", "requested", "pending"]);
export function loadDebt(path = DEFAULT_DEBT_FILE) {
  const reg = JSON.parse(readFileSync(path, "utf8"));
  if (!reg || !Array.isArray(reg.pending)) throw new InputError("debt_registry_invalid");
  const names = {};
  for (const e of reg.pending) {
    if (!e || typeof e.id !== "string" || typeof e.name !== "string" || !String(e.reason || "").trim() || !String(e.planned_pr || "").trim()) throw new InputError("debt_registry_invalid");
    names[e.name] = `${e.id}: ${e.reason} (PR planejado: ${e.planned_pr})`;
  }
  return Object.freeze({ pending: reg.pending.map((e) => ({ id: e.id, name: e.name })), names: Object.freeze(names) });
}
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const cleanType = (t) => String(t || "").replace(/[^a-z0-9_]/g, "").slice(0, 32) || "unknown";
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

export class InputError extends Error {}

// JSON canônico: chaves de objeto ordenadas (ordem de código), arrays na ordem dada, sem espaço.
export function canonicalJson(v) {
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort(cmp).map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
  return JSON.stringify(v === undefined ? null : v);
}

export function entriesFromSecretList(data) {
  if (!Array.isArray(data)) throw new InputError("secret_list_not_array");
  return data.map((item) => {
    const name = item && typeof item === "object" ? item.name : undefined;
    if (typeof name !== "string" || !NAME.test(name)) throw new InputError("secret_list_invalid_name");
    if (typeof item.type !== "string" || !item.type) throw new InputError("secret_list_missing_type");
    return { name, type: cleanType(item.type), origin: "secret" };
  }).map((e, i, all) => { if (all.findIndex((x) => x.name === e.name) !== i) throw new InputError("secret_list_duplicate_name"); return e; });
}
export const namesFromSecretList = (data) => entriesFromSecretList(data).map((e) => e.name);

// Sol 194: resposta paginada só é aceita com a paginação esgotada (inventário parcial falha fechado).
function assertComplete(data, items, what) {
  const ri = data && data.result_info;
  if (Array.isArray(data?.errors) && data.errors.length) throw new InputError(what + "_with_errors");
  if (ri && typeof ri === "object" && (Number(ri.total_pages || 1) > Number(ri.page || 1) || (ri.total_count != null && Number(ri.total_count) > items.length))) throw new InputError(what + "_pagination_not_exhausted");
}
function bindingsOf(data) {
  if (!data || typeof data !== "object" || data.success !== true) throw new InputError("settings_not_success");
  const bindings = data.result?.bindings;
  if (!Array.isArray(bindings)) throw new InputError("settings_without_bindings");
  for (const b of bindings) if (!b || typeof b !== "object" || typeof b.name !== "string" || !NAME.test(b.name)) throw new InputError("settings_invalid_binding_name");
  for (const b of bindings) if (typeof b.type !== "string" || !b.type) throw new InputError("settings_binding_missing_type");
  if (new Set(bindings.map((b) => b.name)).size !== bindings.length) throw new InputError("settings_duplicate_binding_name");
  assertComplete(data, bindings, "settings");
  return bindings;
}

export function namesFromSettings(data) {
  const out = [];
  for (const b of bindingsOf(data)) {
    out.push({ name: b.name, type: cleanType(b.type), source: "binding" });
    if (b.name === "ZEVANORY_RUNTIME_CONFIG") {
      let raw = b.json ?? b.text ?? {};
      if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { raw = {}; } }
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const key of Object.keys(raw)) if (NAME.test(key)) out.push({ name: key, type: "runtime_config_key", source: "ZEVANORY_RUNTIME_CONFIG" });
      }
    }
  }
  return out;
}

// C1: inventário completo (nome, tipo, origem), canônico e sem repetição.
const ORIGIN_OF_SOURCE = { binding: "binding", ZEVANORY_RUNTIME_CONFIG: "runtime_config" };
export const ORIGINS = Object.freeze(["binding", "runtime_config", "secret"]);
export function buildInventory({ secretEntries = [], bindingNames = [] }) {
  const all = [...secretEntries.map((e) => ({ name: e.name, type: e.type, origin: "secret" })),
    ...bindingNames.map((b) => ({ name: b.name, type: b.type, origin: Object.hasOwn(ORIGIN_OF_SOURCE, b.source) ? ORIGIN_OF_SOURCE[b.source] : b.source }))];
  return validateEntries(all);
}
// Sol 194: rejeita origem desconhecida, nome repetido na mesma origem e campo ausente; ordem determinística.
export function validateEntries(all) {
  const byKey = new Map();
  for (const e of all) {
    if (!e || typeof e.name !== "string" || !NAME.test(e.name) || typeof e.type !== "string" || !e.type) throw new InputError("inventory_entry_incomplete");
    if (!ORIGINS.includes(e.origin)) throw new InputError("inventory_unknown_origin");
    const k = e.name + "\u0000" + e.origin;
    if (byKey.has(k)) throw new InputError(byKey.get(k).type === e.type ? "inventory_duplicate_name" : "inventory_inconsistent_type");
    byKey.set(k, { name: e.name, type: e.type, origin: e.origin });
  }
  return [...byKey.values()].sort((a, b) => cmp(a.name, b.name) || cmp(a.origin, b.origin) || cmp(a.type, b.type));
}
// Sol 194: secret list e settings descrevem o mesmo Worker; um segredo tem o MESMO tipo nas duas fontes e todo binding
// de segredo do settings aparece na secret list (senão o inventário está incompleto).
const SECRET_TYPES = new Set(["secret_text", "secret_key"]);
export function crossCheckSources(secretEntries, bindingNames) {
  const bindings = new Map(bindingNames.filter((b) => b.source === "binding").map((b) => [b.name, b.type]));
  for (const s of secretEntries) {
    if (!bindings.has(s.name)) throw new InputError("inventory_incomplete_secret_without_binding");
    if (bindings.get(s.name) !== s.type) throw new InputError("inventory_inconsistent_type");
  }
  const secrets = new Set(secretEntries.map((s) => s.name));
  for (const [name, type] of bindings) if (SECRET_TYPES.has(type) && !secrets.has(name)) throw new InputError("inventory_incomplete_secret_list");
}

// A2: documento canônico do estado autorizado.
export function inventoryDocument({ entries, commitSha, code = null, toDelete, kept }) {
  return { schema: INVENTORY_SCHEMA, account: TARGET.account, script: TARGET.script, commit_sha: commitSha ?? null, code,
    entries: entries.map((e) => [e.name, e.type, e.origin]),
    delete: [...toDelete].sort(cmp), keep: [...kept].sort(cmp) };
}
export const inventoryDigest = (doc) => "sha256:" + sha256(canonicalJson(doc));

// Versão efetiva do Worker: deployment mais recente; id = a versão única a 100% ou "id@pct,..." em rollout gradual.
function deploymentsOf(data) {
  if (!data || typeof data !== "object" || data.success !== true) throw new InputError("deployments_not_success");
  const list = data.result?.deployments;
  if (!Array.isArray(list) || list.length === 0) throw new InputError("deployments_empty");
  assertComplete(data, list, "deployments");
  for (const d of list) if (!d || typeof d.created_on !== "string" || !d.created_on) throw new InputError("deployment_missing_created_on");
  return [...list].sort((a, b) => cmp(b.created_on, a.created_on) || cmp(String(b.id || ""), String(a.id || ""))).map((d) => {
    const versions = Array.isArray(d?.versions) ? d.versions : [];
    if (!versions.length) throw new InputError("deployment_without_versions");
    const parsed = versions.map((v) => {
      const id = String(v?.version_id || "");
      const pct = Number(v?.percentage);
      if (!VERSION_ID.test(id) || !Number.isFinite(pct)) throw new InputError("deployment_invalid_version");
      return { id, pct };
    }).sort((a, b) => cmp(a.id, b.id));
    const single = parsed.length === 1 && parsed[0].pct === 100;
    return { id: single ? parsed[0].id : parsed.map((v) => `${v.id}@${v.pct}`).join(","), deployment_id: VERSION_ID.test(String(d.id || "")) ? d.id : "desconhecido", versions: parsed, single };
  });
}
export function effectiveDeployment(data) {
  const chain = deploymentsOf(data);
  return { ...chain[0], previous: chain[1] ? chain[1].id : null };
}

// A3: impressão digital do CÓDIGO (não muda com segredo) e da CONFIGURAÇÃO (bindings da versão, por hash).
export function versionDetail(data) {
  if (!data || typeof data !== "object" || data.success !== true || !data.result || typeof data.result !== "object") throw new InputError("version_detail_not_success");
  const v = data.result;
  const res = v.resources || {};
  const script = res.script || {}, rt = res.script_runtime;
  if (typeof script.etag !== "string" || !script.etag) throw new InputError("version_detail_without_etag");
  if (!rt || typeof rt !== "object" || !Array.isArray(res.bindings)) throw new InputError("version_detail_incomplete");
  if (new Set(res.bindings.map((b) => b && b.name)).size !== res.bindings.length) throw new InputError("version_detail_duplicate_binding_name");
  const ann = v.annotations || (v.metadata && v.metadata.annotations) || {};
  const tag = String(ann["workers/tag"] || "").toLowerCase();
  const code = { etag: script.etag, handlers: [...(script.handlers || [])].map(String).sort(cmp),
    compatibility_date: rt.compatibility_date ?? null, compatibility_flags: [...(rt.compatibility_flags || [])].map(String).sort(cmp),
    usage_model: rt.usage_model ?? null };
  const config = {};
  for (const b of res.bindings) {
    if (!b || typeof b.name !== "string" || !NAME.test(b.name) || typeof b.type !== "string" || !b.type) throw new InputError("version_detail_invalid_binding");
    config[b.name] = { type: cleanType(b.type), h: sha256(canonicalJson(b)) };
  }
  return { id: VERSION_ID.test(String(v.id || "")) ? v.id : null, number: Number.isInteger(v.number) ? v.number : null,
    tag: COMMIT.test(tag) ? tag : null, trigger: typeof ann["workers/triggered_by"] === "string" ? ann["workers/triggered_by"].replace(/[^a-z_]/g, "") : null,
    code, config };
}
// Demais settings do script (fora os bindings, que já estão no inventário e na configuração da versão).
export function scriptSettingsHash(data) {
  bindingsOf(data);
  const { bindings, ...rest } = data.result;
  return sha256(canonicalJson(rest));
}
export function diffConfig(before, after, allowedRemoved) {
  const allowed = new Set(allowedRemoved);
  const removed = Object.keys(before).filter((n) => !Object.hasOwn(after, n)).sort(cmp);
  const added = Object.keys(after).filter((n) => !Object.hasOwn(before, n)).sort(cmp);
  const changed = Object.keys(after).filter((n) => Object.hasOwn(before, n) && (before[n].h !== after[n].h || before[n].type !== after[n].type)).sort(cmp);
  const unexpectedRemoved = removed.filter((n) => !allowed.has(n) || before[n].type !== "secret_text");
  const notRemoved = [...allowed].filter((n) => !removed.includes(n)).sort(cmp);
  return { ok: unexpectedRemoved.length === 0 && notRemoved.length === 0 && added.length === 0 && changed.length === 0, removed, unexpectedRemoved, notRemoved, added, changed };
}
export const sameCode = (a, b) => canonicalJson(a) === canonicalJson(b);

export function releaseInfo(data) {
  const sha = String(data?.deployment?.commit_sha || "").toLowerCase();
  return { commit_sha: COMMIT.test(sha) ? sha : null, sales_mode: typeof data?.sales_mode === "string" ? data.sales_mode.replace(/[^a-z-]/g, "").slice(0, 40) : null };
}

// Prova do alvo: o settings lido (da URL fixa account/script) é do Worker de produção.
export function proveTarget(data) {
  const env = bindingsOf(data).find((b) => b.name === "ZEVANORY_DEPLOYMENT_ENV");
  const value = env && env.type === "plain_text" ? String(env.text ?? "") : "";
  return { ok: value === TARGET.environment, deployment_env: value === TARGET.environment ? value : (env ? "outro" : "ausente") };
}

export function evaluateReadback({ secretNames = [], bindingNames = [], strict = false, debt: registry = loadDebt() } = {}) {
  const all = [...secretNames.map((name) => ({ name, type: "secret_text", source: "secret_list" })), ...bindingNames];
  const violations = [], debt = [];
  for (const entry of all) {
    if (!FORBIDDEN_IN_PRODUCTION.test(entry.name)) continue;
    if (!strict && Object.hasOwn(registry.names, entry.name)) debt.push(entry);
    else violations.push(entry);
  }
  // Estrito: o item 9 só fecha com a dívida vazia (inclui itens que não são nome de binding, como o Stripe).
  const openDebt = strict ? registry.pending.map((e) => e.id) : [];
  return { ok: violations.length === 0 && openDebt.length === 0, violations, debt, openDebt, total: all.length };
}

const inventory = (secretNames, bindingNames) => new Set([...secretNames, ...bindingNames.map((b) => b.name)]);

export function planRemoval({ confirmation, secretNames, bindingNames }) {
  if (typeof confirmation !== "string" || confirmation !== CONFIRMATION_PHRASE) return { ok: false, error: "confirmation_mismatch", toDelete: [] };
  const present = inventory(secretNames, bindingNames);
  const secrets = new Set(secretNames);
  const toDelete = REMOVAL_ALLOWLIST.filter((n) => present.has(n));
  const notSecret = toDelete.filter((n) => !secrets.has(n));
  if (notSecret.length) return { ok: false, error: "allowlisted_name_is_not_a_secret", toDelete: [], notSecret };
  // Invariante: apagado ⊆ allowlist ∩ presentes (redundante por construção; verificado mesmo assim).
  if (!toDelete.every((n) => REMOVAL_ALLOWLIST.includes(n) && present.has(n))) return { ok: false, error: "delete_set_outside_allowlist", toDelete: [] };
  const kept = [...present].filter((n) => !toDelete.includes(n)).sort();
  const absent = REMOVAL_ALLOWLIST.filter((n) => !present.has(n));
  const debt = Object.keys(loadDebt().names).filter((n) => present.has(n));
  return { ok: true, toDelete, kept, absent, debt };
}

// Estado lido de uma coleta (production-worker-state.sh) e seu documento canônico.
export function snapshot({ secretList, settings, deployments, version, release }) {
  const secretEntries = entriesFromSecretList(secretList);
  const bindingNames = settings ? namesFromSettings(settings) : [];
  if (settings) crossCheckSources(secretEntries, bindingNames);
  const entries = buildInventory({ secretEntries, bindingNames });
  const effective = deployments ? effectiveDeployment(deployments) : null;
  const detail = version ? versionDetail(version) : null;
  if (effective && detail && effective.single && detail.id !== effective.id) throw new InputError("version_detail_not_effective");
  if (settings && detail) {
    const a = canonicalJson(bindingNames.filter((b) => b.source === "binding").map((b) => [b.name, b.type]).sort((x, y) => cmp(x[0], y[0])));
    const b = canonicalJson(Object.keys(detail.config).sort(cmp).map((n) => [n, detail.config[n].type]));
    if (a !== b) throw new InputError("inventory_sources_disagree");
  }
  const preview = planRemoval({ confirmation: CONFIRMATION_PHRASE, secretNames: secretEntries.map((e) => e.name), bindingNames });
  const toDelete = preview.ok ? preview.toDelete : [];
  const kept = preview.ok ? preview.kept : [...new Set(entries.map((e) => e.name))].sort();
  const commit = releaseInfo(release).commit_sha;
  const doc = inventoryDocument({ entries, commitSha: commit, code: detail ? detail.code : null, toDelete, kept });
  return { secretEntries, bindingNames, entries, effective, detail, preview, commit, doc, digest: inventoryDigest(doc),
    settingsHash: settings ? scriptSettingsHash(settings) : null };
}

// C2/A2: a autorização vale só para o estado revisado.
export function checkBinding({ digest, expectedDigest, effective, expectedVersion }) {
  if (typeof expectedDigest !== "string" || !DIGEST.test(expectedDigest)) return { ok: false, error: "expected_digest_missing_or_malformed" };
  if (digest !== expectedDigest) return { ok: false, error: "inventory_digest_mismatch" };
  if (typeof expectedVersion !== "string" || !expectedVersion) return { ok: false, error: "expected_version_missing" };
  if (!effective || effective.id !== expectedVersion) return { ok: false, error: "effective_version_mismatch" };
  return { ok: true };
}

// C3/A1: matriz de publicadores do zevanory.
export function loadMatrix(data) {
  if (!data || data.worker !== "zevanory" || data.group !== "deploy-zevanory" || !Array.isArray(data.github) || !Array.isArray(data.external)) throw new InputError("matrix_invalid");
  for (const g of data.github) if (!g || typeof g.workflow !== "string" || !/^[\w.-]+\.ya?ml$/.test(g.workflow) || typeof g.serialized !== "boolean") throw new InputError("matrix_invalid");
  const writers = [...new Set(data.github.map((g) => g.workflow))].sort(cmp);
  const registered = Object.keys(data.registered_not_touching || {});
  return { group: data.group, writers, files: [...new Set([...writers, ...registered])].sort(cmp), unserialized: data.github.filter((g) => !g.serialized).map((g) => g.workflow).sort(cmp) };
}
export function evaluatePreflight({ listings, watched, selfRunId, plan, effective }) {
  if (!Array.isArray(listings) || listings.length === 0) throw new InputError("runs_missing");
  const files = new Set(watched.files.map((f) => ".github/workflows/" + f));
  const active = [], seen = new Set();
  let truncated = false;
  for (const l of listings) {
    if (!l || typeof l !== "object" || !Array.isArray(l.workflow_runs) || !Number.isInteger(l.total_count)) throw new InputError("runs_listing_invalid");
    if (l.total_count > l.workflow_runs.length) truncated = true;
    for (const r of l.workflow_runs) {
      const path = String(r?.path || "").split("@")[0];
      if (String(r?.id) === String(selfRunId) || !files.has(path) || seen.has(String(r?.id))) continue;
      if (!ACTIVE_RUN_STATUSES.includes(String(r?.status))) continue;
      seen.add(String(r?.id));
      active.push({ id: String(r.id), workflow: path.slice(".github/workflows/".length), status: String(r.status) });
    }
  }
  const versionChanged = !effective || !plan || effective.id !== plan.version;
  return { ok: active.length === 0 && !truncated && !versionChanged, active, truncated, versionChanged };
}

// Plano gravado: só nomes, tipos, ids e hashes; nunca valores.
function planOf(plan) {
  if (!plan || plan.schema !== INVENTORY_SCHEMA || !Array.isArray(plan.toDelete) || !Array.isArray(plan.kept) || !Array.isArray(plan.entries) || !plan.document || !plan.code || !plan.config) throw new InputError("plan_invalid");
  if (!Array.isArray(plan.chain) || plan.chain.length !== plan.toDelete.length + 1 || plan.chain.some((s) => !s || !DIGEST.test(String(s.digest)))) throw new InputError("plan_invalid");
  try { validateEntries(plan.entries); } catch { throw new InputError("plan_invalid"); }
  return plan;
}
// C4/C5: compara o inventário lido com o esperado (plano menos os nomes já removidos), por (nome, origem).
export function compareState({ plan, removed, entries }) {
  const gone = new Set(removed);
  const expected = planOf(plan).entries.filter((e) => !gone.has(e.name));
  const key = (e) => e.name + "\u0000" + e.origin;
  const exp = new Map(expected.map((e) => [key(e), e]));
  const got = new Map(entries.map((e) => [key(e), e]));
  const names = (xs) => [...new Set(xs.map((e) => e.name))].sort(cmp);
  const stillPresent = names(entries.filter((e) => gone.has(e.name)));
  const lost = names(expected.filter((e) => !got.has(key(e))));
  const added = names(entries.filter((e) => !exp.has(key(e)) && !gone.has(e.name)));
  const typeChanged = expected.filter((e) => got.has(key(e)) && got.get(key(e)).type !== e.type)
    .map((e) => `${e.name}(${e.origin}):${e.type}->${got.get(key(e)).type}`).sort(cmp);
  return { stillPresent, lost, added, typeChanged };
}
// Documento que o estado TEM de produzir depois de apagar `removed` (S0 menos esses nomes; KEEP intacto).
export function expectedDocument(document, removed) {
  const gone = new Set(removed);
  return { ...document, entries: document.entries.filter((e) => !gone.has(e[0])) };
}
// Digest do estado vivo com as listas DELETE/KEEP AUTORIZADAS (as do plano), comparável com D0..Dn.
export const liveDigest = (snap, plan) => inventoryDigest({ ...snap.doc, delete: plan.document.delete, keep: plan.document.keep });
// Sol 191: cadeia S0..Sn calculada de S0 antes de qualquer DELETE (ordem = toDelete).
export function stateChain(document, toDelete) {
  return [...Array(toDelete.length + 1).keys()].map((k) => ({ state: "S" + k, removed: toDelete.slice(0, k),
    digest: inventoryDigest(expectedDocument(document, toDelete.slice(0, k))) }));
}

export function verifyRemoval({ plan, snap }) {
  const c = compareState({ plan, removed: REMOVAL_ALLOWLIST, entries: snap.entries });
  const stillPresent = c.stillPresent, lostKept = c.lost, added = c.added, typeChanged = c.typeChanged;
  const errors = [];
  if (!snap.detail) errors.push("version_detail_missing");
  else {
    if (!sameCode(plan.code, snap.detail.code)) errors.push("code_changed");
    const d = diffConfig(plan.config, snap.detail.config, plan.toDelete);
    if (!d.ok) errors.push(`config_diff_not_exactly_delete removed=${d.removed.join("|")} added=${d.added.join("|")} changed=${d.changed.join("|")}`);
  }
  if (snap.settingsHash !== plan.settings_hash) errors.push("script_settings_changed");
  if (liveDigest(snap, plan) !== plan.chain[plan.chain.length - 1].digest) errors.push(`state_digest_mismatch:${plan.chain[plan.chain.length - 1].state}`);
  return { ok: stillPresent.length === 0 && lostKept.length === 0 && added.length === 0 && typeChanged.length === 0 && errors.length === 0, stillPresent, lostKept, added, typeChanged, errors };
}

// C4 + A1/A2/A3 + Sol 191 por passo. O passo k (1-based) apaga toDelete[k-1] e exige deleted = toDelete[0..k-1).
// pre: inventário vivo = S(k-1) (digest D(k-1) do plano), versão = expectedVersion (a do plano no 1º; a que o nosso DELETE
// anterior publicou nos seguintes). post: inventário vivo = Sk (Dk); o ÚNICO movimento desde pre é o nosso DELETE:
// deployment novo cujo anterior é expectedVersion, código igual, configuração = antes − name.
export function stepCheck({ plan, phase, name, deleted = [], expectedVersion, snap }) {
  planOf(plan);
  const k = deleted.length;
  if (plan.toDelete[k] !== name || deleted.some((n, i) => plan.toDelete[i] !== n)) return { ok: false, error: "name_not_planned", c: null, errors: [] };
  if (phase !== "pre" && phase !== "post") return { ok: false, error: "phase_invalid", c: null, errors: [] };
  const removed = phase === "post" ? [...deleted, name] : [...deleted];
  const target = plan.chain[removed.length];
  const c = compareState({ plan, removed, entries: snap.entries });
  const errors = [];
  if (c.stillPresent.length || c.lost.length || c.added.length || c.typeChanged.length) errors.push("inventory_not_expected");
  const live = liveDigest(snap, plan);
  if (live !== target.digest) errors.push(`state_digest_mismatch:${target.state}`);
  if (!snap.effective || !snap.detail) errors.push("effective_version_unreadable");
  else {
    if (!sameCode(plan.code, snap.detail.code)) errors.push("code_changed");
    if (!diffConfig(plan.config, snap.detail.config, removed).ok) errors.push("config_not_expected");
    if (snap.settingsHash !== plan.settings_hash) errors.push("script_settings_changed");
    if (phase === "pre") {
      if (snap.effective.id !== expectedVersion) errors.push("CONCURRENT_CHANGE:effective_version_moved");
      if (!k && plan.version !== expectedVersion) errors.push("expected_version_not_plan");
    } else {
      if (snap.effective.id === expectedVersion) errors.push("delete_did_not_publish_a_version");
      if (snap.effective.previous !== expectedVersion) errors.push("CONCURRENT_CHANGE:deployment_chain_not_single_step");
      if (snap.detail.trigger && snap.detail.trigger !== "secret") errors.push("CONCURRENT_CHANGE:new_version_not_a_secret_change");
    }
  }
  if (snap.commit !== plan.commit_sha) errors.push("CONCURRENT_CHANGE:deployed_commit_changed");
  const ok = errors.length === 0;
  return { ok, error: ok ? null : errors[0], errors, c, state: target.state, from: plan.chain[deleted.length].state, live };
}

// C4: estado efetivo depois de uma falha (nunca recria nada).
export function partialReport({ plan, entries, effective }) {
  const after = new Set(entries.map((e) => e.name));
  return { planned: plan.toDelete.map((n) => ({ name: n, state: after.has(n) ? "present" : "absent" })),
    keptMissing: plan.kept.filter((n) => !after.has(n)).sort(cmp), version: effective ? effective.id : null };
}

// C5: estado público depois da remoção (GET públicos, só leitura).
export function evaluatePostcheck({ plan, release, sales }) {
  const errors = [];
  const r = releaseInfo(release);
  if (!r.commit_sha) errors.push("release_commit_sha_missing");
  else if (plan && plan.commit_sha && r.commit_sha !== plan.commit_sha) errors.push("release_commit_changed_during_cleanup");
  if (r.sales_mode !== "globally-blocked") errors.push("release_sales_mode_not_globally_blocked");
  if (!sales || typeof sales !== "object" || sales.open !== false) errors.push("sales_status_open_not_false");
  return { ok: errors.length === 0, errors, commit_sha: r.commit_sha, sales_mode: r.sales_mode };
}

function arg(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
const args = (argv, flag) => argv.flatMap((a, i) => (a === flag && i + 1 < argv.length ? [argv[i + 1]] : []));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
function need(argv, flag) { const v = arg(argv, flag); if (!v) throw new InputError("missing_" + flag); return v; }
const optJson = (argv, flag) => { const p = arg(argv, flag); if (!p) return null; try { return readJson(p); } catch { return null; } };
const list = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
const readSnap = (argv) => snapshot({ secretList: readJson(need(argv, "--secrets")), settings: readJson(need(argv, "--settings")),
  deployments: readJson(need(argv, "--deployments")), version: readJson(need(argv, "--version-detail")), release: optJson(argv, "--release") });

export function cli(argv, log = console.log) {
  const [cmd] = argv;
  try {
    if (cmd === "readback") {
      const settingsPath = arg(argv, "--settings"), depPath = arg(argv, "--deployments"), verPath = arg(argv, "--version-detail");
      const snap = snapshot({ secretList: readJson(need(argv, "--secrets")), settings: settingsPath ? readJson(settingsPath) : null,
        deployments: depPath ? readJson(depPath) : null, version: verPath ? readJson(verPath) : null, release: optJson(argv, "--release") });
      const secretNames = snap.secretEntries.map((e) => e.name), bindingNames = snap.bindingNames;
      for (const e of snap.entries) log(`INVENTORY_ENTRY origin=${e.origin} type=${e.type} name=${e.name}`);
      log(`INVENTORY_COUNT=${snap.entries.length}`);
      if (snap.effective) {
        log(`EFFECTIVE_DEPLOYMENT id=${snap.effective.deployment_id} versions=${snap.effective.versions.map((v) => `${v.id}@${v.pct}`).join(",")} previous=${snap.effective.previous ?? "nenhuma"}`);
        log(`EFFECTIVE_VERSION_ID=${snap.effective.id}`);
      }
      if (snap.detail) log(`EFFECTIVE_VERSION_DETAIL number=${snap.detail.number ?? "indisponível"} workers_tag=${snap.detail.tag ?? "indisponível"} triggered_by=${snap.detail.trigger ?? "indisponível"} script_etag=${snap.detail.code.etag.replace(/[^\w-]/g, "").slice(0, 80)}`);
      log(`DEPLOYED_COMMIT_SHA=${snap.commit ?? "indisponível"}`);
      if (settingsPath) {
        const p = snap.preview;
        if (!p.ok) log(`PLANNED_ERROR ${p.error}`);
        for (const n of p.toDelete) log(`PLANNED_DELETE ${n}`);
        for (const n of p.absent || []) log(`PLANNED_ALREADY_ABSENT ${n}`);
        for (const n of p.kept || []) log(`PLANNED_KEEP ${n} ${snap.entries.filter((e) => e.name === n).map((e) => `${e.origin}:${e.type}`).join(",")}`);
      }
      log(`INVENTORY_SCHEMA=${INVENTORY_SCHEMA}`);
      log(`INVENTORY_DOCUMENT=${canonicalJson(snap.doc)}`);
      log(`INVENTORY_DIGEST=${snap.digest}`);
      const registry = loadDebt(arg(argv, "--debt") || DEFAULT_DEBT_FILE);
      const r = evaluateReadback({ secretNames, bindingNames, strict: argv.includes("--strict"), debt: registry });
      for (const v of r.violations) log(`::error title=PRODUCTION_TEST_SECRET_PRESENT::${v.name} (${v.source})`);
      for (const v of r.debt) log(`::warning title=LOAD_BEARING_DEBT::${v.name} (${v.source}): ${registry.names[v.name]}`);
      for (const id of r.openDebt) log(`::error title=R9_DEBT_OPEN::${id} pendente em ops/r9-debt.json`);
      log(`PRODUCTION_TEST_SECRET_READBACK=${r.ok ? "PASS" : "FAIL"} names=${r.total} violations=${r.violations.length} debt=${r.debt.length} open_debt=${r.openDebt.length} digest=${snap.digest}`);
      return r.ok ? 0 : 1;
    }
    if (cmd === "plan") {
      const settings = readJson(need(argv, "--settings"));
      const snap = readSnap(argv);
      const out = need(argv, "--out");
      const target = proveTarget(settings);
      log(`TARGET account=${TARGET.account} script=${TARGET.script} deployment_env=${target.deployment_env}`);
      if (!target.ok) { log("::error title=CLEANUP_REFUSED::alvo não provado como produção"); return 1; }
      log(`INVENTORY_DIGEST=${snap.digest}`);
      log(`EFFECTIVE_VERSION_ID=${snap.effective.id}`);
      const bound = checkBinding({ digest: snap.digest, expectedDigest: arg(argv, "--expected-digest"), effective: snap.effective, expectedVersion: arg(argv, "--expected-version") });
      if (!bound.ok) { log(`::error title=CLEANUP_REFUSED::${bound.error}: o estado do Worker não é o do inventário aprovado; rode o readback de novo e peça nova revisão`); return 1; }
      if (!snap.effective.single) { log("::error title=CLEANUP_REFUSED::rollout gradual em curso (não há uma versão única a 100%)"); return 1; }
      const p = planRemoval({ confirmation: arg(argv, "--confirmation"), secretNames: snap.secretEntries.map((e) => e.name), bindingNames: snap.bindingNames });
      if (!p.ok) { log(`::error title=CLEANUP_REFUSED::${p.error}; digite exatamente ${CONFIRMATION_PHRASE}`); return 1; }
      for (const n of p.toDelete) log(`DELETE ${n}`);
      for (const n of p.absent) log(`ALREADY_ABSENT ${n}`);
      for (const n of p.kept) log(`KEEP ${n}`);
      for (const n of p.debt) log(`::warning title=LOAD_BEARING_DEBT_KEPT::${n}: ${loadDebt().names[n]}`);
      const chain = stateChain(snap.doc, p.toDelete);
      if (chain[0].digest !== snap.digest) { log("::error title=CLEANUP_REFUSED::S0 recalculado difere do digest aprovado"); return 1; }
      for (const s of chain) log(`STATE_DIGEST ${s.state}=${s.digest} removed=${s.removed.join(",") || "-"}`);
      writeFileSync(out, JSON.stringify({ schema: INVENTORY_SCHEMA, toDelete: p.toDelete, kept: p.kept, digest: snap.digest, chain, document: snap.doc, version: snap.effective.id, commit_sha: snap.commit, entries: snap.entries, code: snap.detail.code, config: snap.detail.config, settings_hash: snap.settingsHash }));
      log(`CLEANUP_PLAN=OK delete=${p.toDelete.length} keep=${p.kept.length} absent=${p.absent.length} version=${snap.effective.id} commit=${snap.commit ?? "indisponível"}`);
      return 0;
    }
    if (cmd === "preflight") {
      const plan = planOf(readJson(need(argv, "--plan")));
      const effective = effectiveDeployment(readJson(need(argv, "--deployments")));
      const watched = loadMatrix(readJson(arg(argv, "--matrix") || DEFAULT_MATRIX_FILE));
      const r = evaluatePreflight({ listings: args(argv, "--runs").map(readJson), watched, selfRunId: need(argv, "--self-run-id"), plan, effective });
      log(`WATCHED_PUBLISHERS group=${watched.group} unserialized=${watched.unserialized.join(",") || "nenhum"} ${watched.files.join(",")}`);
      for (const a of r.active) log(`::error title=CLEANUP_REFUSED_CONCURRENT::${a.workflow} run ${a.id} ${a.status}`);
      if (r.truncated) log("::error title=CLEANUP_REFUSED_CONCURRENT::lista de runs truncada; não dá para provar ausência de concorrência");
      if (r.versionChanged) log(`::error title=CLEANUP_REFUSED_VERSION::versão efetiva ${effective.id} ≠ ${plan.version} do plano`);
      log(`CLEANUP_PREFLIGHT=${r.ok ? "PASS" : "FAIL"} active=${r.active.length} truncated=${r.truncated} version=${effective.id}`);
      return r.ok ? 0 : 1;
    }
    if (cmd === "step") {
      const plan = readJson(need(argv, "--plan"));
      const snap = readSnap(argv);
      const phase = need(argv, "--phase"), name = need(argv, "--name");
      const r = stepCheck({ plan, phase, name, deleted: list(arg(argv, "--deleted")), expectedVersion: arg(argv, "--expected-version"), snap });
      if (r.c) {
        for (const n of r.c.stillPresent) log(`STEP_STILL_PRESENT ${n}`);
        for (const n of r.c.lost) log(`STEP_MISSING ${n}`);
        for (const n of r.c.added) log(`STEP_ADDED ${n}`);
        for (const t of r.c.typeChanged) log(`STEP_TYPE_CHANGED ${t}`);
      }
      for (const e of r.errors) log(`${e.startsWith("CONCURRENT_CHANGE") ? "::error title=CONCURRENT_CHANGE::" : "STEP_ERROR "}${e}`);
      const outVersion = arg(argv, "--out-version");
      if (r.ok && outVersion) writeFileSync(outVersion, snap.effective.id);
      // Sol 194: prova de versão ligada a cada transição (V antes/depois), separada do digest lógico.
      if (r.ok && phase === "post") log(`TRANSITION ${r.from}->${r.state} name=${name} digest_before=${plan.chain[list(arg(argv, "--deleted")).length].digest} digest_after=${r.live} version_before=${arg(argv, "--expected-version")} version_after=${snap.effective.id} code=preserved`);
      log(`CLEANUP_STEP phase=${phase} name=${name} expected_state=${r.state ?? "-"} ${r.ok ? "OK" : "FAIL " + r.error} version=${snap.effective ? snap.effective.id : "indisponível"} digest=${r.live ?? "indisponível"}`);
      return r.ok ? 0 : 1;
    }
    if (cmd === "partial") {
      const reason = String(arg(argv, "--reason") || "desconhecido").replace(/[^\w:.-]/g, "").slice(0, 80);
      let rep = null;
      try {
        const plan = planOf(readJson(need(argv, "--plan")));
        const entries = buildInventory({ secretEntries: entriesFromSecretList(readJson(need(argv, "--secrets"))), bindingNames: namesFromSettings(readJson(need(argv, "--settings"))) });
        let effective = null;
        try { effective = effectiveDeployment(readJson(need(argv, "--deployments"))); } catch { effective = null; }
        rep = partialReport({ plan, entries, effective });
      } catch { rep = null; }
      if (!rep) log("CLEANUP_PARTIAL state=unknown (relistagem indisponível; rode o readback antes de qualquer outra ação)");
      else {
        for (const p of rep.planned) log(`CLEANUP_PARTIAL name=${p.name} state=${p.state}`);
        for (const n of rep.keptMissing) log(`CLEANUP_PARTIAL kept_missing=${n}`);
        log(`CLEANUP_PARTIAL effective_version=${rep.version ?? "indisponível"}`);
      }
      log(`::error title=CLEANUP_PARTIAL::parou em ${reason}; estado preservado, nada foi recriado; rode o readback e leve ao auditor antes de qualquer nova tentativa`);
      log(`CLEANUP_PARTIAL=FAIL reason=${reason}`);
      return 1;
    }
    if (cmd === "verify") {
      const plan = planOf(readJson(need(argv, "--plan")));
      const v = verifyRemoval({ plan, snap: readSnap(argv) });
      for (const n of v.stillPresent) log(`::error title=TEST_SECRET_STILL_PRESENT::${n}`);
      for (const n of v.lostKept) log(`::error title=KEPT_NAME_MISSING::${n}`);
      for (const n of v.added) log(`::error title=ADDED_SINCE_PLAN::${n}`);
      for (const t of v.typeChanged) log(`::error title=KEPT_TYPE_CHANGED::${t}`);
      for (const e of v.errors) log(`::error title=CLEANUP_POSTPROOF::${e}`);
      const after = readSnap(argv);
      log(`CLEANUP_VERIFY=${v.ok ? "PASS" : "FAIL"} still_present=${v.stillPresent.length} lost=${v.lostKept.length} added=${v.added.length} type_changed=${v.typeChanged.length} postproof_errors=${v.errors.length} version_before=${plan.version} version_after=${after.effective ? after.effective.id : "indisponível"} digest=${liveDigest(after, plan)} expected=${plan.chain[plan.chain.length - 1].digest}`);
      return v.ok ? 0 : 1;
    }
    if (cmd === "postcheck") {
      const plan = readJson(need(argv, "--plan"));
      const r = evaluatePostcheck({ plan, release: optJson(argv, "--release"), sales: optJson(argv, "--sales") });
      for (const e of r.errors) log(`::error title=CLEANUP_POSTCHECK::${e}`);
      log(`CLEANUP_POSTCHECK=${r.ok ? "PASS" : "FAIL"} commit_sha=${r.commit_sha ?? "ausente"} sales_mode=${r.sales_mode ?? "ausente"}`);
      return r.ok ? 0 : 1;
    }
    if (cmd === "version-id") {
      const eff = effectiveDeployment(readJson(need(argv, "--deployments")));
      if (eff.single) log(eff.id);
      return 0;
    }
    throw new InputError("unknown_command");
  } catch (e) {
    log(`INPUT_INVALID ${e instanceof InputError ? e.message : (e?.name || "Error")}`);
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(cli(process.argv.slice(2)));
