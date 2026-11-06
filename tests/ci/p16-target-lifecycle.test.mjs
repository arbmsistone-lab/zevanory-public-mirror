// P16 segue P13 (PR #878): scripts/portfolio_target_lifecycle.py executado de verdade (python3, main() real) com o
// fetch somente-leitura trocado por fixtures (tests/helpers/p16_lifecycle_harness.py): nenhuma rede, nunca produção.
// Fixtures: tests/fixtures/p16/status-*.json (GET /api/sales/status no formato de worker/sales-control.mjs) e
// release-*.json (GET /api/release). HTML: a forma FECHADA é a página real publicada sales-public/<slug>.html; a forma
// ABERTA é a mesma página passada por openSalesHtml() (worker/sales-public-worker.mjs), a restauração do Worker.
// Fora de tests/*.test.mjs de propósito (roda no job p16-lifecycle-contract). Cada asserção leva [Ln.k].
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireTool } from "../helpers/toolchain.mjs";
import { openSalesHtml } from "../../worker/sales-public-worker.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const HARNESS = join(ROOT, "tests", "helpers", "p16_lifecycle_harness.py");
const FIX = (n) => JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "p16", n), "utf8"));
const SKUS = { "ia-na-pratica": "ZEV-IA-011", "vendas-na-pratica": "ZEV-VEN-011", "lucro-e-caixa": "ZEV-LCX-011", "combo-ia-vendas": "ZEV-CMB-011", "negocio-completo": "ZEV-NGC-011" };
const SLUGS = Object.keys(SKUS);
const S = "negocio-completo";
const CLOSED = (slug = S) => readFileSync(join(ROOT, "sales-public", `${slug}.html`), "utf8");
const OPEN = (slug = S) => openSalesHtml(CLOSED(slug), slug);
const ST = { closed: FIX("status-closed.json"), closedBlocked: FIX("status-closed-blocked.json"), open: FIX("status-open.json") };
const REL = { blocked: FIX("release-globally-blocked.json"), enabled: FIX("release-enabled.json") };
const raw = (body, code = 200) => ({ code, raw: typeof body === "string" ? body : JSON.stringify(body) });
const inject = (html, frag) => html.replace("</body>", frag + "</body>");

