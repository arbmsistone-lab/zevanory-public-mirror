// P13 (Ordem 079-P13 / 076-P24): NO-GO na superfície pública + política única de compra.
// (a) modo fechado: zero href /comprar/ e zero schema.org/InStock no HTML estático publicado;
// (b) termos, reembolso e as cinco páginas de produto têm a MESMA regra de 7 dias e a divulgação
//     72 h / um download (texto único do Sol, exato, em termos e reembolso);
// (c) modo aberto (build de preview e restauração em tempo de execução pelo interruptor do
//     proprietário) devolve os CTAs originais e a Offer.
// Mutantes: página com /comprar/, página com InStock, texto "após o pagamento" — todos mortos.
import test from "node:test";
import assert from "node:assert/strict";
import { readTextNormalized, normalizeEol } from "./helpers/text.mjs";
import { readFileSync, readdirSync, mkdtempSync, cpSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import worker, { openSalesHtml, resetPageSwitchCache } from "../worker/sales-public-worker.mjs";

// AVAL 084 (portabilidade): fileURLToPath, não a propriedade pathname da URL (no Windows vira "/C:/...").
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUB = join(ROOT, "sales-public");
const P = JSON.parse(readTextNormalized(join(ROOT, "data/politica-unica.json")));
const PRODUCTS = P.policy_surfaces.products;
const LEGAL = P.policy_surfaces.legal;
const SKUS = { "ia-na-pratica": "ZEV-IA-011", "vendas-na-pratica": "ZEV-VEN-011", "lucro-e-caixa": "ZEV-LCX-011", "combo-ia-vendas": "ZEV-CMB-011", "negocio-completo": "ZEV-NGC-011" };
const CHECKOUT_HREF = /href\s*=\s*["']?[^"'\s>]*(?:\/comprar\/|\/assinar\/|\/hotmart\/|pay\.hotmart\.com)/i;
const SUBS = P.policy_surfaces.subscription;
const read = (dir, slug) => readTextNormalized(join(dir, slug + ".html"));
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" };
const PY = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
const audit = (dir, mode = "closed") => spawnSync(PY, [join(ROOT, "scripts/sales_policy.py"), "--audit", dir, "--mode", mode], { encoding: "utf8", env });
const ld = (html) => JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
const productOffer = (html) => (ld(html)["@graph"] || []).find((n) => n["@type"] === "Product")?.offers;
const serviceOffer = (html) => (ld(html)["@graph"] || []).find((n) => n["@type"] === "Service")?.offers;
const subAnchors = (html) => [...html.matchAll(/<a [^>]*href="\/assinar\/[^"]*"[^>]*>[^<]*<\/a>/g)].map((m) => m[0]);
const buyAnchors = (html) => [...html.matchAll(/<a [^>]*href="\/comprar\/[^"]*"[^>]*>[^<]*<\/a>/g)].map((m) => m[0]);

test("(a) modo fechado: nenhum HTML publicado tem href /comprar/, /assinar/, /hotmart/ ou pay.hotmart, nem schema.org/InStock", () => {
  const files = readdirSync(PUB).filter((f) => f.endsWith(".html"));
  assert.ok(files.length > 60, "superfície completa");
  for (const f of files) {
    const html = readTextNormalized(join(PUB, f));
    assert.doesNotMatch(html, CHECKOUT_HREF, f);
    assert.doesNotMatch(html, /schema\.org\/InStock/i, f);
  }
  for (const slug of PRODUCTS) {
    const html = read(PUB, slug);
    assert.equal(productOffer(html), undefined, "sem Offer enquanto fechado: " + slug);
    assert.ok(html.includes(P.waitlist_label), "CTA lista de espera: " + slug);
    assert.ok(html.includes(P.closed_label), "rótulo vendas fechadas: " + slug);
    assert.match(html, /Preço de tabela: R\$ \d+/, "preço mantido como informação: " + slug);
  }
  for (const slug of SUBS) {
    const html = read(PUB, slug);
    assert.equal(serviceOffer(html), undefined, "assinatura sem Offer enquanto fechada: " + slug);
    assert.ok(html.includes(P.waitlist_label) && html.includes(P.closed_label), "assinatura: espera + rótulo: " + slug);
    assert.match(html, /R\$ 197/, "preço da assinatura como informação");
  }
  assert.equal(audit(PUB).status, 0, "auditoria CLI do modo fechado");
});

test("(b) assinatura e demais páginas: mesma regra de 7 dias junto ao CTA e nenhuma formulação divergente no site", () => {
  for (const slug of SUBS) {
    const html = read(PUB, slug);
    const hero = html.match(/data-zev-sub="conteudo-pronto"[\s\S]*?<p class="policy-summary">[\s\S]*?<\/p>/)[0];
    assert.ok(hero.length < 1200 && hero.includes(P.rule_7d) && hero.includes(`/termos#${P.policy_anchor}`), "resumo ao lado do CTA: " + slug);
    assert.ok(!html.includes("72 horas"), "assinatura não promete link de 72 h (entrega é por link privado mensal)");
  }
  for (const f of readdirSync(PUB).filter((x) => x.endsWith(".html"))) {
    const html = readTextNormalized(join(PUB, f));
    for (const bad of P.banned_policy_phrases) assert.ok(!html.includes(bad), `${f}: '${bad}'`);
  }
});

test("(b) mesma regra de 7 dias e mesma divulgação 72 h / um download em todas as superfícies", () => {
  for (const slug of [...LEGAL, ...PRODUCTS]) {
    const html = read(PUB, slug);
    assert.ok(html.includes(P.rule_7d), "regra 7 dias: " + slug);
    assert.ok(html.includes(P.delivery_72h), "72 h / um download: " + slug);
    for (const bad of P.banned_policy_phrases) assert.ok(!html.includes(bad), `${slug}: '${bad}'`);
  }
  for (const slug of LEGAL) assert.ok(read(PUB, slug).includes(P.sol_text), "texto único exato: " + slug);
  assert.ok(read(PUB, "termos").includes(`id="${P.policy_anchor}"`), "âncora citada pelas páginas de produto");
  // A divulgação fica AO LADO da oferta: dentro do mesmo <aside> do CTA.
  for (const slug of PRODUCTS) {
    // Design PR: o bloco da oferta é <div class="offer-side"> (era <aside>) e termina no CTA.
    const aside = read(PUB, slug).match(/<div class="offer-side"><div><span class="status-pill">[\s\S]*?data-zev-sku="[^"]+"[^>]*>[^<]*<\/a><\/div>/)[0];
    assert.ok(aside.includes(P.delivery_72h) && aside.includes(P.rule_7d), "resumo junto ao CTA: " + slug);
    assert.ok(aside.includes(`data-zev-sku="${SKUS[slug]}"`), "CTA no mesmo bloco: " + slug);
    assert.ok(aside.includes(`/termos#${P.policy_anchor}`), "link para o texto completo: " + slug);
  }
});

test("(c) modo aberto: build de preview e restauração em tempo de execução devolvem CTAs e Offer", () => {
  const out = mkdtempSync(join(tmpdir(), "p13-open-"));
  try {
    const r = spawnSync(PY, [join(ROOT, "scripts/build_sales_public.py")], { encoding: "utf8", env: { ...env, ZEVANORY_SALES_PUBLIC_MODE: "open", ZEVANORY_SALES_PUBLIC_OUT: out } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /ZEVANORY_SALES_MODE=open/);
    assert.equal(audit(out, "open").status, 0, "política única também no modo aberto");
    for (const slug of PRODUCTS) {
      const opened = read(out, slug), closed = read(PUB, slug);
      const anchors = buyAnchors(opened);
      assert.ok(anchors.length >= 3, "CTAs de compra restaurados: " + slug);
      assert.equal(anchors.length, (closed.match(/data-zev-sku=/g) || []).length, "um CTA aberto por CTA de espera: " + slug);
      assert.ok(anchors.every((a) => a.includes(`/comprar/${SKUS[slug]}`)), slug);
      assert.equal(productOffer(opened).availability, "https://schema.org/InStock", slug);
      assert.ok(!opened.includes("data-zev-") && !opened.includes(P.closed_label), "sem marcadores do modo fechado: " + slug);
      // Restauração em runtime (interruptor aberto) == build aberto.
      const runtime = openSalesHtml(closed, slug);
      assert.deepEqual(buyAnchors(runtime), anchors, "CTAs runtime == build aberto: " + slug);
      assert.deepEqual(productOffer(runtime), productOffer(opened), "Offer runtime == build aberto: " + slug);
      assert.ok(!runtime.includes("data-zev-") && !runtime.includes(P.closed_label), "runtime sem marcadores: " + slug);
    }
    for (const slug of SUBS) {
      const opened = read(out, slug), closed = read(PUB, slug);
      const anchors = subAnchors(opened);
      assert.equal(anchors.length, (closed.match(/data-zev-sub=/g) || []).length, "CTA de assinatura restaurado: " + slug);
      assert.ok(anchors.length >= 2);
      assert.equal(serviceOffer(opened).price, "197.00");
      const runtime = openSalesHtml(closed, slug);
      assert.deepEqual(subAnchors(runtime), anchors, "assinatura runtime == build aberto");
      assert.deepEqual(serviceOffer(runtime), serviceOffer(opened), "Offer da assinatura runtime == build aberto");
      assert.ok(!runtime.includes("data-zev-") && !runtime.includes(P.closed_label));
    }
    const bad = spawnSync(PY, [join(ROOT, "scripts/build_sales_public.py")], { encoding: "utf8", env: { ...env, ZEVANORY_SALES_PUBLIC_MODE: "aberto", ZEVANORY_SALES_PUBLIC_OUT: out } });
    assert.notEqual(bad.status, 0, "modo desconhecido nunca abre");
  } finally { rmSync(out, { recursive: true, force: true }); }
});

function pageEnv(status) {
  return {
    ASSETS: { fetch: async (req) => new Response(readFileSync(join(PUB, new URL(req.url).pathname.slice(1)), "utf8"), { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }) },
    CORE: { fetch: async (u) => {
      const url = String(u?.url || u);
      if (url.endsWith("/api/sales/status")) { if (status === "throw") throw new Error("down"); return new Response(JSON.stringify({ open: status === "open" }), { status: status === 500 ? 500 : 200 }); }
      return new Response("{}", { status: 200 });
    } },
  };
}
const ctx = { waitUntil() {} };
const get = (path) => new Request("https://vendas.zevanory.api.br" + path, { headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36" } });

test("(c) Worker: CTAs só voltam com o interruptor do proprietário aberto (mesma /api/sales/status, fail-closed)", async () => {
  for (const [status, open] of [["open", true], ["closed", false], [500, false], ["throw", false]]) {
    for (const slug of ["ia-na-pratica", "negocio-completo"]) {
      resetPageSwitchCache();
      const body = await (await worker.fetch(get("/" + slug), pageEnv(status), ctx)).text();
      assert.equal(CHECKOUT_HREF.test(body), open, `${slug} status=${status}`);
      assert.equal(/schema\.org\/InStock/.test(body), open, `${slug} InStock status=${status}`);
      assert.equal(body.includes(P.waitlist_label), !open, `${slug} lista de espera status=${status}`);
      assert.ok(body.includes(P.delivery_72h), "72 h sempre ao lado da oferta");
    }
    resetPageSwitchCache();
    const sub = await (await worker.fetch(get("/conteudo-pronto"), pageEnv(status), ctx)).text();
    assert.equal(/href="\/assinar\/conteudo-pronto"/.test(sub), open, "assinatura status=" + status);
    assert.equal(sub.includes(P.waitlist_label), !open, "assinatura lista de espera status=" + status);
    resetPageSwitchCache();
    const cat = await (await worker.fetch(get("/solucoes"), pageEnv(status), ctx)).text();
    assert.equal(cat.includes(P.closed_label), !open, "catálogo status=" + status);
  }
});

test("release: build fixado em modo fechado e grep-gate de /comprar/ no workflow de publicação", () => {
  const wf = readTextNormalized(join(ROOT, ".github/workflows/zevanory-sales-public-release.yml"));
  assert.match(wf, /ZEVANORY_SALES_PUBLIC_MODE: closed/);
  assert.ok((wf.match(/P13_NOGO_GREP_GATE=PASS/g) || []).length >= 2, "gate no verify e no deploy");
});

// Classificador dos mutantes P13 (AVAL Sol 125, disciplina do B05): KILLED só com status 1, saída completa
// (P13_AUDIT=FAIL mode=closed), stderr vazio e PELO MENOS UMA linha P13_FAIL, TODAS casando a regra esperada do
// mutante (regex ancorada: "termos:" nunca casa "termos-x:"). SURVIVED só com status 0, P13_AUDIT=PASS e nenhum
// P13_FAIL. Todo o resto é INCONCLUSIVE: erro de spawn/timeout, sinal, crash/Traceback no stderr, marcador ausente,
// regra inesperada, status diferente de 0/1.
// Regra Sol 128: cada mutante tem PRIMÁRIO (1–3 regras P13 que testam DIRETAMENTE a mutação, por raciocínio) e
// SECUNDÁRIO opcional ({re, why}: justificativa causal de uma linha). KILLED exige ao menos uma linha primária e
// toda outra linha primária ou secundária justificada. validateMutantMap recusa iniciar com mapa inválido.
// Tabela de causalidade: docs/evidence/p13-politica-nogo-mutant-causality.md.
function validateMutantMap(map) {
  const problems = [];
  for (const [name, spec] of Object.entries(map)) {
    const prim = spec.primary || [], sec = spec.secondary || [];
    if (prim.length < 1 || prim.length > 3) problems.push(`${name}: ${prim.length} primários (exige 1 a 3)`);
    if (!prim.every((x) => x instanceof RegExp && x.source.startsWith("^") && x.source.endsWith("$"))) problems.push(`${name}: primário sem regex ancorada`);
    for (const e of sec) if (!(e.re instanceof RegExp) || typeof e.why !== "string" || e.why.trim().length < 15) problems.push(`${name}: secundário sem justificativa causal`);
    if (prim.length + sec.length > 4 && !String(spec.broad_reason || "").trim()) problems.push(`${name}: ${prim.length + sec.length} regras sem broad_reason`);
    if (typeof spec.apply !== "function") problems.push(`${name}: sem mutação`);
  }
  if (problems.length) throw new Error("MAPA_DE_MUTANTES_INVALIDO " + problems.join("; "));
  return map;
}
function classifyAudit(r, spec) {
  const primary = spec instanceof RegExp ? [spec] : spec.primary, secondary = spec instanceof RegExp ? [] : (spec.secondary || []).map((e) => e.re);
  if (r.error) return ["INCONCLUSIVE", "spawn_ou_timeout:" + (r.error.code || r.error.message)];
  if (r.signal || r.status === null) return ["INCONCLUSIVE", "sinal:" + r.signal];
  const out = normalizeEol(String(r.stdout || "")), err = String(r.stderr || "");
  if (err.trim()) return ["INCONCLUSIVE", "stderr:" + (/Traceback \(most recent call last\)/.test(err) ? "traceback" : err.trim().split("\n").pop().slice(0, 80))];
  const verdict = (out.match(/^P13_AUDIT=(PASS|FAIL) mode=closed$/m) || [])[1];
  const fails = [...out.matchAll(/^P13_FAIL (.+)$/gm)].map((m) => m[1]);
  if (r.status === 0) return verdict === "PASS" && fails.length === 0 ? ["SURVIVED", ""] : ["INCONCLUSIVE", "status0_incoerente"];
  if (r.status !== 1) return ["INCONCLUSIVE", "status_" + r.status];
  if (verdict !== "FAIL") return ["INCONCLUSIVE", "marcador_P13_AUDIT_ausente"];
  if (!fails.length) return ["INCONCLUSIVE", "bloco_P13_FAIL_ausente"];
  const unexpected = fails.filter((l) => !primary.some((x) => x.test(l)) && !secondary.some((x) => x.test(l)));
  if (unexpected.length) return ["INCONCLUSIVE", "regra_inesperada:" + unexpected.join(";").slice(0, 160)];
  if (!fails.some((l) => primary.some((x) => x.test(l)))) return ["INCONCLUSIVE", "so_falha_secundaria"];
  return ["KILLED", ""];
}

test("meta: classificador P13 — só status 1 + P13_FAIL com a regra esperada é KILLED; crash/marcador ausente é INCONCLUSIVE", () => {
  const ok = (lines, verdict = "FAIL") => lines.map((l) => "P13_FAIL " + l + "\n").join("") + `P13_AUDIT=${verdict} mode=closed\n`;
  const T = /^termos: formulacao divergente '7 dias após o pagamento'$/;
  const c = (r) => classifyAudit({ status: 1, signal: null, stdout: "", stderr: "", ...r }, T)[0];
  assert.equal(c({ stdout: ok(["termos: formulacao divergente '7 dias após o pagamento'"]) }), "KILLED");
  assert.equal(c({ status: 0, stdout: "P13_AUDIT=PASS mode=closed\n" }), "SURVIVED");
  assert.equal(c({ stdout: "", stderr: "Traceback (most recent call last):\n  File \"x\"\nNameError: y\n" }), "INCONCLUSIVE", "crash (exit 1 do Python)");
  assert.equal(c({ stdout: ok(["termos: formulacao divergente '7 dias após o pagamento'"]), stderr: "Traceback (most recent call last):\n" }), "INCONCLUSIVE", "traceback mesmo com marcador");
  assert.equal(c({ stdout: "P13_AUDIT=FAIL mode=closed\n" }), "INCONCLUSIVE", "sem bloco P13_FAIL");
  assert.equal(c({ stdout: "P13_FAIL termos: formulacao divergente '7 dias após o pagamento'\n" }), "INCONCLUSIVE", "sem marcador final (saída truncada)");
  assert.equal(c({ stdout: ok(["termos: formulacao divergente '7 dias após o pagamento'", "reembolso: formulacao divergente 'x'"]) }), "INCONCLUSIVE", "falha extra inesperada");
  assert.equal(c({ stdout: ok(["termos-de-uso: formulacao divergente '7 dias após o pagamento'"]) }), "INCONCLUSIVE", "prefixo colidente");
  assert.equal(c({ status: 2, stdout: ok(["termos: formulacao divergente '7 dias após o pagamento'"]) }), "INCONCLUSIVE", "status 2 (argparse)");
  assert.equal(c({ status: null, signal: "SIGKILL" }), "INCONCLUSIVE", "sinal");
  assert.equal(c({ status: null, error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }) }), "INCONCLUSIVE", "timeout");
  assert.equal(c({ status: 0, stdout: ok(["termos: formulacao divergente '7 dias após o pagamento'"]) }), "INCONCLUSIVE", "status 0 com falha");
  // Regra Sol 128: só secundário => INCONCLUSIVE; falha não relacionada => INCONCLUSIVE; mapa sem justificativa => recusa.
  const spec = { primary: [T], secondary: [{ re: /^termos: texto unico \(Sol 079-P13\) ausente ou alterado$/, why: "a frase inserida também altera o texto único exigido em termos" }], apply: () => {} };
  const cs = (lines) => classifyAudit({ status: 1, signal: null, stdout: ok(lines), stderr: "" }, spec)[0];
  assert.equal(cs(["termos: texto unico (Sol 079-P13) ausente ou alterado"]), "INCONCLUSIVE", "só secundário");
  assert.equal(cs(["termos: formulacao divergente '7 dias após o pagamento'", "termos: texto unico (Sol 079-P13) ausente ou alterado"]), "KILLED", "primário + secundário justificado");
  assert.equal(cs(["termos: formulacao divergente '7 dias após o pagamento'", "solucoes.html: schema.org/InStock em modo fechado"]), "INCONCLUSIVE", "falha não relacionada");
  assert.throws(() => validateMutantMap({ X: { ...spec, secondary: [{ re: /^a$/, why: "" }] } }), /sem justificativa causal/);
  assert.throws(() => validateMutantMap({ X: { ...spec, secondary: [{ re: /^a$/ }] } }), /sem justificativa causal/);
  const many = [1, 2, 3, 4].map((i) => ({ re: new RegExp("^x" + i + "$"), why: "justificativa causal suficiente " + i }));
  assert.throws(() => validateMutantMap({ X: { ...spec, secondary: many } }), /sem broad_reason/);
  assert.doesNotThrow(() => validateMutantMap({ X: { ...spec, secondary: many, broad_reason: "a mutação apaga a política em todas as superfícies" } }));
  assert.throws(() => validateMutantMap({ X: { ...spec, primary: [T, T, T, T] } }), /primários/);
});

test("mutantes: /comprar/ remanescente, InStock remanescente e 'após o pagamento' são mortos (status 1 + bloco P13_FAIL com a regra esperada)", () => {
  const mutants = validateMutantMap({
    "M1 produto mantém href /comprar/": { primary: [/^ia-na-pratica\.html: href de checkout\/assinatura \(href="\/comprar\/\) em modo fechado$/], apply: (d) => mutate(d, "ia-na-pratica", (h) => h.replace(/href="[^"]*" data-zev-sku="ZEV-IA-011"/, 'href="/comprar/ZEV-IA-011" data-zev-sku="ZEV-IA-011"')) },
    "M1b href absoluto para /comprar/": { primary: [/^solucoes\.html: href de checkout\/assinatura \("https:\/\/vendas\.zevanory\.api\.br\/comprar\/\) em modo fechado$/], apply: (d) => mutate(d, "solucoes", (h) => h.replace("</main>", '<a href="https://vendas.zevanory.api.br/comprar/ZEV-NGC-011">x</a></main>')) },
    "M2 produto mantém Offer InStock": { primary: [/^lucro-e-caixa\.html: (?:schema\.org\/InStock em modo fechado|Offer paga em modo fechado \(.*schema\.org\/InStock.*\))$/], apply: (d) => mutate(d, "lucro-e-caixa", (h) => h.replace('"@type": "Product",', '"@type": "Product", "offers": {"@type": "Offer", "availability": "https://schema.org/InStock"},')) },
    "M3 termos mantém 'após o pagamento'": { primary: [/^termos: formulacao divergente '7 dias após o pagamento'$/], apply: (d) => mutate(d, "termos", (h) => h.replace("</main>", "<p>Você pode desistir da compra em até 7 dias após o pagamento.</p></main>")) },
    "M3b produto troca a regra por 'após a compra'": { primary: [/^vendas-na-pratica: (?:falta '7 dias corridos[^']*'|formulacao divergente 'até 7 dias após a compra')$/], apply: (d) => mutate(d, "vendas-na-pratica", (h) => h.split(P.rule_7d).join("até 7 dias após a compra")) },
    "M4 reembolso mantém 'em até 2 dias úteis'": { primary: [/^reembolso: formulacao divergente 'em até 2 dias úteis'$/], apply: (d) => mutate(d, "reembolso", (h) => h.replace("</main>", "<p>Reembolso em até 2 dias úteis.</p></main>")) },
    "M5 produto sem 72 h ao lado da oferta": { primary: [/^combo-ia-vendas: falta 'link pessoal válido por 72 horas[^']*'$/], apply: (d) => mutate(d, "combo-ia-vendas", (h) => h.split(P.delivery_72h).join("link pessoal")) },
    "M7 assinatura mantém href /assinar/": { primary: [/^conteudo-pronto\.html: href de checkout\/assinatura \(href="\/assinar\/\) em modo fechado$/], apply: (d) => mutate(d, "conteudo-pronto", (h) => h.replace(/href="[^"]*" data-zev-sub="conteudo-pronto"/, 'href="/assinar/conteudo-pronto" data-zev-sub="conteudo-pronto"')) },
    "M7b página com link /hotmart/": { primary: [/^ia-por-ramo\.html: href de checkout\/assinatura \(href="\/hotmart\/\) em modo fechado$/], apply: (d) => mutate(d, "ia-por-ramo", (h) => h.replace("</main>", '<a href="/hotmart/ia-na-pratica">x</a></main>')) },
    "M7c página com checkout pay.hotmart.com": { primary: [/^kit-afiliado\.html: href de checkout\/assinatura \(href="https:\/\/pay\.hotmart\.com\) em modo fechado$/], apply: (d) => mutate(d, "kit-afiliado", (h) => h.replace("</main>", '<a href="https://pay.hotmart.com/F107979716H?off=g9knd34r">x</a></main>')) },
    "M8 calculadora mantém 'garantia de 7 dias'": { primary: [/^calculadora-cmv: formulacao divergente 'garantia de 7 dias'$/], apply: (d) => mutate(d, "calculadora-cmv", (h) => h.replace("direito de arrependimento de 7 dias", "garantia de 7 dias")) },
    "M8b assinatura sem a regra dos 7 dias": { primary: [/^conteudo-pronto: falta '7 dias corridos[^']*'$/], apply: (d) => mutate(d, "conteudo-pronto", (h) => h.split(P.rule_7d).join("7 dias")) },
    "M6 texto único alterado em termos": { primary: [/^termos: texto unico \(Sol 079-P13\) ausente ou alterado$/], apply: (d) => mutate(d, "termos", (h) => h.replace(P.sol_text, P.sol_text.replace("receberá imediatamente a confirmação", "receberá a confirmação em 48 horas"))) },
  });
  const report = [];
  for (const [name, spec] of Object.entries(mutants)) {
    const dir = mkdtempSync(join(tmpdir(), "p13-mut-"));
    try {
      cpSync(PUB, dir, { recursive: true, filter: (s) => !/[\\/](brand|assets)([\\/]|$)/.test(s) });
      spec.apply(dir);
      const r = audit(dir);
      const [verdict, why] = classifyAudit(r, spec);
      report.push(`${name}: ${verdict}${why ? " [" + why + "]" : ""}`);
      assert.equal(verdict, "KILLED", name + ": " + why + " :: " + r.stdout + r.stderr);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  console.log("P13_MUTANTS " + report.join(" | "));
});

function mutate(dir, slug, fn) {
  const f = join(dir, slug + ".html");
  const before = readTextNormalized(f);
  const after = fn(before);
  assert.notEqual(after, before, "mutação não aplicada em " + slug);
  writeFileSync(f, after);
}
