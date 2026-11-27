// P18 ao vivo com o preço lido de São Paulo (scripts/b0/p18-live-br.mjs). Sem rede.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { loadAllowlist, loadDirectAuthorization, buildReport, PASS, FAIL } from "../scripts/b0/p18-commercial.mjs";
import { applyBrEvidence, decideBrEvidence, fetchBrRead, brEndpointOk, verifierSha256, BR_MAX_AGE_MS } from "../scripts/b0/p18-live-br.mjs";

const allow = loadAllowlist("."), direct = loadDirectAuthorization(".", allow);
const SHA = createHash("sha256").update(readFileSync("scripts/b0/p18-commercial.mjs", "utf8")).digest("hex");
const NOW = Date.parse("2026-11-27T22:00:00Z");
const URL_OK = "https://abcdefghijklmnopqrst.supabase.co/functions/v1/p18-leitura-br";
const kitOf = (e, over = {}) => ({ slug: e.slug, at: "2026-11-27T21:59:10Z", http: 200, product: e.hotmart_product_id, offer: e.offer, currency: "BRL", currencies_seen: ["BRL"], cash_price: e.price_cash_brl, expected_brl: e.price_cash_brl, structured: "ok", verdict: "PASS", reason: "open_authorized_direct_hotmart", ...over });
const brOk = (over = {}, kitOver = () => ({})) => ({ ok: true, status: 200, edge_region: "sa-east-1", json: { schema: "zevanory.p18.leitura-br.v1", started_at: "2026-11-27T21:59:00Z", region: "sa-east-1", verifier: { verifier_sha256: SHA }, verdict: "PASS",
  kits: direct.products.map((e) => kitOf(e, kitOver(e))), conteudo_pronto: { closed: true } , ...over } });
// Relatório do runner (fora do Brasil): kits abertos com identidade certa, preço não verificado (USD); site e CP ok.
function runnerReport({ kitState = () => "open" } = {}) {
  const results = [];
  for (const p of allow.products) {
    results.push({ source: "live:site_route", slug: p.slug, verdict: PASS, reason: "site_route_paused_as_expected" });
    const e = direct.products.find((x) => x.slug === p.slug);
    if (e) { const st = kitState(p.slug); results.push({ source: "live:checkout", slug: p.slug, authorized_direct: true, state: st, verdict: FAIL, reason: st === "open" ? "authorized_direct_price_unverified" : st === "closed" ? "authorized_direct_open_but_closed" : "product_id_mismatch" }); }
    else results.push({ source: "live:checkout", slug: p.slug, state: "closed", verdict: PASS, reason: "closed_as_expected" });
  }
  return buildReport("live", results, { sales_mode: "globally-blocked", hotmart_channel: false });
}
const reasons = (rep) => rep.results.filter((r) => r.verdict === FAIL).map((r) => [r.slug, r.reason]);
const one = (slug, reason) => direct.products.map((e) => [e.slug, e.slug === slug ? reason : null]).filter((x) => x[1]);

test("P18LB.1: leitura de São Paulo válida (sa-east-1, verificador igual, BRL, 97/97/147/157/247) → live PASS", () => {
  const rep = applyBrEvidence(runnerReport(), brOk(), direct, { verifierSha: SHA, now: NOW });
  assert.equal(rep.verdict, PASS, "[P18LB.1] " + JSON.stringify(reasons(rep)));
  assert.equal(rep.results.filter((r) => r.reason === "open_authorized_direct_hotmart").length, 5);
  assert.deepEqual(rep.results.filter((r) => r.br).map((r) => [r.slug, r.br.currency, r.br.cash_price, r.br.edge_region]), direct.products.map((e) => [e.slug, "BRL", e.price_cash_brl, "sa-east-1"]), "[P18LB.1] evidência por kit");
  assert.equal(rep.br_read.verifier_match, true);
});

