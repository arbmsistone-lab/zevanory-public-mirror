// Marketing pieces of the sales site (closed-sales phase, 2026-10-25), scripts/sales_marketing.py:
//   (a) FAQ on /solucoes, every priced page and the niche pages: native <details>, and the FAQPage JSON-LD
//       repeats exactly the visible questions;
//   (b) every illustrative number sits inside a block labelled "Exemplo fictício, para ilustrar" (round
//       values); outside those blocks the only R$ amounts are real catalogue prices;
//   (c) testimonials: data/depoimentos.json is empty and nothing renders (no placeholder); the validator
//       refuses entries without hashed order reference, written consent, dates, first name + city or source;
//       a valid entry renders, an invalid one fails the build;
//   (d) niche pages /para/<ramo>: built, routed by the Worker, linked from /solucoes, in the sitemap, canonical,
//       genuinely different from each other, with pains -> products, trust block, FAQ and waiting-list CTA;
//   (e) demo video: hashed MP4 + WebM + VTT + poster present and < 4 MB, captions pt-BR, no autoplay,
//       preload none, built only from the approved preview images;
//   (f) P13 on the new pages: closed = waiting list only (no checkout link, no InStock); open switch restores
//       the buy CTA at request time; no WhatsApp link or number.
// Each group has a mutant that the check must kill.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readTextNormalized } from "./helpers/text.mjs";
import worker, { openSalesHtml, NICHE_ROUTES } from "../worker/sales-public-worker.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUB = join(ROOT, "sales-public");
const read = (f) => readTextNormalized(join(PUB, f));
const P = JSON.parse(readTextNormalized(join(ROOT, "data/politica-unica.json")));
const NICHES = JSON.parse(readTextNormalized(join(ROOT, "data/nichos.json"))).nichos;
const PY = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
const pyEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" };
const LABEL = "Exemplo fictício, para ilustrar";
const PRODUCTS = ["ia-na-pratica", "vendas-na-pratica", "lucro-e-caixa", "combo-ia-vendas", "negocio-completo"];
const PRICED = [...PRODUCTS, "conteudo-pronto"];
const NICHE_FILES = NICHES.map((n) => `para-${n.slug}.html`);
const CATALOGUE_PRICES = new Set([97, 197, 244, 247, 297, 394, 397, 641]);  // COMMERCE prices, savings and bundle totals
const CHECKOUT_HREF = /href\s*=\s*["']?[^"'\s>]*(?:\/comprar\/|\/assinar\/|\/hotmart\/|pay\.hotmart\.com)/i;

const lds = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
const faqNodes = (html) => lds(html).flatMap((d) => (d["@graph"] || [d]).filter((n) => n["@type"] === "FAQPage"));
const decode = (s) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const summaries = (html) => [...html.matchAll(/<details><summary>([\s\S]*?)<\/summary>/g)].map((m) => decode(m[1]));
const visibleText = (html) => decode(html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<head>[\s\S]*?<\/head>/, " ")).replace(/\s+/g, " ");

