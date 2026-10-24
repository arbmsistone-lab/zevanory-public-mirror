// F2 item 9: readback de NOMES do Worker de produção e remoção dirigida dos segredos de teste
// (scripts/ci/production-secret-names.mjs; workflows production-test-secret-readback.yml e
// production-test-secret-cleanup.yml). Entradas no formato real: `wrangler secret list --format json` = [{name,type}];
// GET .../workers/scripts/zevanory/settings = {success,result:{bindings:[...]}}; GET .../deployments e
// GET .../versions/{id} da Cloudflare; GET público /api/release e /api/sales/status. O inventário de produção usado
// aqui é o confirmado pelo coordenador em 24/10 (só nomes). Controles do auditor: Sol 187 C1-C5 (N8-N12) e
// Sol 189 A1-A3 (N10/N11/N12/N13). Marcadores [Nn.k].
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { readTextNormalized } from "./helpers/text.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli, evaluateReadback, namesFromSecretList, namesFromSettings, planRemoval, verifyRemoval, proveTarget,
  CONFIRMATION_PHRASE, REMOVAL_ALLOWLIST, loadDebt, snapshot, canonicalJson, inventoryDigest, checkBinding, loadMatrix,
  evaluatePreflight, stepCheck, evaluatePostcheck, diffConfig, liveDigest, validateEntries, INVENTORY_SCHEMA, TARGET } from "../scripts/ci/production-secret-names.mjs";

const VALUE = "VALOR-SINTETICO-QUE-NUNCA-PODE-APARECER-0123456789";
const list = (...names) => names.map((name) => ({ name, type: "secret_text" }));
const SECRETS_NOW = list("MERCADOPAGO_ACCESS_TOKEN", "MERCADOPAGO_WEBHOOK_SECRET", "DATABASE_URL", "OPERATOR_TOKEN",
  "CERTIFICATION_E2E_TOKEN", "MERCADOPAGO_TEST_ACCESS_TOKEN", "MERCADOPAGO_TEST_WEBHOOK_SECRET");
const plain = (name, text = VALUE) => ({ name, type: "plain_text", text });
const baseBindings = ({ env = "production", extra = [], config = { CHECKOUT_ENABLED: "true" }, secrets = SECRETS_NOW, varText = VALUE } = {}) => [
  plain("ZEVANORY_DEPLOYMENT_ENV", env), plain("PUBLIC_BASE_URL", varText),
  plain("CERTIFICATION_PILOT_APPROVER"), plain("CERTIFICATION_PILOT_ENABLED", "true"), plain("CERTIFICATION_PILOT_ENV", "sandbox"),
  plain("CERTIFICATION_PILOT_PRODUCTION_ALLOWED", "false"),
  { name: "ZEVANORY_RUNTIME_CONFIG", type: "json", json: config }, { name: "ZEVANORY_PRIVATE_ARTIFACTS", type: "kv_namespace", namespace_id: "kv1" },
  ...secrets.map((s) => ({ name: s.name, type: "secret_text" })), ...extra];
const settings = (o = {}) => ({ success: true, result: { bindings: baseBindings(o) } });
const SEVEN = ["MERCADOPAGO_TEST_ACCESS_TOKEN", "MERCADOPAGO_TEST_WEBHOOK_SECRET", "CERTIFICATION_E2E_TOKEN", "CERTIFICATION_PILOT_APPROVER",
  "CERTIFICATION_PILOT_ENABLED", "CERTIFICATION_PILOT_ENV", "CERTIFICATION_PILOT_PRODUCTION_ALLOWED"];
// Versões (UUID) e commit sintéticos.
const V0 = "00000000-0000-4000-8000-000000000000", V1 = "11111111-1111-4111-8111-111111111111", V2 = "22222222-2222-4222-8222-222222222222", VX = "99999999-9999-4999-8999-999999999999";
const SHA = "a".repeat(40), SHA2 = "b".repeat(40);
const deployments = (...chain) => ({ success: true, result: { deployments: chain.map((v, i) => ({ id: v.replace(/^./, "d"), created_on: `2026-10-${String(24 - i).padStart(2, "0")}T00:00:00Z`, versions: [{ version_id: v, percentage: 100 }] })) } });
const version = (id, bindings, { etag = "etag-code-1", trigger = "secret", flags = ["nodejs_compat"] } = {}) => ({ success: true, result: { id, number: 7,
  annotations: { "workers/triggered_by": trigger, "workers/tag": SHA }, resources: { bindings, script: { etag, handlers: ["fetch", "scheduled"] },
    script_runtime: { compatibility_date: "2025-01-01", compatibility_flags: flags, usage_model: "standard" } } } });
const release = (sha = SHA, mode = "globally-blocked") => ({ release_id: "R", sales_mode: mode, deployment: { commit_sha: sha } });
// Estado completo do Worker: o que production-worker-state.sh coleta.
function state({ removed = [], extra = [], chain = [V0], etag, trigger, commit = SHA, varText, secretsExtra = [], flags } = {}) {
  const secrets = [...SECRETS_NOW.filter((s) => !removed.includes(s.name)), ...secretsExtra];
  const bindings = baseBindings({ secrets, extra, varText });
  return { l: secrets, s: { success: true, result: { bindings } }, d: deployments(...chain), v: version(chain[0], bindings.map((b) => ({ ...b })), { etag, trigger, flags }), r: release(commit) };
}
// Muda o tipo de um binding nas duas fontes (settings e versão efetiva), como a Cloudflare mostraria.
function retype(st, name, type) {
  for (const list of [st.s.result.bindings, st.v.result.resources.bindings]) for (const b of list) if (b.name === name) b.type = type;
  return st;
}
const snapOf = (st) => snapshot({ secretList: st.l, settings: st.s, deployments: st.d, version: st.v, release: st.r });
const ST = ["--secrets", "@l", "--settings", "@s", "--deployments", "@d", "--version-detail", "@v", "--release", "@r"];

