// Counting rules of the command-center "Funil" — taxonomy v2 (AVAL Sol 23/10/2026). Pure functions:
// no network, no KV. Every metric is published with its window, numerator, denominator, dedup rule,
// sources covered, freshness and an integrity class:
//   COMPLETE      every source the number claims is covered and fresh
//   PARTIAL       some source is missing/unverified (the value is the known part, NEVER a silent zero)
//   STALE         the input is older than its freshness budget
//   LEGACY_MIXED  old series that mixes different entities; kept only for comparison
//   MISSING       nothing to count (not measured, capture not live, or no period where it can exist)
// Four entities are never mixed: waitlist interest, real transactional intent, leads, approved sales.
const DAY = 864e5, HOUR = 36e5;
export const OWN_PROVIDERS = Object.freeze(["mercadopago", "asaas"]);
export const PROVIDER_LABEL = Object.freeze({ mercadopago: "Mercado Pago", asaas: "Asaas" });
export const CLASSES = Object.freeze(["COMPLETE", "PARTIAL", "STALE", "LEGACY_MIXED", "MISSING"]);
// The panel's legacy seal vocabulary (it renders `integrity`); the class above is the truth.
const SEAL = { COMPLETE: "aggregated", PARTIAL: "stale", STALE: "stale", LEGACY_MIXED: "estimated", MISSING: "missing" };

const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);
export const brtDay = (t) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
// Day keys inside the last `days` calendar days ending today (inclusive), as YYYY-MM-DD strings.
export function windowDays(now, days, { endOffset = 0, zone = "brt" } = {}) {
  const f = zone === "utc" ? (t) => new Date(t).toISOString().slice(0, 10) : brtDay;
  const out = [];
  for (let i = endOffset; i < days + endOffset; i++) out.push(f(now - i * DAY));
  return out;
}

export function describe({ value, unit = "count", window, numerator, denominator = null, dedup, sources, updatedAt = null, maxAgeHours = 3, integrityClass, label, definition, now = Date.now(), extra = {} }) {
  const fresh = updatedAt ? now - Date.parse(updatedAt) <= maxAgeHours * HOUR : false;
  let cls = value == null ? "MISSING" : integrityClass;
  if (cls === "COMPLETE" && !fresh) cls = "STALE";
  return { value: value ?? null, unit, window, numerator, denominator, dedup, sources, freshness: { updatedAt, maxAgeHours, fresh }, integrityClass: cls, integrity: SEAL[cls], source: label, updatedAt, definition, ...extra };
}

// ---------- sales (single view over the authenticated ledgers) ----------
// counted: funnel summary ran the provider-confirmed query in production. test_mode: MERCADOPAGO_ENV is
// not production, the own checkout cannot take real money (a true 0). unverified/missing: unknown.
export function ownCheckoutStatus(own) {
  if (!own || typeof own !== "object") return "missing";
  if (own.counted === true && own.byDay && typeof own.byDay === "object") return "counted";
  if (own.mode === "test") return "test_mode";
  return "unverified";
}
// Hotmart ledger: idempotent per transaction (postback hottok). Absent ledger = no postback ever
// stored, which does not prove zero sales.
export const hotmartStatus = (sales) => (sales && sales.schema === "zevanory-sales/v1" ? "ledger" : "no_events");

export function sumOwn(own, days) {
  const set = days ? new Set(days) : null;
  const out = { total: 0, grossCents: 0, byProvider: {}, ignoredNonOwnProvider: 0 };
  if (ownCheckoutStatus(own) !== "counted") return { ...out, total: null, grossCents: null };
  for (const [day, providers] of Object.entries(own.byDay)) {
    if (set && !set.has(day)) continue;
    for (const [provider, b] of Object.entries(providers || {})) {
      // A Hotmart (or unknown) label inside the own ledger is never counted: no sale counts twice.
      if (!OWN_PROVIDERS.includes(provider)) { out.ignoredNonOwnProvider += n(b?.confirmed); continue; }
      out.total += n(b?.confirmed); out.grossCents += n(b?.grossCents);
      out.byProvider[provider] = (out.byProvider[provider] || 0) + n(b?.confirmed);
    }
  }
  return out;
}
export function sumHotmart(sales, days) {
  const set = days ? new Set(days) : null;
  let approved = 0, grossCents = 0, reversed = 0;
  for (const [day, b] of Object.entries(sales?.byDay || {})) if (!set || set.has(day)) { approved += n(b?.approved); grossCents += n(b?.grossCents); reversed += n(b?.reversed); }
  return { approved, grossCents, reversed };
}