test("P18LB.2: região incorreta, falta de evidência, USD, preço divergente, verificador diferente, fora do prazo → FAIL", () => {
  const all = (rep, reason) => assert.deepEqual(reasons(rep), direct.products.map((e) => [e.slug, reason]), "[P18LB.2] " + reason);
  all(applyBrEvidence(runnerReport(), { ...brOk(), edge_region: "us-east-1" }, direct, { verifierSha: SHA, now: NOW }), "leitura_br_regiao_divergente:us-east-1");
  all(applyBrEvidence(runnerReport(), brOk({ region: "us-east-1" }), direct, { verifierSha: SHA, now: NOW }), "leitura_br_regiao_divergente:us-east-1");
  all(applyBrEvidence(runnerReport(), { ...brOk(), edge_region: null }, direct, { verifierSha: SHA, now: NOW }), "leitura_br_regiao_divergente:ausente");
  all(applyBrEvidence(runnerReport(), { ok: false, error: "rede:timeout" }, direct, { verifierSha: SHA, now: NOW }), "authorized_direct_price_unverified:sem_leitura_brasil:rede:timeout");
  all(applyBrEvidence(runnerReport(), null, direct, { verifierSha: SHA, now: NOW }), "authorized_direct_price_unverified:sem_leitura_brasil");
  all(applyBrEvidence(runnerReport(), brOk({}, () => ({ currency: null, currencies_seen: ["USD"], cash_price: null, verdict: "FAIL", reason: "authorized_direct_price_unverified" })), direct, { verifierSha: SHA, now: NOW }), "authorized_direct_price_currency:USD");
  all(applyBrEvidence(runnerReport(), brOk({}, () => ({ currency: "USD", currencies_seen: ["USD"] })), direct, { verifierSha: SHA, now: NOW }), "authorized_direct_price_currency:USD");
  all(applyBrEvidence(runnerReport(), brOk({}, () => ({ cash_price: null, currencies_seen: [] , verdict: "FAIL", reason: "authorized_direct_price_unverified" })), direct, { verifierSha: SHA, now: NOW }), "authorized_direct_price_unverified:sem_preco_brasil");
  all(applyBrEvidence(runnerReport(), brOk({ verifier: { verifier_sha256: "0".repeat(64) } }), direct, { verifierSha: SHA, now: NOW }), "leitura_br_verificador_divergente");
  all(applyBrEvidence(runnerReport(), brOk(), direct, { verifierSha: SHA, now: NOW + BR_MAX_AGE_MS }), "leitura_br_fora_do_prazo");
  all(applyBrEvidence(runnerReport(), brOk({ kits: [] }), direct, { verifierSha: SHA, now: NOW }), "authorized_direct_price_unverified:sem_leitura_brasil:kit_ausente");
  const div = applyBrEvidence(runnerReport(), brOk({}, (e) => (e.slug === "lucro-e-caixa" ? { cash_price: "97,00" } : {})), direct, { verifierSha: SHA, now: NOW });
  assert.deepEqual(reasons(div), one("lucro-e-caixa", "authorized_direct_price_mismatch:97,00"), "[P18LB.2] preço divergente");
  const off = applyBrEvidence(runnerReport(), brOk({}, (e) => (e.slug === "ia-na-pratica" ? { offer: "outra123" } : {})), direct, { verifierSha: SHA, now: NOW });
  assert.deepEqual(reasons(off), one("ia-na-pratica", "authorized_direct_offer_mismatch:8704733/outra123"), "[P18LB.2] oferta divergente");
});

test("P18LB.3: a leitura de São Paulo não salva kit fechado ou com identidade divergente no runner; Conteúdo Pronto e site seguem do runner", () => {
  const rep = applyBrEvidence(runnerReport({ kitState: (s) => (s === "negocio-completo" ? "closed" : s === "ia-na-pratica" ? "mismatch" : "open") }), brOk(), direct, { verifierSha: SHA, now: NOW });
  assert.deepEqual(reasons(rep), [["ia-na-pratica", "product_id_mismatch"], ["negocio-completo", "authorized_direct_open_but_closed"]], "[P18LB.3]");
  assert.equal(rep.results.find((r) => r.slug === "conteudo-pronto" && r.source === "live:checkout").reason, "closed_as_expected");
});

test("P18LB.4: chamada só GET, sem cookie, com x-region: sa-east-1, só ao endpoint fixo do Supabase; lê x-sb-edge-region", async () => {
  const calls = [];
  const f = async (u, init) => { calls.push({ u, init }); return { status: 200, headers: { get: (k) => (k === "x-sb-edge-region" ? "sa-east-1" : null) }, text: async () => JSON.stringify({ region: "sa-east-1" }) }; };
  const r = await fetchBrRead(URL_OK, { fetchImpl: f });
  assert.deepEqual([r.ok, r.edge_region, r.json.region], [true, "sa-east-1", "sa-east-1"]);
  assert.deepEqual([calls[0].init.method, calls[0].init.credentials, calls[0].init.headers["x-region"], calls[0].init.headers.cookie, calls[0].init.redirect], ["GET", "omit", "sa-east-1", undefined, "error"], "[P18LB.4] forma da chamada");
  for (const bad of ["http://abcdefghijklmnopqrst.supabase.co/functions/v1/p18-leitura-br", "https://abcdefghijklmnopqrst.supabase.co/functions/v1/outra", URL_OK + "?x=1", "https://evil.example/functions/v1/p18-leitura-br", "https://x.supabase.co.evil.example/functions/v1/p18-leitura-br"])
    assert.equal(brEndpointOk(bad), false, "[P18LB.4] endpoint recusado: " + bad);
  assert.deepEqual(await fetchBrRead("https://evil.example/x", { fetchImpl: f }), { ok: false, error: "endpoint_invalido" });
  assert.equal((await fetchBrRead(URL_OK, { fetchImpl: async () => ({ status: 503, headers: { get: () => null }, text: async () => "" }) })).error, "http_503");
  assert.equal((await fetchBrRead(URL_OK, { fetchImpl: async () => { throw new Error("timeout"); } })).error, "rede:timeout");
  assert.equal(verifierSha256(), SHA, "[P18LB.4] sha do verificador local");
});
