// ZEVANORY | P18 ao vivo com o preço lido de SÃO PAULO. O runner do GitHub recebe a oferta convertida em USD (#1109);
// a prova do preço à vista em BRL vem da Edge Function "p18-leitura-br" (Supabase Free da ZEVANORY), invocada com
// x-region: sa-east-1, que roda AS MESMAS regras deste verificador (o sha256 de scripts/b0/p18-commercial.mjs vem na
// resposta e precisa ser igual ao deste checkout). O resto do live (trava, canal, rotas do site, identidade do produto e
// do produtor, Conteúdo Pronto) continua sendo lido pelo runner, sem mudança.
// Falha fechada, por kit autorizado (nunca PASS sem a leitura de São Paulo válida):
//   sem resposta / HTTP ≠ 200 / não JSON          → authorized_direct_price_unverified:sem_leitura_brasil
//   x-sb-edge-region ou region ≠ sa-east-1         → leitura_br_regiao_divergente:<região>
//   verificador da função ≠ verificador local      → leitura_br_verificador_divergente
//   leitura com mais de 15 min (ou do futuro)       → leitura_br_fora_do_prazo
//   produto ou oferta ≠ decisão                     → authorized_direct_offer_mismatch:<produto>/<oferta>
//   moeda ≠ BRL (inclui USD sem preço à vista)      → authorized_direct_price_currency:<moedas>
//   preço à vista ausente                           → authorized_direct_price_unverified:sem_preco_brasil
//   preço à vista ≠ decidido                        → authorized_direct_price_mismatch:<valor>
// Somente GET, sem cookie, sem segredo; host da função limitado a *.supabase.co e ao caminho fixo.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { loadAllowlist, loadDirectAuthorization, runLive, buildReport, PASS, FAIL } from "./p18-commercial.mjs";

export const BR_REGION = "sa-east-1";
export const BR_MAX_AGE_MS = 15 * 60 * 1000;
export const BR_PATH = "/functions/v1/p18-leitura-br";
const HERE = dirname(fileURLToPath(import.meta.url));
export const verifierSha256 = (file = join(HERE, "p18-commercial.mjs")) => createHash("sha256").update(readFileSync(file, "utf8")).digest("hex");

export function brEndpointOk(url) {
  try { const u = new URL(url); return u.protocol === "https:" && /^[a-z0-9]{20}\.supabase\.co$/.test(u.hostname) && u.pathname === BR_PATH && !u.search && !u.hash && !u.username && !u.password && !u.port; }
  catch { return false; }
}
export async function fetchBrRead(url, { fetchImpl = fetch, timeoutMs = 120_000 } = {}) {
  if (!brEndpointOk(url)) return { ok: false, error: "endpoint_invalido" };
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
  const init = { method: "GET", headers: { accept: "application/json", "x-region": BR_REGION }, credentials: "omit", redirect: "error", cache: "no-store", signal: ctl.signal };
  try {
    const r = await fetchImpl(url, init);
    const edge = typeof r.headers?.get === "function" ? r.headers.get("x-sb-edge-region") : null;
    if (r.status !== 200) return { ok: false, status: r.status, edge_region: edge, error: "http_" + r.status };
    let json; try { json = JSON.parse(await r.text()); } catch { return { ok: false, status: 200, edge_region: edge, error: "nao_json" }; }
    return { ok: true, status: 200, edge_region: edge, json };
  } catch (e) { return { ok: false, error: "rede:" + String(e?.message || e).slice(0, 60) }; }
  finally { clearTimeout(t); }
}
export function decideBrEvidence(br, entry, { verifierSha, now = Date.now() } = {}) {
  const F = (reason) => ({ verdict: FAIL, reason });
  if (!br || !br.ok) return F("authorized_direct_price_unverified:sem_leitura_brasil" + (br?.error ? ":" + br.error : ""));
  const j = br.json || {};
  if (br.edge_region !== BR_REGION) return F("leitura_br_regiao_divergente:" + (br.edge_region || "ausente"));
  if (j.region !== BR_REGION) return F("leitura_br_regiao_divergente:" + (j.region || "ausente"));
  if (!verifierSha || j.verifier?.verifier_sha256 !== verifierSha) return F("leitura_br_verificador_divergente");
  const at = Date.parse(j.started_at);
  if (!Number.isFinite(at) || now - at > BR_MAX_AGE_MS || at - now > 60_000) return F("leitura_br_fora_do_prazo");
  const k = (Array.isArray(j.kits) ? j.kits : []).find((x) => x && x.slug === entry.slug);
  if (!k) return F("authorized_direct_price_unverified:sem_leitura_brasil:kit_ausente");
  if (k.product !== entry.hotmart_product_id || k.offer !== entry.offer) return F("authorized_direct_offer_mismatch:" + k.product + "/" + k.offer);
  const seen = Array.isArray(k.currencies_seen) ? k.currencies_seen : [];
  if ((k.currency && k.currency !== "BRL") || seen.some((c) => c !== "BRL")) return F("authorized_direct_price_currency:" + ([...new Set([k.currency, ...seen].filter(Boolean))].join("|") || "ausente"));
  if (!k.cash_price) return F("authorized_direct_price_unverified:sem_preco_brasil");
  if (k.cash_price !== entry.price_cash_brl) return F("authorized_direct_price_mismatch:" + k.cash_price);
  if (k.currency !== "BRL" || k.verdict !== PASS) return F(k.reason || "authorized_direct_price_unverified:sem_preco_brasil");
  return { verdict: PASS, reason: "open_authorized_direct_hotmart" };
}
// Aplica a leitura de São Paulo ao relatório do live: só nos checkouts dos kits autorizados que o runner viu ABERTOS
// com produto e produtor corretos (state open). Fechado, divergente ou ilegível no runner continua reprovando.
export function applyBrEvidence(report, br, direct, { verifierSha, now = Date.now() } = {}) {
  const results = report.results.map((r) => {
    if (r.source !== "live:checkout" || !r.authorized_direct) return r;
    const entry = direct.products.find((x) => x.slug === r.slug);
    const k = br?.json?.kits?.find?.((x) => x && x.slug === r.slug) || null;
    const evidence = { edge_region: br?.edge_region ?? null, region: br?.json?.region ?? null, started_at: br?.json?.started_at ?? null,
      product: k?.product ?? null, offer: k?.offer ?? null, currency: k?.currency ?? null, currencies_seen: k?.currencies_seen ?? [], cash_price: k?.cash_price ?? null, error: br?.ok ? null : br?.error ?? "sem_resposta" };
    if (r.state !== "open") return { ...r, br: evidence };
    const d = decideBrEvidence(br, entry, { verifierSha, now });
    return { ...r, verdict: d.verdict, reason: d.reason, runner_reason: r.reason, br: evidence };
  });
  const { mode, results: _r, counts: _c, verdict: _v, reason: _re, schema: _s, ...extra } = report;
  return buildReport(mode, results, { ...extra, br_read: { endpoint_ok: !!br?.ok, edge_region: br?.edge_region ?? null, started_at: br?.json?.started_at ?? null, verifier_match: br?.json?.verifier?.verifier_sha256 === verifierSha } });
}