// Approved sales of a window (list of day keys; null = all time), split by source.
export function combineSales({ sales, own, days = null }) {
  const os = ownCheckoutStatus(own), hs = hotmartStatus(sales);
  const o = sumOwn(own, days), h = sumHotmart(sales, days);
  const ownTotal = os === "counted" ? o.total : os === "test_mode" ? 0 : null;
  const ownGross = os === "counted" ? o.grossCents : os === "test_mode" ? 0 : null;
  const complete = ownTotal != null && hs === "ledger";
  return {
    total: ownTotal == null && hs !== "ledger" && !h.approved ? null : h.approved + (ownTotal || 0),
    grossCents: h.grossCents + (ownGross || 0),
    complete,
    checkoutProprio: { status: os, total: ownTotal, grossCents: ownGross, byProvider: o.byProvider, ignoredNonOwnProvider: o.ignoredNonOwnProvider },
    hotmart: { status: hs, total: h.approved, grossCents: h.grossCents, reversed: h.reversed, edgeSales: days ? sumHotmart(sales, hotmartEdgeDays(days)).approved : 0 },
  };
}
export const SALES_LABEL = Object.freeze({
  counted: "Checkout próprio (Mercado Pago/Asaas) + Hotmart",
  test_mode: "Checkout próprio (modo teste, sem cobrança real) + Hotmart",
  unverified: "Hotmart · checkout próprio NÃO VERIFICADO",
  missing: "Hotmart · checkout próprio NÃO VERIFICADO",
});
// Hotmart ledger days are UTC (legacy). A Hotmart sale on a UTC day at the edge of a São Paulo window may
// belong to the neighbouring São Paulo day, so the total is PARTIAL whenever one exists there.
export function hotmartEdgeDays(days) {
  if (!days?.length) return [];
  const sorted = [...days].sort(), first = sorted[0], last = sorted[sorted.length - 1];
  const next = new Date(Date.parse(last + "T00:00:00Z") + DAY).toISOString().slice(0, 10);
  return [first, next];
}
export function salesMetric(c, { window, updatedAt, now, definition }) {
  const byProv = Object.entries(c.checkoutProprio.byProvider).map(([p, v]) => `${PROVIDER_LABEL[p] || p} ${v}`).join(", ");
  const own = c.checkoutProprio.total == null ? "checkout próprio não verificado" : `checkout próprio ${c.checkoutProprio.total}${byProv ? ` (${byProv})` : ""}`;
  const hot = c.hotmart.status === "ledger" ? `Hotmart ${c.hotmart.total}` : `Hotmart ${c.hotmart.total} (nenhum postback registrado: não prova zero)`;
  return describe({
    value: c.total, window, now, updatedAt, maxAgeHours: 3,
    numerator: "vendas aprovadas únicas", dedup: "checkout próprio: 1 por sessão de compra (failover entre provedores não duplica), chave do pagamento provider+payment_id via webhook autenticado; Hotmart: 1 por transação (postback autenticado, idempotente). Reembolsos e chargebacks ficam à parte (não subtraídos).",
    sources: ["checkout_proprio:mercadopago", "checkout_proprio:asaas", "hotmart"],
    integrityClass: c.complete && !c.hotmart.edgeSales ? "COMPLETE" : "PARTIAL",
    label: SALES_LABEL[c.checkoutProprio.status],
    definition: `${definition}: ${own} + ${hot}. Dia do pagamento em America/Sao_Paulo (Hotmart: registro legado por dia UTC). Pedidos de certificação/sandbox fora.`,
    extra: { parts: { checkoutProprio: c.checkoutProprio, hotmart: c.hotmart } },
  });
}

