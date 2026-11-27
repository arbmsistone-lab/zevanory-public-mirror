// P18 — leitura a partir de São Paulo (Edge Function "p18-leitura-br"). Sem rede: fetch falso com fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { readTextNormalized } from "./helpers/text.mjs";
import { leituraBr, closedByRedirect, LEITURA_SCHEMA } from "../scripts/p18/edge/leitura-br.mjs";
import { build, OUT } from "../scripts/p18/edge/build.mjs";

const allow = JSON.parse(readFileSync("data/p18-commercial-allowlist.json", "utf8"));
const direct = JSON.parse(readFileSync("data/p18-hotmart-direct-authorization.json", "utf8"));
const FX = (n) => readTextNormalized(new URL("./fixtures/p18-commercial/" + n, import.meta.url));
const P = (slug) => allow.products.find((p) => p.slug === slug);
const KITS = allow.products.filter((p) => p.kind === "kit"), CP = allow.products.find((p) => p.kind !== "kit");
const priceOf = (slug) => direct.products.find((x) => x.slug === slug).price_cash_brl;
const productFixture = (slug) => FX("hotmart-open-ok.html").replace(/8704733/g, P(slug).hotmart_product_id).replace(/IA na Pr(á|\\u00e1)tica/g, P(slug).name);
function devalue(root) {
  const a = [["ShallowReactive", 1]], memo = new Map();
  const enc = (v) => { if (v === undefined) return -1; if (v !== null && typeof v === "object" && memo.has(v)) return memo.get(v);
    const i = a.length; a.push(null); if (v !== null && typeof v === "object") memo.set(v, i);
    if (Array.isArray(v)) a[i] = v.map(enc); else if (v !== null && typeof v === "object") { const o = {}; for (const k of Object.keys(v)) o[k] = enc(v[k]); a[i] = o; } else a[i] = v; return i; };
  enc(root); return a;
}
const num = (s) => Number(String(s).replace(",", "."));
// Forma real (27/11): Brasil = cartão (parcelas, 1x) + PIX em BRL; fora do Brasil = só cartão em USD, sem parcelas.
function nuxt(slug, { price = priceOf(slug), currency = "BRL", usd = false } = {}) {
  const m = (v) => ({ currency, label: null, value: num(v) });
  const pms = usd ? [{ type: "CREDIT_CARD", offer: P(slug).offer, amount: m(price) }]
    : [{ type: "CREDIT_CARD", offer: P(slug).offer, amount: m(price), installments: [{ number: 1, amount: m(price), fullAmount: m(price) }] }, { type: "PIX", offer: P(slug).offer, amount: m(price) }];
  const product = { id: Number(P(slug).hotmart_product_id), offer: { key: P(slug).offer, paymentMethods: pms } };
  return `<script type="application/json" id="__NUXT_DATA__">${JSON.stringify(devalue({ data: { products: [product] } }))}</script>`;
}
const resp = (status, body = "", location = null) => ({ status, headers: { get: (k) => (k === "location" ? location : null) }, text: async () => body });
function fakeFetch({ kit = (slug) => resp(200, productFixture(slug) + nuxt(slug)), cp = (u) => (u.includes("/error") ? resp(200, FX("hotmart-spa-shell.html")) : resp(302, "", "/error?errorMessage=049&checkoutLoadId=CKTID-teste")) } = {}) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, method: init.method, credentials: init.credentials, cookie: init.headers?.cookie });
    const s = allow.products.find((p) => url.includes(p.checkout_code))?.slug; return s && s !== CP.slug ? kit(s, url) : cp(url); };
  f.calls = calls; return f;
}

