// F2 item 9: readback de NOMES do Worker de produção e remoção dirigida dos segredos de teste
// (scripts/ci/production-secret-names.mjs; workflows production-test-secret-readback.yml e
// production-test-secret-cleanup.yml). Entradas no formato real: `wrangler secret list --format json` = [{name,type}];
// GET .../workers/scripts/zevanory/settings = {success,result:{bindings:[...]}}. O inventário de produção usado aqui é
// o confirmado pelo coordenador em 24/10 (só nomes). Marcadores [Nn.k].
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { readTextNormalized } from "./helpers/text.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli, evaluateReadback, namesFromSecretList, namesFromSettings, planRemoval, verifyRemoval, proveTarget,
  CONFIRMATION_PHRASE, REMOVAL_ALLOWLIST, loadDebt } from "../scripts/ci/production-secret-names.mjs";

const VALUE = "VALOR-SINTETICO-QUE-NUNCA-PODE-APARECER-0123456789";
const list = (...names) => names.map((name) => ({ name, type: "secret_text" }));
const SECRETS_NOW = list("MERCADOPAGO_ACCESS_TOKEN", "MERCADOPAGO_WEBHOOK_SECRET", "DATABASE_URL", "OPERATOR_TOKEN",
  "CERTIFICATION_E2E_TOKEN", "MERCADOPAGO_TEST_ACCESS_TOKEN", "MERCADOPAGO_TEST_WEBHOOK_SECRET");
const plain = (name, text = VALUE) => ({ name, type: "plain_text", text });
const settings = ({ env = "production", extra = [], config = { CHECKOUT_ENABLED: "true" } } = {}) => ({ success: true, result: { bindings: [
  plain("ZEVANORY_DEPLOYMENT_ENV", env), plain("PUBLIC_BASE_URL"),
  plain("CERTIFICATION_PILOT_APPROVER"), plain("CERTIFICATION_PILOT_ENABLED", "true"), plain("CERTIFICATION_PILOT_ENV", "sandbox"),
  plain("CERTIFICATION_PILOT_PRODUCTION_ALLOWED", "false"),
  { name: "ZEVANORY_RUNTIME_CONFIG", type: "json", json: config }, { name: "ZEVANORY_PRIVATE_ARTIFACTS", type: "kv_namespace" },
  ...SECRETS_NOW.map((s) => ({ name: s.name, type: "secret_text" })), ...extra] } });
const SEVEN = ["MERCADOPAGO_TEST_ACCESS_TOKEN", "MERCADOPAGO_TEST_WEBHOOK_SECRET", "CERTIFICATION_E2E_TOKEN", "CERTIFICATION_PILOT_APPROVER",
  "CERTIFICATION_PILOT_ENABLED", "CERTIFICATION_PILOT_ENV", "CERTIFICATION_PILOT_PRODUCTION_ALLOWED"];