// What a consumer (milestones, forecast, recommendations) may claim from a sales metric: the value only
// when it is COMPLETE/STALE; a PARTIAL value > 0 is a lower bound; PARTIAL 0 and MISSING are unknown (null).
export function knownCount(m) {
  if (!m || m.value == null || m.integrityClass === "MISSING") return { value: null, integrityClass: "MISSING", lowerBound: false };
  if (m.integrityClass === "PARTIAL") return m.value > 0 ? { value: m.value, integrityClass: "PARTIAL", lowerBound: true } : { value: null, integrityClass: "PARTIAL", lowerBound: false };
  return { value: m.value, integrityClass: m.integrityClass, lowerBound: false };
}

// Daily approved sales of both sources merged (forecast and ledger start); own part only when counted.
export function mergeDaily(sales, own) {
  const out = {};
  const add = (day, a, g) => { const d = (out[day] = out[day] || { approved: 0, grossCents: 0 }); d.approved += a; d.grossCents += g; };
  for (const [day, b] of Object.entries(sales?.byDay || {})) add(day, n(b?.approved), n(b?.grossCents));
  if (ownCheckoutStatus(own) === "counted") for (const day of Object.keys(own.byDay)) { const o = sumOwn(own, [day]); if (o.total) add(day, o.total, o.grossCents); }
  return out;
}

// ---------- funnel signals (taxonomy v2 daily rows from worker/funnel.mjs) ----------
export const sumSources = (sources, keys) => Object.values(sources || {}).reduce((a, s) => a + keys.reduce((b, k) => b + (Number(s?.[k]) || 0), 0), 0);
export const LEGACY_MIXED_KEYS = Object.freeze(["checkout_intent", "hotmart_view", "subscribe_click"]);
export function sumDaily(daily, metric, days) { return days.reduce((a, d) => a + n(daily?.[d]?.[metric]), 0); }
// First day the v2 instrumentation recorded anything (site_visitors rides every counted view).
export const v2Since = (daily) => Object.keys(daily || {}).filter((d) => n(daily[d]?.site_visitors) > 0).sort()[0] || null;
const coverage = (daily, days) => { const since = v2Since(daily); return since && days.every((d) => d >= since) ? "full" : since ? "partial" : "none"; };
// Days with the buy CTA shown (sales open). Closed days never enter checkout/sale denominators.
export const openDays = (daily, days) => days.filter((d) => n(daily?.[d]?.buy_cta_view) > 0);

// The waitlist click and the waitlist lead capture are not live in this release: the CTA still links
// to an external chat (its replacement is a separate PR) and the P01 Fase A form is off. Tests pin both
// flags to the code (an emitter of waitlist_click in the sales Worker must flip the first one).
export const WAITLIST_CLICK_INSTRUMENTED = false;
export const WAITLIST_CAPTURE_LIVE = false;
// Lead capture that IS live: the free-material form -> double-opt-in lead table (proved by tests).
export const LEAD_CAPTURE = Object.freeze({ live: true, form: "/material-gratuito", what: "formulário do Material gratuito" });