test("P18BR.1: Brasil (BRL, oferta exata) nos 5 kits + Conteúdo Pronto fechado pelo salto 049 = PASS; só GET, sem cookie", async () => {
  const f = fakeFetch();
  const r = await leituraBr({ allow, direct, fetchImpl: f, region: "sa-east-1", now: () => Date.parse("2026-11-27T21:00:00Z") });
  assert.equal(r.schema, LEITURA_SCHEMA);
  assert.equal(r.verdict, "PASS", "[P18BR.1] " + JSON.stringify(r));
  assert.deepEqual(r.kits.map((k) => [k.slug, k.product, k.offer, k.currency, k.cash_price, k.verdict]),
    KITS.map((p) => [p.slug, p.hotmart_product_id, p.offer, "BRL", priceOf(p.slug), "PASS"]), "[P18BR.1] 5 kits");
  assert.deepEqual([r.conteudo_pronto.closed, r.conteudo_pronto.evidence], [true, "salto_checkout:/error?errorMessage=049"], "[P18BR.1] Conteúdo Pronto");
  assert.equal(r.region, "sa-east-1");
  assert.ok(f.calls.every((c) => c.method === "GET" && c.credentials === "omit" && !c.cookie), "[P18BR.1] só GET, sem cookie");
  assert.ok(f.calls.every((c) => c.url.startsWith("https://pay.hotmart.com/")), "[P18BR.1] só os links fixos");
});

test("P18BR.2: fora do Brasil (USD, sem parcela 1 e sem PIX) reprova; preço divergente reprova; checkout fechado de kit reprova", async () => {
  const usd = await leituraBr({ allow, direct, fetchImpl: fakeFetch({ kit: (s) => resp(200, productFixture(s) + nuxt(s, { currency: "USD", usd: true, price: "19" })) }) });
  assert.equal(usd.verdict, "FAIL");
  assert.ok(usd.kits.every((k) => k.verdict === "FAIL" && k.reason === "authorized_direct_price_unverified" && k.cash_price === null && k.currencies_seen.join() === "USD"), "[P18BR.2] USD: " + JSON.stringify(usd.kits[0]));
  const cur = await leituraBr({ allow, direct, fetchImpl: fakeFetch({ kit: (s) => resp(200, productFixture(s) + nuxt(s, { currency: "USD" })) }) });
  assert.ok(cur.kits.every((k) => k.currency === "USD" && k.reason === "authorized_direct_price_currency:USD"), "[P18BR.2] moeda USD");
  const div = await leituraBr({ allow, direct, fetchImpl: fakeFetch({ kit: (s) => resp(200, productFixture(s) + nuxt(s, s === "lucro-e-caixa" ? { price: "97,00" } : {})) }) });
  assert.deepEqual(div.kits.filter((k) => k.verdict === "FAIL").map((k) => [k.slug, k.reason]), [["lucro-e-caixa", "authorized_direct_price_mismatch:97,00"]], "[P18BR.2] preço divergente");
  assert.equal(div.verdict, "FAIL");
  const cl = await leituraBr({ allow, direct, fetchImpl: fakeFetch({ kit: (s) => resp(200, FX("hotmart-closed-049.html").replace(/8704733/g, P(s).hotmart_product_id)) }) });
  assert.ok(cl.kits.every((k) => k.reason === "authorized_direct_open_but_closed"), "[P18BR.2] kit fechado");
});

test("P18BR.3: Conteúdo Pronto aberto ou salto para fora da lista reprova; salto só vale com host da lista e erro 049", async () => {
  const open = await leituraBr({ allow, direct, fetchImpl: fakeFetch({ cp: () => resp(200, FX("hotmart-open-ok.html").replace(/8704733/g, CP.hotmart_product_id)) }) });
  assert.equal(open.conteudo_pronto.closed, false, "[P18BR.3] aberto");
  assert.equal(open.verdict, "FAIL");
  assert.equal(closedByRedirect("https://pay.hotmart.com/error?errorMessage=049", allow), true);
  assert.equal(closedByRedirect("https://pay.hotmart.com/error?errorMessage=050", allow), false, "[P18BR.3] outro código");
  assert.equal(closedByRedirect("https://evil.example/error?errorMessage=049", allow), false, "[P18BR.3] outro host");
  const out = await leituraBr({ allow, direct, fetchImpl: fakeFetch({ cp: () => resp(302, "", "https://evil.example/error?errorMessage=049") }) });
  assert.equal(out.conteudo_pronto.closed, false, "[P18BR.3] salto para fora da lista");
});

