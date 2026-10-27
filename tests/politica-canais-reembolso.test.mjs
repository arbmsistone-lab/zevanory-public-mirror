// Decisão delegada (2026-10-25): o texto único (data/politica-unica.json, sol_text) e onde ele aparece
// (termos, reembolso, privacidade, respostas do suporte) descreve os DOIS canais de arrependimento como o
// Worker realmente funciona. Correção factual; revisão jurídica recomendada, sem mudar a regra do CDC art. 49.
//   * Checkout próprio (Mercado Pago): worker/refund-flow.mjs só acha pedidos da tabela orders com pagamento
//     confirmado e estorna pela API do Mercado Pago -> zevanory.api.br/pedir-reembolso + "comunicará
//     imediatamente o Mercado Pago" valem SÓ para esse canal.
//   * Hotmart (Conteúdo Pronto e as variantes /hotmart/): worker/content-service.mjs declara que a Hotmart cuida
//     de cobrança, cancelamento e reembolso; o Worker só para o serviço no postback de reembolso/cancelamento.
// Também: nota do CEP (63540-000 confirmado como CEP geral da sede urbana, com fonte).
// As asserções ficam em funções reaplicadas a mutantes (cópias alteradas do JSON/páginas/código): cada mutante
// tem de ser morto pelas MESMAS asserções que passam no repositório verdadeiro.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readTextNormalized } from "./helpers/text.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (f) => readTextNormalized(join(ROOT, f));
const POLICY = JSON.parse(read("data/politica-unica.json"));
const MP_SENTENCE = /Nas compras pagas no checkout próprio da ZEVANORY \(Mercado Pago\),.*?\.(?=\s|$)/;
const HOTMART_SENTENCE = /Nas compras pagas pela Hotmart \(como a assinatura Conteúdo Pronto\), o cancelamento e o reembolso são processados pela Hotmart:.*?\.(?=\s|$)/;
const sentences = (t) => t.split(/(?<=\.)\s+/);

// (1) O texto único: cada canal com o que é verdade para ele; CDC art. 49 intacto.
function checkSolText(P) {
  const t = P.sol_text;
  assert.ok(t.includes("Em contratação online, o consumidor poderá desistir sem justificativa e sem ônus no prazo de " + P.rule_7d), "CDC art. 49: 7 dias corridos");
  assert.ok(t.includes(P.refund_window.fragmento_sol), "a data mais recente");
  const mp = t.match(MP_SENTENCE)?.[0] || "";
  const hm = t.match(HOTMART_SENTENCE)?.[0] || "";
  assert.ok(mp, "frase do checkout próprio (Mercado Pago)");
  assert.ok(hm, "frase da Hotmart");
  assert.match(mp, /zevanory\.api\.br\/pedir-reembolso ou suporte@zevanory\.api\.br/);
  assert.match(mp, /comunicará imediatamente o Mercado Pago para impedir o lançamento ou iniciar o estorno/);
  assert.match(hm, /conta Hotmart do comprador, em Minhas compras, ou por suporte@zevanory\.api\.br/);
  for (const s of sentences(t)) {
    if (s.includes("pedir-reembolso")) assert.equal(s, mp, "pedir-reembolso só na frase do checkout próprio: " + s);
    if (/Mercado Pago/.test(s)) assert.equal(s, mp, "Mercado Pago só na frase do checkout próprio: " + s);
  }
  assert.doesNotMatch(hm, /pedir-reembolso|Mercado Pago/, "a Hotmart não passa pelo formulário nem pelo Mercado Pago");
  assert.match(t, /comunica imediatamente a Hotmart ou a administradora do cartão/);
  assert.match(t, /O recebimento do pedido será confirmado imediatamente\. Em qualquer dos casos, os valores pagos serão devolvidos integralmente e monetariamente atualizados; a visualização do crédito em cartão seguirá o prazo do emissor\./);
  for (const f of P.customer_wording.fragmentos_sol) assert.ok(t.includes(f), "fragmento fora do sol_text: " + f);
}

