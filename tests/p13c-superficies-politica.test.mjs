// P13c: a política única (data/politica-unica.json) também fora das páginas: respostas do suporte
// (API, WhatsApp e voz), e-mails de nutrição, avaliações, posts e criativos. Prazo, entrega e
// reembolso vêm só do JSON (worker/politica-unica.mjs); com vendas fechadas (interruptor do
// proprietário, worker/sales-control.mjs) e-mails, posts e suporte não têm chamada de compra.
// Guarda de repositório: formulações divergentes proibidas em worker/, scripts/channels/, data/ e
// páginas publicadas. Mutantes reais (cópia do código em diretório temporário) mortos pelas MESMAS
// asserções usadas no código verdadeiro.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, cpSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as POL from "../worker/politica-unica.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const P = JSON.parse(readFileSync(join(ROOT, "data/politica-unica.json"), "utf8"));
const W = P.customer_wording;
const PRODUCTS = P.policy_surfaces.products;
const rel = (f) => relative(ROOT, f).split(sep).join("/");

// ---------- asserções reutilizadas (código real e mutantes) ----------
function checkSupport(mod) {
  for (const slug of PRODUCTS) {
    const refund = mod.answerSupportQuestion({ product: slug, question: "Posso pedir reembolso se não gostar?" });
    const delivery = mod.answerSupportQuestion({ product: slug, question: "Como recebo o acesso depois de pagar?" });
    assert.equal(refund.intent, "refund", slug); assert.equal(delivery.intent, "delivery", slug);
    for (const [kind, a] of [["refund", refund.answer], ["delivery", delivery.answer]]) {
      assert.ok(a.includes(W.rule_7d), `${slug}/${kind}: regra única dos 7 dias`);
      assert.match(a, /72 horas/, `${slug}/${kind}: link de 72 h`);
      assert.match(a, /um download/, `${slug}/${kind}: um download`);
      assert.match(a, /sem custo/, `${slug}/${kind}: reenvio sem custo`);
      assert.match(a, /imediata/, `${slug}/${kind}: confirmação imediata`);
      assert.match(a, /resposta conclusiva em até 5 dias/, `${slug}/${kind}: resposta em até 5 dias`);
      assert.doesNotMatch(a, /2 dias úteis/, `${slug}/${kind}`);
      assert.deepEqual(POL.bannedPolicyHits(a), [], `${slug}/${kind}: formulação divergente`);
      assert.equal(POL.hasCheckoutCta(a), false, `${slug}/${kind}: chamada de compra`);
    }
    assert.match(refund.answer, /comunica imediatamente o Mercado Pago/, slug);
    assert.match(refund.answer, /prazo do emissor/, slug);
  }
  for (const q of ["Posso pedir reembolso se não gostar?", "Como recebo o acesso depois de pagar?"]) {
    const a = mod.answerSupportQuestion({ product: "conteudo-pronto", question: q }).answer;
    assert.ok(a.includes(W.rule_7d), "assinatura: " + q);
    assert.deepEqual(POL.bannedPolicyHits(a), []);
    assert.equal(POL.hasCheckoutCta(a), false, "assinatura sem chamada de compra (Hotmart): " + q);
  }
  for (const slug of [...PRODUCTS, "conteudo-pronto"]) {
    for (const q of ["Quanto custa?", "O que vem no conteúdo?"]) {
      const closed = mod.answerSupportQuestion({ product: slug, question: q, salesOpen: false }).answer;
      assert.ok(closed.includes(P.closed_label), `${slug}: vendas fechadas avisadas`);
      assert.equal(POL.hasCheckoutCta(closed), false, `${slug}: sem chamada de compra fechado`);
    }
  }
}