function run({ slug = S, status, release, html, pageCode = 200 }) {
  requireTool("python3");
  const dir = mkdtempSync(join(tmpdir(), "zev-p16-"));
  try {
    const casePath = join(dir, "case.json");
    writeFileSync(casePath, JSON.stringify({ slug, status, release, page_code: pageCode, page_html: html, evidence_dir: join(dir, "evidence") }));
    const r = spawnSync("python3", ["-I", "-B", HARNESS, ROOT, casePath], { encoding: "utf8", windowsHide: true });
    const line = String(r.stdout || "").split(/\r?\n/).find((l) => l.startsWith("{"));
    assert.ok(line, "[L0.1] harness sem JSON: " + String(r.stderr || r.stdout).slice(-600));
    const res = JSON.parse(line);
    assert.notEqual(res.label, "HARNESS_ERROR", "[L0.2] erro de harness: " + res.detail);
    return res;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const failsWith = (res, label, marker) => {
  assert.equal(res.ok, false, `${marker} deveria falhar com ${label}, passou`);
  assert.equal(res.label, label, `${marker} rótulo esperado ${label}, obtido ${res.label} (${res.detail})`);
};

test("L1 vendas fechadas: as 5 páginas reais fechadas passam no P16 (forma fechada exigida)", () => {
  for (const slug of SLUGS) {
    for (const status of [ST.closed, ST.closedBlocked]) {
      const r = run({ slug, status, release: REL.blocked, html: CLOSED(slug) });
      assert.equal(r.ok, true, `[L1.1] ${slug}: fechada deveria passar: ${r.label} ${r.detail}`);
      const e = r.evidence;
      assert.equal(e.sales_mode, "globally-blocked", `[L1.2] ${slug} sales_mode`);
      assert.equal(e.sales_switch_open, false, `[L1.2] ${slug} switch`);
      assert.equal(e.live_surface, "closed", `[L1.2] ${slug} superfície`);
      assert.equal(e.checks.LIVE_SURFACE_MATCHES_SWITCH, "PASS", `[L1.2] ${slug} check`);
      // Demais asserções do P16 intactas (ciclo de vida simulado inteiro).
      assert.deepEqual([e.final_order_status, e.final_entitlement_status, e.final_fulfillment_status, e.provider_state.terminal, e.verdict, e.false_green],
        ["refunded", "revoked", "canceled", true, "PROVED", 0], `[L1.3] ${slug} ciclo de vida`);
    }
  }
});

test("L2 vendas abertas: as 5 páginas restauradas por openSalesHtml passam (botão de compra exigido)", () => {
  for (const slug of SLUGS) {
    const html = OPEN(slug);
    assert.ok(html.includes(`href="/comprar/${SKUS[slug]}"`), `[L2.0] fixture aberta sem /comprar/ (${slug})`);
    const r = run({ slug, status: ST.open, release: REL.enabled, html });
    assert.equal(r.ok, true, `[L2.1] ${slug}: aberta deveria passar: ${r.label} ${r.detail}`);
    assert.deepEqual([r.evidence.sales_mode, r.evidence.sales_switch_open, r.evidence.live_surface, r.evidence.verdict], ["enabled", true, "open", "PROVED"], `[L2.2] ${slug}`);
  }
});

test("L3 fechado no interruptor + página aberta (com /comprar/) falha", () => {
  failsWith(run({ status: ST.closed, release: REL.blocked, html: OPEN() }), "closed_buy_href_present", "[L3.1]");
});

test("L4 aberto no interruptor + página fechada falha (sem destino de compra)", () => {
  failsWith(run({ status: ST.open, release: REL.enabled, html: CLOSED() }), "buy_target_missing", "[L4.1]");
});

test("L5 fechado: /comprar/ fora de link visível (script) também falha", () => {
  const html = inject(CLOSED(), `<script>window.zevBuy="/comprar/${SKUS[S]}"</script>`);
  failsWith(run({ status: ST.closed, release: REL.blocked, html }), "closed_buy_href_present", "[L5.1]");
});

test("L6 fechado: checkout externo falha", () => {
  const html = inject(CLOSED(), `<a class="button" href="https://pay.hotmart.com/X0000">Garantir vaga</a>`);
  failsWith(run({ status: ST.closed, release: REL.blocked, html }), "closed_external_checkout_present", "[L6.1]");
});

test("L7 fechado: botão de compra visível falha; o rótulo em data-zev-open-text não é botão", () => {
  assert.ok(CLOSED().includes('data-zev-open-text="Comprar agora'), "[L7.0] a página fechada real guarda o rótulo aberto no atributo");
  const html = inject(CLOSED(), `<button type="button" class="button primary">Comprar agora</button>`);
  failsWith(run({ status: ST.closed, release: REL.blocked, html }), "closed_buy_cta_present", "[L7.1]");
});

test("L8 fechado: Offer InStock falha", () => {
  const html = inject(CLOSED(), `<script type="application/ld+json">{"@type":"Offer","availability":"https://schema.org/InStock"}</script>`);
  failsWith(run({ status: ST.closed, release: REL.blocked, html }), "closed_instock_present", "[L8.1]");
});

test("L9 fechado: CTA de lista de espera do próprio SKU é obrigatório", () => {
  const noText = CLOSED().replaceAll(">Entrar na lista de espera</a>", ">Avise-me</a>");
  failsWith(run({ status: ST.closed, release: REL.blocked, html: noText }), "closed_waitlist_cta_missing", "[L9.1]");
  const otherSku = CLOSED().replaceAll(`data-zev-sku="${SKUS[S]}"`, 'data-zev-sku="ZEV-IA-011"');
  failsWith(run({ status: ST.closed, release: REL.blocked, html: otherSku }), "closed_waitlist_cta_missing", "[L9.2]");
  const deadHref = CLOSED().replace(/<a ([^>]*?)href="[^"]*" data-zev-sku=/g, '<a $1href="#" data-zev-sku=');
  failsWith(run({ status: ST.closed, release: REL.blocked, html: deadHref }), "closed_waitlist_cta_missing", "[L9.3]");
});

test("L10 fechado: rótulo 'vendas temporariamente fechadas' é obrigatório", () => {
  const html = CLOSED().replace(/vendas temporariamente fechadas/gi, "consulte");
  failsWith(run({ status: ST.closed, release: REL.blocked, html }), "closed_label_missing", "[L10.1]");
});

test("L11 aberto: CTA de lista de espera remanescente (estado misto) falha", () => {
  const html = inject(OPEN(), `<a class="button" href="mailto:x@zevanory.api.br">Entrar na lista de espera</a>`);
  failsWith(run({ status: ST.open, release: REL.enabled, html }), "open_waitlist_still_present", "[L11.1]");
});

test("L12 aberto: rótulo de vendas fechadas remanescente falha", () => {
  const html = inject(OPEN(), `<p class="microcopy">Preço informativo: vendas temporariamente fechadas.</p>`);
  failsWith(run({ status: ST.open, release: REL.enabled, html }), "open_closed_label_still_present", "[L12.1]");
});

test("L13 aberto: destino de compra de outro SKU falha", () => {
  const html = inject(OPEN(), `<a href="/comprar/ZEV-IA-011" rel="nofollow">Comprar agora · R$ 97</a>`);
  failsWith(run({ status: ST.open, release: REL.enabled, html }), "open_foreign_buy_target", "[L13.1]");
});

test("L14 aberto: 'Comprar agora' precisa ser link para /comprar/<SKU> (não basta o texto solto)", () => {
  const html = inject(OPEN().replaceAll(`href="/comprar/${SKUS[S]}"`, 'href="#oferta"'), `<p>Referência: /comprar/${SKUS[S]}</p>`);
  failsWith(run({ status: ST.open, release: REL.enabled, html }), "open_buy_anchor_missing", "[L14.1]");
});

test("L15 status ilegível falha fechado (nunca vira aberto nem fechado)", () => {
  for (const [m, status] of [["[L15.1]", raw({ open: false }, 503)], ["[L15.2]", raw("<html>erro</html>")], ["[L15.3]", { network_error: true }], ["[L15.4]", raw([false])]]) {
    failsWith(run({ status, release: REL.blocked, html: CLOSED() }), "sales_status_unreadable", m);
  }
});

test("L16 status ambíguo falha fechado", () => {
  for (const [m, body] of [["[L16.1]", { open: "true" }], ["[L16.2]", {}], ["[L16.3]", { open: 1 }], ["[L16.4]", { open: true, blocked: "release_or_financial_proof_pending" }], ["[L16.5]", { open: null }]]) {
    failsWith(run({ status: raw(body), release: REL.blocked, html: CLOSED() }), "sales_status_ambiguous", m);
  }
});

test("L17 sales_mode do release precisa casar com o interruptor", () => {
  failsWith(run({ status: ST.closed, release: REL.enabled, html: CLOSED() }), "sales_mode_mismatch", "[L17.1]");
  failsWith(run({ status: ST.open, release: REL.blocked, html: OPEN() }), "sales_mode_mismatch", "[L17.2]");
});

test("L18 garantia e identificação do fornecedor continuam exigidas nos dois estados", () => {
  failsWith(run({ status: ST.closed, release: REL.blocked, html: CLOSED().replaceAll("7 dias", "sete") }), "guarantee_missing", "[L18.1]");
  failsWith(run({ status: ST.open, release: REL.enabled, html: OPEN().replaceAll("CNPJ 69.077.233/0001-99", "CNPJ") }), "supplier_identification_missing", "[L18.2]");
});