test("P18BR.4: resposta só com os campos da prova (sem HTML, sem cookie, sem dado de comprador)", async () => {
  const r = await leituraBr({ allow, direct, fetchImpl: fakeFetch(), region: "sa-east-1", verifier: { verifier_sha256: "x" } });
  assert.deepEqual(Object.keys(r).sort(), ["conteudo_pronto", "finished_at", "kits", "region", "schema", "started_at", "verdict", "verifier"]);
  for (const k of r.kits) assert.deepEqual(Object.keys(k).sort(), ["at", "cash_price", "currencies_seen", "currency", "expected_brl", "http", "offer", "product", "reason", "slug", "structured", "verdict"]);
  assert.deepEqual(Object.keys(r.conteudo_pronto).sort(), ["at", "closed", "evidence", "http", "reason", "slug", "verdict"]);
  const s = JSON.stringify(r);
  assert.ok(!/[<>]|cookie|checkoutLoadId|CKTID/i.test(s), "[P18BR.4] nada de HTML, cookie ou id de sessão: " + s.slice(0, 200));
});

test("P18BR.5: função publicada = saída exata do gerador (regras do verificador sem edição); servidor só GET sem parâmetros", async () => {
  const { out, meta } = build();
  assert.equal(readFileSync(OUT, "utf8").replace(/\r\n?/g, "\n"), out, "[P18BR.5] index.ts versionado = gerador (rode node scripts/p18/edge/build.mjs)");
  assert.ok(!/^\s*import\s/m.test(out) && !/from "node:/.test(out), "[P18BR.5] arquivo único, sem imports");
  assert.match(out, new RegExp("verifier_sha256=" + meta.verifier_sha256));
  // Portabilidade: com fontes em CRLF (Windows), o gerador produz o MESMO arquivo e os mesmos hashes.
  const crlf = mkdtempSync(join(tmpdir(), "p18br-crlf-"));
  for (const f of ["scripts/b0/p18-commercial.mjs", "data/p18-commercial-allowlist.json", "data/p18-hotmart-direct-authorization.json", "scripts/p18/edge/leitura-br.mjs"]) {
    mkdirSync(join(crlf, dirname(f)), { recursive: true }); writeFileSync(join(crlf, f), readFileSync(f, "utf8").replace(/\r?\n/g, "\r\n"));
  }
  assert.equal(build(crlf).out, out, "[P18BR.5] fontes em CRLF geram o mesmo arquivo");
  // Gate PED (arquivos .ts): nenhuma linha fora de comentário com padrão de cor #rgb/#rrggbb.
  const hexLines = out.split("\n").filter((l) => /#[0-9a-fA-F]{3,8}\b/.test(l) && !l.includes("--") && !/^\s*(\/\/|\/\*|\*)/.test(l));
  assert.deepEqual(hexLines, [], "[P18BR.5] nada que o PED leia como cor fixa");
  // Roda o arquivo gerado com um Deno falso: GET → 200 JSON; POST → 405; parâmetro → 400.
  const d = mkdtempSync(join(tmpdir(), "p18br-")); copyFileSync(OUT, join(d, "fn.mjs"));
  let handler = null;
  globalThis.Deno = { serve: (h) => { handler = h; }, env: { get: (k) => (k === "SB_REGION" ? "sa-east-1" : undefined) } };
  const realFetch = globalThis.fetch; globalThis.fetch = fakeFetch();
  try {
    await import(pathToFileURL(join(d, "fn.mjs")).href);
    const ok = await handler(new Request("https://x.supabase.co/functions/v1/p18-leitura-br"));
    const j = await ok.json();
    assert.deepEqual([ok.status, j.verdict, j.region, j.verifier.verifier_sha256], [200, "PASS", "sa-east-1", meta.verifier_sha256], "[P18BR.5] GET");
    assert.equal((await handler(new Request("https://x.supabase.co/functions/v1/p18-leitura-br", { method: "POST", body: "{}" }))).status, 405, "[P18BR.5] só GET");
    assert.equal((await handler(new Request("https://x.supabase.co/functions/v1/p18-leitura-br?url=https://evil"))).status, 400, "[P18BR.5] sem parâmetros");
  } finally { globalThis.fetch = realFetch; delete globalThis.Deno; }
});
