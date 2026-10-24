// Contato público (data/politica-unica.json, contato_publico). A conta WhatsApp Business da ZEVANORY
// (4019600665012911) foi desativada PERMANENTEMENTE pela Meta em 2026-10-10 (revisão negada) e o número
// está BANIDO: suporte@zevanory.api.br é o único endereço eletrônico oficial. A flag
// whatsapp_public_links_enabled=false é uma trava: links de WhatsApp só voltam por decisão explícita.
// Com a flag !== true:
//   (a) nenhuma superfície pública (sales-public/*, páginas-fonte das rotas de venda, sales-overlay,
//       public/whatsapp-contact.js, páginas e e-mails do Worker) tem link de WhatsApp nem o número banido
//       (o número banido é proibido mesmo com a flag ligada);
//   (b) todo CTA "Entrar na lista de espera" (data-zev-sku / data-zev-sub) abre mailto para o e-mail
//       oficial com assunto "Lista de espera — <Produto>" e corpo fixos (sem dado pessoal na URL) e
//       mantém data-zev-open-text, que o Worker usa para restaurar a compra quando as vendas abrirem;
//   (c) o "Endereço eletrônico" do Resumo da oferta (Decreto 7.962/2013, art. 2º, II) lista só canais
//       que funcionam (e-mail e site) e os canais de arrependimento do texto único também.
// Mutantes (CTA de volta ao wa.me, rodapé, resumo da oferta, JSON-LD, script, número sem link,
// e-mail errado, assunto sem produto, open-text removido, flag como texto) — todos mortos.
import test from "node:test";
import assert from "node:assert/strict";
import { readTextNormalized } from "./helpers/text.mjs";
import { readdirSync, existsSync, mkdtempSync, cpSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import worker, { openSalesHtml } from "../worker/sales-public-worker.mjs";
import { brandedEmailHtml, OFFICIAL_LEGAL_FOOTER } from "../worker/brand-email.mjs";
import * as PU from "../worker/politica-unica.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUB = join(ROOT, "sales-public");
const P = JSON.parse(readTextNormalized(join(ROOT, "data/politica-unica.json")));
const C = P.contato_publico;
const read = (rel) => readTextNormalized(join(ROOT, rel));
const enabledFlag = (c) => c.whatsapp_public_links_enabled === true;
const ENABLED = enabledFlag(C);
// Mesmo padrão de scripts/sales_policy.py (WHATSAPP_PUBLIC_RE) e worker/politica-unica.mjs.
const BANNED_RE = new RegExp((C.numeros_banidos || []).map((n) => `${n}|${n.slice(4, -4)}[-\\s.]?${n.slice(-4)}`).join("|") || "(?!)");
const WA_RE = new RegExp(`wa\\.me/|api\\.whatsapp\\.com/|whatsapp://|${BANNED_RE.source}`, "i");
// Fonte única do padrão de menção de canal: worker/politica-unica.mjs (também usado em tests/comprar-noindex.test.mjs).
const CHANNEL_RE = PU.WHATSAPP_CHANNEL_RE;
const PRODUCTS = { "ZEV-IA-011": "IA na Prática", "ZEV-VEN-011": "Vendas na Prática", "ZEV-LCX-011": "Lucro & Caixa", "ZEV-CMB-011": "Combo IA + Vendas", "ZEV-NGC-011": "Negócio Completo" };
const SUBS = { "conteudo-pronto": "Conteúdo Pronto" };
const decodeHtml = (s) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<");

// (a) violações: arquivo -> trecho com wa.me/número, somente quando a flag está desligada.
function contactViolations(files, contact = C) {
  const rx = enabledFlag(contact) ? BANNED_RE : WA_RE;  // número banido: proibido sempre
  const out = [];
  for (const [name, text] of Object.entries(files)) {
    const m = rx.exec(text);
    if (m) out.push(`${name}: ${m[0]}`);
  }
  return out;
}

// (b) CTA de lista de espera: mailto oficial, assunto/corpo fixos, rótulo e open-text preservados.
function waitlistViolations(name, html, contact = C) {
  const out = [];
  const anchors = [...html.matchAll(/<a\b[^>]*\bdata-zev-(sku|sub)="([^"]+)"[^>]*>([^<]*)<\/a>/g)];
  for (const [a, kind, id, label] of anchors) {
    const product = (kind === "sku" ? PRODUCTS : SUBS)[id];
    if (!product) { out.push(`${name}: ${id} desconhecido`); continue; }
    if (label !== P.waitlist_label) out.push(`${name}: rótulo '${label}'`);
    if (!/\bdata-zev-open-text="[^"]+"/.test(a)) out.push(`${name}: ${id} sem data-zev-open-text`);
    const href = decodeHtml((a.match(/\bhref="([^"]*)"/) || [])[1] || "");
    if (enabledFlag(contact)) continue;
    let u;
    try { u = new URL(href); } catch { out.push(`${name}: ${id} href inválido`); continue; }
    if (u.protocol !== "mailto:" || decodeURIComponent(u.pathname) !== contact.email) { out.push(`${name}: ${id} não abre mailto:${contact.email} (${href.slice(0, 40)})`); continue; }
    const params = new URLSearchParams(u.search.replace(/\+/g, "%2B"));
    const keys = [...params.keys()].sort().join(",");
    if (keys !== "body,subject") out.push(`${name}: ${id} parâmetros ${keys} (só subject e body fixos)`);
    if (params.get("subject") !== contact.waitlist_subject.replaceAll("{produto}", product)) out.push(`${name}: ${id} assunto '${params.get("subject")}'`);
    if (params.get("body") !== contact.waitlist_body.replaceAll("{produto}", product)) out.push(`${name}: ${id} corpo fora do texto fixo`);
  }
  return out;
}

function publicFiles(pub = PUB) {
  const files = {};
  for (const f of readdirSync(pub)) if (/\.(html|js|txt|xml)$/.test(f)) files["sales-public/" + f] = readTextNormalized(join(pub, f));
  return files;
}
const ROUTES = readdirSync(PUB).filter((f) => f.endsWith(".html") && f !== "index.html").map((f) => f.slice(0, -5));
function sourceFiles() {
  const files = {};
  for (const slug of ROUTES) if (existsSync(join(ROOT, slug, "index.html"))) files[slug + "/index.html"] = read(slug + "/index.html");
  for (const f of ["sales-overlay/llms.txt", "sales-overlay/approved.json", "public/whatsapp-contact.js", "public/arbm-contador-saloes.html"]) files[f] = read(f);
  // O overlay mantém o bloco de WhatsApp entre marcadores; o build o remove com a flag desligada.
  files["sales-overlay/whatsapp-contact.js"] = read("sales-overlay/whatsapp-contact.js");
  return files;
}
// Templates do Worker que viram página ou e-mail para o público.
const WORKER_PUBLIC = ["worker/atendimento.mjs", "worker/sales-public-worker.mjs", "worker/refund-flow.mjs", "worker/sales-control.mjs", "worker/post-sale.mjs", "worker/brand-email.mjs", "worker/multichannel-autonomy.mjs", "worker/lead-magnet.mjs", "worker/reviews.mjs", "worker/content-service.mjs"];
function workerFiles() {
  const files = {};
  for (const f of WORKER_PUBLIC) files[f] = read(f);
  // Bundle recuperado: só as linhas de atendimento ao cliente (o resto é identidade/robô do canal).
  files["worker/cloudflare-worker.recovered.mjs#atendimento"] = read("worker/cloudflare-worker.recovered.mjs").split("\n").filter((l) => /D[uú]vidas:/.test(l)).join("\n");
  return files;
}

test("contato_publico: flag booleana, e-mail oficial = e-mail do fornecedor, assunto/corpo fixos com {produto}", () => {
  assert.equal(typeof C.whatsapp_public_links_enabled, "boolean", "flag precisa ser booleana (texto 'false' não vale)");
  assert.equal(C.email, P.resumo_oferta.fornecedor.email);
  assert.equal(C.email, "suporte@zevanory.api.br");
  assert.ok(C.waitlist_subject.startsWith("Lista de espera — ") && C.waitlist_subject.includes("{produto}"));
  assert.ok(C.waitlist_body.includes("{produto}") && !/[{]nome|[{]email|[{]telefone/i.test(C.waitlist_body), "corpo estático, sem dado pessoal");
  assert.equal(PU.WHATSAPP_PUBLIC_LINKS_ENABLED, ENABLED, "Worker lê a mesma flag");
  assert.deepEqual(C.numeros_banidos, ["5588992545413"], "número banido pela Meta registrado");
  assert.equal(PU.WHATSAPP_PUBLIC_RE.source, WA_RE.source, "Worker usa o mesmo padrão do teste e do build");
  assert.ok(!("whatsapp" in P.resumo_oferta.fornecedor), "fornecedor sem WhatsApp: e-mail é o único endereço eletrônico");
  if (ENABLED) assert.ok(/^\d{12,13}$/.test(C.whatsapp_e164 || "") && !C.numeros_banidos.includes(C.whatsapp_e164), "flag ligada exige número novo, nunca o banido");
  // Fora da nota e da lista de banidos, o JSON não carrega o número.
  const { nota, numeros_banidos, ...rest } = C;
  assert.doesNotMatch(JSON.stringify({ ...P, contato_publico: rest }), BANNED_RE);
});

test("(a) nenhuma superfície pública tem wa.me ou o número com o WhatsApp desligado", () => {
  // Sem skip (o gate da suíte reprova testes pulados): com a flag ligada contactViolations devolve [].
  const pub = publicFiles();
  assert.ok(Object.keys(pub).length > 60, "superfície completa");
  assert.deepEqual(contactViolations(pub), []);
  assert.deepEqual(contactViolations(sourceFiles()), []);
  assert.deepEqual(contactViolations(workerFiles()), []);
  assert.deepEqual(contactViolations({ OFFICIAL_LEGAL_FOOTER, email: brandedEmailHtml("Olá"), CONTACT_HTML: PU.CONTACT_HTML, CONTACT_TEXT: PU.CONTACT_TEXT, CONTACT_TEXT_OR: PU.CONTACT_TEXT_OR, REFUND_TEXT: PU.REFUND_TEXT, SUPPORT_REFUND_ANSWER: PU.SUPPORT_REFUND_ANSWER, SOL_TEXT: PU.SOL_TEXT }), []);
  assert.equal(readTextNormalized(join(PUB, "whatsapp-contact.js")), read("public/whatsapp-contact.js"), "public/whatsapp-contact.js é cópia do asset gerado");
  // Menção ao WhatsApp como canal da ZEVANORY (sem link nem número) também não pode voltar.
  if (!ENABLED) for (const [name, text] of Object.entries({ ...pub, ...sourceFiles(), ...workerFiles() })) assert.doesNotMatch(text, CHANNEL_RE, name);
});

test("(b) CTAs de lista de espera abrem e-mail com assunto 'Lista de espera — <Produto>' e mantêm data-zev-open-text", () => {
  let n = 0;
  for (const [name, html] of Object.entries(publicFiles())) {
    if (!name.endsWith(".html")) continue;
    n += (html.match(/data-zev-(sku|sub)="/g) || []).length;
    assert.deepEqual(waitlistViolations(name, html), [], name);
  }
  assert.ok(n >= 22, "5 produtos x 4 CTAs + 2 do Conteúdo Pronto; achados " + n);
  // Vendas abertas: o Worker continua restaurando a compra a partir de data-zev-open-text.
  const open = openSalesHtml(readTextNormalized(join(PUB, "ia-na-pratica.html")), "ia-na-pratica");
  assert.match(open, /<a class="button primary" href="\/comprar\/ZEV-IA-011" rel="nofollow">Comprar agora · R\$ 197<\/a>/);
  assert.doesNotMatch(open, /mailto:[^"]*Lista%20de%20espera/);
  const sub = openSalesHtml(readTextNormalized(join(PUB, "conteudo-pronto.html")), "conteudo-pronto");
  assert.match(sub, /href="\/assinar\/conteudo-pronto">Assinar agora/);
});

// Sem telefone público (JSON-LD/Microdata/RDFa telephone, href tel:): não há linha de atendimento.
const PHONE_RE = /"telephone"\s*:|\b(?:itemprop|property)\s*=\s*["']?(?:schema:)?telephone\b|href\s*=\s*["']?tel:/i;
function structuredViolations(files) {
  const out = [];
  for (const [name, text] of Object.entries(files)) {
    if (PHONE_RE.test(text)) out.push(`${name}: telefone`);
    if (name.endsWith(".html") && name.startsWith("sales-public/") && !text.includes(`href="mailto:${C.email}"`)) out.push(`${name}: e-mail oficial ausente`);
  }
  return out;
}
function orgContactViolations(html) {
  const out = [];
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const data = JSON.parse(m[1]);
    for (const n of data["@graph"] || [data]) {
      if (n["@type"] !== "Organization" || !n.legalName) continue;
      if (n.email !== C.email) out.push("Organization.email");
      const cp = [].concat(n.contactPoint || []);
      if (!cp.some((c) => c["@type"] === "ContactPoint" && c.email === C.email && c.url === C.formulario)) out.push("Organization.contactPoint (e-mail + formulário)");
      if (cp.some((c) => c.telephone) || n.telephone) out.push("Organization.telephone");
    }
  }
  return out.length || html.includes('"legalName"') ? out : ["Organization ausente"];
}
// Arquivos versionados que podem citar o número banido/wa.me: só internos, nunca publicados.
const ALLOWLIST = new Map(Object.entries({
  "data/politica-unica.json": "fonte única: nota histórica + numeros_banidos (trava)",
  "docs/audits/official-brand-matrix-2026-10-10.md": "auditoria histórica (não publicada)",
  "worker/cloudflare-worker.recovered.mjs": "perfil interno OFFICIAL_WHATSAPP + filtros do robô (sem rota pública); exigido por premerge_product_audit",
  "worker/whatsapp-conversation.mjs": "robô de WhatsApp (aposentadoria em PR separado)",
  "worker/whatsapp-inbound-safety.mjs": "robô de WhatsApp: filtro de auto-remetente",
  "worker/politica-unica.mjs": "padrão da trava",
  "scripts/sales_policy.py": "padrão da trava",
  "scripts/premerge_product_audit.py": "gate interno",
  "scripts/patch_whatsapp_broker.py": "ferramenta interna",
  "scripts/whatsapp_audio_runtime_test.mjs": "teste interno",
  "scripts/whatsapp_delivery_proof_test.mjs": "teste interno",
  "scripts/ci/mutants_comprar_noindex.py": "mutantes de CI que reinjetam o número para provar o oráculo de /comprar",
  "scripts/ci/mutants_whatsapp_retirement.mjs": "mutantes de CI que reinjetam o número/alias para provar a aposentadoria do WhatsApp (#896)",
  "scripts/deploy/public_whatsapp_scan.py": "padrão da trava: varredura fail-closed dos ativos públicos e workflows (#896)",
}));
const PUBLISHED = /^(sales-public|public|sales-overlay|brand|assets)\/|^[^/]+\/index\.html$|^[^/]+\.(html|txt|xml|js|css)$/;

test("Sol: sem telefone público, e-mail oficial em toda página, Organization com e-mail + ContactPoint (formulário)", () => {
  assert.deepEqual(structuredViolations({ ...publicFiles(), ...sourceFiles() }), []);
  assert.deepEqual(orgContactViolations(readTextNormalized(join(PUB, "solucoes.html"))), []);
  assert.deepEqual(orgContactViolations(readTextNormalized(join(PUB, "index.html"))), []);
  assert.equal(C.formulario, "https://zevanory.api.br/atendimento");
});

test("Sol: número banido / wa.me só em arquivos internos da lista explícita (nunca publicados)", () => {
  const out = spawnSync("git", ["grep", "-lIE", "wa\\.me/|api\\.whatsapp\\.com/|5588992545413|99254[-. ]?5413"], { cwd: ROOT, encoding: "utf8" });
  const files = out.stdout.split("\n").filter(Boolean).filter((f) => !f.startsWith("tests/"));
  assert.ok(out.status === 0 || out.status === 1, out.stderr);
  const extra = files.filter((f) => !ALLOWLIST.has(f));
  assert.deepEqual(extra, [], "fora da lista explícita");
  // A lista só encolhe: entrada que não cita mais o número/wa.me é obsoleta e sai no mesmo PR (#896).
  assert.deepEqual([...ALLOWLIST.keys()].filter((f) => !files.includes(f)), [], "entrada obsoleta na lista explícita");
  for (const f of ALLOWLIST.keys()) assert.doesNotMatch(f, PUBLISHED, "item da lista não pode ser publicado: " + f);
});

test("(c) Resumo da oferta e canais de arrependimento: só endereços que funcionam", () => {
  for (const slug of [...P.policy_surfaces.products, ...P.policy_surfaces.subscription]) {
    const html = readTextNormalized(join(PUB, slug + ".html"));
    const dd = (html.match(/<div data-field="endereco_eletronico"><dt>[^<]*<\/dt><dd>([^<]*)<\/dd>/) || [])[1];
    assert.ok(dd, slug + ": campo endereço eletrônico");
    assert.ok(dd.includes(C.email) && dd.includes(P.resumo_oferta.fornecedor.site), slug + ": e-mail e site");
    assert.equal(/WhatsApp/i.test(dd), ENABLED, slug + ": WhatsApp só com a flag ligada");
  }
  assert.equal(WA_RE.test(P.sol_text), ENABLED, "sol_text");
  assert.equal(WA_RE.test(P.customer_wording.refund_channels), ENABLED, "refund_channels");
  assert.ok(P.customer_wording.refund_channels.includes(C.email));
});

test("(d) páginas renderizadas pelo Worker (compra fechada, pausas, indisponível) sem wa.me", async () => {
  const ctx = { waitUntil() {} };
  const env = (state) => ({
    CORE: { fetch: async () => new Response(JSON.stringify({ open: state === "open" }), { status: 200 }) },
    ASSETS: { fetch: async () => new Response("<html><head></head><body></body></html>", { status: 200 }) },
  });
  const get = (path, e) => worker.fetch(new Request("https://vendas.zevanory.api.br" + path, { headers: { "user-agent": "Mozilla/5.0" } }), e, ctx);
  const pages = {};
  for (const path of ["/comprar/ZEV-IA-011", "/hotmart/ia-na-pratica", "/assinar/conteudo-pronto"]) pages["closed " + path] = await (await get(path, env("closed"))).text();
  pages["sem CORE /comprar/ZEV-IA-011"] = await (await get("/comprar/ZEV-IA-011", { ASSETS: env("closed").ASSETS })).text();
  assert.deepEqual(contactViolations(pages), []);
  if (ENABLED) return;
  assert.match(pages["closed /hotmart/ia-na-pratica"], /href="mailto:suporte@zevanory\.api\.br\?subject=Lista%20de%20espera%20%E2%80%94%20IA%20na%20Pr%C3%A1tica&amp;body=/);
  assert.match(pages["sem CORE /comprar/ZEV-IA-011"], /mailto:suporte@zevanory\.api\.br/);
});

test("mutantes: wa.me/número de volta em CTA, rodapé, resumo, JSON-LD, script, Worker; CTA de e-mail errado — todos mortos", () => {
  const pub = publicFiles();
  const page = pub["sales-public/ia-na-pratica.html"];
  const WA = "https://wa.me/5588992545413?text=Ol%C3%A1%21%20Quero%20entrar%20na%20lista%20de%20espera%20do%20IA%20na%20Pr%C3%A1tica.";
  const ctaRe = /href="mailto:[^"]*"( data-zev-sku="ZEV-IA-011")/;
  const contactMutants = {
    "M1 CTA da lista de espera volta ao wa.me": () => [page, page.replace(ctaRe, `href="${WA}"$1`)],
    "M2 rodapé com WhatsApp clicável": () => [page, page.replace('>Atendimento com protocolo</a><br>', '>Atendimento com protocolo</a> · WhatsApp <a href="https://wa.me/5588992545413">+55 88 99254-5413</a><br>')],
    "M3 resumo da oferta com WhatsApp": () => [page, page.replace("suporte@zevanory.api.br · vendas.zevanory.api.br", "suporte@zevanory.api.br · WhatsApp +55 88 99254-5413 · vendas.zevanory.api.br")],
    "M4b telephone com outro número": () => [pub["sales-public/solucoes.html"], pub["sales-public/solucoes.html"].replace('"email": "suporte@zevanory.api.br", "contactPoint"', '"email": "suporte@zevanory.api.br", "telephone": "+55 88 3000-0000", "contactPoint"')],
    "M4c microdata telephone": () => [page, page.replace("</main>", '<span itemprop="telephone">+55 88 3000-0000</span></main>')],
    "M4d link tel:": () => [page, page.replace("</main>", '<a href="tel:+558830000000">Ligue</a></main>')],
    "M4e página sem o e-mail oficial": () => [page, page.replaceAll('href="mailto:suporte@zevanory.api.br"', 'href="mailto:contato@zevanory.api.br"')],
    "M4 JSON-LD com telephone": () => [pub["sales-public/solucoes.html"], pub["sales-public/solucoes.html"].replace('"email": "suporte@zevanory.api.br"', '"email": "suporte@zevanory.api.br", "telephone": "+55 88 99254-5413"')],
    "M5 script volta a injetar wa.me": () => [pub["sales-public/whatsapp-contact.js"], pub["sales-public/whatsapp-contact.js"].replace("})();", "document.querySelector('nav').insertAdjacentHTML('beforeend','<a href=\"https://wa.me/5588992545413\">WhatsApp</a>');})();")],
    "M6 número sem link, com espaço": () => [page, page.replace("</main>", "<p>Ligue 88 99254 5413</p></main>")],
    "M7 api.whatsapp.com": () => [page, page.replace("</main>", '<a href="https://api.whatsapp.com/send?phone=5588992545413">x</a></main>')],
    "M8 página do Worker com wa.me": () => [read("worker/sales-public-worker.mjs"), read("worker/sales-public-worker.mjs") + '\nconst X="https://wa.me/5588992545413";'],
    "M9b menção de canal sem número": () => [page, page.replace("suporte humano por", "suporte humano no WhatsApp ou por")],
    "M9 e-mail ao cliente com o número": () => [OFFICIAL_LEGAL_FOOTER, OFFICIAL_LEGAL_FOOTER + " · WhatsApp +55 88 99254-5413"],
  };
  const report = [];
  for (const [name, make] of Object.entries(contactMutants)) {
    const [before, after] = make();
    assert.notEqual(after, before, "mutação não aplicada: " + name);
    const isPage = /^<!doctype html>/i.test(before);
    const sv = (s) => structuredViolations({ [isPage ? "sales-public/x.html" : "x.js"]: s });
    assert.deepEqual([...contactViolations({ before }, { ...C, whatsapp_public_links_enabled: false }), ...sv(before)], [], name + ": original já limpo");
    const v = [...contactViolations({ after }, { ...C, whatsapp_public_links_enabled: false }), ...sv(after)];
    if (CHANNEL_RE.test(after) && !CHANNEL_RE.test(before)) v.push("canal");
    report.push(`${name}: ${v.length ? "KILLED" : "SURVIVED"}`);
    assert.ok(v.length > 0, name + " sobreviveu");
  }
  const ctaMutants = {
    "M10 CTA com e-mail errado": () => page.replace(/href="mailto:suporte@zevanory\.api\.br\?(subject=[^"]*" data-zev-sku="ZEV-IA-011")/, 'href="mailto:contato@zevanory.api.br?$1'),
    "M11 assunto sem o produto": () => page.replace(/subject=Lista%20de%20espera%20%E2%80%94%20IA%20na%20Pr%C3%A1tica&amp;/, "subject=Lista%20de%20espera&amp;"),
    "M12 dado pessoal na URL": () => page.replace(/(&amp;body=[^"]*)(" data-zev-sku="ZEV-IA-011")/, "$1&amp;email=cliente%40x.com$2"),
    "M13 data-zev-open-text removido": () => page.replace(/( data-zev-sku="ZEV-IA-011") data-zev-open-text="[^"]*"/, "$1"),
    "M14 rótulo trocado": () => page.replace(/(data-zev-sku="ZEV-IA-011" data-zev-open-text="[^"]*">)Entrar na lista de espera/, "$1Fale conosco"),
    "M15 CTA de volta ao wa.me (forma do CTA)": () => page.replace(ctaRe, `href="${WA}"$1`),
  };
  for (const [name, make] of Object.entries(ctaMutants)) {
    const html = make();
    assert.notEqual(html, page, "mutação não aplicada: " + name);
    const v = waitlistViolations("ia-na-pratica", html, { ...C, whatsapp_public_links_enabled: false });
    report.push(`${name}: ${v.length ? "KILLED" : "SURVIVED"}`);
    assert.ok(v.length > 0, name + " sobreviveu");
  }
  // ContactPoint/e-mail da Organization removidos ou telefone no ContactPoint.
  const sol = pub["sales-public/solucoes.html"];
  for (const [name, mut] of Object.entries({
    "M18 Organization sem e-mail": sol.replace('"email": "suporte@zevanory.api.br", "contactPoint"', '"contactPoint"'),
    "M19 ContactPoint sem formulário": sol.replace('"url": "https://zevanory.api.br/atendimento", ', ""),
    "M20 ContactPoint com telefone": sol.replace('"contactType": "customer support",', '"contactType": "customer support", "telephone": "+5588992545413",'),
  })) {
    assert.notEqual(mut, sol, "mutação não aplicada: " + name);
    assert.ok(orgContactViolations(mut).length > 0, name + " sobreviveu");
    report.push(name + ": KILLED");
  }
  // Flag como texto "false"/"true" não liga o WhatsApp: só o booleano true desliga o gate.
  assert.ok(contactViolations({ p: WA }, { ...C, whatsapp_public_links_enabled: "true" }).length > 0, "M16 flag em texto");
  report.push("M16 flag em texto: KILLED");
  // Número banido continua proibido com a flag ligada; um número novo seria aceito (controle).
  assert.ok(contactViolations({ p: WA }, { ...C, whatsapp_public_links_enabled: true }).length > 0, "M17 número banido com a flag ligada");
  report.push("M17 número banido com a flag ligada: KILLED");
  assert.deepEqual(contactViolations({ p: "https://wa.me/5511900000000" }, { ...C, whatsapp_public_links_enabled: true }), []);
  console.log("CONTATO_PUBLICO_MUTANTS " + report.join(" | "));
});

const PY = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
test("mutantes no gate do build (scripts/sales_policy.py --audit): wa.me/número em HTML, script e llms.txt são mortos", () => {
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" };
  const audit = (dir) => spawnSync(PY, [join(ROOT, "scripts/sales_policy.py"), "--audit", dir, "--mode", "closed"], { encoding: "utf8", env });
  const base = audit(PUB);
  assert.equal(base.status, 0, base.stdout + base.stderr);
  const mutants = {
    "P1 CTA wa.me": ["ia-na-pratica.html", (h) => h.replace(/href="mailto:[^"]*"( data-zev-sku="ZEV-IA-011")/, 'href="https://wa.me/5588992545413"$1')],
    "P2 rodapé com número": ["privacidade.html", (h) => h.replace("</main>", "<p>WhatsApp +55 88 99254-5413</p></main>")],
    "P3 script com wa.me": ["whatsapp-contact.js", (s) => s + "\nlocation.href='https://wa.me/5588992545413';"],
    "P4 llms.txt com número": ["llms.txt", (s) => s + "\nWhatsApp: +55 88 99254-5413\n"],
    "P5 JSON-LD telephone": ["solucoes.html", (h) => h.replace('"email": "suporte@zevanory.api.br", "contactPoint"', '"email": "suporte@zevanory.api.br", "telephone": "+55 88 3000-0000", "contactPoint"')],
    "P6 página sem e-mail oficial": ["privacidade.html", (h) => h.replaceAll('href="mailto:suporte@zevanory.api.br"', 'href="mailto:x@zevanory.api.br"')],
  };
  for (const [name, [file, fn]] of Object.entries(mutants)) {
    const dir = mkdtempSync(join(tmpdir(), "contato-mut-"));
    try {
      cpSync(PUB, dir, { recursive: true, filter: (s) => !/[\\/](brand|assets)([\\/]|$)/.test(s) });
      const before = readTextNormalized(join(dir, file));
      const after = fn(before);
      assert.notEqual(after, before, "mutação não aplicada: " + name);
      writeFileSync(join(dir, file), after);
      const r = audit(dir);
      // Com a flag ligada o gate de contato fica desligado (o WhatsApp volta a ser permitido).
      if (ENABLED && /^P[1-4]/.test(name)) { assert.doesNotMatch(r.stdout, /WhatsApp publico/, name); continue; }
      assert.equal(r.status, 1, name + " sobreviveu: " + r.stdout);
      assert.match(r.stdout, /P13_FAIL [^\n]*(WhatsApp publico|telefone publico|e-mail oficial)/, name);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
