// P23 Fiscal e consumidor (parte de comércio eletrônico): contrato do gate scripts/p23/ecommerce_legal_gate.py
// (Decreto 7.962/2013, arts. 2º, 4º e 5º; CDC arts. 31 e 49) e da trava "Nenhuma venda direta pelo checkout próprio
// antes do processo fiscal definido" (worker/fiscal-process.mjs + sinal 'fiscal' do portão de checkout).
// Sem rede e sem segredo: o portão roda com verify injetado; o gate roda sobre uma cópia temporária mínima da árvore.
// Marcadores [Ln.k] identificam a asserção para o classificador de mutantes.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readTextNormalized } from "./helpers/text.mjs";
import { requireTool } from "./helpers/toolchain.mjs";
import { FISCAL_PROCESS, fiscalProcessDefined, FISCAL_DECISION_FIELDS } from "../worker/fiscal-process.mjs";
import { REQUIRED, evaluateCheckout, allowCheckout } from "../worker/commercial-checkout-guard.mjs";
import { handleSalesControl, resetSalesSwitchCache } from "../worker/sales-control.mjs";

const PYTHON = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
requireTool(PYTHON);
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(REPO, "scripts/p23/ecommerce_legal_gate.py");
const FILES = ["data/politica-unica.json", "data/products.json", "data/p23/fiscal-process.json", "data/p23/ecommerce-legal-checklist.json", "data/p23/legal-reviewers.json",
  "worker/commercial-checkout-guard.mjs", "worker/sales-control.mjs", "worker/cloudflare-worker.compat.mjs", "termos/index.html", "reembolso/index.html",
  ...readdirSync(join(REPO, "sales-public")).filter((f) => f.endsWith(".html")).map((f) => `sales-public/${f}`)];