function runCli(args, files) {
  const dir = mkdtempSync(join(tmpdir(), "zev-secret-names-"));
  const paths = { out: join(dir, "plan-out.json"), ver: join(dir, "ver.txt") };
  for (const [k, v] of Object.entries(files)) { paths[k] = join(dir, k + ".json"); writeFileSync(paths[k], typeof v === "string" ? v : JSON.stringify(v)); }
  const lines = [];
  try {
    const code = cli(args.map((a) => (a.startsWith("@") ? paths[a.slice(1)] : a)), (l) => lines.push(String(l)));
    const plan = existsSync(paths.out) ? JSON.parse(readTextNormalized(paths.out)) : null;
    const ver = existsSync(paths.ver) ? readTextNormalized(paths.ver) : null;
    return { code, out: lines.join("\n"), plan, ver };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const DEBT = loadDebt();
const CERT_DEBT = Object.keys(DEBT.names).filter((n) => n.startsWith("CERTIFICATION")).sort();
const EMPTY_DEBT = Object.freeze({ pending: [], names: {} });
const inv = () => ({ secretNames: namesFromSecretList(SECRETS_NOW), bindingNames: namesFromSettings(settings()) });
const S0 = () => state();
const DIGEST0 = () => snapOf(S0()).digest;
function makePlan(st = S0(), extra = []) {
  const r = runCli(["plan", ...ST, "--confirmation", CONFIRMATION_PHRASE, "--expected-digest", snapOf(st).digest, "--expected-version", snapOf(st).effective.id, ...extra, "--out", "@out"], st);
  assert.equal(r.code, 0, "[N0.1] plano de referência: " + r.out.slice(-300));
  return r.plan;
}
const ROOT = new URL("../", import.meta.url);
const CLEANUP_WF = readTextNormalized(new URL(".github/workflows/production-test-secret-cleanup.yml", ROOT));
const READBACK_WF = readTextNormalized(new URL(".github/workflows/production-test-secret-readback.yml", ROOT));
const STATE_SH = readTextNormalized(new URL("scripts/ci/production-worker-state.sh", ROOT));

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
  const res = runCli(["readback", ...ST], { ...S0(), s: settings({ config: { X: VALUE } }) });
  assert.equal(res.code, 1, "[N3.2] CLI falha com os segredos de teste presentes");
  assert.match(res.out, /^PRODUCTION_TEST_SECRET_READBACK=FAIL /m, "[N3.2] veredito");
  assert.ok(!res.out.includes(VALUE), "[N3.3] nenhum valor aparece (texto de var, config)");
  const plan = runCli(["plan", ...ST, "--confirmation", CONFIRMATION_PHRASE, "--expected-digest", DIGEST0(), "--expected-version", V0, "--out", "@out"], S0());
  assert.equal(plan.code, 0, "[N3.3] plano de referência");
  assert.ok(!plan.out.includes(VALUE) && !JSON.stringify(plan.plan).includes(VALUE), "[N3.3] plano não imprime nem grava valor");
});

test("N4 entrada inválida falha fechado (código 2), nunca PASS", () => {
  assert.equal(runCli(["readback", "--secrets", "@l"], { l: { secrets: [] } }).code, 2, "[N4.1] lista que não é array");
  assert.equal(runCli(["readback", "--secrets", "@l"], { l: "not json" }).code, 2, "[N4.1] JSON ilegível");
  assert.equal(runCli(["readback", "--secrets", "@l", "--settings", "@s"], { l: [], s: { success: false } }).code, 2, "[N4.2] settings sem success");
  assert.equal(runCli(["readback", "--secrets", "@l"], { l: [{ name: "BAD NAME;rm" }] }).code, 2, "[N4.3] nome fora do formato");
  assert.equal(runCli(["plan", "--secrets", "@l", "--confirmation", CONFIRMATION_PHRASE, "--out", "@out"], { l: SECRETS_NOW }).code, 2, "[N4.3] plano sem settings");
  const st = S0();
  assert.equal(runCli(["plan", ...ST, "--confirmation", CONFIRMATION_PHRASE, "--expected-digest", DIGEST0(), "--expected-version", V0, "--out", "@out"], { ...st, d: { success: true, result: { deployments: [] } } }).code, 2, "[N4.4] sem deployment efetivo: código 2");
  assert.equal(runCli(["plan", ...ST, "--confirmation", CONFIRMATION_PHRASE, "--expected-digest", DIGEST0(), "--expected-version", V0, "--out", "@out"], { ...st, v: { success: true, result: { id: V0, resources: {} } } }).code, 2, "[N4.4] versão sem etag do código: código 2");
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
  const wrong = S0(); wrong.s = settings({ env: "certification" });
  const wrongTarget = runCli(["plan", ...ST, "--confirmation", CONFIRMATION_PHRASE, "--expected-digest", snapOf(wrong).digest, "--expected-version", V0, "--out", "@out"], wrong);
  assert.equal(wrongTarget.code, 1, "[N5.5] alvo que não prova ZEVANORY_DEPLOYMENT_ENV=production recusa");
  assert.equal(wrongTarget.plan, null, "[N5.5] e não grava plano");
  assert.equal(proveTarget(settings()).ok, true, "[N5.5] produção provada");
  const ok = runCli(["plan", ...ST, "--confirmation", CONFIRMATION_PHRASE, "--expected-digest", DIGEST0(), "--expected-version", V0, "--out", "@out"], S0());
  assert.equal(ok.code, 0, "[N5.6] CLI planeja");
  assert.deepEqual(ok.out.split("\n").filter((l) => l.startsWith("DELETE ")), ["DELETE MERCADOPAGO_TEST_ACCESS_TOKEN", "DELETE MERCADOPAGO_TEST_WEBHOOK_SECRET"], "[N5.6] diff: exatamente dois DELETE");
  assert.deepEqual(ok.out.split("\n").filter((l) => l.startsWith("KEEP ")).map((l) => l.slice(5)), p.kept, "[N5.6] diff: lista KEEP completa impressa antes");
  assert.deepEqual([ok.plan.toDelete, ok.plan.kept], [p.toDelete, p.kept], "[N5.6] plano gravado = diff impresso");
  const refused = runCli(["plan", ...ST, "--confirmation", "sim", "--expected-digest", DIGEST0(), "--expected-version", V0, "--out", "@out"], S0());
  assert.ok(refused.code === 1 && !/^DELETE /m.test(refused.out) && refused.plan === null, "[N5.6] recusa sem DELETE e sem plano");
});