test("(a) FAQ: native details on /solucoes, priced and niche pages; FAQPage JSON-LD == visible questions", () => {
  const need = {
    "solucoes.html": ["O que a lista de espera faz enquanto as vendas estão fechadas?", "Como recebo o produto?", "Em que formato vêm os arquivos?", "Preciso saber mexer em planilha?", "Serve para o meu ramo?", "E se eu não gostar?", "Tem mensalidade?"],
    ...Object.fromEntries(PRODUCTS.map((s) => [s + ".html", ["Como recebo o produto?", "E se não for para mim?", "Em que formato vêm os arquivos?", "Preciso saber mexer em planilha?", "Serve para o meu ramo?", "Tem mensalidade?", "O que a lista de espera faz enquanto as vendas estão fechadas?"]])),
    "conteudo-pronto.html": ["Tem mensalidade?", "Como recebo?", "Serve para o meu ramo?", "E se eu não gostar?", "O que a lista de espera faz enquanto as vendas estão fechadas?"],
    ...Object.fromEntries(NICHE_FILES.map((f) => [f, ["Preciso saber mexer em planilha?", "Como recebo o produto?", "E se eu não gostar?", "O que a lista de espera faz enquanto as vendas estão fechadas?"]])),
  };
  for (const [file, qs] of Object.entries(need)) {
    const html = read(file);
    const visible = summaries(html);
    for (const q of qs) assert.ok(visible.includes(q), `${file}: falta "${q}"`);
    assert.equal(new Set(visible).size, visible.length, file + ": pergunta repetida");
    const faq = faqNodes(html);
    assert.equal(faq.length, 1, file + ": exatamente um FAQPage");
    assert.deepEqual(faq[0].mainEntity.map((q) => q.name), visible, file + ": JSON-LD com as mesmas perguntas, na mesma ordem");
    assert.ok(faq[0].mainEntity.every((q) => q.acceptedAnswer?.text?.length > 20), file + ": respostas no JSON-LD");
  }
  // Only Conteúdo Pronto is a subscription; one-off products say so.
  for (const s of PRODUCTS) assert.match(read(s + ".html"), /<summary>Tem mensalidade\?<\/summary><p>Não\. É pagamento único de R\$ \d+\./, s);
  assert.match(read("conteudo-pronto.html"), /<summary>Tem mensalidade\?<\/summary><p>Sim\. O Conteúdo Pronto é uma assinatura de R\$ 197 por mês, cobrada pela Hotmart/);
  // The FAQ answers restate the single policy (no divergent wording).
  for (const f of Object.keys(need)) for (const bad of P.banned_policy_phrases) assert.ok(!read(f).includes(bad), `${f}: ${bad}`);
});

// Every "R$ N" outside labelled examples must be a real catalogue price; inside examples, values are round.
function illustrativeViolations(html) {
  const out = [];
  const blocks = [...html.matchAll(/<section[^>]*\bdata-illustrative\b[^>]*>[\s\S]*?<\/section>/g)].map((m) => m[0]);
  for (const b of blocks) {
    if (!b.includes(`<p class="example-label">${LABEL}</p>`)) out.push("bloco ilustrativo sem o rótulo visível");
    for (const m of decode(b).matchAll(/R\$ ?([\d.]+)/g)) if (Number(m[1].replace(/\./g, "")) % 10 !== 0) out.push("valor não redondo R$ " + m[1]);
    for (const m of decode(b).matchAll(/(\d+)%/g)) if (Number(m[1]) % 5 !== 0) out.push("percentual não redondo " + m[1]);
  }
  let rest = html;
  for (const b of blocks) rest = rest.replace(b, "");
  for (const m of visibleText(rest).matchAll(/R\$ ?([\d.]+)/g)) {
    const v = Number(m[1].replace(/\./g, ""));
    if (!CATALOGUE_PRICES.has(v)) out.push(`R$ ${m[1]} fora de um bloco "${LABEL}"`);
  }
  return out;
}

test("(b) illustrative numbers only inside blocks labelled 'Exemplo fictício, para ilustrar' (round values)", () => {
  for (const f of [...PRICED.map((s) => s + ".html"), ...NICHE_FILES, "solucoes.html"]) {
    const html = read(f);
    assert.deepEqual(illustrativeViolations(html), [], f);
    if (f !== "solucoes.html") assert.equal((html.match(/\bdata-illustrative\b/g) || []).length, 1, f + ": um exemplo fictício por página");
  }
  // Mutants: label removed; an unlabelled invented amount; a non-round amount inside the example.
  const page = read("lucro-e-caixa.html");
  assert.ok(illustrativeViolations(page.replace(`<p class="example-label">${LABEL}</p>`, "")).length > 0, "M1 rótulo removido");
  assert.ok(illustrativeViolations(page.replace("</main>", "<p>Clientes economizam R$ 1.350 por mês.</p></main>")).length > 0, "M2 número fora do bloco");
  assert.ok(illustrativeViolations(page.replace("R$ 6.500", "R$ 6.537")).length > 0, "M3 valor não redondo");
});

