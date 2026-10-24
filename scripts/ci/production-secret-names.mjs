#!/usr/bin/env node
// ZEVANORY | Nomes de segredos/bindings do Worker de produção `zevanory`: readback e remoção dirigida dos segredos de
// teste (F2 item 9; roteiro 3.1 seção 7). Usado por production-test-secret-readback.yml e
// production-test-secret-cleanup.yml. Só NOMES: `wrangler secret list --format json` = [{name,type}];
// GET /accounts/{id}/workers/scripts/{script}/settings = {success,result:{bindings:[...]}}. Dos bindings só se lê nome,
// tipo, as CHAVES do json ZEVANORY_RUNTIME_CONFIG e o texto de ZEVANORY_DEPLOYMENT_ENV (prova do alvo, não é segredo).
// Nenhum valor é impresso.
// Referências (24/10/2026; fonte do wrangler em cloudflare/workers-sdk@ac795396, packages/wrangler/src/secret/index.ts):
// `secret list --format json` imprime JSON.stringify([{name,type}]); `secret delete <KEY> --name <worker>` chama
// DELETE /accounts/{id}/workers/scripts/{worker}/secrets/{KEY} e, fora de terminal interativo, confirma sozinho
// (dialogs.ts, fallbackValue = true). `secret delete` só remove segredos: var de texto (plain_text) não sai por ele.
//
// Desenho (Sol): alvo provado; diff esperado impresso ANTES (apagar x manter); conjunto apagado ⊆ allowlist ∩ presentes;
// confirmação digitada = nomes exatos; readback depois (allowlist ausente E todo outro nome do pré-inventário presente);
// qualquer divergência falha fechado.
//
// CLI (0 = PASS, 1 = FAIL/recusa, 2 = entrada inválida):
//   readback --secrets LIST.json [--settings SETTINGS.json] [--strict]
//   plan     --secrets LIST.json --settings SETTINGS.json --confirmation "<texto>" --out PLAN.json
//   verify   --plan PLAN.json --secrets LIST.json --settings SETTINGS.json
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const TARGET = Object.freeze({ account: "1b26415802588185a86c1d4d3ebf5bdb", script: "zevanory", environment: "production" });
// Regra do readback: nenhum nome contendo _TEST_ ou CERTIFICATION no Worker de produção.
export const FORBIDDEN_IN_PRODUCTION = /_TEST_|CERTIFICATION/;
// Remoção: SÓ estes nomes. Seguros de remover: a produção nunca os lê fora da rota mercadopago_test / piloto sandbox
// (tests/production-payment-credential-isolation.test.mjs P1-P6) e nenhum deploy os regrava.
export const REMOVAL_ALLOWLIST = Object.freeze(["MERCADOPAGO_TEST_ACCESS_TOKEN", "MERCADOPAGO_TEST_WEBHOOK_SECRET"]);
export const CONFIRMATION_PHRASE = REMOVAL_ALLOWLIST.join(",");
// Nomes CERTIFICATION* presentes na produção que NÃO podem sair sem mudança de código/contrato (dívida conhecida).
// O readback os relata sempre; --strict os reprova. Nunca entram na remoção.
export const LOAD_BEARING_DEBT = Object.freeze({
  CERTIFICATION_E2E_TOKEN: "token de operador da produção: backup, voz, WhatsApp, auditoria financeira autenticam com ele e central-production-deploy.yml recusa o deploy sem ele",
  CERTIFICATION_PILOT_ENABLED: "var de texto do painel (secret delete não remove); liga o piloto sandbox DENTRO da produção (resolveCheckoutProviderRequest/certificationPilotPolicy). Remover é fail-closed (FAIL_CLOSED_RUNTIME_FLAGS => false) e é o alvo do item 9, mas desliga fluxos que ainda usam o piloto em produção (financial-e2e-stripe): decisão do proprietário",
  CERTIFICATION_PILOT_ENV: "gravado a cada deploy por prepare-central-candidate.py e EXIGIDO =sandbox por verify-financial-boundary.py; apagar no painel volta no próximo deploy",
  CERTIFICATION_PILOT_PRODUCTION_ALLOWED: "gravado =false a cada deploy e EXIGIDO por verify-financial-boundary.py (trava explícita do piloto em produção)",
  CERTIFICATION_PILOT_APPROVER: "gravado a cada deploy por prepare-central-candidate.py; lido pelas operações de convite do piloto",
});
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export class InputError extends Error {}

export function namesFromSecretList(data) {
  if (!Array.isArray(data)) throw new InputError("secret_list_not_array");
  return data.map((item) => {
    const name = item && typeof item === "object" ? item.name : undefined;
    if (typeof name !== "string" || !NAME.test(name)) throw new InputError("secret_list_invalid_name");
    return name;
  });
}

function bindingsOf(data) {
  if (!data || typeof data !== "object" || data.success !== true) throw new InputError("settings_not_success");
  const bindings = data.result?.bindings;
  if (!Array.isArray(bindings)) throw new InputError("settings_without_bindings");
  for (const b of bindings) if (!b || typeof b !== "object" || typeof b.name !== "string" || !NAME.test(b.name)) throw new InputError("settings_invalid_binding_name");
  return bindings;
}