test("N6 readback pós-remoção: allowlist ausente E todo outro nome do pré-inventário presente", () => {
  const plan = makePlan();
  const done = snapOf(state({ removed: REMOVAL_ALLOWLIST, chain: [V2, V1, V0] }));
  assert.deepEqual(verifyRemoval({ plan, snap: done }), { ok: true, stillPresent: [], lostKept: [], added: [], typeChanged: [], errors: [] }, "[N6.1] remoção exata passa");
  const still = verifyRemoval({ plan, snap: snapOf(S0()) });
  assert.deepEqual([still.ok, still.stillPresent], [false, [...REMOVAL_ALLOWLIST]], "[N6.2] segredo de teste ainda presente reprova");
  const lostSt = state({ removed: [...REMOVAL_ALLOWLIST, "DATABASE_URL"], chain: [V2, V1, V0] });
  lostSt.s.result.bindings = lostSt.s.result.bindings.filter((b) => b.name !== "CERTIFICATION_PILOT_ENABLED");
  lostSt.v.result.resources.bindings = lostSt.v.result.resources.bindings.filter((b) => b.name !== "CERTIFICATION_PILOT_ENABLED");
  const lost = verifyRemoval({ plan, snap: snapOf(lostSt) });
  assert.deepEqual([lost.ok, lost.lostKept], [false, ["CERTIFICATION_PILOT_ENABLED", "DATABASE_URL"]], "[N6.3] qualquer outro nome sumido reprova");
  const res = runCli(["verify", "--plan", "@p", ...ST], { p: plan, ...S0() });
  assert.equal(res.code, 1, "[N6.2] CLI código 1");
  assert.equal(runCli(["verify", "--plan", "@p", ...ST], { p: { kept: "x" }, ...S0() }).code, 2, "[N6.4] plano inválido: código 2");
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

test("N8 C1 pré-inventário: todo (nome, tipo, origem), versão efetiva, commit publicado, DELETE/KEEP e digest; nunca valores", () => {
  const st = S0();
  const r = runCli(["readback", ...ST], st);
  const lines = r.out.split("\n");
  const entries = lines.filter((l) => l.startsWith("INVENTORY_ENTRY "));
  const snap = snapOf(st);
  assert.equal(entries.length, snap.entries.length, "[N8.1] uma linha por entrada do inventário");
  assert.ok(entries.includes("INVENTORY_ENTRY origin=secret type=secret_text name=MERCADOPAGO_TEST_ACCESS_TOKEN"), "[N8.1] segredo pela secret list");
  assert.ok(entries.includes("INVENTORY_ENTRY origin=binding type=secret_text name=MERCADOPAGO_TEST_ACCESS_TOKEN"), "[N8.1] o mesmo segredo como binding do settings");
  assert.ok(entries.includes("INVENTORY_ENTRY origin=binding type=plain_text name=CERTIFICATION_PILOT_ENABLED"), "[N8.1] var com o TIPO");
  assert.ok(entries.includes("INVENTORY_ENTRY origin=runtime_config type=runtime_config_key name=CHECKOUT_ENABLED"), "[N8.1] chave da config com origem própria");
  assert.ok(entries.includes("INVENTORY_ENTRY origin=binding type=kv_namespace name=ZEVANORY_PRIVATE_ARTIFACTS"), "[N8.1] binding de recurso com o tipo");
  assert.ok(lines.includes(`EFFECTIVE_VERSION_ID=${V0}`), "[N8.2] versão efetiva (deployments)");
  assert.ok(lines.some((l) => l.startsWith("EFFECTIVE_VERSION_DETAIL number=7 ")), "[N8.2] detalhe da versão (versions)");
  assert.ok(lines.includes(`DEPLOYED_COMMIT_SHA=${SHA}`), "[N8.3] commit publicado (/api/release)");
  assert.deepEqual(lines.filter((l) => l.startsWith("PLANNED_DELETE ")), ["PLANNED_DELETE MERCADOPAGO_TEST_ACCESS_TOKEN", "PLANNED_DELETE MERCADOPAGO_TEST_WEBHOOK_SECRET"], "[N8.4] DELETE planejado");
  assert.equal(lines.filter((l) => l.startsWith("PLANNED_KEEP ")).length, planRemoval({ confirmation: CONFIRMATION_PHRASE, ...inv() }).kept.length, "[N8.4] KEEP planejado completo");
  assert.ok(lines.includes(`INVENTORY_DIGEST=${snap.digest}`) && /^sha256:[0-9a-f]{64}$/.test(snap.digest), "[N8.5] digest impresso");
  assert.ok(lines.includes(`INVENTORY_DOCUMENT=${canonicalJson(snap.doc)}`), "[N8.5] documento canônico impresso (recalculável pelo auditor)");
  assert.ok(!r.out.includes(VALUE), "[N8.6] nenhum valor no inventário");
  const noRelease = runCli(["readback", ...ST], { ...st, r: "indisponivel" });
  assert.ok(noRelease.out.split("\n").includes("DEPLOYED_COMMIT_SHA=indisponível"), "[N8.3] commit indisponível relatado, não inventado");
  assert.match(READBACK_WF, /zev_fetch_state "\$d"/, "[N8.7] o workflow de readback coleta o estado completo");
  assert.match(READBACK_WF, /--deployments "\$d\/deployments\.json" --version-detail "\$d\/version\.json" --release "\$d\/release\.json"/, "[N8.7] e passa versão e release ao readback");
  for (const ep of ["zev_cf_get settings", "zev_cf_get deployments", 'zev_cf_get "versions/$vid"', "https://zevanory.api.br/api/release"]) assert.ok(STATE_SH.includes(ep), "[N8.8] coleta lê " + ep);
  assert.doesNotMatch(STATE_SH, /-X\s*(POST|PUT|PATCH|DELETE)|secret (put|delete|bulk)|wrangler(@[\d.]+)? deploy/, "[N8.8] coleta só lê");
});

test("N9 C2/A2 digest canônico versionado e autorização presa ao estado", () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: null }], "é": "x" }), '{"a":[{"c":null,"d":2}],"b":1,"é":"x"}', "[N9.1] JSON canônico: chaves ordenadas, sem espaço, arrays na ordem");
  const doc = { schema: INVENTORY_SCHEMA, account: TARGET.account, script: "zevanory", commit_sha: SHA, entries: [["A", "secret_text", "secret"]], delete: [], keep: ["A"] };
  const manual = `{"account":"${TARGET.account}","commit_sha":"${SHA}","delete":[],"entries":[["A","secret_text","secret"]],"keep":["A"],"schema":"zev-inventory/v1","script":"zevanory"}`;
  assert.equal(inventoryDigest(doc), "sha256:" + createHash("sha256").update(manual).digest("hex"), "[N9.1] SHA-256 do JSON canônico, recalculável fora daqui");
  const snap = snapOf(S0());
  assert.deepEqual(Object.keys(snap.doc).sort(), ["account", "code", "commit_sha", "delete", "entries", "keep", "schema", "script"], "[N9.2] campos do documento (versão fica fora: campo autorizado à parte)");
  assert.deepEqual([snap.doc.schema, snap.doc.account, snap.doc.script, snap.doc.commit_sha], [INVENTORY_SCHEMA, TARGET.account, "zevanory", SHA], "[N9.2] conta, script e commit");
  assert.equal(snapOf(state({ chain: [V1, V0] })).digest, snap.digest, "[N9.2] versão nova sozinha não muda o digest (é verificada à parte)");
  assert.deepEqual(snap.doc.delete, [...REMOVAL_ALLOWLIST], "[N9.2] lista DELETE no documento");
  const shuffled = S0(); shuffled.l = [...shuffled.l].reverse(); shuffled.s.result.bindings.reverse();
  assert.equal(snapOf(shuffled).digest, snap.digest, "[N9.3] ordem de leitura não muda o digest");
  for (const [label, st] of [["nome novo", state({ secretsExtra: list("NOVO_SEGREDO") })], ["tipo mudado", retype(S0(), "ZEVANORY_PRIVATE_ARTIFACTS", "r2_bucket")], ["código mudado", state({ etag: "etag-code-2" })],
    ["commit novo", state({ commit: SHA2 })], ["sem release", { ...S0(), r: {} }]]) {
    assert.notEqual(snapOf(st).digest, snap.digest, "[N9.3] estado diferente muda o digest: " + label);
  }
  assert.deepEqual(checkBinding({ digest: snap.digest, expectedDigest: snap.digest, effective: snap.effective, expectedVersion: V0 }), { ok: true }, "[N9.4] digest e versão iguais autorizam");
  assert.equal(checkBinding({ digest: snap.digest, expectedDigest: snapOf(state({ secretsExtra: list("NOVO") })).digest, effective: snap.effective, expectedVersion: V0 }).error, "inventory_digest_mismatch", "[N9.4] estado mudou: recusa");
  for (const bad of [undefined, "", "abc", snap.digest.toUpperCase(), snap.digest.slice(0, -1)]) assert.equal(checkBinding({ digest: snap.digest, expectedDigest: bad, effective: snap.effective, expectedVersion: V0 }).ok, false, "[N9.4] digest ausente/malformado recusa: " + bad);
  assert.equal(checkBinding({ digest: snap.digest, expectedDigest: snap.digest, effective: snap.effective }).error, "expected_version_missing", "[N9.5] versão esperada ausente recusa");
  assert.equal(checkBinding({ digest: snap.digest, expectedDigest: snap.digest, effective: snap.effective, expectedVersion: V1 }).error, "effective_version_mismatch", "[N9.5] versão esperada diferente recusa");
  const changed = state({ secretsExtra: list("NOVO_DEPOIS_DA_REVISAO") });
  const refused = runCli(["plan", ...ST, "--confirmation", CONFIRMATION_PHRASE, "--expected-digest", DIGEST0(), "--expected-version", V0, "--out", "@out"], changed);
  assert.ok(refused.code === 1 && refused.plan === null && /CLEANUP_REFUSED::inventory_digest_mismatch/.test(refused.out), "[N9.6] CLI: estado mudou desde o inventário aprovado => recusa sem plano");
  const noDigest = runCli(["plan", ...ST, "--confirmation", CONFIRMATION_PHRASE, "--expected-version", V0, "--out", "@out"], S0());
  assert.ok(noDigest.code === 1 && noDigest.plan === null, "[N9.6] CLI sem digest recusa");
  const noVersion = runCli(["plan", ...ST, "--confirmation", CONFIRMATION_PHRASE, "--expected-digest", DIGEST0(), "--out", "@out"], S0());
  assert.ok(noVersion.code === 1 && noVersion.plan === null && /expected_version_missing/.test(noVersion.out), "[N9.6] CLI sem versão esperada recusa");
  const verRef = runCli(["plan", ...ST, "--confirmation", CONFIRMATION_PHRASE, "--expected-digest", DIGEST0(), "--expected-version", V1, "--out", "@out"], S0());
  assert.ok(verRef.code === 1 && verRef.plan === null, "[N9.6] CLI com versão esperada diferente recusa");
  const plan = makePlan();
  assert.deepEqual([plan.schema, plan.digest, plan.version, plan.commit_sha], [INVENTORY_SCHEMA, snap.digest, V0, SHA], "[N9.7] plano grava digest, versão e commit aprovados");
  assert.match(CLEANUP_WF, /expected_inventory_digest:\n\s+description: [^\n]+\n\s+required: true/, "[N9.8] input expected_inventory_digest obrigatório");
  assert.match(CLEANUP_WF, /expected_version_id:\n\s+description: [^\n]+\n\s+required: true/, "[N9.8] input expected_version_id obrigatório");
  assert.ok(CLEANUP_WF.includes('--expected-version "$EXPECTED_VERSION_ID"') && CLEANUP_WF.includes("EXPECTED_VERSION_ID: ${{ inputs.expected_version_id }}"), "[N9.8] o plano recebe a versão digitada");
  assert.ok(CLEANUP_WF.includes('--expected-digest "$EXPECTED_INVENTORY_DIGEST"') && CLEANUP_WF.includes("EXPECTED_INVENTORY_DIGEST: ${{ inputs.expected_inventory_digest }}"), "[N9.8] o plano recebe o digest digitado");
});