// (2) Redação ao cliente (suporte, chat, formulário): a assinatura nunca manda para /pedir-reembolso.
function checkWording(P) {
  const W = P.customer_wording;
  assert.equal(W.refund_channels, "zevanory.api.br/pedir-reembolso ou suporte@zevanory.api.br");
  assert.doesNotMatch(W.subscription_refund, /pedir-reembolso|\{refund_channels\}|Mercado Pago/, "assinatura (Hotmart) não usa o formulário do checkout próprio");
  assert.match(W.subscription_refund, /processa o cancelamento e o reembolso/);
  assert.match(W.subscription_refund, /suporte@zevanory\.api\.br/);
  const mp = sentences(W.refund).find((s) => s.includes("{refund_channels}")) || "";
  assert.match(mp, /^Nas compras pagas pelo Mercado Pago no site da ZEVANORY, peça também em \{refund_channels\}:/, "o formulário vem amarrado ao checkout próprio");
  assert.match(W.refund, /Nas compras pagas em outra plataforma, o cancelamento e o reembolso são processados por ela/);
  assert.equal(sentences(W.refund).filter((s) => /Mercado Pago/.test(s)).length, 1, "Mercado Pago só na frase do checkout próprio");
}

// (3) Páginas (fonte da raiz e saída do build fechado) carregam o texto e as instruções por canal.
function checkPages(P, page) {
  for (const slug of ["termos", "reembolso"]) {
    assert.ok(page(`${slug}/index.html`).includes(P.sol_text), `${slug}: texto único (fonte)`);
    assert.ok(page(`sales-public/${slug}.html`).includes(P.sol_text), `${slug}: texto único (build)`);
  }
  for (const f of ["reembolso/index.html", "sales-public/reembolso.html"]) {
    const h = page(f);
    assert.match(h, /<strong>Compras no checkout próprio da ZEVANORY \(Mercado Pago\):<\/strong><\/p><ol>\s*<li>Acesse <a href="https:\/\/zevanory\.api\.br\/pedir-reembolso">/, f);
    assert.match(h, /<h2 id="assinatura-hotmart">Assinatura Conteúdo Pronto \(cobrada pela Hotmart\)<\/h2>/, f);
    assert.match(h, /Peça pela Hotmart, em Minhas compras, ou por suporte@zevanory\.api\.br; quando o pedido chega pelo suporte, a ZEVANORY comunica imediatamente a Hotmart ou a administradora do cartão\./, f);
    assert.match(h, /valores pagos, monetariamente atualizados/, f);
    assert.match(h, /<strong>Estorno \(checkout próprio\):<\/strong> a ZEVANORY comunica imediatamente o Mercado Pago/, f);
    assert.match(h, /<strong>Estorno \(Hotmart\):<\/strong> processado pela Hotmart/, f);
  }
  for (const f of ["termos/index.html", "sales-public/termos.html"]) {
    assert.match(page(f), /A assinatura Conteúdo Pronto é cobrada pela Hotmart \(Pix, cartão ou boleto\), com renovação mensal automática e sem fidelidade;/, f);
  }
  for (const f of ["privacidade/index.html", "sales-public/privacidade.html"]) {
    assert.match(page(f), /Mercado Pago \(pagamentos no checkout próprio\), Hotmart \(pagamento, cancelamento e reembolso das compras feitas pela Hotmart/, f + ": Hotmart como operador");
  }
}

// (4) O que o texto afirma continua sendo o que o código faz (se o código mudar, o texto tem de ser revisto).
function checkCodeFacts(src) {
  const refund = src("worker/refund-flow.mjs");
  assert.match(refund, /from orders o/, "formulário procura só pedidos do checkout próprio");
  assert.match(refund, /normalized_event='payment_confirmed'/);
  assert.match(refund, /\/v1\/payments\/" \+ encodeURIComponent\(record\.payment_id\) \+ "\/refunds"/, "estorno pela API do Mercado Pago");
  assert.doesNotMatch(refund, /hotmart/i, "o formulário não processa compras da Hotmart");
  const cp = src("worker/content-service.mjs");
  assert.match(cp, /Hotmart owns billing, recurrence, cancellation and refunds/);
  assert.match(cp, /const STOP_EVENTS = new Set\(\["PURCHASE_REFUNDED", "PURCHASE_CHARGEBACK", "PURCHASE_CANCELED", "PURCHASE_PROTEST", "SUBSCRIPTION_CANCELLATION"\]\);/);
  assert.doesNotMatch(cp, /api\.mercadopago\.com|\/refunds/, "o serviço da assinatura não estorna nada por conta própria");
}

// (5) CEP: confirmado, com faixa e fonte; o campo continua.
function checkCep(P) {
  const f = P.resumo_oferta.fornecedor;
  assert.equal(f.cep, "63540-000");
  assert.match(f.endereco_fisico, /Rua Francisco de Freitas Neto, nº 96, Alto do Tenente, Várzea Alegre – CE/);
  const n = P.resumo_oferta.nota;
  assert.doesNotMatch(n, /a confirmar/i, "CEP não está mais pendente");
  assert.match(n, /CEP 63540-000, confirmado como CEP geral da sede urbana \(faixa 63540-000–63559-999;/);
  assert.match(n, /fonte: https:\/\/www\.ruacep\.com\.br\/ce\/varzea-alegre\/logradouros/);
}

test("texto único: cada canal de arrependimento com o que é verdade para ele (CDC art. 49 intacto)", () => checkSolText(POLICY));
test("redação ao cliente: assinatura sem /pedir-reembolso; formulário amarrado ao checkout próprio", () => checkWording(POLICY));
test("páginas (fonte e build fechado): termos, reembolso e privacidade com os dois canais", () => checkPages(POLICY, read));
test("o texto continua batendo com o código do Worker (refund-flow e content-service)", () => checkCodeFacts(read));
test("CEP: confirmado como CEP geral da sede urbana, com faixa e fonte; campo mantido", () => checkCep(POLICY));

test("mutantes: cada regressão factual é morta pelas mesmas asserções", () => {
  const clone = () => JSON.parse(JSON.stringify(POLICY));
  const OLD = "O pedido poderá ser feito pela mesma ferramenta usada na contratação e também em zevanory.api.br/pedir-reembolso ou suporte@zevanory.api.br. O recebimento do pedido será confirmado imediatamente. A ZEVANORY comunicará imediatamente o Mercado Pago para impedir o lançamento ou iniciar o estorno e devolverá integralmente os valores pagos; a visualização do crédito em cartão seguirá o prazo do emissor.";
  const mp = POLICY.sol_text.match(MP_SENTENCE)[0], hm = POLICY.sol_text.match(HOTMART_SENTENCE)[0];
  const policyMutants = {
    "K1 texto único volta a mandar todo reembolso para /pedir-reembolso e Mercado Pago": [checkSolText, (P) => { P.sol_text = P.sol_text.slice(0, P.sol_text.indexOf("O pedido poderá ser feito")) + OLD + P.sol_text.slice(P.sol_text.indexOf(" Contratos acessórios")); }],
    "K2 Hotmart passa a citar o formulário": [checkSolText, (P) => { P.sol_text = P.sol_text.replace(hm, hm.replace("em Minhas compras,", "em Minhas compras, em zevanory.api.br/pedir-reembolso")); }],
    "K3 frase da Hotmart removida": [checkSolText, (P) => { P.sol_text = P.sol_text.replace(hm + " ", ""); }],
    "K4 prazo do CDC encurtado": [checkSolText, (P) => { P.sol_text = P.sol_text.replace(P.rule_7d, "7 dias corridos contado da compra"); }],
    "K5 Mercado Pago fora da frase do checkout próprio": [checkSolText, (P) => { P.sol_text = P.sol_text.replace(hm, hm + " O Mercado Pago será avisado."); }],
    "K6 assinatura volta a {refund_channels}": [checkWording, (P) => { P.customer_wording.subscription_refund += " Peça em {refund_channels}."; }],
    "K7 formulário solto do checkout próprio": [checkWording, (P) => { P.customer_wording.refund = P.customer_wording.refund.replace("Nas compras pagas pelo Mercado Pago no site da ZEVANORY, peça também em {refund_channels}:", "Peça também em {refund_channels}:"); }],
    "K8 CEP volta a 'a confirmar'": [checkCep, (P) => { P.resumo_oferta.nota = P.resumo_oferta.nota.replace("confirmado como CEP geral da sede urbana", "CEP único de Várzea Alegre, a confirmar pelo proprietário"); }],
    "K9 nota do CEP sem fonte": [checkCep, (P) => { P.resumo_oferta.nota = P.resumo_oferta.nota.replace("https://www.ruacep.com.br/ce/varzea-alegre/logradouros", "consulta informal"); }],
  };
  const pageMutants = {
    "K10 reembolso publicado sem a seção da Hotmart": (f, h) => f === "sales-public/reembolso.html" ? h.replace(/<h2 id="assinatura-hotmart">[^]*?<h2>Prazos<\/h2>/, "<h2>Prazos</h2>") : h,
    "K11 privacidade publicada sem a Hotmart como operador": (f, h) => f === "sales-public/privacidade.html" ? h.replace(/, Hotmart \([^)]*\)/, "") : h,
    "K12 termos publicados com o texto único antigo": (f, h) => f === "sales-public/termos.html" ? h.replace(mp, "") : h,
  };
  const codeMutants = {
    "K13 formulário passa a aceitar compras da Hotmart (texto teria de mudar)": (f, s) => f === "worker/refund-flow.mjs" ? s.replace("from orders o", "from orders o /* hotmart */") : s,
    "K14 assinatura passa a estornar pelo Mercado Pago": (f, s) => f === "worker/content-service.mjs" ? s + "\nfetch('https://api.mercadopago.com/v1/payments/1/refunds');\n" : s,
  };
  const report = [];
  const kill = (name, fn) => { let killed = false; try { fn(); } catch (e) { killed = e instanceof assert.AssertionError; } report.push(`${name}: ${killed ? "KILLED" : "SURVIVED"}`); };
  for (const [name, [check, mutate]] of Object.entries(policyMutants)) { const P = clone(); mutate(P); assert.notDeepEqual(P, POLICY, "mutação não aplicada: " + name); kill(name, () => check(P)); }
  for (const [name, mutate] of Object.entries(pageMutants)) kill(name, () => checkPages(POLICY, (f) => mutate(f, read(f))));
  for (const [name, mutate] of Object.entries(codeMutants)) kill(name, () => checkCodeFacts((f) => mutate(f, read(f))));
  console.log("# POLITICA_CANAIS_MUTANTS " + report.join(" | "));
  assert.deepEqual(report.filter((r) => r.endsWith("SURVIVED")), []);
  assert.equal(report.length, 14);
});

// (6) Sol A272-03: nenhuma instrução geral contraditória sobra em lugar nenhum. Toda menção ao formulário
// /pedir-reembolso em texto ao cliente (páginas, Worker, suporte, e-mails, chat) está amarrada ao checkout próprio
// (Mercado Pago) num raio de 400 caracteres, ou é um uso que só existe para compras do checkout próprio
// (lista explícita abaixo, com o motivo). Arquivo novo com menção solta derruba o teste.
const SCOPED = /Mercado Pago|REFUND_FORM_SCOPE|checkout próprio/;
const CHANNEL_SPECIFIC = {
  "worker/refund-flow.mjs": "o próprio formulário e suas rotas (a página diz o escopo: REFUND_FORM_SCOPE)",
  "worker/cloudflare-worker.recovered.mjs": "e-mail de entrega enviado só para pedidos pagos no checkout próprio",
  "worker/reviews.mjs": "avaliação só existe para pedidos da tabela orders (checkout próprio)",
  "worker/sales-public-worker.mjs": "página de produto (checkout próprio); a variante /hotmart/ troca a frase por 'peça pela Hotmart' (HOTMART_TEXT); 308 de /reembolso/solicitar; mapa de URLs do chat",
  "scripts/build_sales_public.py": "FAQ da página de produto do checkout próprio (a variante /hotmart/ troca a frase)",
  "scripts/p23/ecommerce_legal_gate.py": "expressão estrutural que reconhece links de reembolso; não é instrução ao cliente",
  "worker/site-chat.mjs": "lista de URLs permitidas (não é instrução)",
  "worker/support-knowledge.mjs": "fontes da resposta de produto; a da assinatura não cita o formulário",
  "worker/whatsapp-conversation.mjs": "lista de URLs permitidas (não é instrução; canal aposentado)",
  "data/site-chat-eval/critical.json": "fixture de avaliação",
  "data/politica-unica.json": "refund_channels/fragmentos: usados só nas frases do checkout próprio (checkWording)",
  // Páginas de produto do checkout próprio (saída de GUARANTEE_Q/FAQ do build); a variante /hotmart/ troca a frase.
  ...Object.fromEntries(POLICY.policy_surfaces.products.map((slug) => [`sales-public/${slug}.html`, "página de produto do checkout próprio; /hotmart/ troca a frase (HOTMART_TEXT)"])),
};
function looseMentions(files, read) {
  const loose = [];
  for (const f of files) {
    if (CHANNEL_SPECIFIC[f]) continue;
    const t = read(f);
    for (let i = t.indexOf("pedir-reembolso"); i !== -1; i = t.indexOf("pedir-reembolso", i + 1)) {
      if (!SCOPED.test(t.slice(Math.max(0, i - 400), i + 400))) loose.push(`${f}@${i}`);
    }
  }
  return loose;
}
import { readdirSync, statSync } from "node:fs";
function textFiles() {
  const out = [];
  const walk = (d) => { for (const n of readdirSync(join(ROOT, d))) { const r = d ? `${d}/${n}` : n; const s = statSync(join(ROOT, r));
    if (s.isDirectory()) { if (!/^(\.git|node_modules|tests|docs|evidence|brand|assets|\.github)$/.test(n)) walk(r); }
    else if (/\.(mjs|js|py|json|html|txt)$/.test(n) && s.size < 3_000_000) out.push(r); } };
  walk("");
  return out.filter((f) => read(f).includes("pedir-reembolso"));
}
test("A272-03: nenhuma instrução geral sobre /pedir-reembolso sem o escopo do checkout próprio, em todo o repositório publicado", () => {
  const files = textFiles();
  for (const must of ["termos/index.html", "reembolso/index.html", "sales-public/termos.html", "sales-public/reembolso.html", "worker/atendimento.mjs", "sales-overlay/site-chat.js"]) assert.ok(files.includes(must), "varredura cobre " + must);
  assert.deepEqual(looseMentions(files, read), []);
  // Mutantes: as frases antigas do atendimento e do chat voltam -> menção solta.
  const old = {
    "worker/atendimento.mjs": (s) => s.replace(/Nas \$\{REFUND_FORM_SCOPE\}, você também pode registrar o pedido de reembolso em https:\/\/zevanory\.api\.br\/pedir-reembolso \(código do pedido \+ e-mail do pagamento\)\. \$\{REFUND_OTHER_PLATFORM\}/, "Se o pedido foi pago, você também pode registrar o reembolso automaticamente, pela mesma ferramenta usada na compra: https://zevanory.api.br/pedir-reembolso (código do pedido + e-mail do pagamento).").replace(/REFUND_FORM_SCOPE|checkout próprio|Mercado Pago/g, "X"),
    "sales-overlay/site-chat.js": (s) => s.replace("Pedir reembolso (compras pelo Mercado Pago)", "Pedir reembolso"),
  };
  for (const [f, mutate] of Object.entries(old)) {
    const loose = looseMentions(files, (g) => (g === f ? mutate(read(g)) : read(g)));
    assert.ok(loose.some((x) => x.startsWith(f + "@")), "mutante não morto: " + f);
  }
  // M2: todo link interno que o gerador introduz aponta para uma âncora real,
  // tanto na fonte quanto na saída publicada.
  const generator = read("scripts/build_sales_public.py");
  const links = [...generator.matchAll(/href=["'](\/[a-z0-9-]+)#([a-z0-9-]+)["']/gi)];
  assert.ok(links.length > 0, "o gerador contém ao menos uma âncora interna");
  for (const [, route, anchor] of links) {
    const slug = route.slice(1);
    for (const file of [`${slug}/index.html`, `sales-public/${slug}.html`]) {
      assert.match(read(file), new RegExp(`\\bid=["']${anchor}["']`), `${file}: #${anchor}`);
    }
  }
  // M4: o build fechado inteiro usa somente o endereço atual de suporte.
  const publicFiles = readdirSync(join(ROOT, "sales-public")).filter((f) => f.endsWith(".html")).map((f) => `sales-public/${f}`);
  for (const f of publicFiles) {
    assert.doesNotMatch(read(f), /contato@zevanory\.api\.br/i, f);
  }
  assert.match(read("sales-public/404.html"), /mailto:suporte@zevanory\.api\.br/i);
});