export function funnelMetrics({ funnel, sales, own, now = Date.now(), funnelAt = null, salesAt = null, capture = LEAD_CAPTURE, clickInstrumented = WAITLIST_CLICK_INSTRUMENTED, waitlistCaptureLive = WAITLIST_CAPTURE_LIVE }) {
  const daily = funnel?.daily || null;
  // v2 rows are keyed by America/Sao_Paulo day (worker/funnel.mjs v2Day), like the own-checkout sales.
  const d30 = windowDays(now, 30), d7 = windowDays(now, 7);
  const ownIn = (days) => { const st = ownCheckoutStatus(own); return st === "counted" ? sumOwn(own, days).total : st === "test_mode" ? 0 : null; };
  const v2 = daily != null;
  const cov30 = v2 ? coverage(daily, d30) : "none";
  const v2Class = cov30 === "full" ? "COMPLETE" : "PARTIAL";
  const v2Note = cov30 === "full" ? "" : ` Instrumentação v2 desde ${v2Since(daily) || "—"}: janela ainda não coberta por inteiro.`;
  const common = { now, updatedAt: funnelAt };
  const m = {};

  // Visitors / denominators.
  m.visitorPageDays7 = describe({ ...common, value: funnel?.last7Days?.cleanVisitors ?? null, unit: "visitor-page-days", window: "7 dias UTC (desde o filtro de robôs)", numerator: "(dia, página, hash diário) únicos", dedup: "por dia e página: a mesma pessoa em 3 páginas conta 3", sources: ["site"], integrityClass: "COMPLETE", label: "Site (legado: visitor-page-days)", definition: "Soma diária de visitantes únicos POR PÁGINA. Não é pessoa única; não usar como denominador de conversão." });
  const sv7 = v2 ? sumDaily(daily, "site_visitors", d7) : null;
  m.visitorDays7 = describe({ ...common, value: sv7, unit: "visitor-days", window: "7 dias (America/Sao_Paulo)", numerator: "(dia, hash diário) únicos no site", dedup: "1 por visitante por dia no site inteiro; o hash gira por dia, então 7 dias = soma de dias, não pessoas únicas", sources: ["site"], integrityClass: v2 && coverage(daily, d7) === "full" ? "COMPLETE" : "PARTIAL", label: "Site (visitor-days)", definition: "Visitantes elegíveis (robôs/datacenter fora) por dia, somados em 7 dias." + (v2 && coverage(daily, d7) !== "full" ? ` Instrumentação desde ${v2Since(daily) || "—"}.` : "") });
  const pv30 = funnel ? Object.values(funnel.sources || {}).reduce((a, s) => a + (Number(s?.views) || 0), 0) : null;
  m.pageviews30 = describe({ ...common, value: pv30, unit: "pageviews", window: "30 dias UTC", numerator: "páginas vistas com origem atribuída", dedup: "nenhuma (cada página vista conta)", sources: ["site"], integrityClass: "COMPLETE", label: "Site (páginas vistas)", definition: "Páginas vistas com origem, 30 dias. É volume de páginas, não pessoas; nunca entra em conversão." });

  // Waitlist (interest, never lead or intent).
  const wlView = v2 ? sumDaily(daily, "waitlist_cta_view", d30) : null;
  m.waitlistCtaViews30 = describe({ ...common, value: wlView, unit: "visitor-day-product", window: "30 dias (America/Sao_Paulo)", numerator: "visitantes expostos ao CTA de lista de espera (vendas fechadas)", dedup: "1 por visitante/dia/página de produto", sources: ["site"], integrityClass: v2Class, label: "Site (exposição ao CTA fechado)", definition: "Visitante elegível recebeu a página de produto com vendas fechadas (CTA de lista de espera)." + v2Note });
  const wlClick = v2 && clickInstrumented ? sumDaily(daily, "waitlist_click", d30) : null;
  m.waitlistClicks30 = describe({ ...common, value: wlClick, unit: "visitor-day-product", window: "30 dias (America/Sao_Paulo)", numerator: "cliques únicos em Entrar na lista de espera", dedup: "1 por visitante/dia/produto", sources: ["site"], integrityClass: v2Class, label: clickInstrumented ? "Site (clique na lista de espera)" : "Clique na lista de espera NÃO MEDIDO", definition: clickInstrumented ? "Interesse na lista de espera; não é lead nem intenção de compra." : "O botão leva direto a um link externo sem passar pelo site; o clique não é contado nesta versão (substituição do CTA em PR separado). Ausência de número não é zero." });
  m.waitlistLeadsPending = describe({ ...common, value: null, unit: "leads", window: "7 dias", numerator: "contatos recebidos com consentimento, não confirmados", dedup: "hash do contato + finalidade/versão do consentimento", sources: ["lista de espera"], integrityClass: "MISSING", label: waitlistCaptureLive ? "Lista de espera: fonte ainda não ligada ao painel" : "Captura da lista de espera ainda não ativa", definition: (waitlistCaptureLive ? "A captura existe, mas esta versão do painel não lê a sua tabela." : "Nenhum formulário de lista de espera está no ar (P01 Fase A desligada).") + " Clique em link externo nunca conta como lead." });
  m.waitlistLeadsConfirmed = describe({ ...m.waitlistLeadsPending, value: null, numerator: "leads da lista com opt-in duplo confirmado", integrityClass: "MISSING", label: m.waitlistLeadsPending.source, definition: m.waitlistLeadsPending.definition });

  // Leads (free material): only confirmed are "Leads confirmados"; pending apart.
  const lc = funnel?.last7Days?.leadsConfirmed, lp = funnel?.last7Days?.leadsPending;
  const capNote = capture?.live ? ` Captura no ar: ${capture.what} (${capture.form}).` : "";
  m.leadsConfirmed7 = capture?.live
    ? describe({ ...common, value: lc ?? null, unit: "leads", window: "7 dias (data da confirmação)", numerator: "leads com opt-in duplo confirmado", dedup: "1 por e-mail (tabela de leads, chave única)", sources: ["material gratuito"], integrityClass: "COMPLETE", label: "Leads confirmados (opt-in duplo) · Material gratuito", definition: "Somente cadastros confirmados por e-mail." + capNote })
    : describe({ ...common, value: null, unit: "leads", window: "7 dias", numerator: "leads confirmados", dedup: "—", sources: [], integrityClass: "MISSING", label: "Captura de leads ainda não ativa", definition: "Nenhum formulário de captura no ar: não há o que contar (não é zero cadastros)." });
  m.leadsPending7 = describe({ ...common, value: capture?.live ? lp ?? null : null, unit: "leads", window: "7 dias (data do cadastro)", numerator: "cadastros aguardando confirmação", dedup: "1 por e-mail", sources: ["material gratuito"], integrityClass: "COMPLETE", label: "Leads pendentes · Material gratuito", definition: "Cadastros ainda não confirmados; não entram em Leads confirmados." + capNote });

  // Real transactional intent (sales open, server-created session). Hotmart/assinatura opening is not
  // observable on our side, so the metric covers the own checkout only.
  const open30 = v2 ? openDays(daily, d30) : [];
  const ocs = v2 ? sumDaily(daily, "own_checkout_started", d30) : null;
  m.transactionalIntent30 = describe({ ...common, value: v2 && open30.length ? ocs : null, window: "30 dias (America/Sao_Paulo), só dias com vendas abertas", numerator: "sessões de pagamento do checkout próprio criadas pelo servidor", dedup: "1 por visitante + produto + provedor a cada janela fixa de 30 min (nova janela = nova tentativa); contador bruto à parte", sources: ["checkout_proprio"], integrityClass: "PARTIAL", label: "Checkout próprio (sessão criada) · Hotmart/assinatura não observáveis", definition: v2 && !open30.length ? "Nenhum dia com vendas abertas na janela: intenção transacional não pode existir (não é zero de demanda)." : "Intenção transacional real. Exclui lista de espera, visita a página fechada, ida genérica à Hotmart, cliques repetidos e envio de formulário." + v2Note, extra: { openDays: open30.length, raw: v2 ? sumDaily(daily, "own_checkout_started_raw", d30) : null } });
  const legacy = funnel ? sumSources(funnel.sources, LEGACY_MIXED_KEYS) : null;
  m.legacyMixedClicks30 = describe({ ...common, value: legacy, window: "30 dias UTC", numerator: "checkout_intent + hotmart_view + subscribe_click (série antiga)", dedup: "nenhuma (cada clique conta)", sources: ["site"], integrityClass: "LEGACY_MIXED", label: "Série antiga de cliques (mistura)", definition: "Mantida só para comparação; mistura abertura da página de compra, ida à Hotmart e assinatura, sem deduplicação. Não é intenção real e não foi reclassificada." });

  // Sales.
  const salesUpdatedAt = [salesAt, ownCheckoutStatus(own) === "counted" ? funnelAt : null].filter(Boolean).sort().pop() || funnelAt || salesAt || null;
  const s30days = windowDays(now, 30);
  m.sales30 = salesMetric(combineSales({ sales, own, days: s30days }), { window: "30 dias (America/Sao_Paulo)", updatedAt: salesUpdatedAt, now, definition: "Vendas aprovadas em 30 dias" });
  const h30 = sumHotmart(sales, s30days);
  m.reversals30 = describe({ now, updatedAt: salesUpdatedAt, value: hotmartStatus(sales) === "ledger" ? h30.reversed : null, window: "30 dias", numerator: "reembolsos + chargebacks + reclamações", dedup: "1 por transação e desfecho", sources: ["hotmart"], integrityClass: "PARTIAL", label: "Hotmart · reembolsos do checkout próprio não medidos aqui", definition: "Reversões ficam fora de Vendas aprovadas (não subtraídas)." });

  // Five separate conversions; same window and exposure; closed days never enter checkout/sale ratios.
  const ratio = (num, den) => (num != null && den ? Math.round((10000 * num) / den) / 100 : null);
  m.conversions = {
    waitlistCtr: describe({ ...common, value: ratio(wlClick, wlView), unit: "%", window: "30 dias (America/Sao_Paulo)", numerator: "clicadores únicos da lista de espera (visitante/dia/produto)", denominator: "visitantes únicos expostos ao CTA fechado (visitante/dia/produto)", dedup: "visitante/dia/produto", sources: ["site"], integrityClass: v2Class, label: "CTR da lista de espera", definition: clickInstrumented ? "Cliques únicos ÷ expostos ao CTA fechado." : "Clique ainda não medido (CTA direto para link externo): sem numerador." }),
    waitlistCapture: describe({ ...common, value: null, unit: "%", window: "30 dias", numerator: "leads confirmados da lista", denominator: "clicadores únicos da lista (também ÷ expostos)", dedup: "hash do contato + consentimento", sources: ["lista de espera"], integrityClass: "MISSING", label: "Captura da lista de espera", definition: "Captura da lista ainda não ativa." }),
    checkoutStart: describe({ ...common, value: open30.length ? ratio(ocs, sumDaily(daily, "buy_cta_view", d30)) : null, unit: "%", window: "30 dias (America/Sao_Paulo), só dias com vendas abertas", numerator: "intenções transacionais únicas (checkout próprio)", denominator: "visitantes únicos expostos ao botão de compra com vendas abertas", dedup: "visitante/dia/produto (exposição); visitante+produto+provedor/30 min (intenção)", sources: ["site", "checkout_proprio"], integrityClass: "PARTIAL", label: "Início de checkout", definition: open30.length ? "Hotmart/assinatura fora (não observáveis)." + v2Note : "Sem dias com vendas abertas na janela." }),
    checkoutCompletion: (() => {
      const dm = windowDays(now, 30, { endOffset: 1 }); // 24 h of maturation, same São Paulo days for both sides
      const opens = v2 ? openDays(daily, dm) : [];
      const den = v2 ? sumDaily(daily, "own_checkout_started", dm) : null;
      const num = ownIn(dm);
      return describe({ ...common, value: opens.length ? ratio(num, den) : null, unit: "%", window: "30 dias terminando há 24 h (maturação), só dias abertos", numerator: "vendas aprovadas únicas do checkout próprio", denominator: "intenções transacionais únicas do checkout próprio", dedup: "sessão de compra / visitante+produto+provedor/30 min", sources: ["checkout_proprio"], integrityClass: "PARTIAL", label: "Conclusão de checkout (checkout próprio)", definition: opens.length ? "Coorte aproximada pela janela (vendas e intenções no mesmo dia de São Paulo, sem ligação por tentativa); Hotmart fora." : "Sem intenções em dias abertos na janela." });
    })(),
    visitorToSale: (() => {
      const den = open30.length ? open30.reduce((a, d) => a + n(daily[d]?.site_visitors), 0) : null;
      // Same calendar on both sides: v2 visitor-days and own-checkout sales are both America/Sao_Paulo days.
      const num = ownIn(open30);
      const hot = sumHotmart(sales, s30days).approved;
      return describe({ ...common, value: open30.length ? ratio(num, den) : null, unit: "%", window: "30 dias, só dias com vendas abertas", numerator: "vendas aprovadas atribuídas ao site (checkout próprio)", denominator: "visitantes elegíveis (visitor-days) nos dias abertos", dedup: "sessão de compra / visitante por dia", sources: ["site", "checkout_proprio"], integrityClass: hot || num == null ? "PARTIAL" : v2Class, label: "Conversão visitante → venda", definition: (open30.length ? "Nunca usa páginas vistas nem dias fechados." : "Sem dias com vendas abertas na janela.") + (hot ? " Vendas Hotmart da janela não são atribuíveis por dia ao site: fora do numerador." : "") });
    })(),
  };
  return m;
}