test("N10 C3/A1 serialização: run ativo de publicador do zevanory ou versão mudada recusa", () => {
  const matrix = loadMatrix(JSON.parse(readTextNormalized(new URL("docs/ops/zevanory-publisher-matrix.json", ROOT))));
  const plan = makePlan();
  const eff = snapOf(S0()).effective;
  const listing = (...runs) => ({ total_count: runs.length, workflow_runs: runs });
  const run = (id, wf, status) => ({ id, path: `.github/workflows/${wf}`, status });
  const ev = (listings, effective = eff) => evaluatePreflight({ listings, watched: matrix, selfRunId: 42, plan, effective });
  assert.equal(ev([listing(run(42, "production-test-secret-cleanup.yml", "in_progress"), run(7, "ci.yml", "in_progress"))]).ok, true, "[N10.1] só o próprio run e workflows alheios: passa");
  for (const [wf, status] of [["central-production-deploy.yml", "queued"], ["channel-credentials-sync.yml", "in_progress"], ["mercadopago-production-token-rotate.yml", "waiting"], ["financial-e2e-stripe.yml", "pending"], ["production-test-secret-cleanup.yml", "requested"]]) {
    const r = ev([listing(run(9, wf, status))]);
    assert.deepEqual([r.ok, r.active.map((a) => a.workflow)], [false, [wf]], `[N10.2] ${wf} ${status} recusa`);
  }
  assert.equal(ev([listing(run(9, "central-production-deploy.yml", "completed"))]).ok, true, "[N10.3] run concluído não bloqueia");
  assert.equal(ev([{ total_count: 101, workflow_runs: [] }]).truncated, true, "[N10.4] lista truncada recusa (não prova ausência)");
  assert.equal(ev([{ total_count: 101, workflow_runs: [] }]).ok, false, "[N10.4] lista truncada recusa");
  const moved = ev([listing()], snapOf(state({ chain: [V1, V0] })).effective);
  assert.deepEqual([moved.ok, moved.versionChanged], [false, true], "[N10.5] versão efetiva mudou depois do plano: recusa");
  assert.ok(matrix.files.includes("mercadopago-production-token-rotate.yml") && matrix.files.includes("central-production-deploy.yml"), "[N10.6] a matriz vigia todos os publicadores, dentro e fora do grupo");
  const cli1 = runCli(["preflight", "--plan", "@p", "--deployments", "@d", "--runs", "@a", "--runs", "@b", "--self-run-id", "42"], { p: plan, d: deployments(V0), a: listing(), b: listing(run(5, "voice-zero-spend-enable.yml", "queued")) });
  assert.ok(cli1.code === 1 && /CLEANUP_REFUSED_CONCURRENT::voice-zero-spend-enable\.yml run 5 queued/.test(cli1.out), "[N10.7] CLI soma todas as listas de status");
  assert.equal(runCli(["preflight", "--plan", "@p", "--deployments", "@d", "--runs", "@a", "--self-run-id", "42"], { p: plan, d: deployments(V0), a: listing() }).code, 0, "[N10.7] CLI sem concorrência passa");
  assert.equal(runCli(["preflight", "--plan", "@p", "--deployments", "@d", "--self-run-id", "42"], { p: plan, d: deployments(V0) }).code, 2, "[N10.7] sem listas de runs: código 2");
  assert.match(CLEANUP_WF, /for s in queued in_progress waiting requested pending; do\n[^\n]*\n\s+"\$GITHUB_API_URL\/repos\/\$GITHUB_REPOSITORY\/actions\/runs\?status=\$s&per_page=100"/, "[N10.8] workflow consulta os 5 status ativos");
  assert.match(CLEANUP_WF.split(/^jobs:/m)[0], /^permissions:\n  contents: read\n  actions: read\n/m, "[N10.8] GITHUB_TOKEN só com actions: read");
  assert.match(CLEANUP_WF, /preflight --plan "\$d\/plan\.json"[^\n]*\n[^\n]*--self-run-id "\$GITHUB_RUN_ID"/, "[N10.8] preflight exclui só o próprio run");
});

