// Reauditoria do PR #946 (N-H1, N-M2, KV): contrato de CTA com as vendas fechadas.
//   * N-H1: intenção de atendimento, produto, processador de pagamento, necessidade de suporte e elegibilidade de CTA
//     são coisas separadas. Citar a Hotmart num pedido de reembolso, cancelamento ou informação de pagamento não muda a
//     intenção; a guarda de CTA só decide o TEXTO da resposta.
//   * N-M2: com SALE_GLOBALLY_ENABLED=false (e o interruptor do proprietário fechado ou ilegível) nenhum CTA comercial
//     volta: detector completo (inclui "Assine agora na Hotmart"), guardas de e-mail, legenda e chat ligadas a ele,
//     checkout fechado e páginas /hotmart/ pausadas.
//   * KV: falha do KV mantém tudo fechado (interruptor de vendas, chat) em vez de abrir.
// Marcadores [Cn.k].
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { readTextNormalized } from "./helpers/text.mjs";
import { hasCheckoutCta, SUPPORT_SUBSCRIPTION_REFUND_ANSWER } from "../worker/politica-unica.mjs";
import { classify, composeReply, guardReply, validateSiteReply, readSiteChatFlags, resetSiteChatState, SUPPORT_INTENTS } from "../worker/site-chat.mjs";
import { readSalesSwitch, resetSalesSwitchCache } from "../worker/sales-control.mjs";
import { evaluateCheckout } from "../worker/commercial-checkout-guard.mjs";
import { nurtureEmail } from "../worker/lead-magnet.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readTextNormalized(join(ROOT, f));

