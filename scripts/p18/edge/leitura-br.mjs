// ZEVANORY | P18 — leitura dos 6 checkouts fixos a partir de São Paulo (Edge Function Supabase, invocação regional
// sa-east-1). Reaproveita as regras do verificador oficial (scripts/b0/p18-commercial.mjs): forma do link, GET seguro
// (só GET, sem corpo, sem cookie, credentials omit, redirect manual conferido contra redirect_hosts), classificação do
// checkout, preço estruturado da oferta exata (BRL) e decisão do estado autorizado. Devolve SÓ o necessário à prova:
// horário, região, produto, oferta, moeda, preço à vista e status. Nunca HTML, cookie ou dado de comprador.
import {
  validateAllowlist, validateDirectAuthorization, directEntry, checkLinkShape, safeGet, classifyCheckout,
  structuredOfferPrice, decideDirectCheckout, decideCheckout, searchableText, decodeNuxtData, PASS, FAIL,
} from "../../b0/p18-commercial.mjs";

export const LEITURA_SCHEMA = "zevanory.p18.leitura-br.v1";
// Conteúdo Pronto: o aviso de vendas encerradas é desenhado por JavaScript; sem navegador, a prova é o salto do próprio
// checkout para /error?errorMessage=049 (mesmo host da lista). Regra auxiliar, rotulada no resultado.
const CLOSED_REDIRECT = /^\/error$/;
export function closedByRedirect(finalUrl, allow) {
  try { const u = new URL(finalUrl); return allow.redirect_hosts.includes(u.hostname) && CLOSED_REDIRECT.test(u.pathname) && u.searchParams.get("errorMessage") === "049"; }
  catch { return false; }
}
// Moedas presentes nos objetos {currency, value} do estado da página (só os códigos ISO; registra USD quando vier USD).
const NUXT_ONE = /<script\b[^>]*\bid\s*=\s*["']__NUXT_DATA__["'][^>]*>([\s\S]*?)<\/script\s*>/i;
export function currenciesSeen(html) {
  const m = NUXT_ONE.exec(String(html || "")); if (!m) return [];
  let root; try { root = decodeNuxtData(m[1].trim()); } catch { return ["?"]; }
  const out = new Set(), seen = new Set();
  const walk = (o, d) => { if (out.size > 5 || d > 40 || o === null || typeof o !== "object" || seen.has(o)) return; seen.add(o);
    if (!Array.isArray(o) && typeof o.currency === "string" && "value" in o && /^[A-Z]{3}$/.test(o.currency)) out.add(o.currency);
    for (const k of Object.keys(o)) walk(o[k], d + 1); };
  walk(root, 0);
  return [...out].sort();
}
export async function leituraBr({ allow: allowRaw, direct: directRaw, fetchImpl = fetch, now = () => Date.now(), region = null, verifier = null } = {}) {
  const allow = validateAllowlist(allowRaw), direct = validateDirectAuthorization(directRaw, allow);
  const started = new Date(now()).toISOString();
  const kits = [];
  let conteudoPronto = null;
  for (const p of allow.products) {
    const href = `https://${allow.checkout_hosts[0]}/${p.checkout_code}?off=${p.offer}`;
    const at = new Date(now()).toISOString();
    const shape = checkLinkShape(href, allow, { pageSlug: p.slug });
    if (!shape.ok) { (p.kind === "kit" ? kits : []).push({ slug: p.slug, at, verdict: FAIL, reason: shape.reason }); continue; }
    const got = await safeGet(href, { fetchImpl, allowHosts: allow.redirect_hosts });
    const cls = got.error && !got.body ? { state: "unverifiable", reason: got.error, identity: null } : classifyCheckout(got, p, allow);
    const de = directEntry(direct, p, "globally-blocked", false);
    if (de) {
      const st = structuredOfferPrice(got.body || "", de);
      const d = decideDirectCheckout(cls, searchableText(got.body || ""), de, st);
      kits.push({ slug: p.slug, at, http: got.status, product: st.product_id ?? null, offer: st.offer ?? null, currency: st.currency ?? (st.state === "currency" ? st.detail : null),
        currencies_seen: currenciesSeen(got.body), cash_price: st.value_brl ?? null, expected_brl: de.price_cash_brl, structured: st.state + (st.detail ? ":" + st.detail : ""), verdict: d.verdict, reason: d.reason });
    } else {
      let d = decideCheckout("globally-blocked", cls), evidence = "classificacao:" + cls.state;
      if (d.verdict !== PASS && closedByRedirect(got.final_url, allow)) { d = { verdict: PASS, reason: "closed_as_expected" }; evidence = "salto_checkout:/error?errorMessage=049"; }
      conteudoPronto = { slug: p.slug, at, http: got.status, closed: d.verdict === PASS, evidence, verdict: d.verdict, reason: d.reason };
    }
  }
  const ok = kits.length === direct.products.length && kits.every((k) => k.verdict === PASS && k.currency === "BRL" && k.cash_price === k.expected_brl) && conteudoPronto?.closed === true;
  return { schema: LEITURA_SCHEMA, started_at: started, finished_at: new Date(now()).toISOString(), region, verifier, verdict: ok ? PASS : FAIL, kits, conteudo_pronto: conteudoPronto };
}
