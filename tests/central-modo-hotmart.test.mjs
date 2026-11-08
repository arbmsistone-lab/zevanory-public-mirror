// Central em modo Hotmart (reabertura de 08/11 só pela Hotmart, 5 kits). O interruptor completo sales:open:v1 segue
// FECHADO (checkout próprio, recuperação de carrinho e a assinatura Conteúdo Pronto continuam desligados); o canal
// sales:hotmart:v1 (readHotmartSwitch, /api/sales/hotmart-status) abre só os 5 kits. Falha de leitura = fechado.
// Cobre: helper purchaseOpenFor, blog (CTA), atendimento (support-knowledge), nutrição de leads (ofertas e retidos sem
// descarte de 30 dias), legendas do cross-post, ligações no Worker central e os dois workflows corrigidos.
// Só fakes locais: nenhuma rede, nenhum KV/banco real, nenhum e-mail enviado.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTextNormalized } from "./helpers/text.mjs";
import { requireTool } from "./helpers/toolchain.mjs";
import { fakeDb, kv as leadKv, mailbox } from "./helpers/p09-lead-fakes.mjs";
import { resetSalesSwitchCache, resetHotmartSwitchCache, handleSalesControl } from "../worker/sales-control.mjs";
import { purchaseOpenFor, hotmartKitsOpen, readPurchaseMode, hotmartKit, HOTMART_KIT_SLUGS, hotmartLockViolations } from "../worker/sales-lock-content.mjs";
import { renderBlogArticle } from "../worker/multichannel-autonomy.mjs";
import { answerSupportQuestion, handleSupportKnowledge } from "../worker/support-knowledge.mjs";
import { runLeadNurture, subjectRef, NURTURE_DONE } from "../worker/lead-magnet.mjs";
import { planShort } from "../scripts/channels/youtube-daily-short.mjs";
import { captionFor } from "../scripts/channels/short-crosspost.mjs";
import { CLOSED_LABEL, DELIVERY_72H, hasCheckoutCta } from "../worker/politica-unica.mjs";

const HOTMART = "sales:hotmart:v1", SALES = "sales:open:v1", PREFLIGHT = "zpc-sales-preflight:v1";
const nowIso = () => new Date(Date.now() - 60_000).toISOString();
const owner = (extra = {}) => JSON.stringify({ enabled: true, authorization: "LIBERAR VENDAS", by: "owner-test", at: nowIso(), ref: "teste/central-hotmart", ...extra });
function store(state = "hotmart", extra = {}) {
  const m = new Map(Object.entries(extra));
  if (state === "hotmart") m.set(HOTMART, owner({ channel: "hotmart" }));
  if (state === "full") { m.set(SALES, owner()); m.set(PREFLIGHT, JSON.stringify({ ok: true, at: nowIso() })); }
  return { m, async get(k) { if (state === "throw" && k === HOTMART) throw new Error("kv_down"); return m.get(k) ?? null; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); } };
}
const fresh = () => { resetSalesSwitchCache(); resetHotmartSwitchCache(); };

test("helper: purchaseOpenFor = interruptor completo OU (modo Hotmart E um dos 5 kits); falha de leitura = fechado", async () => {
  fresh();
  const hm = { ZEVANORY_PRIVATE_ARTIFACTS: store("hotmart") };
  assert.deepEqual(HOTMART_KIT_SLUGS, ["ia-na-pratica", "vendas-na-pratica", "lucro-e-caixa", "combo-ia-vendas", "negocio-completo"]);
  for (const k of ["ZEV-IA-011", "ZEV-VEN-011", "ZEV-LCX-011", "ZEV-CMB-011", "ZEV-NGC-011", ...HOTMART_KIT_SLUGS]) assert.equal(await purchaseOpenFor(hm, k), true, k);
  assert.deepEqual([hotmartKit("ZEV-LCX-011").price, hotmartKit("combo-ia-vendas").price, hotmartKit("ZEV-NGC-011").price], [147, 157, 247]);
  assert.equal(await purchaseOpenFor(hm, "conteudo-pronto"), false, "assinatura segue o interruptor completo");
  assert.deepEqual(await readPurchaseMode(hm), { full: false, hotmart: true });
  // O interruptor completo continua fechado: /api/sales/status responde open=false; /api/sales/hotmart-status, open=true.
  const st = await (await handleSalesControl(new Request("https://zevanory.api.br/api/sales/status"), hm)).json();
  const hs = await (await handleSalesControl(new Request("https://zevanory.api.br/api/sales/hotmart-status"), hm)).json();
  assert.equal(st.open, false); assert.equal(hs.open, true);
  for (const s of ["closed", "throw"]) { fresh(); assert.equal(await purchaseOpenFor({ ZEVANORY_PRIVATE_ARTIFACTS: store(s) }, "ZEV-IA-011"), false, s); assert.equal(await hotmartKitsOpen({ ZEVANORY_PRIVATE_ARTIFACTS: store(s) }), false, s); }
  fresh(); assert.equal(await hotmartKitsOpen({}), false); assert.equal(await purchaseOpenFor(null, "ZEV-IA-011"), false);
  fresh(); assert.equal(await purchaseOpenFor({ ZEVANORY_PRIVATE_ARTIFACTS: store("full") }, "conteudo-pronto"), true, "interruptor completo abre tudo");
  fresh();
});

