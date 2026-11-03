// Sol 232 (#914): the trust block (trust-mini, "Como a compra funciona", hero buy-facts, legal footer)
// must state exactly the same facts as /termos, /privacidade, /reembolso and the Worker's checkout facts
// (worker/politica-unica.mjs: DELIVERY_72H, RULE_7D, SUPPLIER). Facts are EXTRACTED from the built pages,
// so any edit that makes one source diverge (support time, 7 days, 72-hour link, CNPJ, company name,
// address) fails here.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readTextNormalized } from "./helpers/text.mjs";
import { DELIVERY_72H, DELIVERY_TEXT, RULE_7D, RULE_LINE, SUPPLIER } from "../worker/politica-unica.mjs";

const PUB = join(fileURLToPath(new URL("..", import.meta.url)), "sales-public");
const read = (f) => readTextNormalized(join(PUB, f));
const pages = readdirSync(PUB).filter((f) => f.endsWith(".html")).map((f) => [f, read(f)]);
const text = (h) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const lc1 = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const LEGAL = ["termos.html", "privacidade.html", "reembolso.html"].map((f) => [f, read(f)]);
const legalBody = (h) => text(h.replace(/<footer[\s\S]*$/, "")); // the page's own text, without the injected footer

function collect(re, group = 1) {
  const out = new Set();
  for (const [, h] of pages) for (const m of h.matchAll(re)) out.add(m[group].trim());
  return [...out];
}

test("support response time: one wording everywhere, matches Termos and Reembolso, nothing contradicts it", () => {
  const found = [
    ...collect(/<span class="tm-note">([^<]+?)\.?<\/span>/g),
    ...collect(/<li class="fl-note">([^<]+?)\.?<\/li>/g),
    ...collect(/<dt>Suporte<\/dt><dd>.*?<br>([^<]+?)\.?<\/dd>/g),
  ].map(lc1);
  assert.ok(found.length >= 1, "trust/footers state a response time");
  assert.deepEqual([...new Set(found)], ["confirmação imediata e resposta conclusiva em até 5 dias"], "one wording");
  const fact = found[0];
  for (const f of ["termos.html", "reembolso.html"]) assert.ok(legalBody(read(f)).includes(fact), `${f} states "${fact}"`);
  for (const [f, h] of LEGAL) for (const m of legalBody(h).matchAll(/resposta conclusiva em até (\d+) (dias|horas)/g)) assert.equal(`${m[1]} ${m[2]}`, "5 dias", f);
});

test("7-day withdrawal: trust copy == Worker RULE_7D == Termos/Reembolso", () => {
  assert.ok(RULE_7D.startsWith("7 dias corridos"), RULE_7D);
  const hero = collect(/<li>Arrependimento em (\d+ dias corridos), com devolução integral<\/li>/g);
  assert.deepEqual(hero, ["7 dias corridos"]);
  assert.deepEqual(collect(/<li><strong>(\d+ dias)<\/strong><span>Para desistir/g), ["7 dias"]);
  assert.ok(RULE_LINE.includes("7 dias corridos") && RULE_LINE.includes("devolução integral"));
  for (const f of ["termos.html", "reembolso.html"]) {
    const b = legalBody(read(f));
    assert.ok(b.includes("7 dias corridos"), f);
    for (const m of b.matchAll(/(\d+) dias corridos/g)) assert.equal(m[1], "7", `${f}: ${m[0]}`);
  }
});

test("DEC-01 v3: 192h PDF/ZIP commitment matches Worker, products, Termos and Reembolso", () => {
  assert.equal(DELIVERY_72H,"192 horas (8 dias) após a aprovação do pagamento");
  assert.ok(DELIVERY_TEXT.includes(DELIVERY_72H));
  const facts=collect(/<li>PDFs e ZIP por e-mail ([^<]+)<\/li>/g);
  assert.ok(facts.some(v=>v.includes(DELIVERY_72H)),"hero states the exact 192-hour deadline");
  const trust=collect(/<li><strong>PDFs e ZIP<\/strong><span>([^<]+)<\/span><\/li>/g);
  assert.ok(trust.some(v=>v.includes(DELIVERY_72H)),"offer trust states the same deadline");
  for (const f of ["termos.html","reembolso.html"]) assert.ok(legalBody(read(f)).includes(DELIVERY_72H),f);
  for (const [f,h] of [...LEGAL,...pages]){
    const b=text(h);
    assert.doesNotMatch(b,/link pessoal válido por 72 horas e para um download|72 horas e para um download/i,f);
  }
  for(const slug of ["ia-na-pratica","vendas-na-pratica","lucro-e-caixa","combo-ia-vendas","negocio-completo"]){
    assert.ok(read(slug+".html").includes(DELIVERY_72H),slug+": no early link");
  }
});

test("company name, CNPJ and address: trust block, seller list and footer == Worker SUPPLIER == legal pages", () => {
  const { razao_social: NAME, cnpj: CNPJ, endereco_fisico: ADDR, cep: CEP } = SUPPLIER;
  assert.deepEqual(collect(/class="trust-mini"[^>]*><li><strong>Empresa brasileira<\/strong><span>([^,]+), <span class="nowrap">CNPJ ([\d./-]+)<\/span>/g).sort(), [NAME]);
  assert.deepEqual(collect(/class="trust-mini"[^>]*><li><strong>Empresa brasileira<\/strong><span>[^,]+, <span class="nowrap">CNPJ ([\d./-]+)<\/span>/g), [CNPJ]);
  assert.deepEqual(collect(/<dt>Quem vende<\/dt><dd>([^,<]+),/g), [NAME]);
  assert.deepEqual(collect(/<dt>CNPJ<\/dt><dd>([^<]+)<\/dd>/g), [CNPJ]);
  assert.deepEqual(collect(/id="fl-empresa">Empresa<\/h2><p>([^<]+)<br>/g), [NAME]);
  assert.deepEqual(collect(/id="fl-empresa">Empresa<\/h2><p>[^<]+<br>CNPJ ([^<]+)<br>/g), [CNPJ]);
  assert.deepEqual(collect(/id="fl-empresa">Empresa<\/h2><p>[^<]+<br>[^<]+<br>([^<]+)<\/p>/g), [`${ADDR}, CEP ${CEP}`]);
  for (const [f, h] of LEGAL) {
    const b = legalBody(h);
    assert.ok(b.includes(NAME) && b.includes(CNPJ), `${f}: name and CNPJ`);
    assert.ok(b.includes(ADDR), `${f}: address`);
  }
  for (const [f, h] of pages) for (const m of text(h).matchAll(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g)) assert.equal(m[0], CNPJ, `${f}: foreign CNPJ`);
  const worker = readTextNormalized(fileURLToPath(new URL("../worker/sales-public-worker.mjs", import.meta.url)));
  assert.ok(worker.includes(`name:"${NAME}"`), "Worker JSON-LD seller name");
});