test("C1 N-H1: citar a Hotmart não muda a intenção (reembolso, cancelamento, arrependimento, pagamento)", async () => {
  const cases = [
    ["quero reembolso do conteúdo pronto", "refund"],
    ["quero reembolso da minha compra na Hotmart", "refund"],
    ["comprei na hotmart e quero meu dinheiro de volta", "refund"],
    ["quero cancelar minha assinatura da hotmart", "cancellation"],
    ["como cancelo a assinatura na Hotmart?", "policy"],
    ["posso me arrepender da assinatura feita na Hotmart?", "policy"],
    ["a Hotmart aceita pix?", "condition"],
    ["como pago pela hotmart", "condition"],
  ];
  for (const [q, want] of cases) {
    const c = classify(q);
    assert.equal(c.kind === "escalate" ? c.category : c.kind, want, `[C1.1] classificação: ${q}`);
    const r = guardReply(await composeReply({ message: q, salesOpen: false }), { salesOpen: false });
    assert.equal(r.category, want, `[C1.2] intenção preservada depois da guarda: ${q}`);
    assert.notEqual(r.mode, "guard_blocked", `[C1.3] resposta oficial não é bloqueada: ${q}`);
    assert.equal(hasCheckoutCta(r.body) || /hotmart|pay\.|\/comprar\/|\/assinar\//i.test(r.body), false, `[C1.4] resposta sem CTA nem processador: ${q}`);
  }
  assert.deepEqual(validateSiteReply(SUPPORT_SUBSCRIPTION_REFUND_ANSWER, { salesOpen: false }).issues, [], "[C1.5] a resposta da assinatura passa no validador do chat");
});

test("C2 N-H1: a guarda bloqueia o texto, não a intenção; CTA real continua bloqueado com vendas fechadas", async () => {
  for (const cat of ["refund", "cancellation", "withdrawal", "payment", "delivery"]) {
    const blocked = guardReply({ body: "Peça o reembolso na sua conta Hotmart: https://pay.hotmart.com/X", mode: "escalation", category: cat, escalate: { category: cat }, actions: [] }, { salesOpen: false });
    assert.equal(blocked.mode, "guard_blocked", `[C2.1] ${cat}`);
    assert.equal(blocked.category, cat, `[C2.2] intenção ${cat} sobrevive ao bloqueio`);
    assert.equal(blocked.escalate.category, cat, `[C2.3] escalonamento com a intenção ${cat}`);
    assert.doesNotMatch(blocked.body, /hotmart|pay\./i, `[C2.4] o texto bloqueado não sai (${cat})`);
  }
  assert.equal(guardReply({ body: "Compre em /comprar/ZEV-IA-011", mode: "content", category: "content", actions: [] }, { salesOpen: false }).category, "low_confidence", "[C2.5] resposta comercial bloqueada não vira intenção de suporte");
  assert.ok(SUPPORT_INTENTS.includes("refund") && !SUPPORT_INTENTS.includes("content"), "[C2.6]");
  for (const cta of ["Assine agora na Hotmart", "Compre em https://pay.hotmart.com/ABC", "Garanta já: /comprar/ZEV-IA-011", "Assine: /assinar/conteudo-pronto", "Veja /hotmart/ia-na-pratica", "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=1"]) {
    assert.ok(validateSiteReply(cta, { salesOpen: false }).issues.includes("checkout"), `[C2.7] CTA bloqueado com vendas fechadas: ${cta}`);
  }
  const buy = guardReply(await composeReply({ message: "quero comprar o conteudo pronto na hotmart", salesOpen: false }), { salesOpen: false });
  assert.equal(hasCheckoutCta(buy.body), false, "[C2.8] pedido de compra com vendas fechadas: sem CTA");
  assert.ok(buy.actions.every((a) => !/comprar|assinar|hotmart|pay\./.test(String(a.href || ""))), "[C2.9] ações sem checkout");
});

test("C3 N-M2: detector de CTA completo e ligado a todas as guardas de vendas fechadas", () => {
  for (const t of ["Assine agora na Hotmart", "assine pela Hotmart", "https://hotmart.com/pt-br/marketplace/produtos/x", "https://pay.hotmart.com/X", "/hotmart/ia-na-pratica", "/comprar/ZEV-IA-011", "/assinar/conteudo-pronto", "https://go.hotmart.com/abc"]) {
    assert.equal(hasCheckoutCta(t), true, `[C3.1] ${t}`);
  }
  assert.equal(hasCheckoutCta("Peça o reembolso pela plataforma em que você assinou ou por suporte@zevanory.api.br."), false, "[C3.2] texto de suporte sem processador");
  assert.match(read("worker/politica-unica.mjs"), /\|\\\\bhotmart\\\\b", "i"\)/, "[C3.3] a palavra Hotmart continua sendo CTA (N-M2: sem enfraquecer)");
  for (const [f, re] of [
    ["worker/lead-magnet.mjs", /if \(salesOpen !== true && hasCheckoutCta\(mail\.text \+ " " \+ mail\.subject\)\) throw new Error\("nurture_checkout_cta_while_closed"\)/],
    ["scripts/channels/short-crosspost.mjs", /if \(salesOpen !== true && hasCheckoutCta\(caption\)\) throw new Error\("caption_checkout_cta_while_closed"\)/],
    ["worker/site-chat.mjs", /if \(hasCheckoutCta\(body\) \|\| CHECKOUT_RE\.test\(body\)\) issues\.push\("checkout"\)/],
    ["scripts/p09/nurture_gate.mjs", /if \(!salesOpen && hasCheckoutCta\(mail\.subject \+ " " \+ mail\.text\)\) err\(/],
  ]) assert.match(read(f), re, `[C3.4] guarda ligada ao detector: ${f}`);
  for (const step of [0, 1]) assert.equal(hasCheckoutCta(JSON.stringify(nurtureEmail(step, { name: "", optOutUrl: "u", salesOpen: false }))), false, `[C3.5] e-mail ${step} com vendas fechadas`);
  for (const step of [2, 3, 4]) assert.equal(nurtureEmail(step, { name: "", optOutUrl: "u", salesOpen: true }), null, `[C3.6] oferta antiga ${step} nunca volta`);
});

test("C4 N-M2 + KV: SALE_GLOBALLY_ENABLED=false e interruptor fechado ou KV com falha -> checkout fechado", async () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  const FISCAL_OK = { status: "DEFINIDO", decision: { regime: "fixture de teste", documento_fiscal: "fixture de teste", emissor: "fixture de teste", decided_by: "proprietario",
    accountant_ref: "fixture de teste", decided_at: "2026-10-01", procedure_ref: { kind: "repo", ref: "docs/fixture.md", contains: "fixture de teste" }, test_order_ref: "fixture de teste", owner_approval_ref: "fixture de teste" } };
  const broken = { get: async () => { throw new Error("kv_down"); }, put: async () => { throw new Error("kv_down"); } };
  const base = { SALE_GLOBALLY_ENABLED: "false", PRE_SALE_GATES_APPROVED: "true", ABSOLUTE_RELEASE_APPROVED: "true", CHECKOUT_ENABLED: "true", FINANCIAL_EVENTS_ENABLED: "true", MERCADOPAGO_ENV: "production" };
  for (const [label, kv] of [["KV com falha", broken], ["KV vazio", { get: async () => null }], ["registro corrompido", { get: async () => "{nao-json" }],
    ["aberto sem autorização do proprietário", { get: async (k) => (/preflight/.test(k) ? JSON.stringify({ ok: true, at: new Date(now - 1000).toISOString() }) : JSON.stringify({ enabled: true, at: new Date(now - 1000).toISOString() })) }]]) {
    resetSalesSwitchCache();
    const sw = await readSalesSwitch({ ZEVANORY_PRIVATE_ARTIFACTS: kv }, now);
    assert.equal(sw.enabled, false, `[C4.1] interruptor fechado: ${label}`);
    const r = await evaluateCheckout({ ...base, ZEVANORY_PRIVATE_ARTIFACTS: kv }, sw, { now, fiscal: FISCAL_OK, verify: async () => true });
    assert.equal(r.allowed, false, `[C4.2] checkout fechado: ${label}`);
  }
  resetSalesSwitchCache();
});

test("C5 N-M2 + KV: páginas públicas com o interruptor fechado ou ilegível não mostram CTA comercial; chat com KV em falha fica desligado", async () => {
  const worker = (await import("../worker/sales-public-worker.mjs")).default;
  const dir = join(ROOT, "sales-public");
  const ASSETS = { async fetch(req) { const p = decodeURIComponent(new URL(req.url).pathname); const f = normalize(join(dir, p)); try { return new Response(readFileSync(f), { status: 200, headers: { "content-type": extname(f) === ".html" ? "text/html; charset=utf-8" : "application/octet-stream" } }); } catch { return new Response("nf", { status: 404 }); } } };
  for (const [label, CORE] of [["CORE com falha", { fetch: async () => { throw new Error("down"); } }], ["CORE 500", { fetch: async () => new Response("x", { status: 500 }) }], ["open:false", { fetch: async () => Response.json({ open: false }) }], ["open:'true' (texto)", { fetch: async () => Response.json({ open: "true" }) }]]) {
    for (const path of ["/conteudo-pronto", "/ia-na-pratica", "/solucoes", "/hotmart/ia-na-pratica"]) {
      const res = await worker.fetch(new Request("https://vendas.zevanory.api.br" + path, { headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/140 Safari/537.36" } }), { ASSETS, CORE }, { waitUntil() {} });
      const html = await res.text();
      assert.doesNotMatch(html, /href="[^"]*(\/comprar\/|\/assinar\/|pay\.hotmart\.com|go\.hotmart\.com)/, `[C5.1] ${label} ${path}: sem link de compra`);
      assert.doesNotMatch(html, /schema\.org\/InStock/, `[C5.2] ${label} ${path}: sem oferta InStock`);
    }
  }
  resetSiteChatState();
  const flags = await readSiteChatFlags({ SITE_CHAT_ENABLED: "true", ZEVANORY_PRIVATE_ARTIFACTS: { get: async () => { throw new Error("kv_down"); } } }, { now: Date.now() });
  assert.equal(flags.enabled, false, "[C5.3] KV em falha: chat desligado (fail-closed)");
  resetSiteChatState();
});