test("N11 C4 + A1/A2 por passo: um nome por vez, estado provado antes e logo depois de cada DELETE; falha => CLEANUP_PARTIAL", () => {
  const plan = makePlan();
  const [A, B] = REMOVAL_ALLOWLIST;
  const pre1 = snapOf(S0()), post1 = snapOf(state({ removed: [A], chain: [V1, V0] })), post2 = snapOf(state({ removed: [A, B], chain: [V2, V1, V0] }));
  assert.equal(stepCheck({ plan, phase: "pre", name: A, deleted: [], expectedVersion: V0, snap: pre1 }).ok, true, "[N11.1] antes do 1º: estado = aprovado");
  assert.equal(stepCheck({ plan, phase: "post", name: A, deleted: [], expectedVersion: V0, snap: post1 }).ok, true, "[N11.1] depois do 1º: só ele saiu, um passo de deployment");
  assert.equal(stepCheck({ plan, phase: "pre", name: B, deleted: [A], expectedVersion: V1, snap: post1 }).ok, true, "[N11.1] antes do 2º: versão = a que o nosso DELETE publicou");
  assert.equal(stepCheck({ plan, phase: "post", name: B, deleted: [A], expectedVersion: V1, snap: post2 }).ok, true, "[N11.1] depois do 2º");
  const errs = (o) => stepCheck({ plan, ...o }).errors;
  assert.ok(errs({ phase: "pre", name: A, deleted: [], expectedVersion: V0, snap: snapOf(state({ secretsExtra: list("INTRUSO") })) }).includes("state_digest_mismatch:S0"), "[N11.2] digest recalculado antes do 1º DELETE difere de D0: recusa");
  assert.ok(errs({ phase: "pre", name: B, deleted: [A], expectedVersion: V1, snap: snapOf(state({ removed: [A], chain: [VX, V1, V0] })) }).includes("CONCURRENT_CHANGE:effective_version_moved"), "[N11.3] versão andou entre DELETEs: CONCURRENT_CHANGE");
  assert.ok(errs({ phase: "post", name: A, deleted: [], expectedVersion: V0, snap: snapOf(state({ removed: [A], chain: [V1, VX, V0] })) }).includes("CONCURRENT_CHANGE:deployment_chain_not_single_step"), "[N11.4] deployment estranho entre o antes e o depois: CONCURRENT_CHANGE");
  assert.ok(errs({ phase: "post", name: A, deleted: [], expectedVersion: V0, snap: snapOf(state({ removed: [A], chain: [V1, V0], trigger: "upload" })) }).includes("CONCURRENT_CHANGE:new_version_not_a_secret_change"), "[N11.4] versão nova que não é troca de segredo: CONCURRENT_CHANGE");
  assert.ok(errs({ phase: "post", name: A, deleted: [], expectedVersion: V0, snap: snapOf(state({ removed: [A], chain: [V0] })) }).includes("delete_did_not_publish_a_version"), "[N11.5] DELETE sem versão nova reprova");
  assert.ok(errs({ phase: "post", name: A, deleted: [], expectedVersion: V0, snap: snapOf(S0()) }).includes("inventory_not_expected"), "[N11.5] nome ainda presente depois do DELETE reprova");
  assert.ok(errs({ phase: "post", name: A, deleted: [], expectedVersion: V0, snap: snapOf(state({ removed: [A, B], chain: [V1, V0] })) }).includes("config_not_expected"), "[N11.5] sumiu mais que o nome do passo: reprova");
  assert.ok(errs({ phase: "post", name: A, deleted: [], expectedVersion: V0, snap: snapOf(state({ removed: [A], chain: [V1, V0], varText: "OUTRO" })) }).includes("config_not_expected"), "[N11.5] valor de var mudou junto (hash): reprova");
  assert.ok(errs({ phase: "post", name: A, deleted: [], expectedVersion: V0, snap: snapOf(state({ removed: [A], chain: [V1, V0], commit: SHA2 })) }).includes("CONCURRENT_CHANGE:deployed_commit_changed"), "[N11.5] commit publicado mudou: CONCURRENT_CHANGE");
  assert.equal(stepCheck({ plan, phase: "pre", name: "CERTIFICATION_E2E_TOKEN", deleted: [], expectedVersion: V0, snap: pre1 }).error, "name_not_planned", "[N11.6] nome fora do plano recusa");
  const okPost = runCli(["step", "--phase", "post", "--plan", "@p", "--name", A, "--expected-version", V0, ...ST, "--out-version", "@ver"], { p: plan, ...state({ removed: [A], chain: [V1, V0] }) });
  assert.ok(okPost.code === 0 && okPost.ver === V1, "[N11.7] CLI confirma o passo e entrega a versão nova para o próximo");
  const badPost = runCli(["step", "--phase", "post", "--plan", "@p", "--name", A, "--expected-version", V0, ...ST, "--out-version", "@ver"], { p: plan, ...state({ removed: [A], chain: [V1, VX, V0] }) });
  assert.ok(badPost.code === 1 && badPost.ver === null && /::error title=CONCURRENT_CHANGE::/.test(badPost.out), "[N11.7] CLI reprova sem versão confirmada");
  const partial = runCli(["partial", "--plan", "@p", "--secrets", "@l", "--settings", "@s", "--deployments", "@d", "--reason", "post_check_failed:" + A], { p: plan, ...state({ removed: [A], chain: [V1, V0] }) });
  assert.equal(partial.code, 1, "[N11.8] relatório parcial sempre falha o job");
  assert.ok(partial.out.includes(`CLEANUP_PARTIAL name=${A} state=absent`) && partial.out.includes(`CLEANUP_PARTIAL name=${B} state=present`) && partial.out.includes(`CLEANUP_PARTIAL effective_version=${V1}`), "[N11.8] imprime presentes/ausentes e a versão efetiva");
  assert.match(partial.out, /^CLEANUP_PARTIAL=FAIL reason=post_check_failed:MERCADOPAGO_TEST_ACCESS_TOKEN$/m, "[N11.8] veredito com o motivo");
  assert.match(runCli(["partial", "--plan", "@p", "--reason", "x"], { p: plan }).out, /^CLEANUP_PARTIAL state=unknown/m, "[N11.8] sem relistagem: estado desconhecido, nunca PASS");
  const loopAt = CLEANUP_WF.indexOf("for name in $PLANNED; do");
  const loop = CLEANUP_WF.slice(loopAt, CLEANUP_WF.indexOf("          done\n", loopAt));
  const order = ['zev_fetch_state "$d/pre-$name" || fail', "step --phase pre", 'secret delete "$name" --name zevanory || fail', 'zev_fetch_state "$d/post-$name" || fail', "step --phase post"];
  const at = order.map((s) => loop.indexOf(s));
  assert.ok(at.every((i) => i >= 0) && at.every((i, k) => k === 0 || i > at[k - 1]), "[N11.9] um nome por iteração: relê, prova, apaga, relê, prova — nessa ordem");
  assert.ok(/--expected-version "\$expected"[^\n]*\|\| fail "pre_check_failed/.test(loop) && /\|\| fail "post_check_failed/.test(loop), "[N11.9] cada prova falha => fail (para)");
  assert.match(CLEANUP_WF, /fail\(\) \{\n[^}]*production-secret-names\.mjs partial[^}]*exit 1\n\s*\}/, "[N11.9] fail imprime CLEANUP_PARTIAL e sai 1");
  assert.doesNotMatch(CLEANUP_WF, /secret (put|bulk)|versions (deploy|upload)|wrangler(@[\d.]+)? (deploy|rollback)/, "[N11.10] nada é recriado nem republicado automaticamente");
});