const runPy = (args, extraEnv = {}) => spawnSync(PY, args, { encoding: "utf8", env: { ...pyEnv, ...extraEnv }, timeout: 240000 });
const VALID = { pedido_ref_sha256: createHash("sha256").update("pedido-exemplo-de-teste").digest("hex"), consentimento_escrito: true,
  consentimento_data: "2026-10-20", data: "2026-10-18", primeiro_nome: "Ana", cidade: "Várzea Alegre (CE)", fonte: "email",
  produto: "lucro-e-caixa", texto: "Texto de teste com mais de vinte caracteres, só para o validador." };

test("(c) testimonials: empty file renders nothing; validator refuses incomplete entries; valid renders, invalid fails the build", () => {
  assert.deepEqual(JSON.parse(readTextNormalized(join(ROOT, "data/depoimentos.json"))), [], "lista vazia até existir depoimento real");
  for (const f of readdirSync(PUB).filter((x) => x.endsWith(".html"))) {
    const html = read(f);
    assert.ok(!/id="depoimentos"|class="depo|O que clientes escreveram/.test(html), f + ": seção de depoimentos com a lista vazia");
    assert.ok(!/em breve[^<]{0,40}depoimento|depoimentos?[^<]{0,40}em breve/i.test(html), f + ": marcador 'em breve depoimentos'");
    assert.ok(!/"@type":\s*"(Review|AggregateRating)"/.test(html), f + ": avaliação estruturada sem dado real");
  }
  const dir = mkdtempSync(join(tmpdir(), "depo-"));
  try {
    const check = (entries) => { const p = join(dir, "d.json"); writeFileSync(p, JSON.stringify(entries)); return runPy([join(ROOT, "scripts/sales_marketing.py"), "--check-depoimentos", p]); };
    assert.equal(check([]).status, 0);
    const ok = check([VALID]);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    for (const field of Object.keys(VALID)) {
      const e = { ...VALID }; delete e[field];
      assert.equal(check([e]).status, 1, "sem " + field + " é recusado");
    }
    const bad = {
      "consentimento false": { consentimento_escrito: false }, "consentimento 'sim'": { consentimento_escrito: "sim" },
      "pedido sem hash": { pedido_ref_sha256: "PED-12345" }, "sobrenome": { sobrenome: "Silva" }, "nome completo": { primeiro_nome: "Ana Silva" },
      "nota": { nota: 5 }, "foto": { foto: "a.jpg" }, "cidade sem UF": { cidade: "Várzea Alegre" }, "fonte livre": { fonte: "instagram" },
      "data futura": { data: "2999-01-01" }, "consentimento antes": { consentimento_data: "2026-10-01" }, "link no texto": { texto: "Muito bom, veja https://exemplo.com agora mesmo" },
    };
    for (const [why, patch] of Object.entries(bad)) assert.equal(check([{ ...VALID, ...patch }]).status, 1, why);
    assert.equal(check([VALID, VALID]).status, 1, "mesmo pedido duas vezes");
    // Build with a valid entry renders it (first name + city only); with an invalid one the build fails.
    const out = join(dir, "out"), depo = join(dir, "valid.json");
    writeFileSync(depo, JSON.stringify([VALID]));
    const r = runPy([join(ROOT, "scripts/build_sales_public.py")], { ZEVANORY_SALES_PUBLIC_OUT: out, ZEVANORY_DEPOIMENTOS: depo });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const page = readTextNormalized(join(out, "lucro-e-caixa.html"));
    assert.match(page, /id="depoimentos"/);
    assert.match(page, /Ana, Várzea Alegre \(CE\)\. Cliente do Lucro &amp; Caixa, outubro de 2026\./);
    assert.ok(!page.includes(VALID.pedido_ref_sha256), "a referência do pedido nunca é publicada");
    assert.ok(!readTextNormalized(join(out, "ia-na-pratica.html")).includes('id="depoimentos"'), "só no produto do depoimento");
    writeFileSync(depo, JSON.stringify([{ ...VALID, consentimento_escrito: false }]));
    const r2 = runPy([join(ROOT, "scripts/build_sales_public.py")], { ZEVANORY_SALES_PUBLIC_OUT: out, ZEVANORY_DEPOIMENTOS: depo });
    assert.notEqual(r2.status, 0, "build recusa depoimento sem consentimento");
    assert.match(r2.stderr + r2.stdout, /depoimentos recusados/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const env = { ASSETS: { fetch: async (req) => {
  const p = decodeURIComponent(new URL(req.url).pathname).slice(1), f = join(PUB, p);
  if (!p || !existsSync(f) || statSync(f).isDirectory()) return new Response("Not found", { status: 404 });
  return new Response(readFileSync(f), { status: 200, headers: { "content-type": p.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream" } });
} } };
const get = (path, e = env) => worker.fetch(new Request("https://vendas.zevanory.api.br" + path, { headers: { "user-agent": "Mozilla/5.0" } }), e, { waitUntil() {} });

function shingles(text) {
  const w = text.toLowerCase().split(/[^a-zà-ÿ0-9]+/).filter(Boolean), s = new Set();
  for (let i = 0; i + 4 <= w.length; i++) s.add(w.slice(i, i + 4).join(" "));
  return s;
}
const ownContent = (html) => visibleText(html.replace(/<header[\s\S]*?<\/header>/, "").replace(/<section class="container how-to-buy"[\s\S]*?<\/section>/, "")
  .replace(/<div class="container footer-legal">[\s\S]*?<\/div><\/main>/, "</main>").replace(/<footer[\s\S]*?<\/footer>/, "").replace(/<section class="container section faq-section"[\s\S]*?<\/section>/, ""));

test("(d) niche pages: built, routed, canonical, linked from /solucoes, in the sitemap, specific, with trust + FAQ + waiting list", async () => {
  assert.deepEqual(Object.keys(NICHE_ROUTES).sort(), NICHES.map((n) => "para/" + n.slug).sort(), "Worker == data/nichos.json");
  assert.deepEqual(NICHES.map((n) => n.slug).sort(), ["clinica", "loja", "oficina", "salao"]);
  const sitemap = read("sitemap.xml"), cat = read("solucoes.html");
  const texts = {};
  for (const n of NICHES) {
    const file = `para-${n.slug}.html`, html = read(file), url = `https://vendas.zevanory.api.br/para/${n.slug}`;
    for (const path of [`/para/${n.slug}`, `/para/${n.slug}/`]) {
      const res = await get(path);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get("cache-control"), "no-store, no-transform", path + ": segue o interruptor de vendas");
      assert.equal(await res.text(), html, path);
    }
    assert.ok(html.includes(`<link rel="canonical" href="${url}">`), file + ": canonical");
    assert.ok(sitemap.includes(`<loc>${url}</loc>`), file + ": sitemap");
    assert.ok(cat.includes(`href="/para/${n.slug}"`), file + ": link no catálogo");
    assert.equal((html.match(/<h1>/g) || []).length, 1);
    assert.ok(n.dores.length >= 5, file + ": dores");
    for (const d of n.dores) assert.ok(html.includes(`href="/${d.produto}"`), `${file}: link para ${d.produto}`);
    for (const g of n.gratis) assert.ok(html.includes(`href="${g.href}"`) && existsSync(join(PUB, g.href.slice(1) + ".html")), `${file}: recurso grátis ${g.href}`);
    assert.match(html, /<h2 id="como-compra">Como a compra funciona<\/h2>/, file + ": bloco de confiança");
    assert.ok(html.includes("CNPJ") && html.includes("69.077.233/0001-99") && html.includes('href="mailto:suporte@zevanory.api.br"'), file + ": empresa e suporte");
    assert.ok(html.includes('class="faq"'), file + ": FAQ");
    assert.match(html, /<a class="button primary" href="mailto:suporte@zevanory\.api\.br\?subject=[^"]+" data-zev-sku="ZEV-NGC-011" data-zev-open-text="[^"]+">Entrar na lista de espera<\/a>/, file + ": CTA de lista de espera");
    assert.match(html, /<a class="button primary key" href="\/material-gratuito">/, file + ": checklist grátis é a ação principal");
    texts[n.slug] = shingles(ownContent(html));
  }
  // Genuinely different pages: shared 4-word shingles of each page's own content stay low.
  const slugs = Object.keys(texts);
  for (let i = 0; i < slugs.length; i++) for (let j = i + 1; j < slugs.length; j++) {
    const a = texts[slugs[i]], b = texts[slugs[j]];
    const inter = [...a].filter((x) => b.has(x)).length, jac = inter / (a.size + b.size - inter);
    assert.ok(jac < 0.35, `${slugs[i]} x ${slugs[j]}: conteúdo parecido demais (Jaccard ${jac.toFixed(2)})`);
  }
  const titles = NICHES.map((n) => read(`para-${n.slug}.html`).match(/<title>([^<]*)<\/title>/)[1]);
  assert.equal(new Set(titles).size, titles.length, "títulos únicos");
  // Mutant: a cloned page (same content, other slug) is caught by the similarity check.
  const clone = shingles(ownContent(read("para-salao.html").replace(/salão/g, "barbearia")));
  const a = texts.salao, inter = [...a].filter((x) => clone.has(x)).length;
  assert.ok(inter / (a.size + clone.size - inter) >= 0.35, "M clone de página é detectado");
  // Unknown niche stays a designed 404; the flat file name is not a public route.
  assert.equal((await get("/para/barbearia")).status, 404);
  assert.equal((await get("/para/constructor")).status, 404);
  assert.equal((await get("/para-salao")).status, 404);
});

test("(e) demo video: hashed MP4 + WebM + VTT + poster, < 4 MB, captions pt-BR, no autoplay, real previews only", () => {
  const M = JSON.parse(readTextNormalized(join(ROOT, "docs/evidence/sales-ux/demo-video-manifest.json")));
  const PREV = JSON.parse(readTextNormalized(join(ROOT, "docs/evidence/sales-ux/previews-manifest.json")));
  const approved = new Map(PREV.images.map((i) => [i.webp.file, i.webp.sha256]));
  assert.ok(M.duration_s >= 60 && M.duration_s <= 90, "60–90 s");
  assert.equal(M.audio, "none (silent by design)");
  for (const s of M.shots) if (s.source !== "typography only") assert.equal(approved.get(s.source), s.source_sha256, s.id + ": só imagens das prévias aprovadas");
  for (const [k, o] of Object.entries(M.outputs)) {
    const f = join(ROOT, o.file);
    assert.equal(createHash("sha256").update(readFileSync(f)).digest("hex"), o.sha256, k + ": hash do manifesto");
    if (k === "mp4" || k === "webm") assert.ok(o.bytes < 4 * 1024 * 1024, k + " < 4 MB");
  }
  const vtt = readTextNormalized(join(ROOT, M.outputs.vtt.file));
  assert.match(vtt, /^WEBVTT\n/);
  assert.equal((vtt.match(/-->/g) || []).length, M.shots.length, "uma legenda por cena");
  const html = read("solucoes.html");
  const video = html.match(/<video\b[^>]*>[\s\S]*?<\/video>/)[0], open = video.match(/<video\b[^>]*>/)[0];
  for (const a of ["controls", 'preload="none"', "playsinline", "muted", 'width="1280"', 'height="720"']) assert.ok(open.includes(a), "video " + a);
  assert.ok(!/autoplay|\bloop\b/.test(open), "sem autoplay nem loop");
  assert.match(video, /<track kind="captions" srclang="pt-BR" label="Português \(Brasil\)" src="\/assets\/video\/zevanory-demo\.[0-9a-f]{10}\.vtt" default>/);
  const refs = [...video.matchAll(/(?:src|poster)="(\/assets\/video\/[^"]+)"/g)].map((m) => m[1]);
  assert.equal(refs.length, 4, "webm, mp4, vtt e poster");
  for (const r of refs) {
    const m = r.match(/\.([0-9a-f]{10})\.(mp4|webm|vtt|webp)$/);
    assert.ok(m, r + ": nome com hash");
    assert.equal(createHash("sha256").update(readFileSync(join(PUB, r))).digest("hex").slice(0, 10), m[1], r + ": hash confere");
  }
  assert.ok(html.includes("Demonstração com páginas reais do material"), "rótulo da demonstração");
  assert.match(html, /<details class="demo-script"><summary[^>]*>Ler o roteiro da demonstração<\/summary><ol>(<li>[^<]+<\/li>){14}<\/ol><\/details>/, "roteiro em texto (alternativa à mídia)");
  // Below the fold: after the whole catalogue.
  assert.ok(html.indexOf("<video") > html.indexOf('id="g-segmento"'), "vídeo depois do catálogo");
});

test("(f) P13 on the new pages: closed = waiting list, no checkout/InStock; owner switch restores the buy CTA; no WhatsApp", async () => {
  for (const f of [...NICHE_FILES, "solucoes.html", ...PRICED.map((s) => s + ".html")]) {
    const html = read(f);
    assert.ok(!CHECKOUT_HREF.test(html), f + ": sem link de checkout");
    assert.ok(!/schema\.org\/InStock/.test(html), f + ": sem InStock");
    assert.ok(!/wa\.me\/|api\.whatsapp\.com|whatsapp:\/\//i.test(html), f + ": sem link de WhatsApp");
    assert.ok(!/<a [^>]*>(?:Comprar|Assinar)[^<]*<\/a>/.test(html), f + ": sem CTA de compra no HTML fechado");
  }
  for (const f of NICHE_FILES) {
    const closed = read(f);
    assert.ok(closed.includes(`Aviso: ${P.closed_label}.`), f + ": aviso único de vendas fechadas");
    const opened = openSalesHtml(closed, f.replace(/\.html$/, ""));
    assert.match(opened, /<a class="button primary" href="\/comprar\/ZEV-NGC-011" rel="nofollow">Comprar Negócio Completo · R\$ 397<\/a>/, f + ": CTA restaurado");
    assert.ok(!opened.includes(P.waitlist_label) && !opened.includes(P.closed_label) && !opened.includes("data-zev-"), f + ": sem marcadores do modo fechado");
  }
  // Through the Worker: only an open owner switch restores (fail-closed otherwise).
  const pageEnv = (open) => ({ ...env, CORE: { fetch: async (u) => String(u?.url || u).endsWith("/api/sales/status") ? new Response(JSON.stringify({ open }), { status: 200 }) : new Response("{}") } });
  for (const open of [true, false]) {
    const body = await (await get("/para/oficina", pageEnv(open))).text();
    assert.equal(CHECKOUT_HREF.test(body), open, "para/oficina open=" + open);
    assert.equal(body.includes(P.waitlist_label), !open);
  }
  const audit = runPy([join(ROOT, "scripts/sales_policy.py"), "--audit", PUB, "--mode", "closed"]);
  assert.equal(audit.status, 0, audit.stdout + audit.stderr);
});