// ---------- buy flow and Hotmart offers vs the owner switch ----------
export const expectedBuyState = (salesOpen) => (salesOpen === true ? "checkout" : salesOpen === false ? "closed" : null);
export function evaluateBuyFlow(records, salesOpen) {
  const expected = expectedBuyState(salesOpen);
  return (records || []).map((r) => ({ ...r, expected, ok: expected != null && r.state === expected }));
}
// One Hotmart offer probe. "closed" = Hotmart's own closed page (redirect to /error, e.g. errorMessage=049
// "vendas deste produto estão temporariamente encerradas", or that text); "accepting" = the offer page
// itself answered with positive evidence of the offer (its product code in the page, no error/closed
// signal) — able to take a payment; "inconclusive" = 200 without either signal (never counted as closed,
// never raised as P0 without evidence); "error" = no answer.
export const HOTMART_CLOSED_RE = /temporariamente encerrad|vendas deste produto est[aã]o|indispon[ií]vel|n[aã]o est[aá] dispon[ií]vel|unavailable|not available/i;
export function classifyHotmartProbe(p) {
  if (!p || !(p.http > 0)) return "error";
  if (/^\/error/i.test(String(p.finalPath || "")) || p.errorCode || p.blockedText) return "closed";
  if (p.http === 200) return p.offerMarker ? "accepting" : "inconclusive";
  return "error";
}
export function hotmartLockState(probes, salesOpen) {
  const list = (probes || []).map((p) => ({ slug: p.slug, state: classifyHotmartProbe(p), errorCode: p.errorCode || null }));
  const accepting = list.filter((p) => p.state === "accepting").map((p) => p.slug);
  const closed = list.filter((p) => p.state === "closed").map((p) => p.slug);
  const base = { total: list.length, accepting, closed, unverified: list.filter((p) => p.state === "error" || p.state === "inconclusive").map((p) => p.slug), offers: list };
  if (!list.length) return { ...base, state: "unknown", severity: null };
  if (salesOpen === false) {
    if (accepting.length) return { ...base, state: "p0_bypass", severity: "P0" };
    return { ...base, state: closed.length === list.length ? "closed" : "unverified", severity: null };
  }
  if (salesOpen === true) return { ...base, state: accepting.length === list.length ? "selling" : closed.length === list.length ? "closed_while_open" : "degraded", severity: null };
  return { ...base, state: "unknown", severity: null };
}
export function hotmartModeText(lock) {
  const code = [...new Set(lock.offers.map((o) => o.errorCode).filter(Boolean))].join(", ");
  return `Hotmart: ${lock.accepting.length}/${lock.total} ofertas aceitando pagamento, ${lock.closed.length}/${lock.total} encerradas${code ? ` (erro ${code})` : ""}${lock.unverified.length ? `, ${lock.unverified.length} sem prova (sem resposta ou inconclusiva)` : ""}`;
}