test("N12 C5/A3 verificação estrita: ADDED_SINCE_PLAN, tipo, código preservado, diff = DELETE exato, release e sales status", () => {
  const plan = makePlan();
  const done = () => state({ removed: REMOVAL_ALLOWLIST, chain: [V2, V1, V0] });
  assert.equal(verifyRemoval({ plan, snap: snapOf(done()) }).ok, true, "[N12.0] remoção exata passa");
  const added = verifyRemoval({ plan, snap: snapOf(state({ removed: REMOVAL_ALLOWLIST, chain: [V2, V1, V0], secretsExtra: list("NOVO_DEPOIS") })) });
  assert.deepEqual([added.ok, added.added], [false, ["NOVO_DEPOIS"]], "[N12.1] ADDED_SINCE_PLAN reprova");
  const typed = verifyRemoval({ plan, snap: snapOf(retype(done(), "ZEVANORY_PRIVATE_ARTIFACTS", "r2_bucket")) });
  assert.deepEqual([typed.ok, typed.typeChanged], [false, ["ZEVANORY_PRIVATE_ARTIFACTS(binding):kv_namespace->r2_bucket"]], "[N12.2] tipo de entrada mantida mudou: reprova");
  assert.ok(verifyRemoval({ plan, snap: snapOf(state({ removed: REMOVAL_ALLOWLIST, chain: [V2, V1, V0], etag: "etag-code-2" })) }).errors.includes("code_changed"), "[N12.3] etag do script mudou: código não preservado");
  assert.ok(verifyRemoval({ plan, snap: snapOf(state({ removed: REMOVAL_ALLOWLIST, chain: [V2, V1, V0], flags: [] })) }).errors.includes("code_changed"), "[N12.3] runtime (flags) mudou: reprova");
  const varChanged = verifyRemoval({ plan, snap: snapOf(state({ removed: REMOVAL_ALLOWLIST, chain: [V2, V1, V0], varText: "OUTRO" })) });
  assert.ok(varChanged.errors.some((e) => e.startsWith("config_diff_not_exactly_delete") && e.includes("changed=PUBLIC_BASE_URL")), "[N12.4] valor de var mudou: diff de configuração ≠ DELETE");
  assert.ok(!JSON.stringify(varChanged).includes("OUTRO") && !JSON.stringify(varChanged).includes(VALUE), "[N12.4] o diff cita só nomes, nunca valores");
  const d = diffConfig({ A: { type: "secret_text", h: "1" }, B: { type: "plain_text", h: "2" } }, { B: { type: "plain_text", h: "2" } }, ["A"]);
  assert.equal(d.ok, true, "[N12.5] diff = exatamente o segredo autorizado");
  assert.equal(diffConfig({ A: { type: "secret_text", h: "1" }, B: { type: "plain_text", h: "2" } }, {}, ["A"]).ok, false, "[N12.5] removeu além do autorizado");
  assert.equal(diffConfig({ A: { type: "plain_text", h: "1" } }, {}, ["A"]).ok, false, "[N12.5] removido autorizado que não era secret_text");
  assert.equal(diffConfig({ A: { type: "secret_text", h: "1" } }, { A: { type: "secret_text", h: "1" } }, ["A"]).ok, false, "[N12.5] autorizado que não saiu");
  const s = done(); s.s.result.logpush = true;  // setting fora dos bindings
  assert.ok(verifyRemoval({ plan, snap: snapOf(s) }).errors.includes("script_settings_changed"), "[N12.6] outro setting do script mudou: reprova");
  const res = runCli(["verify", "--plan", "@p", ...ST], { p: plan, ...state({ removed: REMOVAL_ALLOWLIST, chain: [V2, V1, V0], secretsExtra: list("NOVO_DEPOIS") }) });
  assert.ok(res.code === 1 && res.out.includes("::error title=ADDED_SINCE_PLAN::NOVO_DEPOIS"), "[N12.1] CLI: ADDED_SINCE_PLAN é erro");
  assert.match(runCli(["verify", "--plan", "@p", ...ST], { p: plan, ...done() }).out, new RegExp(`^CLEANUP_VERIFY=PASS .* version_before=${V0} version_after=${V2} `, "m"), "[N12.7] CLI registra a versão de antes");
  assert.equal(evaluatePostcheck({ plan, release: release(), sales: { open: false } }).ok, true, "[N12.8] release e sales consistentes");
  for (const [label, rel, sales, err] of [["sem commit", { sales_mode: "globally-blocked" }, { open: false }, "release_commit_sha_missing"],
    ["commit mudou", release(SHA2), { open: false }, "release_commit_changed_during_cleanup"],
    ["vendas abertas no release", release(SHA, "enabled"), { open: false }, "release_sales_mode_not_globally_blocked"],
    ["sales/status aberto", release(), { open: true }, "sales_status_open_not_false"],
    ["sales/status ilegível", release(), null, "sales_status_open_not_false"], ["open ausente", release(), {}, "sales_status_open_not_false"]]) {
    assert.ok(evaluatePostcheck({ plan, release: rel, sales }).errors.includes(err), "[N12.8] " + label);
  }
  assert.equal(runCli(["postcheck", "--plan", "@p", "--release", "@r", "--sales", "@x"], { p: plan, r: release(), x: { open: true } }).code, 1, "[N12.8] CLI reprova");
  const verify = CLEANUP_WF.slice(CLEANUP_WF.indexOf("- name: Read back and prove the result"));
  assert.ok(verify.includes("https://zevanory.api.br/api/sales/status") && /postcheck --plan "\$d\/plan\.json" --release "\$d\/after\/release\.json" --sales/.test(verify), "[N12.9] workflow faz o pós-check público");
  assert.match(verify, /if \[ "\$v" != 0 \] \|\| \[ "\$p" != 0 \] \|\| \[ "\$r" != 0 \]; then [^\n]*exit 1; fi/, "[N12.9] qualquer verificação reprovada falha o job");
});