function runCli(args, files) {
  const dir = mkdtempSync(join(tmpdir(), "zev-secret-names-"));
  const paths = { out: join(dir, "plan-out.json") };
  for (const [k, v] of Object.entries(files)) { paths[k] = join(dir, k + ".json"); writeFileSync(paths[k], typeof v === "string" ? v : JSON.stringify(v)); }
  const lines = [];
  try {
    const code = cli(args.map((a) => (a.startsWith("@") ? paths[a.slice(1)] : a)), (l) => lines.push(String(l)));
    const plan = existsSync(paths.out) ? JSON.parse(readTextNormalized(paths.out)) : null;
    return { code, out: lines.join("\n"), plan };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const DEBT = loadDebt();
const CERT_DEBT = Object.keys(DEBT.names).filter((n) => n.startsWith("CERTIFICATION")).sort();
const EMPTY_DEBT = Object.freeze({ pending: [], names: {} });
const inv = () => ({ secretNames: namesFromSecretList(SECRETS_NOW), bindingNames: namesFromSettings(settings()) });

test("N1 readback do estado atual: os 2 segredos de teste reprovam; os 5 CERTIFICATION* lidos pela produção viram dívida relatada", () => {
  const r = evaluateReadback(inv());
  assert.equal(r.ok, false, "[N1.1] estado de 24/10 reprova");
  assert.deepEqual([...new Set(r.violations.map((v) => v.name))].sort(), ["MERCADOPAGO_TEST_ACCESS_TOKEN", "MERCADOPAGO_TEST_WEBHOOK_SECRET"], "[N1.1] só os de teste reprovam");
  assert.deepEqual([...new Set(r.debt.map((v) => v.name))].sort(), CERT_DEBT, "[N1.2] os 5 CERTIFICATION* aparecem como dívida");
  assert.deepEqual([...SEVEN].sort(), [...REMOVAL_ALLOWLIST, ...CERT_DEBT].sort(), "[N1.2] os 7 do inventário = remoção + dívida, sem sobra");
  const other = evaluateReadback({ secretNames: ["CERTIFICATION_DATABASE_URL", "STRIPE_TEST_KEY_X"] });
  assert.deepEqual(other.violations.map((v) => v.name), ["CERTIFICATION_DATABASE_URL", "STRIPE_TEST_KEY_X"], "[N1.3] qualquer outro CERTIFICATION/_TEST_ reprova (a dívida não é curinga)");
});

test("N2 modo estrito reprova a dívida e reprova enquanto ops/r9-debt.json tiver item pendente", () => {
  const after = evaluateReadback({ secretNames: namesFromSecretList(SECRETS_NOW).filter((n) => !REMOVAL_ALLOWLIST.includes(n)), bindingNames: namesFromSettings(settings()).filter((b) => !REMOVAL_ALLOWLIST.includes(b.name)) });
  assert.equal(after.ok, true, "[N2.1] depois da remoção, modo normal passa");
  const strict = evaluateReadback({ secretNames: ["CERTIFICATION_E2E_TOKEN"], bindingNames: [{ name: "CERTIFICATION_PILOT_ENV", type: "plain_text", source: "binding" }], strict: true });
  assert.deepEqual(strict.violations.map((v) => v.name), ["CERTIFICATION_E2E_TOKEN", "CERTIFICATION_PILOT_ENV"], "[N2.2] estrito reprova a dívida");
  const clean = { secretNames: ["MERCADOPAGO_ACCESS_TOKEN"], bindingNames: [], strict: true };
  const open = evaluateReadback({ ...clean, debt: DEBT });
  assert.equal(open.ok, false, "[N2.3] sem nome proibido, estrito ainda falha com a dívida aberta");
  assert.deepEqual(open.openDebt, DEBT.pending.map((e) => e.id), "[N2.3] lista os itens pendentes");
  assert.equal(evaluateReadback({ ...clean, debt: EMPTY_DEBT }).ok, true, "[N2.4] dívida vazia e nomes limpos: estrito passa");
});

test("N3 bindings e chaves do ZEVANORY_RUNTIME_CONFIG contam; valores nunca são impressos", () => {
  const b = namesFromSettings(settings({ config: { MERCADOPAGO_TEST_WEBHOOK_SECRET: VALUE }, extra: [{ name: "CERTIFICATION_D1", type: "d1" }] }));
  const r = evaluateReadback({ secretNames: [], bindingNames: b });
  assert.ok(r.violations.some((v) => v.source === "ZEVANORY_RUNTIME_CONFIG" && v.name === "MERCADOPAGO_TEST_WEBHOOK_SECRET"), "[N3.1] chave da config conta");
  assert.ok(r.violations.some((v) => v.source === "binding" && v.name === "CERTIFICATION_D1"), "[N3.1] binding conta");
  const res = runCli(["readback", "--secrets", "@l", "--settings", "@s"], { l: SECRETS_NOW, s: settings({ config: { X: VALUE } }) });
  assert.equal(res.code, 1, "[N3.2] CLI falha com os segredos de teste presentes");
  assert.match(res.out, /^PRODUCTION_TEST_SECRET_READBACK=FAIL /m, "[N3.2] veredito");
  assert.ok(!res.out.includes(VALUE), "[N3.3] nenhum valor aparece (texto de var, config)");
  const plan = runCli(["plan", "--secrets", "@l", "--settings", "@s", "--confirmation", CONFIRMATION_PHRASE, "--out", "@out"], { l: SECRETS_NOW, s: settings() });
  assert.ok(!plan.out.includes(VALUE) && !JSON.stringify(plan.plan).includes(VALUE), "[N3.3] plano não imprime nem grava valor");
});

test("N4 entrada inválida falha fechado (código 2), nunca PASS", () => {
  assert.equal(runCli(["readback", "--secrets", "@l"], { l: { secrets: [] } }).code, 2, "[N4.1] lista que não é array");
  assert.equal(runCli(["readback", "--secrets", "@l"], { l: "not json" }).code, 2, "[N4.1] JSON ilegível");
  assert.equal(runCli(["readback", "--secrets", "@l", "--settings", "@s"], { l: [], s: { success: false } }).code, 2, "[N4.2] settings sem success");
  assert.equal(runCli(["readback", "--secrets", "@l"], { l: [{ name: "BAD NAME;rm" }] }).code, 2, "[N4.3] nome fora do formato");
  assert.equal(runCli(["plan", "--secrets", "@l", "--confirmation", CONFIRMATION_PHRASE, "--out", "@out"], { l: SECRETS_NOW }).code, 2, "[N4.3] plano sem settings");
});

test("N5 plano: confirmação exata, alvo provado, diff impresso e apagado ⊆ allowlist ∩ presentes", () => {
  for (const typed of ["", "sim", "MERCADOPAGO_TEST_ACCESS_TOKEN", "MERCADOPAGO_TEST_WEBHOOK_SECRET,MERCADOPAGO_TEST_ACCESS_TOKEN",
    " MERCADOPAGO_TEST_ACCESS_TOKEN,MERCADOPAGO_TEST_WEBHOOK_SECRET", "MERCADOPAGO_TEST_ACCESS_TOKEN, MERCADOPAGO_TEST_WEBHOOK_SECRET",
    SEVEN.join(","), "mercadopago_test_access_token,mercadopago_test_webhook_secret", undefined]) {
    const p = planRemoval({ confirmation: typed, ...inv() });
    assert.equal(p.ok, false, "[N5.1] confirmação diferente recusa: " + JSON.stringify(typed));
    assert.deepEqual(p.toDelete, [], "[N5.1] recusa não planeja nada");
  }
  const p = planRemoval({ confirmation: CONFIRMATION_PHRASE, ...inv() });
  assert.equal(CONFIRMATION_PHRASE, "MERCADOPAGO_TEST_ACCESS_TOKEN,MERCADOPAGO_TEST_WEBHOOK_SECRET", "[N5.2] frase = nomes exatos");
  assert.deepEqual(p.toDelete, ["MERCADOPAGO_TEST_ACCESS_TOKEN", "MERCADOPAGO_TEST_WEBHOOK_SECRET"], "[N5.2] apaga só a allowlist presente");
  const all = new Set([...inv().secretNames, ...inv().bindingNames.map((b) => b.name)]);
  assert.deepEqual(p.kept, [...all].filter((n) => !REMOVAL_ALLOWLIST.includes(n)).sort(), "[N5.2] mantém TODO o resto (inclusive os 5 CERTIFICATION*)");
  for (const n of CERT_DEBT) assert.ok(p.kept.includes(n) && !p.toDelete.includes(n), "[N5.2] dívida nunca é apagada: " + n);
  const partial = planRemoval({ confirmation: CONFIRMATION_PHRASE, secretNames: ["MERCADOPAGO_TEST_WEBHOOK_SECRET", "X_KEEP"], bindingNames: [] });
  assert.deepEqual([partial.toDelete, partial.absent, partial.kept], [["MERCADOPAGO_TEST_WEBHOOK_SECRET"], ["MERCADOPAGO_TEST_ACCESS_TOKEN"], ["X_KEEP"]], "[N5.3] ausente não é apagado (relatado)");
  const asVar = planRemoval({ confirmation: CONFIRMATION_PHRASE, secretNames: [], bindingNames: [{ name: "MERCADOPAGO_TEST_ACCESS_TOKEN", type: "plain_text", source: "binding" }] });
  assert.equal(asVar.error, "allowlisted_name_is_not_a_secret", "[N5.4] nome da allowlist que não é segredo: recusa (secret delete não o remove)");
  const wrongTarget = runCli(["plan", "--secrets", "@l", "--settings", "@s", "--confirmation", CONFIRMATION_PHRASE, "--out", "@out"], { l: SECRETS_NOW, s: settings({ env: "certification" }) });
  assert.equal(wrongTarget.code, 1, "[N5.5] alvo que não prova ZEVANORY_DEPLOYMENT_ENV=production recusa");
  assert.equal(wrongTarget.plan, null, "[N5.5] e não grava plano");
  assert.equal(proveTarget(settings()).ok, true, "[N5.5] produção provada");
  const ok = runCli(["plan", "--secrets", "@l", "--settings", "@s", "--confirmation", CONFIRMATION_PHRASE, "--out", "@out"], { l: SECRETS_NOW, s: settings() });
  assert.equal(ok.code, 0, "[N5.6] CLI planeja");
  assert.deepEqual(ok.out.split("\n").filter((l) => l.startsWith("DELETE ")), ["DELETE MERCADOPAGO_TEST_ACCESS_TOKEN", "DELETE MERCADOPAGO_TEST_WEBHOOK_SECRET"], "[N5.6] diff: exatamente dois DELETE");
  assert.deepEqual(ok.out.split("\n").filter((l) => l.startsWith("KEEP ")).map((l) => l.slice(5)), p.kept, "[N5.6] diff: lista KEEP completa impressa antes");
  assert.deepEqual(ok.plan, { toDelete: p.toDelete, kept: p.kept }, "[N5.6] plano gravado = diff impresso");
  const refused = runCli(["plan", "--secrets", "@l", "--settings", "@s", "--confirmation", "sim", "--out", "@out"], { l: SECRETS_NOW, s: settings() });
  assert.ok(refused.code === 1 && !/^DELETE /m.test(refused.out) && refused.plan === null, "[N5.6] recusa sem DELETE e sem plano");
});

test("N6 readback pós-remoção: allowlist ausente E todo outro nome do pré-inventário presente", () => {
  const p = planRemoval({ confirmation: CONFIRMATION_PHRASE, ...inv() });
  const afterSecrets = namesFromSecretList(SECRETS_NOW).filter((n) => !REMOVAL_ALLOWLIST.includes(n));
  const afterBindings = namesFromSettings(settings()).filter((b) => !REMOVAL_ALLOWLIST.includes(b.name));
  assert.deepEqual(verifyRemoval({ plan: p, secretNames: afterSecrets, bindingNames: afterBindings }), { ok: true, stillPresent: [], lostKept: [], added: [] }, "[N6.1] remoção exata passa");
  const still = verifyRemoval({ plan: p, ...inv() });
  assert.deepEqual([still.ok, still.stillPresent], [false, [...REMOVAL_ALLOWLIST]], "[N6.2] segredo de teste ainda presente reprova");
  const lost = verifyRemoval({ plan: p, secretNames: afterSecrets.filter((n) => n !== "DATABASE_URL"), bindingNames: afterBindings.filter((b) => b.name !== "DATABASE_URL" && b.name !== "CERTIFICATION_PILOT_ENABLED") });
  assert.deepEqual([lost.ok, lost.lostKept], [false, ["CERTIFICATION_PILOT_ENABLED", "DATABASE_URL"]], "[N6.3] qualquer outro nome sumido reprova");
  const res = runCli(["verify", "--plan", "@p", "--secrets", "@l", "--settings", "@s"], { p, l: SECRETS_NOW, s: settings() });
  assert.equal(res.code, 1, "[N6.2] CLI código 1");
  assert.equal(runCli(["verify", "--plan", "@p", "--secrets", "@l", "--settings", "@s"], { p: { kept: "x" }, l: [], s: settings() }).code, 2, "[N6.4] plano inválido: código 2");
});

test("N7 ops/r9-debt.json: os 5 CERTIFICATION* e o Stripe nomeados com dono, motivo e PR planejado; CLI estrito falha", () => {
  const reg = JSON.parse(readTextNormalized(new URL("../ops/r9-debt.json", import.meta.url)));
  assert.deepEqual(reg.pending.map((e) => e.name).sort(), [...CERT_DEBT, "STRIPE_SECRET_KEY"].sort(), "[N7.1] itens nomeados");
  for (const e of reg.pending) for (const f of ["id", "owner", "reason", "planned_pr"]) assert.ok(String(e[f] || "").trim().length >= 5, `[N7.1] ${e.name}.${f}`);
  const strict = runCli(["readback", "--secrets", "@l", "--strict"], { l: list("MERCADOPAGO_ACCESS_TOKEN") });
  assert.equal(strict.code, 1, "[N7.2] CLI estrito falha com a dívida aberta");
  assert.match(strict.out, /^::error title=R9_DEBT_OPEN::R9-D1 /m, "[N7.2] cita o item pendente");
  const emptied = runCli(["readback", "--secrets", "@l", "--strict", "--debt", "@d"], { l: list("MERCADOPAGO_ACCESS_TOKEN"), d: { pending: [] } });
  assert.equal(emptied.code, 0, "[N7.3] com a dívida vazia o estrito passa");
  assert.equal(runCli(["readback", "--secrets", "@l", "--debt", "@d"], { l: [], d: { pending: [{ id: "X", name: "Y" }] } }).code, 2, "[N7.4] registro sem motivo/PR: código 2");
});