async function main(argv) {
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const out = arg("--out", null), root = arg("--root", "."), endpointFile = arg("--br-endpoint", "data/p18-leitura-br-endpoint.json");
  const allow = loadAllowlist(root), direct = loadDirectAuthorization(root, allow);
  let url = null; try { url = JSON.parse(readFileSync(join(root, endpointFile), "utf8")).url; } catch { url = null; }
  const br = url ? await fetchBrRead(url) : { ok: false, error: "endpoint_nao_configurado" };
  let renderCheckout = null;
  if (argv.includes("--browser")) renderCheckout = (await import("./p18-commercial-browser.mjs")).makeBrowserRenderer(allow);
  let base; try { base = await runLive({ allow, direct, renderCheckout }); } finally { await renderCheckout?.close?.(); }
  const report = applyBrEvidence(base, br, direct, { verifierSha: verifierSha256() });
  if (out) writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  console.log(`P18_BR_READ ok=${br.ok} http=${br.status ?? "-"} x-sb-edge-region=${br.edge_region ?? "-"} region=${br.json?.region ?? "-"} started=${br.json?.started_at ?? "-"} verifier_match=${report.br_read.verifier_match}${br.error ? " erro=" + br.error : ""}`);
  for (const r of report.results) console.log(`${r.verdict} ${r.source} ${r.slug ?? "-"} ${r.reason}${r.link ? " " + r.link : ""}`);
  for (const r of report.results) if (r.br) console.log(`P18_BR_EVIDENCE ${r.slug} produto=${r.br.product} oferta=${r.br.offer} moeda=${r.br.currency} moedas_vistas=${(r.br.currencies_seen || []).join(",")} a_vista=${r.br.cash_price} regiao=${r.br.edge_region} lido_em=${r.br.started_at}`);
  console.log(`P18_COMMERCIAL mode=${report.mode} verdict=${report.verdict} total=${report.counts.total} pass=${report.counts.pass} fail=${report.counts.fail} sales_mode=${report.sales_mode} hotmart_channel=${report.hotmart_channel} br=${br.ok ? "ok" : "sem_leitura"}`);
  return report.verdict === PASS ? 0 : 1;
}
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(String(e?.stack || e)); process.exitCode = 2; });