const LEGAL = join(REPO, "scripts/p23/legal_review.py");
const fingerprint = (root) => { const r = spawnSync(PYTHON, ["-I", LEGAL, "--root", root, "--fingerprint"], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
// Aprovação no formato real (M1): revisor cadastrado pelo proprietário, nome igual, data ISO, SHA-256 do texto revisado,
// commit, versão do documento e registro auditável versionado com os mesmos campos.
const REVIEWER = { id: "rev-msouza", name: "Maria Clara Souza, OAB/CE 12345", registro: "OAB/CE 12345", github_login: "msouza-adv", authorized_by: "proprietario", authorized_at: "2026-10-20", authorization_commit: "a098d8802a184df02b362d46f08fb6c81b7382f9" };
function approval(root, over = {}, { reviewer = REVIEWER, record = {} } = {}) {
  const sha = fingerprint(root);
  const version = JSON.parse(readFileSync(join(root, "data/politica-unica.json"), "utf8")).legal_document_version;
  const review = { status: "APPROVED", reviewer_id: reviewer ? reviewer.id : "rev-nao-cadastrado", approved_by: reviewer ? reviewer.name : REVIEWER.name, approved_at: "2026-10-27", reviewed_sha256: sha,
    reviewed_commit: "b7671272b1c0b35d1bb7a20fa2489bd7c5a0f224", document_version: version, record: `docs/legal/reviews/${sha}.json`, ...over };
  mkdirSync(join(root, "data/p23"), { recursive: true });
  writeFileSync(join(root, "data/p23/legal-reviewers.json"), JSON.stringify({ schema: "zevanory-legal-reviewers/v1", reviewers: reviewer ? [reviewer] : [] }, null, 2));
  if (record !== null) {
    mkdirSync(join(root, "docs/legal/reviews"), { recursive: true });
    const r = { reviewer_id: review.reviewer_id, reviewed_sha256: review.reviewed_sha256, reviewed_commit: review.reviewed_commit, document_version: review.document_version, approved_at: review.approved_at, decision: "APPROVED", ...record };
    writeFileSync(join(root, `docs/legal/reviews/${sha}.json`), JSON.stringify(r, null, 2));
  }
  return review;
}
function gate(edits = {}, review = (root) => approval(root)) {
  const root = mkdtempSync(join(tmpdir(), "p23-"));
  try {
    for (const rel of FILES) { mkdirSync(dirname(join(root, rel)), { recursive: true }); copyFileSync(join(REPO, rel), join(root, rel)); }
    for (const [rel, fn] of Object.entries(edits)) {
      const cur = readTextNormalized(join(root, rel));
      const next = fn(cur);
      assert.notEqual(next, cur, `fixture: edição sem efeito em ${rel}`);
      writeFileSync(join(root, rel), next);
    }
    const policyPath = join(root, "data/politica-unica.json");
    const policy = JSON.parse(readTextNormalized(policyPath));
    policy.legal_review = review(root);
    writeFileSync(policyPath, JSON.stringify(policy, null, 2));
    const r = spawnSync(PYTHON, ["-I", GATE, "--root", root], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" } });
    return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const fails = (r, re, label) => { assert.equal(r.code, 1, `${label} esperado FAIL:\n${r.out}`); assert.match(r.out, re, `${label} motivo:\n${r.out}`); };
const json = (fn) => (s) => JSON.stringify(fn(JSON.parse(s)), null, 2);

const NOW = Date.parse("2026-10-25T12:00:00Z");
const FISCAL_OK = { status: "DEFINIDO", decision: { regime: "fixture de teste", documento_fiscal: "fixture de teste", emissor: "fixture de teste", decided_by: "proprietario",
  accountant_ref: "fixture de teste", decided_at: "2026-10-01", procedure_ref: { kind: "repo", ref: "docs/fixture.md", contains: "fixture de teste" }, test_order_ref: "fixture de teste", owner_approval_ref: "fixture de teste" } };
const ENV = { SALE_GLOBALLY_ENABLED: "true", PRE_SALE_GATES_APPROVED: "true", ABSOLUTE_RELEASE_APPROVED: "true", CHECKOUT_ENABLED: "true", FINANCIAL_EVENTS_ENABLED: "true",
  MERCADOPAGO_ENV: "production", ZEVANORY_PRIVATE_ARTIFACTS: { get: async () => JSON.stringify({ ok: true, at: new Date(NOW - 60_000).toISOString() }) } };
const counting = () => { const f = async () => { f.calls += 1; return true; }; f.calls = 0; return f; };

test("L1 site real permanece fail-closed enquanto a revisão jurídica está pendente", () => {
  const r = spawnSync(PYTHON, ["-I", GATE, "--root", REPO], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  assert.equal(r.status, 1, "[L1.1] " + r.stdout + r.stderr);
  assert.match(r.stdout, /REVISÃO JURÍDICA PENDENTE/, "[L1.1a]");
  assert.match(r.stdout, /P23_PAGES priced=\d+ offers=6 legal=2 fiscal_status=NAO_DEFINIDO/, "[L1.2]");
  assert.match(r.stdout, /FINDING P23-F3-FISCAL: processo fiscal NAO_DEFINIDO/, "[L1.3]");
  assert.match(r.stdout, /FINDING D7962-2-I\/II: \d+ páginas-fonte na raiz do repositório/, "[L1.4]");
  const approved = gate();
  assert.doesNotMatch(approved.out, /REVISÃO JURÍDICA PENDENTE/, "[L1.5] aprovação jurídica identificável libera apenas esse bloqueio");
});
test("L2 registro fiscal real (NAO_DEFINIDO) fecha o checkout próprio sozinho e sem tocar a rede", async () => {
  assert.equal(FISCAL_PROCESS.status, "NAO_DEFINIDO", "[L2.1]");
  assert.equal(fiscalProcessDefined(), false, "[L2.2]");
  const verify = counting();
  const r = await evaluateCheckout(ENV, { enabled: true, authorized: true }, { now: NOW, verify });
  assert.equal(r.allowed, false, "[L2.3]");
  assert.equal(r.flags.fiscal, false, "[L2.4]");
  assert.equal(verify.calls, 0, "[L2.5] token não é verificado enquanto o fiscal fecha");
  const ok = await evaluateCheckout(ENV, { enabled: true, authorized: true }, { now: NOW, verify, fiscal: FISCAL_OK });
  assert.equal(ok.allowed, true, "[L2.6] com o registro completo (fixture) e os demais sinais, abre");
});
test("L3 registro fiscal incompleto ou fora de regra nunca abre", () => {
  assert.equal(fiscalProcessDefined(FISCAL_OK, NOW), true, "[L3.1]");
  for (const k of FISCAL_DECISION_FIELDS) {
    const d = { ...FISCAL_OK.decision }; delete d[k];
    assert.equal(fiscalProcessDefined({ ...FISCAL_OK, decision: d }, NOW), false, "[L3.2] sem " + k);
  }
  for (const bad of [{ ...FISCAL_OK, status: "definido" }, { ...FISCAL_OK, decision: null }, { ...FISCAL_OK, decision: { ...FISCAL_OK.decision, decided_by: "executor" } },
    { ...FISCAL_OK, decision: { ...FISCAL_OK.decision, decided_at: "2026-12-01" } }, { ...FISCAL_OK, decision: { ...FISCAL_OK.decision, regime: "PENDENTE" } },
    { ...FISCAL_OK, decision: { ...FISCAL_OK.decision, procedure_ref: { kind: "url", ref: "x", contains: "y" } } }, null, undefined]) {
    assert.equal(fiscalProcessDefined(bad, NOW), false, "[L3.3] " + JSON.stringify(bad)?.slice(0, 80));
  }
});
test("L4 'fiscal' é sinal obrigatório do portão (estrito)", () => {
  assert.ok(REQUIRED.includes("fiscal"), "[L4.1]");
  const all = Object.fromEntries(REQUIRED.map((k) => [k, true]));
  assert.equal(allowCheckout({ ...all, fiscal: false }), false, "[L4.2]");
  assert.equal(allowCheckout({ ...all, fiscal: "true" }), false, "[L4.3]");
});
test("L5 página com preço sem CNPJ reprova", () => fails(gate({ "sales-public/solucoes.html": (s) => s.replaceAll("69.077.233/0001-99", "") }), /solucoes.html: página com preço sem 'CNPJ 69.077.233\/0001-99'/, "[L5.1]"));
test("L6 resumo da oferta sem um campo reprova", () => fails(gate({ "sales-public/lucro-e-caixa.html": (s) => s.replace(/<div data-field="restricoes">.*?<\/div>/, "") }), /lucro-e-caixa.html: Resumo da oferta sem o campo restricoes/, "[L6.1]"));
test("L7 preço do resumo diferente do catálogo reprova (CDC art. 31)", () => fails(gate({ "data/products.json": (s) => s.replace('"price": 247', '"price": 249') }), /lucro-e-caixa.html: preço total do resumo .* difere do catálogo \(R\$ 249,00\)/, "[L7.1]"));
test("L8 resumo sem arrependimento de 7 dias reprova (CDC art. 49)", () => fails(gate({ "sales-public/ia-na-pratica.html": (s) => s.replace(/(<div data-field="arrependimento"><dt>[^<]*<\/dt><dd>)[^<]*/, "$1Consulte os termos.") }), /ia-na-pratica.html: arrependimento sem '7 dias corridos'/, "[L8.1]"));
test("L9 termos sem a declaração do art. 5º, § 2º reprova", () => fails(gate({ "sales-public/termos.html": (s) => s.replace("Contratos acessórios serão cancelados sem custo", "Contratos acessórios seguem as regras próprias") }), /termos.html: falta a declaração de D7962-5-2/, "[L9.1]"));
test("L10 CNPJ com dígitos inválidos reprova", () => fails(gate({ "data/politica-unica.json": (s) => s.replace('"cnpj": "69.077.233/0001-99"', '"cnpj": "69.077.233/0001-98"') }), /dígitos verificadores inválidos/, "[L10.1]"));
test("L11 portão de checkout sem o sinal fiscal reprova", () => fails(gate({ "worker/commercial-checkout-guard.mjs": (s) => s.replace('"environment","fiscal","token"', '"environment","token"') }), /REQUIRED sem o sinal 'fiscal'/, "[L11.1]"));
test("L12 status público sem o processo fiscal reprova", async () => {
  const at = new Date(Date.now() - 60_000).toISOString();
  const sha = "a".repeat(40);
  const records = new Map([
    ["sales:open:v1", JSON.stringify({ enabled: true, authorization: "LIBERAR VENDAS", by: "owner", at, ref: "fixture-audit" })],
    ["zpc-sales-preflight:v1", JSON.stringify({ ok: true, at })],
    ["zpc-production-financial-metrics:v1", JSON.stringify({ schema: "zevanory.production-financial-proof/v1", release_sha: sha, measured_at: at, verified: true, ambiguous: 0,
      production: { paid_orders: 0, payment_events: 0, refund_events: 0, checkouts_started: 0 }, certification: { events: 0, orders_flagged: 0 }, unverified: { orders: 0 } })],
  ]);
  resetSalesSwitchCache();
  const response = await handleSalesControl(new Request("https://zevanory.api.br/api/sales/status"), {
    ZEVANORY_PRIVATE_ARTIFACTS: { get: async (key) => records.get(key) ?? null }, ZEVANORY_RELEASE_SHA: sha,
    ABSOLUTE_RELEASE_APPROVED: "true", PRE_SALE_GATES_APPROVED: "true", MERCADOPAGO_ENV: "production",
  }, { fiscal: { status: "NAO_DEFINIDO", decision: null } });
  assert.equal((await response.json()).open, false, "[L12.2] status público fica fechado pelo processo fiscal mesmo com os demais sinais verdes");
  fails(gate({ "worker/sales-control.mjs": (s) => s.replace("const open = released && fiscalProcessDefined(fiscal);", "const open = released;") }), /\/api\/sales\/status abre sem exigir/, "[L12.1]");
});
test("L13 /api/status sem o processo fiscal reprova", () => fails(gate({ "worker/cloudflare-worker.compat.mjs": (s) => s.replace('"production" &&\n        fiscalProcessDefined();', '"production";') }), /\/api\/status projeta vendas abertas/, "[L13.1]"));
test("L14 registro fiscal DEFINIDO incompleto ou NAO_DEFINIDO preenchido reprova", () => {
  fails(gate({ "data/p23/fiscal-process.json": json((d) => ({ ...d, status: "DEFINIDO", decision: { regime: "Simples", decided_by: "proprietario" } })) }), /DEFINIDO sem decision.documento_fiscal/, "[L14.1]");
  fails(gate({ "data/p23/fiscal-process.json": json((d) => ({ ...d, decision: { regime: "palpite" } })) }), /NAO_DEFINIDO não pode trazer decision/, "[L14.2]");
});
test("L15 checklist sem item obrigatório reprova", () => fails(gate({ "data/p23/ecommerce-legal-checklist.json": json((d) => ({ ...d, items: d.items.filter((i) => i.id !== "CDC-49") })) }), /item CDC-49 ausente/, "[L15.1]"));
test("L16 conferência dos dígitos do CNPJ", () => {
  const v = (c) => spawnSync(PYTHON, ["-I", GATE, "--cnpj", c], { encoding: "utf8" }).stdout.trim();
  assert.equal(v("69.077.233/0001-99"), "CNPJ_VALID", "[L16.1]");
  assert.equal(v("69.077.233/0001-98"), "CNPJ_INVALID", "[L16.2]");
  assert.equal(v("11.111.111/1111-11"), "CNPJ_INVALID", "[L16.3]");
});
test("L17 preço total sem a informação de taxas adicionais reprova (art. 2º, IV)", () => fails(gate({ "sales-public/vendas-na-pratica.html": (s) => s.replace(/(<div data-field="preco_total"><dt>[^<]*<\/dt><dd>[^<]*?)sem taxas adicionais/, "$1com valor final") }), /vendas-na-pratica.html: preço total sem a informação de taxas adicionais/, "[L17.1]"));
test("L18 página com preço sem link para os termos reprova", () => fails(gate({ "sales-public/ferramentas.html": (s) => s.replace(/href="([^"]*)\/termos(["#])/g, 'href="$1/regras$2') }), /ferramentas.html: página com preço sem link para os termos/, "[L18.1]"));
test("L19 aprovação jurídica só no formato real: pessoa, data, SHA-256 do texto revisado e commit", () => {
  const pending = /REVISÃO JURÍDICA PENDENTE/;
  fails(gate({}, () => ({ status: "PENDING", approved_by: null, approved_at: null })), pending, "[L19.1] PENDING");
  for (const who of ["fixture-jurista", "Jurista", "teste da Silva", "Proprietário ZEVANORY", "", "x"]) {
    fails(gate({}, (root) => approval(root, { approved_by: who })), /approved_by .* não identifica uma pessoa/, "[L19.2] " + JSON.stringify(who));
  }
  fails(gate({}, (root) => approval(root, { approved_at: "ontem" })), /approved_at .* não é uma data ISO/, "[L19.3] data");
  fails(gate({}, (root) => approval(root, { approved_at: "2999-01-01" })), /approved_at .* está no futuro/, "[L19.3a] futuro");
  fails(gate({}, (root) => approval(root, { reviewed_sha256: "0".repeat(64) })), /o texto mudou depois da revisão/, "[L19.4] texto revisado diferente");
  fails(gate({}, (root) => approval(root, { reviewed_commit: "HEAD" })), /reviewed_commit ausente ou inválido/, "[L19.5] commit");
  // A aprovação vale para um texto: mudar uma palavra dos termos depois da revisão volta a bloquear.
  const after = gate({}, (root) => { const a = approval(root); writeFileSync(join(root, "sales-public/termos.html"), readTextNormalized(join(root, "sales-public/termos.html")).replace("devolução integral", "devolução parcial")); return a; });
  assert.match(after.out, /o texto mudou depois da revisão/, "[L19.6] texto alterado depois da revisão");
  assert.doesNotMatch(gate().out, /approved_by|approved_at|reviewed_|PENDENTE|reviewer_id|record|document_version/, "[L19.7] aprovação válida não acusa nada");
  // Identidade autorizada, versão e registro auditável (Sol ORDEM 294): string livre não basta.
  fails(gate({}, (root) => approval(root, {}, { reviewer: null })), /não está no cadastro de revisores autorizados/, "[L19.8] revisor não cadastrado");
  fails(gate({}, (root) => approval(root, {}, { reviewer: { ...REVIEWER, authorized_by: "codex" } })), /cadastro incompleto/, "[L19.9] cadastro sem autorização do proprietário");
  fails(gate({}, (root) => approval(root, { approved_by: "Ana Beatriz Lima" })), /nome diferente de approved_by/, "[L19.10] nome diferente do cadastro");
  fails(gate({}, (root) => approval(root, { document_version: "v0" })), /document_version .* difere da versão publicada/, "[L19.11] versão");
  fails(gate({}, (root) => approval(root, {}, { record: null })), /legal_review.record ausente/, "[L19.12] sem registro auditável");
  fails(gate({}, (root) => approval(root, {}, { record: { reviewed_commit: "c".repeat(40) } })), /reviewed_commit .* difere de legal_review/, "[L19.13] registro divergente");
});