test("N13 A1 matriz: todo workflow que escreve no zevanory está na matriz e no grupo deploy-zevanory (exceção só registrada)", () => {
  const WRITE = [/wrangler(?:@[\d.]+)?\s+(?:deploy|rollback|versions\s+deploy)\b(?![^\n]*--dry-run)/, /wrangler(?:@[\d.]+)?\s+(?:versions\s+)?secret\s+(?:put|delete|bulk)\b/,
    /-X\s*(?:POST|PUT|PATCH|DELETE)\b[^\n]*workers\/scripts|workers\/scripts[^\n]*-X\s*(?:POST|PUT|PATCH|DELETE)\b/, /worker_secret_rotate\.py[^\n]*--apply/];
  const TOUCH = /--name[ =]["']?zevanory(?![\w-])|workers\/scripts\/zevanory(?![\w-])|wrangler\.central-fix\.jsonc|wrangler\.mp-recovery\.jsonc|worker_secret_rotate\.py/;
  const writesZevanory = (text) => text.replace(/\\\n/g, " ").split("\n").some((l) => !/^\s*#/.test(l) && WRITE.some((re) => re.test(l)) && TOUCH.test(l));
  const group = (text) => { const m = text.match(/^concurrency:\s*\n\s+group:\s*(.+)$/m); return m ? m[1].trim() : null; };
  const wfDir = new URL(".github/workflows/", ROOT);
  const files = readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)).sort();
  const text = (f) => readTextNormalized(new URL(f, wfDir));
  const raw = JSON.parse(readTextNormalized(new URL("docs/ops/zevanory-publisher-matrix.json", ROOT)));
  const matrix = loadMatrix(raw);
  const writers = files.filter((f) => writesZevanory(text(f)));
  assert.ok(writers.length >= 10, "[N13.1] o detector acha os publicadores conhecidos (não passa vazio)");
  assert.deepEqual(writers, matrix.writers, "[N13.1] matriz = exatamente os workflows que escrevem no zevanory");
  for (const g of raw.github) {
    const t = text(g.workflow);
    if (g.serialized) {
      assert.equal(group(t), "deploy-zevanory", `[N13.2] ${g.workflow} tem de estar no grupo deploy-zevanory`);
      assert.match(t.split(/^jobs:/m)[0], /^concurrency:[\s\S]*?\n  queue: max\n/m, `[N13.2] ${g.workflow} mantém queue: max`);
    } else {
      assert.ok(String(g.reason || "").length > 40, `[N13.3] ${g.workflow} fora do grupo exige motivo escrito`);
    }
    assert.equal(g.group, group(t), `[N13.4] grupo na matriz = grupo real: ${g.workflow}`);
  }
  const publishers = JSON.parse(readTextNormalized(new URL("ops/publishers.json", ROOT)));
  assert.deepEqual(matrix.unserialized, ["mercadopago-exact-sha-recovery.yml"], "[N13.3] exceção fixada: só o financeiro aposentado (a rotação do token MP entrou no grupo por autorização escrita do proprietário, #919)");
  for (const f of matrix.unserialized) assert.ok(publishers.unserialized_known[f], "[N13.3] exceção também registrada em ops/publishers.json: " + f);
  for (const f of Object.keys(raw.registered_not_touching)) assert.equal(writesZevanory(text(f)), false, "[N13.5] registrado mas não escreve no zevanory: " + f);
  for (const f of raw.readers_only) assert.equal(writesZevanory(text(f)), false, "[N13.5] leitor não escreve: " + f);
  assert.ok(raw.external.length >= 4 && raw.external.every((e) => e.serializable === false && String(e.detection).length > 3), "[N13.6] caminhos externos listados com a detecção");
  const doc = readTextNormalized(new URL("docs/ops/zevanory-publisher-matrix.md", ROOT));
  for (const g of raw.github) assert.ok(doc.includes("`" + g.workflow + "`"), "[N13.7] documento cita " + g.workflow);
  assert.match(doc, /## Risco residual/, "[N13.7] documento declara o risco residual");
  assert.equal(writesZevanory("      - run: npx --yes wrangler@4.143.0 secret put X --name zevanory\n"), true, "[N13.8] detector pega secret put no zevanory");
  assert.equal(writesZevanory("      - run: npx --yes wrangler@4.143.0 secret put X --name zevanory-certification\n"), false, "[N13.8] e não confunde com outro Worker");
});

test("N14 Sol 191 transições S0 -> S1 -> S2: D1 e D2 calculados de S0 antes de qualquer DELETE e exigidos em cada passo", () => {
  const [A, B] = REMOVAL_ALLOWLIST;
  const s0 = snapOf(S0());
  const plan = makePlan();
  const D = plan.chain.map((s) => s.digest);
  assert.deepEqual(plan.chain.map((s) => [s.state, s.removed]), [["S0", []], ["S1", [A]], ["S2", [A, B]]], "[N14.1] cadeia S0, S1 (− 1º nome), S2 (− os 2)");
  assert.equal(D[0], s0.digest, "[N14.1] D0 = digest aprovado");
  assert.equal(new Set(D).size, 3, "[N14.1] D0, D1 e D2 distintos");
  // Recalculados à mão a partir de S0 (independente do plano): S1 = S0 menos exatamente A, KEEP intacto.
  const manual = (gone) => inventoryDigest({ ...s0.doc, entries: s0.doc.entries.filter((e) => !gone.includes(e[0])) });
  assert.deepEqual(D, [manual([]), manual([A]), manual([A, B])], "[N14.2] D1 e D2 determinísticos a partir de S0");
  assert.equal(liveDigest(snapOf(state({ removed: [A], chain: [V1, V0] })), plan), D[1], "[N14.2] estado real depois do 1º DELETE dá D1 (versão nova não entra)");
  assert.equal(liveDigest(snapOf(state({ removed: [A, B], chain: [V2, V1, V0] })), plan), D[2], "[N14.2] estado real depois do 2º dá D2");
  const shuffled = state({ removed: [A], chain: [V1, V0] }); shuffled.l.reverse(); shuffled.s.result.bindings.reverse(); shuffled.v.result.resources.bindings.reverse();
  assert.equal(liveDigest(snapOf(shuffled), plan), D[1], "[N14.3] mesmo conjunto em outra ordem de entrada: mesmo hash");
  const p1 = runCli(["plan", ...ST, "--confirmation", CONFIRMATION_PHRASE, "--expected-digest", DIGEST0(), "--expected-version", V0, "--out", "@out"], S0());
  assert.deepEqual(p1.out.split("\n").filter((l) => l.startsWith("STATE_DIGEST ")), [`STATE_DIGEST S0=${D[0]} removed=-`, `STATE_DIGEST S1=${D[1]} removed=${A}`, `STATE_DIGEST S2=${D[2]} removed=${A},${B}`], "[N14.4] plano imprime D0, D1 e D2 antes de qualquer DELETE");
  const step = (o) => stepCheck({ plan, ...o });
  const extra = state({ removed: [A], chain: [V1, V0], secretsExtra: list("EXTRA") });
  assert.ok(step({ phase: "post", name: A, deleted: [], expectedVersion: V0, snap: snapOf(extra) }).errors.includes("state_digest_mismatch:S1"), "[N14.5] S1 com mudança a mais: não é D1, bloqueia o 2º DELETE");
  assert.ok(step({ phase: "pre", name: B, deleted: [A], expectedVersion: V1, snap: snapOf(state({ removed: [A], chain: [V1, V0], secretsExtra: list("EXTRA") })) }).errors.includes("state_digest_mismatch:S1"), "[N14.5] antes do 2º o vivo tem de ser D1");
  const t2 = retype(state({ removed: [A, B], chain: [V2, V1, V0] }), "ZEVANORY_PRIVATE_ARTIFACTS", "r2_bucket");
  assert.ok(step({ phase: "post", name: B, deleted: [A], expectedVersion: V1, snap: snapOf(t2) }).errors.includes("state_digest_mismatch:S2"), "[N14.6] S2 com tipo do KEEP mudado: não é D2");
  assert.equal(step({ phase: "pre", name: B, deleted: [], expectedVersion: V0, snap: s0 }).error, "name_not_planned", "[N14.7] ordem da cadeia: o 2º nome antes do 1º recusa");
  assert.ok(verifyRemoval({ plan, snap: snapOf(extra) }).errors.includes("state_digest_mismatch:S2"), "[N14.8] verificação final exige D2");
  const single = makePlan(state({ removed: [A] }));
  assert.deepEqual(single.chain.map((s) => s.state), ["S0", "S1"], "[N14.9] com um nome já ausente a cadeia tem só S0 -> S1");
});

test("N15 Sol 194: digest lógico com identidade do código, prova de versão por transição, validador rejeita inventário inválido, ordem determinística", () => {
  const [A] = REMOVAL_ALLOWLIST;
  const s0 = snapOf(S0());
  assert.deepEqual(s0.doc.code, { etag: "etag-code-1", handlers: ["fetch", "scheduled"], compatibility_date: "2025-01-01", compatibility_flags: ["nodejs_compat"], usage_model: "standard" }, "[N15.1] D cobre a identidade do código");
  assert.equal(Object.hasOwn(s0.doc, "effective_version_id"), false, "[N15.1] D não contém a versão (mutável)");
  const plan = makePlan();
  const post = runCli(["step", "--phase", "post", "--plan", "@p", "--name", A, "--expected-version", V0, ...ST, "--out-version", "@ver"], { p: plan, ...state({ removed: [A], chain: [V1, V0] }) });
  assert.ok(post.out.split("\n").includes(`TRANSITION S0->S1 name=${A} digest_before=${plan.chain[0].digest} digest_after=${plan.chain[1].digest} version_before=${V0} version_after=${V1} code=preserved`), "[N15.2] cada transição registra D antes/depois e V antes/depois");
  const bad = (st, code) => { assert.throws(() => snapOf(st), (e) => e.message === code, "[N15.3] rejeita: " + code); };
  const dupList = S0(); dupList.l = [...dupList.l, { name: "DATABASE_URL", type: "secret_text" }]; bad(dupList, "secret_list_duplicate_name");
  const dupBind = S0(); dupBind.s.result.bindings.push({ name: "PUBLIC_BASE_URL", type: "plain_text", text: "x" }); bad(dupBind, "settings_duplicate_binding_name");
  const incType = S0(); incType.s.result.bindings = incType.s.result.bindings.map((b) => (b.name === "DATABASE_URL" ? { ...b, type: "plain_text" } : b)); bad(incType, "inventory_inconsistent_type");
  assert.throws(() => validateEntries([{ name: "X", type: "plain_text", origin: "binding" }, { name: "X", type: "json", origin: "binding" }]), /inventory_inconsistent_type/, "[N15.3] mesmo nome e origem com tipos diferentes");
  assert.throws(() => validateEntries([{ name: "X", type: "plain_text", origin: "binding" }, { name: "X", type: "plain_text", origin: "binding" }]), /inventory_duplicate_name/, "[N15.3] nome repetido na mesma origem");
  assert.throws(() => validateEntries([{ name: "X", type: "plain_text", origin: "dashboard" }]), /inventory_unknown_origin/, "[N15.4] origem desconhecida");
  assert.throws(() => validateEntries([{ name: "X", origin: "binding" }]), /inventory_entry_incomplete/, "[N15.5] entrada sem tipo");
  const noBind = S0(); noBind.l = [...noBind.l, { name: "SO_NA_LISTA", type: "secret_text" }]; bad(noBind, "inventory_incomplete_secret_without_binding");
  const noList = S0(); noList.l = noList.l.filter((s) => s.name !== "DATABASE_URL"); bad(noList, "inventory_incomplete_secret_list");
  const missType = S0(); missType.l = missType.l.map((s) => (s.name === "DATABASE_URL" ? { name: s.name } : s)); bad(missType, "secret_list_missing_type");
  const bindNoType = S0(); delete bindNoType.s.result.bindings.find((b) => b.name === "PUBLIC_BASE_URL").type; bad(bindNoType, "settings_binding_missing_type");
  const pageS = S0(); pageS.s.result_info = { page: 1, total_pages: 2 }; bad(pageS, "settings_pagination_not_exhausted");
  const pageD = S0(); pageD.d.result_info = { page: 1, per_page: 1, total_count: 5, total_pages: 1 }; bad(pageD, "deployments_pagination_not_exhausted");
  const errS = S0(); errS.s.errors = [{ code: 1 }]; bad(errS, "settings_with_errors");
  const noCreated = S0(); delete noCreated.d.result.deployments[0].created_on; bad(noCreated, "deployment_missing_created_on");
  const noRt = S0(); delete noRt.v.result.resources.script_runtime; bad(noRt, "version_detail_incomplete");
  const dupVer = S0(); dupVer.v.result.resources.bindings.push({ name: "PUBLIC_BASE_URL", type: "plain_text", text: "y" }); bad(dupVer, "version_detail_duplicate_binding_name");
  const disagree = S0(); disagree.v.result.resources.bindings = disagree.v.result.resources.bindings.filter((b) => b.name !== "PUBLIC_BASE_URL"); bad(disagree, "inventory_sources_disagree");
  const refused = runCli(["plan", ...ST, "--confirmation", CONFIRMATION_PHRASE, "--expected-digest", DIGEST0(), "--expected-version", V0, "--out", "@out"], dupList);
  assert.deepEqual([refused.code, refused.plan], [2, null], "[N15.6] CLI: inventário inválido => código 2, sem plano");
  const badPlan = { ...plan, entries: [...plan.entries, { name: "X", type: "plain_text", origin: "dashboard" }] };
  assert.equal(runCli(["step", "--phase", "pre", "--plan", "@p", "--name", A, "--expected-version", V0, ...ST], { p: badPlan, ...S0() }).code, 2, "[N15.6] plano com origem desconhecida: código 2");
  const mixed = S0(); mixed.l.sort((a, b) => (a.name < b.name ? 1 : -1)); mixed.s.result.bindings.reverse(); mixed.v.result.resources.bindings.reverse();
  mixed.v.result.resources.script.handlers.reverse(); mixed.d = deployments(V0, VX); mixed.d.result.deployments.reverse();
  let m = null;
  assert.doesNotThrow(() => { m = snapOf(mixed); }, "[N15.7] ordem das APIs não pode quebrar a leitura (efetivo = deployment mais recente por created_on)");
  assert.deepEqual([m.digest, canonicalJson(m.doc), m.effective.id, m.effective.previous], [s0.digest, canonicalJson(s0.doc), V0, VX], "[N15.7] ordem das APIs não muda documento, digest nem versão efetiva");
});