export function namesFromSettings(data) {
  const out = [];
  for (const b of bindingsOf(data)) {
    out.push({ name: b.name, type: String(b.type || "").replace(/[^a-z_]/g, "").slice(0, 32), source: "binding" });
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

// Prova do alvo: o settings lido (da URL fixa account/script) é do Worker de produção.
export function proveTarget(data) {
  const env = bindingsOf(data).find((b) => b.name === "ZEVANORY_DEPLOYMENT_ENV");
  const value = env && env.type === "plain_text" ? String(env.text ?? "") : "";
  return { ok: value === TARGET.environment, deployment_env: value === TARGET.environment ? value : (env ? "outro" : "ausente") };
}

export function evaluateReadback({ secretNames = [], bindingNames = [], strict = false } = {}) {
  const all = [...secretNames.map((name) => ({ name, type: "secret_text", source: "secret_list" })), ...bindingNames];
  const violations = [], debt = [];
  for (const entry of all) {
    if (!FORBIDDEN_IN_PRODUCTION.test(entry.name)) continue;
    if (!strict && Object.hasOwn(LOAD_BEARING_DEBT, entry.name)) debt.push(entry);
    else violations.push(entry);
  }
  return { ok: violations.length === 0, violations, debt, total: all.length };
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
  const debt = Object.keys(LOAD_BEARING_DEBT).filter((n) => present.has(n));
  return { ok: true, toDelete, kept, absent, debt };
}

export function verifyRemoval({ plan, secretNames, bindingNames }) {
  if (!plan || !Array.isArray(plan.toDelete) || !Array.isArray(plan.kept)) throw new InputError("plan_invalid");
  const after = inventory(secretNames, bindingNames);
  const stillPresent = REMOVAL_ALLOWLIST.filter((n) => after.has(n));
  const lostKept = plan.kept.filter((n) => !after.has(n));
  const added = [...after].filter((n) => !plan.kept.includes(n) && !REMOVAL_ALLOWLIST.includes(n)).sort();
  return { ok: stillPresent.length === 0 && lostKept.length === 0, stillPresent, lostKept, added };
}

function arg(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
function need(argv, flag) { const v = arg(argv, flag); if (!v) throw new InputError("missing_" + flag); return v; }

export function cli(argv, log = console.log) {
  const [cmd] = argv;
  try {
    const secretNames = namesFromSecretList(readJson(need(argv, "--secrets")));
    if (cmd === "readback") {
      const settingsPath = arg(argv, "--settings");
      const bindingNames = settingsPath ? namesFromSettings(readJson(settingsPath)) : [];
      for (const n of [...secretNames].sort()) log(`SECRET_NAME ${n}`);
      for (const b of bindingNames) log(`BINDING_NAME ${b.name} type=${b.type} source=${b.source}`);
      const r = evaluateReadback({ secretNames, bindingNames, strict: argv.includes("--strict") });
      for (const v of r.violations) log(`::error title=PRODUCTION_TEST_SECRET_PRESENT::${v.name} (${v.source})`);
      for (const v of r.debt) log(`::warning title=LOAD_BEARING_DEBT::${v.name} (${v.source}): ${LOAD_BEARING_DEBT[v.name]}`);
      log(`PRODUCTION_TEST_SECRET_READBACK=${r.ok ? "PASS" : "FAIL"} names=${r.total} violations=${r.violations.length} debt=${r.debt.length}`);
      return r.ok ? 0 : 1;
    }
    if (cmd === "plan") {
      const settings = readJson(need(argv, "--settings"));
      const out = need(argv, "--out");
      const target = proveTarget(settings);
      log(`TARGET account=${TARGET.account} script=${TARGET.script} deployment_env=${target.deployment_env}`);
      if (!target.ok) { log("::error title=CLEANUP_REFUSED::alvo não provado como produção"); return 1; }
      const p = planRemoval({ confirmation: arg(argv, "--confirmation"), secretNames, bindingNames: namesFromSettings(settings) });
      if (!p.ok) { log(`::error title=CLEANUP_REFUSED::${p.error}; digite exatamente ${CONFIRMATION_PHRASE}`); return 1; }
      for (const n of p.toDelete) log(`DELETE ${n}`);
      for (const n of p.absent) log(`ALREADY_ABSENT ${n}`);
      for (const n of p.kept) log(`KEEP ${n}`);
      for (const n of p.debt) log(`::warning title=LOAD_BEARING_DEBT_KEPT::${n}: ${LOAD_BEARING_DEBT[n]}`);
      writeFileSync(out, JSON.stringify({ toDelete: p.toDelete, kept: p.kept }));
      log(`CLEANUP_PLAN=OK delete=${p.toDelete.length} keep=${p.kept.length} absent=${p.absent.length}`);
      return 0;
    }
    if (cmd === "verify") {
      const v = verifyRemoval({ plan: readJson(need(argv, "--plan")), secretNames, bindingNames: namesFromSettings(readJson(need(argv, "--settings"))) });
      for (const n of v.stillPresent) log(`::error title=TEST_SECRET_STILL_PRESENT::${n}`);
      for (const n of v.lostKept) log(`::error title=KEPT_NAME_MISSING::${n}`);
      for (const n of v.added) log(`ADDED_SINCE_PLAN ${n}`);
      log(`CLEANUP_VERIFY=${v.ok ? "PASS" : "FAIL"} still_present=${v.stillPresent.length} lost=${v.lostKept.length}`);
      return v.ok ? 0 : 1;
    }
    throw new InputError("unknown_command");
  } catch (e) {
    log(`INPUT_INVALID ${e instanceof InputError ? e.message : (e?.name || "Error")}`);
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(cli(process.argv.slice(2)));