function checkNurture(mod) {
  for (let s = 0; s < mod.NURTURE_DONE; s++) {
    const mail = mod.nurtureEmail(s, { name: "", optOutUrl: "https://zevanory.api.br/x", interest: "caixa" });
    if (s >= 2) { assert.equal(mail, null, `e-mail ${s} com oferta enquanto fechado`); continue; }
    assert.equal(POL.hasCheckoutCta(mail.subject + " " + mail.text), false, `e-mail ${s}: chamada de compra com vendas fechadas`);
    assert.deepEqual(POL.bannedPolicyHits(mail.text), [], `e-mail ${s}`);
  }
  for (let s = 2; s < mod.NURTURE_DONE; s++) {
    const t = mod.nurtureEmail(s, { name: "", optOutUrl: "u", salesOpen: true }).text;
    assert.deepEqual(POL.bannedPolicyHits(t), [], `e-mail ${s} aberto`);
  }
  assert.ok(mod.nurtureEmail(2, { name: "", optOutUrl: "u", salesOpen: true }).text.includes(W.rule_7d));
}

function checkCaptions(cross, yt) {
  const plan = yt.planShort("2026-10-12");
  assert.doesNotMatch(plan.link + plan.description, /\/comprar\//, "descrição/link fechado");
  for (const ch of ["instagram", "facebook", "telegram", "tiktok"]) {
    const c = cross.captionFor(plan, ch);
    assert.equal(POL.hasCheckoutCta(c), false, ch + ": chamada de compra fechado");
    assert.deepEqual(POL.bannedPolicyHits(c), [], ch);
  }
  const open = yt.planShort("2026-10-12", { salesOpen: true });
  assert.ok(cross.captionFor(open, "facebook", { salesOpen: true }).includes(W.short), "aberto: regra curta da política");
}

const SCAN_DIRS = ["worker", "scripts/channels", "data"];
const TEXT = /\.(m?js|json|html|txt|md|py|toml|ya?ml|css|svg)$/i;
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const f = join(dir, name);
    if (statSync(f).isDirectory()) walk(f, out); else if (TEXT.test(name)) out.push(f);
  }
  return out;
}
function publishedPages(root) {
  const pages = walk(join(root, "sales-public")).filter((f) => f.endsWith(".html"));
  if (existsSync(join(root, "index.html"))) pages.push(join(root, "index.html"));
  for (const d of readdirSync(root)) {
    const f = join(root, d, "index.html");
    if (!d.startsWith(".") && existsSync(f)) pages.push(f);
  }
  return pages;
}
// Política no próprio JSON: só a lista de proibidas e as notas de histórico são isentas.
function policyJsonText(raw) {
  const d = JSON.parse(raw);
  return JSON.stringify([d.sol_text, d.rule_7d, d.delivery_72h, d.customer_wording, d.resumo_oferta]);
}
function guardHits(root) {
  const hits = [];
  const files = [...SCAN_DIRS.flatMap((d) => walk(join(root, d))), ...publishedPages(root)];
  for (const f of files) {
    const r = relative(root, f).split(sep).join("/");
    let text = readFileSync(f, "utf8");
    if (r === "data/politica-unica.json") text = policyJsonText(text);
    for (const h of POL.bannedPolicyHits(text)) hits.push(`${r}: ${h}`);
  }
  return { hits, files: files.length };
}