test("blog: no modo Hotmart o CTA vai à página do kit com o preço; fechado ou leitura com erro mantém o aviso", async () => {
  const article = { slug: "caixa-2026-11-08", title: "Rotina de caixa", description: "Passo a passo.", publishedAt: "2026-11-08T12:00:00Z", url: "https://zevanory.api.br/blog/caixa-2026-11-08", day: "2026-11-08", product: "ZEV-LCX-011", body: "Separe entradas e saídas.", faq: [] };
  const kv = (state) => store(state, { "zpc:blog:article:caixa-2026-11-08": JSON.stringify(article) });
  fresh();
  const html = await renderBlogArticle({ ZEVANORY_PRIVATE_ARTIFACTS: kv("hotmart") }, article.slug);
  assert.match(html, /<a href="https:\/\/vendas\.zevanory\.api\.br\/lucro-e-caixa\?utm_source=blog&utm_medium=organic&utm_campaign=blog_20261108">Conhecer o produto<\/a>/);
  assert.match(html, /Lucro &amp; Caixa: R\$ 147,00 · pagamento pela Hotmart\./);
  assert.doesNotMatch(html, /\/comprar\//); assert.ok(!html.includes("Preço informativo"));
  for (const state of ["closed", "throw"]) {
    fresh();
    const closed = await renderBlogArticle({ ZEVANORY_PRIVATE_ARTIFACTS: kv(state) }, article.slug);
    assert.ok(closed.includes(`Preço informativo: ${CLOSED_LABEL}.`), state); assert.doesNotMatch(closed, /R\$ 147|Hotmart\./, state);
  }
  fresh();
  assert.match(await renderBlogArticle({ ZEVANORY_PRIVATE_ARTIFACTS: kv("closed") }, article.slug, { salesOpen: true, hotmartOpen: true }), /\/comprar\/ZEV-LCX-011\?/, "interruptor completo prevalece");
  fresh();
});

test("atendimento: kits à venda pela Hotmart no modo Hotmart; Conteúdo Pronto indisponível sem o interruptor completo", async () => {
  const kit = answerSupportQuestion({ product: "combo-ia-vendas", question: "Quanto custa?", salesOpen: false, hotmartOpen: true });
  assert.ok(kit.answer.includes("R$ 157,00") && kit.answer.includes("Está à venda: a compra é feita pela Hotmart, a partir da página https://vendas.zevanory.api.br/combo-ia-vendas."), kit.answer);
  assert.ok(!kit.answer.includes(CLOSED_LABEL + "."), "sem 'vendas fechadas' para o kit");
  for (const [salesOpen, hotmartOpen] of [[false, true], [false, false], [undefined, undefined]]) {
    for (const q of ["Quanto custa?", "O que vem no conteúdo?"]) {
      const cp = answerSupportQuestion({ product: "conteudo-pronto", question: q, salesOpen, hotmartOpen });
      assert.match(cp.answer, q.startsWith("Quanto") ? /não está disponível para novas contratações/ : new RegExp("No momento, " + CLOSED_LABEL), `${salesOpen}/${hotmartOpen}: ${q}`);
      assert.doesNotMatch(cp.answer, /R\$/, "sem preço da assinatura fechada");
      assert.equal(hasCheckoutCta(cp.answer), false);
    }
  }
  assert.match(answerSupportQuestion({ product: "conteudo-pronto", question: "Quanto custa?", salesOpen: true }).answer, /R\$ 197,00/, "aberta só com o interruptor completo");
  assert.match(answerSupportQuestion({ product: "ia-na-pratica", question: "Quanto custa?", salesOpen: false }).answer, new RegExp("No momento, " + CLOSED_LABEL), "fechado continua avisando");
  // Rota HTTP lê os dois interruptores (KV): modo Hotmart => kit à venda; leitura com erro => fechado.
  const ask = async (state) => { fresh(); return (await (await handleSupportKnowledge(new Request("https://zevanory.api.br/api/support/knowledge?product=lucro-e-caixa&q=quanto%20custa"), { ZEVANORY_PRIVATE_ARTIFACTS: store(state) })).json()).answer; };
  assert.match(await ask("hotmart"), /R\$ 147,00 .*Hotmart/);
  assert.match(await ask("throw"), new RegExp(CLOSED_LABEL));
  fresh();
});

test("nutrição: ofertas saem no modo Hotmart; lead retido pela trava não é descartado depois de 30 dias; descadastro respeitado", async () => {
  const db = fakeDb(); const sent = mailbox(); const kvs = leadKv();
  const env = { DATABASE_URL: "x", RESEND_API_KEY: ["fake", "mailer", "key"].join("-"), LEAD_PRIVACY_SECRET: "a".repeat(40), ZEVANORY_PRIVATE_ARTIFACTS: kvs };
  const ref = await subjectRef(env, "lead@empresa.com.br");
  const old = new Date(Date.now() - 40 * 86400e3).toISOString();
  db.rows.set("lead@empresa.com.br", { email: "lead@empresa.com.br", email_hash: "", subject_ref: ref, name: "Bia", consent_version: "lead-magnet-v1-2026-10-07", status: "confirmed", nurture_step: 2, nurture_at: old });
  db.rows.set("saiu@empresa.com.br", { email: "saiu@empresa.com.br", email_hash: "", subject_ref: "r2", name: "", consent_version: "lead-magnet-v1-2026-10-07", status: "unsubscribed", nurture_step: 2, nurture_at: old });
  kvs.m.set("zpc:lead:interest:" + ref, "caixa");
  const held = await runLeadNurture(env, { sqlFactory: db.factory, salesOpen: false, hotmartOpen: false });
  assert.equal(held.held, 1); assert.equal(sent.length, 0);
  assert.equal(db.rows.get("lead@empresa.com.br").nurture_step, 2, "retido pela trava há 40 dias: continua no passo 2 (não é encerrado)");
  assert.notEqual(db.rows.get("lead@empresa.com.br").nurture_step, NURTURE_DONE);
  const out = await runLeadNurture(env, { sqlFactory: db.factory, salesOpen: false, hotmartOpen: true });
  assert.equal(out.sent, 1, "modo Hotmart: a oferta do kit sai");
  assert.equal(sent.length, 1); assert.deepEqual(sent[0].to, ["lead@empresa.com.br"], "descadastrado não recebe");
  assert.match(sent[0].text, /Lucro & Caixa \(R\$ 147, pagamento único\)/);
  assert.ok(sent[0].text.includes("Entrega: " + DELIVERY_72H), "entrega na área de compras da Hotmart");
  assert.doesNotMatch(sent[0].text, /\/comprar\/|pay\.hotmart/);
  assert.match(sent[0].headers["List-Unsubscribe"], /material-gratuito\/sair/, "descadastro em um clique continua");
  assert.equal(db.rows.get("lead@empresa.com.br").nurture_step, 3);
});

test("cross-post: no modo Hotmart a legenda só leva o caminho /hotmart/<slug> do kit; qualquer outro link é recusado", () => {
  const plan = { ...planShort("2026-11-09", { hotmartOpen: true }), salesOpen: true };
  assert.equal(plan.purchase, "hotmart");
  for (const ch of ["telegram", "instagram", "facebook", "tiktok"]) {
    const c = captionFor(plan, ch, { salesOpen: true });
    assert.deepEqual(hotmartLockViolations(c, plan.entry.product.sku), [], ch + ": " + c);
    if (ch !== "tiktok") assert.match(c, /https:\/\/vendas\.zevanory\.api\.br\/hotmart\/ia-na-pratica\?utm_source=/, ch);
  }
  const bad = { ...plan, link: "https://vendas.zevanory.api.br/comprar/ZEV-IA-011?utm_source=youtube" };
  assert.throws(() => captionFor(bad, "telegram", { salesOpen: true }), /caption_outside_hotmart_kit/);
  const closed = planShort("2026-11-09");
  assert.equal(hasCheckoutCta(captionFor(closed, "telegram")), false, "fechado continua sem chamada de compra");
});

test("Worker central: chats leem /api/sales/hotmart-status e a nutrição horária recebe o modo Hotmart", () => {
  const src = readTextNormalized(new URL("../worker/cloudflare-worker.compat.mjs", import.meta.url));
  const reads = src.match(/hotmartOpen\s*:\s*async\s*\(\)\s*=>\s*\{\s*const st\s*=\s*await handleSalesControl\(new Request\("https:\/\/zevanory\.api\.br\/api\/sales\/hotmart-status"/g) || [];
  assert.equal(reads.length, 2, "chat público e chat interno");
  assert.match(src, /const nurtureHotmartOpen = !salesOpen && \(await hotmartKitsOpen\(normalized\)\);/);
  assert.match(src, /runLeadNurture\(normalized, \{ sqlFactory: whatsappProofDatabase, salesOpen, hotmartOpen: nurtureHotmartOpen \}\)/);
  assert.doesNotMatch(src, /applySalesSwitch\([^)]*hotmart/i, "o modo Hotmart nunca abre o interruptor completo do bundle");
});

test("workflows: SLOT exportado ao cross-post; p18 não falha sem linhas FAIL e mantém o código do node", () => {
  const yt = readTextNormalized(new URL("../.github/workflows/youtube-autonomous-short.yml", import.meta.url));
  assert.match(yt, /echo "SLOT=\$SLOT" >> "\$GITHUB_ENV"/);
  assert.match(yt, /short-crosspost\.mjs --slot="\$\{SLOT:-oferta\}"/);
  const wf = readTextNormalized(new URL("../.github/workflows/p18-commercial-check.yml", import.meta.url));
  const step = wf.slice(wf.indexOf("- name: Verificação comercial live"), wf.indexOf("- name: Relatório"));
  const line = step.split("\n").find((l) => l.includes("P18_COMMERCIAL_FAIL"));
  assert.ok(line, "linha do FAIL encontrada");
  requireTool("bash");
  const dir = mkdtempSync(join(tmpdir(), "zev-p18-"));
  try {
    const run = (body, script) => { writeFileSync(join(dir, "live.txt"), body); return spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], { env: { ...process.env, RUNNER_TEMP: dir }, encoding: "utf8" }); };
    const ok = run("P18_COMMERCIAL PASS 12/12\n", line.trim() + "\necho AFTER");
    assert.equal(ok.status, 0, "zero linhas FAIL não derrubam o passo: " + ok.stderr); assert.match(ok.stdout, /AFTER/);
    const bad = run("FAIL x1\nFAIL x2\n", line.trim());
    assert.equal(bad.status, 0); assert.match(bad.stdout, /::error title=P18_COMMERCIAL_FAIL::FAIL x1/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.match(step, /code=\$\{PIPESTATUS\[0\]\}[\s\S]*exit "\$code"/, "o resultado do passo continua sendo o do node");
});

test("Short: sem leitura da pausa (sem KV) o job não publica nada (fail-closed)", () => {
  const env = { ...process.env, CLOUDFLARE_API_TOKEN: "", YOUTUBE_CLIENT_ID: "", GEMINI_API_KEY: "" };
  const r = spawnSync(process.execPath, ["scripts/channels/youtube-daily-short.mjs", "--slot=oferta", "--day=2026-11-08"], { cwd: new URL("..", import.meta.url), env, encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /sales_open=false hotmart_open=false/);
  assert.match(r.stdout, /creative_autopublish_paused_or_unknown: no Short published/);
  assert.doesNotMatch(r.stdout, /window /, "parou antes de planejar/renderizar");
});