// ---------- testes ----------
test("P13c: redação ao cliente é derivada do texto único (fragmentos literais do sol_text, sem marcador solto)", () => {
  for (const frag of W.fragmentos_sol) assert.ok(P.sol_text.includes(frag), "fragmento fora do sol_text: " + frag);
  assert.ok(W.rule_7d.replace("contados", "contado").startsWith(P.rule_7d), "regra ao cliente = regra do texto único");
  assert.ok(W.delivery.includes(P.delivery_72h));
  for (const k of ["RULE_LINE", "DELIVERY_TEXT", "REFUND_TEXT", "SUPPORT_REFUND_ANSWER", "SUPPORT_DELIVERY_ANSWER", "SUPPORT_SUBSCRIPTION_REFUND_ANSWER", "SUPPORT_SUBSCRIPTION_DELIVERY_ANSWER"]) {
    assert.doesNotMatch(POL[k], /[{}]/, k + " com marcador não resolvido");
    assert.deepEqual(POL.bannedPolicyHits(POL[k]), [], k);
  }
  assert.deepEqual([...POL.ALLOWED_DAY_COUNTS].sort(), [5, 7]);
  // Nenhum módulo de superfície escreve o prazo à mão: todos importam a fonte única.
  for (const f of ["worker/support-knowledge.mjs", "worker/lead-magnet.mjs", "worker/reviews.mjs", "worker/whatsapp-conversation.mjs", "worker/refund-flow.mjs", "scripts/channels/short-crosspost.mjs", "scripts/channels/youtube-daily-short.mjs"]) {
    const src = readFileSync(join(ROOT, f), "utf8");
    assert.match(src, /politica-unica\.mjs"/, f + " importa a política única");
    assert.doesNotMatch(src, /7 dias corridos cont/, f + " não copia a regra à mão");
  }
});

test("P13c: respostas do suporte trazem a regra única completa e nenhuma chamada de compra", async () => {
  checkSupport(await import("../worker/support-knowledge.mjs"));
});

test("P13c: rota /api/support/knowledge lê o interruptor do proprietário (fail-closed) e e-mails/legendas seguem o fechamento", async () => {
  const { handleSupportKnowledge } = await import("../worker/support-knowledge.mjs");
  const { resetSalesSwitchCache } = await import("../worker/sales-control.mjs");
  const ask = async (env) => { resetSalesSwitchCache(); return (await (await handleSupportKnowledge(new Request("https://zevanory.api.br/api/support/knowledge?product=lucro-e-caixa&q=pre%C3%A7o"), env)).json()).answer; };
  const kv = (m) => ({ get: async (k) => m[k] ?? null });
  assert.ok((await ask({})).includes(P.closed_label), "sem KV: fechado");
  assert.ok((await ask({ ZEVANORY_PRIVATE_ARTIFACTS: kv({ "sales:open:v1": JSON.stringify({ enabled: true }) }) })).includes(P.closed_label), "registro incompleto: fechado");
  const at = new Date(Date.now() - 60_000).toISOString();
  const open = await ask({ ZEVANORY_PRIVATE_ARTIFACTS: kv({ "sales:open:v1": JSON.stringify({ enabled: true, authorization: "LIBERAR VENDAS", by: "owner", at, ref: "audit-ref-1" }), "zpc-sales-preflight:v1": JSON.stringify({ ok: true, at }) }) });
  assert.ok(!open.includes(P.closed_label) && open.includes("R$ 247,00"), "aberto e autorizado: sem rótulo de fechado");
  resetSalesSwitchCache();
  checkNurture(await import("../worker/lead-magnet.mjs"));
  checkCaptions(await import("../scripts/channels/short-crosspost.mjs"), await import("../scripts/channels/youtube-daily-short.mjs"));
});

test("P13c guarda: nenhuma formulação divergente em worker/, scripts/channels/, data/ nem nas páginas publicadas", () => {
  const { hits, files } = guardHits(ROOT);
  assert.ok(files > 150, "varredura completa: " + files);
  assert.deepEqual(hits, []);
});

test("P13c mutantes: suporte com redação antiga, e-mail com /comprar fechado, oferta fechada, legenda com checkout e arquivo com 'garantia de 7 dias' são mortos", async () => {
  const mutants = {
    "M-S1 suporte volta à redação antiga do reembolso": ["worker/support-knowledge.mjs", (s) => s.replace("const REFUND = SUPPORT_REFUND_ANSWER;", 'const REFUND = "Direito de arrependimento: você pode desistir em até 7 dias após a compra e recebe o reembolso integral pelo mesmo meio de pagamento.";'), "support"],
    "M-S2 suporte sem 72 h / um download": ["worker/support-knowledge.mjs", (s) => s.replace("const DELIVERY = SUPPORT_DELIVERY_ANSWER;", 'const DELIVERY = "Entrega digital: após o pagamento você recebe por e-mail um link seguro. Respondemos em até 2 dias úteis.";'), "support"],
    "M-S3 suporte da assinatura volta a mandar para a Hotmart": ["worker/support-knowledge.mjs", (s) => s.replace('const answer = intent === "refund" ? SUPPORT_SUBSCRIPTION_REFUND_ANSWER', 'const answer = intent === "refund" ? SUPPORT_SUBSCRIPTION_REFUND_ANSWER + " Peça na sua conta Hotmart."'), "support"],
    "M-E1 e-mail com /comprar enquanto fechado": ["worker/lead-magnet.mjs", (s) => s.replace("Toda sexta, olhe três números", "Compre agora: ${SALES}/comprar/ZEV-LCX-011. Toda sexta, olhe três números"), "nurture"],
    "M-E2 oferta sai com vendas fechadas": ["worker/lead-magnet.mjs", (s) => s.replace("if (step >= 2 && salesOpen !== true) return null;", "").replace('if (salesOpen !== true && hasCheckoutCta(mail.text + " " + mail.subject)) throw new Error("nurture_checkout_cta_while_closed");', ""), "nurture"],
    "M-E3 e-mail volta a 'garantia de 7 dias'": ["worker/lead-magnet.mjs", (s) => s.replace("Se não for para você, pode desistir em ${CUSTOMER_RULE_7D}", "Tem garantia de 7 dias"), "nurture"],
    "M-C1 legenda/descrição com /comprar/ fechado": ["scripts/channels/youtube-daily-short.mjs", (s) => s.replace("const link = open ? checkout : page.toString();", "const link = checkout;"), "captions"],
    "M-C2 legenda volta a 'garantia de 7 dias'": ["scripts/channels/short-crosspost.mjs", (s) => s.replace("(open ? SHORT_RULE : CLOSED_LABEL)", '"garantia de 7 dias"'), "captions"],
    "M-G1 reviews volta a '7 dias de garantia a partir da compra'": ["worker/reviews.mjs", (s) => s.replace("Lembre: você pode desistir em", "Lembre: você tem 7 dias de garantia a partir da compra. Ou desista em"), "guard"],
    "M-G2 recibo de entrega com 'após a compra' no prazo": ["worker/cloudflare-worker.recovered.mjs", (s) => s.replace("Arrependimento: voce pode desistir em ${CUSTOMER_RULE_7D}", "Reembolso: ate 7 dias após a compra"), "guard"],
    "M-G3 página publicada com 'download imediato'": ["sales-public/solucoes.html", (s) => s.replace("</main>", "<p>Download imediato.</p></main>"), "guard"],
  };
  const report = [];
  for (const [name, [file, fn, kind]] of Object.entries(mutants)) {
    const dir = mkdtempSync(join(tmpdir(), "p13c-mut-"));
    try {
      for (const d of ["worker", "data", "scripts/channels"]) cpSync(join(ROOT, d), join(dir, d), { recursive: true });
      if (kind === "guard") cpSync(join(ROOT, "sales-public"), join(dir, "sales-public"), { recursive: true, filter: (s) => !/[\\/](brand|assets)([\\/]|$)/.test(s) });
      const target = join(dir, file), before = readFileSync(target, "utf8"), after = fn(before);
      assert.notEqual(after, before, "mutação não aplicada: " + name);
      writeFileSync(target, after);
      const load = (f) => import(pathToFileURL(join(dir, f)).href + "?m=" + encodeURIComponent(name));
      let killed = false, why = "";
      try {
        if (kind === "support") checkSupport(await load("worker/support-knowledge.mjs"));
        else if (kind === "nurture") checkNurture(await load("worker/lead-magnet.mjs"));
        else if (kind === "captions") checkCaptions(await load("scripts/channels/short-crosspost.mjs"), await load("scripts/channels/youtube-daily-short.mjs"));
        else assert.deepEqual(guardHits(dir).hits, []);
      } catch (e) { killed = true; why = String(e.message).split("\n")[0].slice(0, 110); }
      report.push(`${name}: ${killed ? "KILLED" : "SURVIVED"} ${why}`);
      assert.ok(killed, name + " sobreviveu");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  console.log(report.join("\n"));
});
