// ZEVANORY Revenue Command Center snapshot (read-only, hourly, zero cost).
// Collects every number the owner panel shows, each with provenance:
//   { value, source, updatedAt, definition, integrity }
// integrity: "real" (read from the provider now), "webhook_authenticated", "aggregated"
// (hourly rollup), "stale" (older than its freshness budget), "missing" (no data / no
// access). Nothing is estimated as real; forecasts carry intervals and need history.
// Writes KV zpc:command:v1:snapshot (shared with the panel) and keeps daily history of
// reach in zpc:command:v1:reach-history. Never publishes, charges or changes anything.
import { getYoutubeAccessToken } from "../channels/youtube-access.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { evaluateExperiments } from "./experiments.mjs";
import { evaluateInventory } from "./autonomy-inventory.mjs";
import { funnelMetrics, combineSales, salesMetric, windowDays, mergeDaily, evaluateBuyFlow, hotmartLockState, hotmartModeText, HOTMART_CLOSED_RE, knownCount, ownCheckoutStatus, hotmartStatus } from "./funnel-counting.mjs";
import { workersUsageForDay, prevUtcDay } from "./workers-usage.mjs";

export const SNAPSHOT_KEY = "zpc:command:v1:snapshot";
export const REACH_HISTORY_KEY = "zpc:command:v1:reach-history";
const TZ = "America/Sao_Paulo";
const HOUR = 3600e3, DAY = 24 * HOUR;

// Engines: who does what, when (UTC cron or local hour), and how it is proven.
export const AGENDA = [
  { id: "short-dica", agent: "Motor de Vídeo", task: "Short: dica de IA por ramo (YouTube + cross-post)", cron: { m: 0, h: 13 }, proof: "youtube_dica", workflow: "youtube-autonomous-short.yml" },
  { id: "short-oferta", agent: "Motor de Vídeo", task: "Short: produto do dia (YouTube + Telegram + cross-post)", cron: { m: 0, h: 18 }, proof: "youtube", workflow: "youtube-autonomous-short.yml" },
  { id: "short-calc", agent: "Motor de Vídeo", task: "Short: calculadora gratuita (YouTube + cross-post)", cron: { m: 0, h: 22 }, proof: "youtube_calc", workflow: "youtube-autonomous-short.yml" },
  { id: "short-backstop", agent: "Autocorreção", task: "Completa o que algum Short do dia não publicou", cron: { m: 30, h: 23 }, workflow: "youtube-autonomous-short.yml" },
  { id: "blog", agent: "Motor Editorial", task: "Artigo novo no blog", cron: { m: 5, h: 12 }, proof: "blog" },
  { id: "indexnow", agent: "Motor de SEO", task: "Avisa Bing e buscadores das páginas novas (IndexNow)", cron: { m: 40, h: 12 }, workflow: "indexnow-submit.yml" },
  { id: "telegram", agent: "Motor Social", task: "Post do dia no Telegram", cron: { m: 5, h: 15 }, proof: "telegram" },
  { id: "bluesky", agent: "Motor Social", task: "Post do dia no Bluesky com hashtags", cron: { m: 5, h: 22 }, proof: "bluesky" },
  { id: "tiktok-pack", agent: "Motor TikTok", task: "Pacote de 20 vídeos + agendamento no TikTok Studio", cron: { m: 0, h: 9, dom: [1, 11, 21] }, workflow: "short-pack.yml" },
  { id: "command", agent: "Central de Comando", task: "Atualiza números, autonomia e previsões", cron: { m: 17, h: "*" }, workflow: "command-center-snapshot.yml" },
];
export const DAILY_PROOFS = ["blog", "telegram", "bluesky", "youtube_dica", "youtube", "youtube_calc"];
// Business engines measured for autonomy. Deploys (engineering changes) and this
// observer are reported separately so they neither dilute nor inflate the number.
const ENGINE_WORKFLOWS = ["youtube-autonomous-short.yml", "short-pack.yml", "indexnow-submit.yml"];
const OBSERVED_WORKFLOWS = [...ENGINE_WORKFLOWS, "central-production-deploy.yml", "command-center-snapshot.yml", "engine-dispatcher.yml", "data-backup.yml"];
// Workflows of the panel repository whose runs are evidence for inventory processes.
const PANEL_REPO = "arbmsistone-lab/zevanory-product-control-edge";
const PANEL_WORKFLOWS = ["command-center-live-proof.yml", "creative-auto-decision.yml"];

export const localDay = (t = Date.now()) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
const iso = (t) => new Date(t).toISOString();
export const metric = (value, source, updatedAt, definition, integrity = "real") => ({ value, source, updatedAt: updatedAt || null, definition, integrity: value == null ? "missing" : integrity });

export function nextRun(cron, now = Date.now()) {
  const d = new Date(now);
  for (let i = 0; i < 24 * 40; i++) {
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + i, cron.m));
    if (t.getTime() <= now) continue;
    if (cron.h !== "*" && t.getUTCHours() !== cron.h) continue;
    if (cron.dom && !cron.dom.includes(t.getUTCDate())) continue;
    return t.toISOString();
  }
  return null;
}

// Autonomy from real workflow runs (7 days): scheduled runs that ended well, failures,
// failures recovered automatically by a later scheduled/backstop run, manual runs.
export function computeAutonomy(runs = [], now = Date.now()) {
  const since = now - 7 * DAY;
  const recent = runs.filter((r) => Date.parse(r.created_at) >= since && r.status === "completed");
  // Autonomous = cron or started by the engine dispatcher (github-actions[bot]); manual = a person.
  const auto = (r) => r.event === "schedule" || (r.event === "workflow_dispatch" && r.actor === "github-actions[bot]");
  const scheduled = recent.filter(auto);
  const manual = recent.filter((r) => r.event === "workflow_dispatch" && !auto(r));
  const ok = scheduled.filter((r) => r.conclusion === "success" || r.conclusion === "skipped");
  const failures = scheduled.filter((r) => r.conclusion === "failure" || r.conclusion === "timed_out");
  const recoveries = [];
  for (const f of failures) {
    const fixed = recent
      .filter((r) => r.path === f.path && auto(r) && r.conclusion === "success" && Date.parse(r.created_at) > Date.parse(f.created_at))
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0];
    if (fixed) recoveries.push((Date.parse(fixed.updated_at || fixed.created_at) - Date.parse(f.updated_at || f.created_at)) / 60000);
  }
  const unrecovered = failures.length - recoveries.length;
  return {
    windowDays: 7,
    scheduledRuns: scheduled.length,
    succeeded: ok.length,
    failed: failures.length,
    recoveredAutomatically: recoveries.length,
    unrecovered,
    manualRuns: manual.length,
    autonomyPct: scheduled.length ? Math.round((1000 * (ok.length + recoveries.length)) / (scheduled.length + manual.length)) / 10 : null,
    mttrMinutes: recoveries.length ? Math.round(recoveries.reduce((a, b) => a + b, 0) / recoveries.length) : null,
    failuresList: failures.slice(0, 8).map((f) => ({ workflow: f.path.split("/").pop(), at: f.created_at, recovered: recoveries.length > 0 && recent.some((r) => r.path === f.path && r.conclusion === "success" && Date.parse(r.created_at) > Date.parse(f.created_at)) })),
  };
}

// Publication completion (7 days): expected daily proofs vs published records in KV.
export function computePublications(byDay = {}) {
  let expected = 0, published = 0;
  const perChannel = {};
  for (const [, entries] of Object.entries(byDay)) {
    for (const ch of DAILY_PROOFS) {
      const e = entries[ch];
      if (!e) continue; // not yet due / not recorded: the matrix shows it, the rate ignores future slots
      expected++;
      const done = e.status === "publicado";
      if (done) published++;
      const p = (perChannel[ch] = perChannel[ch] || { expected: 0, published: 0 });
      p.expected++; if (done) p.published++;
    }
  }
  return { expected, published, pct: expected ? Math.round((1000 * published) / expected) / 10 : null, perChannel };
}

// Forecast for the next 30 days from daily sales, Poisson rate with 80% interval.
// Requires at least 14 days of ledger history and 3 sales; otherwise "insufficient".
export function forecastSales(byDay = {}, firstDay = null, now = Date.now()) {
  const today = localDay(now);
  const days = firstDay ? Math.max(0, Math.round((Date.parse(today) - Date.parse(firstDay)) / DAY)) : 0;
  const window = Math.min(days, 28);
  let sales = 0, gross = 0;
  for (let i = 0; i < window; i++) {
    const d = localDay(now - i * DAY); const b = byDay[d];
    if (b) { sales += b.approved || 0; gross += b.grossCents || 0; }
  }
  if (days < 14 || sales < 3) return { status: "insufficient", reason: `histórico de ${days} dia(s) e ${sales} venda(s); mínimo 14 dias e 3 vendas`, daysOfHistory: days, sales };
  const rate = sales / window, mean = rate * 30, sd = Math.sqrt(mean), ticket = gross / Math.max(sales, 1);
  const lo = Math.max(0, Math.floor(mean - 1.2816 * sd)), hi = Math.ceil(mean + 1.2816 * sd);
  return { status: "ok", horizonDays: 30, salesExpected: Math.round(mean * 10) / 10, salesInterval80: [lo, hi], revenueExpectedCents: Math.round(mean * ticket), revenueInterval80Cents: [Math.round(lo * ticket), Math.round(hi * ticket)], basis: `${sales} vendas em ${window} dias` };
}

// Opportunities and decisions: rule-based, each with evidence, expected result and confidence.
// salesKnown: knownCount() of the all-time approved sales ({ value, integrityClass, lowerBound }); null value
// = unknown (a source is missing), never read as zero.
export function recommend({ funnel, reach, publications, salesKnown = { value: null, integrityClass: "MISSING", lowerBound: false } }) {
  const out = [];
  const src = funnel?.sources || {};
  const ranked = Object.entries(src).filter(([k]) => k !== "direto").sort((a, b) => (b[1].views || 0) - (a[1].views || 0));
  if (ranked[0]) {
    const [name, s] = ranked[0];
    const intent = s.own_checkout_started || 0; // real transactional intent only (taxonomy v2)
    out.push({ title: `Canal que mais traz visitas: ${name}`, evidence: `${s.views || 0} páginas vistas e ${intent} intenção(ões) transacional(is) em 30 dias`, action: intent ? `Manter frequência em ${name} e repetir os formatos que geraram intenção` : `Manter ${name} e medir a exposição/lista de espera: com vendas fechadas não há intenção transacional possível`, confidence: (s.views || 0) >= 50 ? "média" : "baixa", risk: "baixo", cost: "R$ 0" });
  }
  const yt = reach?.youtube;
  if (yt?.recent?.length) {
    const best = [...yt.recent].sort((a, b) => b.views - a.views)[0];
    out.push({ title: "Short com mais visualizações", evidence: `"${best.t}" — ${best.views} visualizações`, action: best.views > 0 ? "Produzir mais Shorts com o mesmo tema e gancho" : "Ainda sem visualizações: manter consistência diária por 3 semanas antes de concluir", confidence: best.views >= 100 ? "média" : "baixa", risk: "baixo", cost: "R$ 0" });
  }
  if (publications?.pct != null && publications.pct < 90) out.push({ title: "Publicação abaixo da meta", evidence: `${publications.published}/${publications.expected} publicações confirmadas em 7 dias`, action: "Autocorreção já reexecuta; se persistir, o canal com falha aparece em Operação", confidence: "alta", risk: "baixo", cost: "R$ 0" });
  const k = salesKnown || { value: null };
  if (k.value == null) out.push({ title: "Tráfego pago bloqueado (vendas NÃO VERIFICADAS)", evidence: `Total de vendas ${k.integrityClass}: alguma fonte (checkout próprio ou Hotmart) não está coberta`, action: "Restabelecer a leitura das vendas antes de qualquer decisão; a regra do dono só libera teste pago após a 7ª venda comprovada", confidence: "alta", risk: "nenhum", cost: "R$ 0" });
  else if (k.value >= 7 && !k.lowerBound) out.push({ title: "7ª venda atingida: teste pago liberável", evidence: `${k.value} venda(s) aprovada(s) (checkout próprio + Hotmart, ${k.integrityClass})`, action: "Preparar proposta de teste pago com o criativo e canal que mais venderam (decisão do dono)", confidence: "alta", risk: "nenhum", cost: "R$ 0" });
  else out.push({ title: `Tráfego pago bloqueado (${k.lowerBound ? "≥" : ""}${k.value}/7 vendas)`, evidence: `${k.lowerBound ? "pelo menos " : ""}${k.value} venda(s) aprovada(s) (checkout próprio + Hotmart, ${k.integrityClass})`, action: k.value >= 7 ? "Total parcial: confirmar a fonte que falta antes de liberar (decisão do dono)" : "Seguir orgânico; a regra do dono libera teste pago só após a 7ª venda", confidence: "alta", risk: "nenhum", cost: "R$ 0" });
  return out;
}

// ---------- IO (only when run as a script) ----------
async function kvApi(path, init = {}) {
  const { CLOUDFLARE_API_TOKEN: tk, CLOUDFLARE_ACCOUNT_ID: ac, KV_NAMESPACE_ID: ns } = process.env;
  return fetch(`https://api.cloudflare.com/client/v4/accounts/${ac}/storage/kv/namespaces/${ns}/${path}`, { ...init, headers: { authorization: "Bearer " + tk, ...(init.headers || {}) }, signal: AbortSignal.timeout(20000) });
}
async function kvGet(key) { const r = await kvApi("values/" + encodeURIComponent(key)); if (!r.ok) return null; try { return JSON.parse(await r.text()); } catch { return null; } }
async function kvPut(key, value) { const r = await kvApi("values/" + encodeURIComponent(key), { method: "PUT", body: JSON.stringify(value) }); if (!r.ok) throw new Error("kv_put_" + r.status); }
async function kvList(prefix) { const r = await kvApi("keys?limit=1000&prefix=" + encodeURIComponent(prefix)); if (!r.ok) return []; return ((await r.json()).result || []).map((k) => k.name); }
const j = async (u, o) => { const r = await fetch(u, { ...o, signal: AbortSignal.timeout(15000) }); return r.ok ? r.json() : { _http: r.status }; };

// KV writes today for the whole account (Workers Free: 1,000/day, reset 00:00 UTC). On 12/10 the
// quota ran out and the financial proof could not be stored. Null = NOT VERIFIED (token scope).
export const KV_DAILY_WRITE_LIMIT = 1000;
async function kvWritesToday(now = Date.now()) {
  const { CLOUDFLARE_API_TOKEN: tk, CLOUDFLARE_ACCOUNT_ID: ac } = process.env;
  if (!tk || !ac) return null;
  const day = new Date(now).toISOString().slice(0, 10);
  const query = `query($a:String!,$d:Date!){viewer{accounts(filter:{accountTag:$a}){kvOperationsAdaptiveGroups(limit:100,filter:{date_geq:$d,date_leq:$d}){sum{requests}dimensions{actionType namespaceId}}}}}`;
  try {
    const r = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { authorization: "Bearer " + tk, "content-type": "application/json" }, body: JSON.stringify({ query, variables: { a: ac, d: day } }), signal: AbortSignal.timeout(15000) });
    const body = await r.json().catch(() => null);
    const groups = body?.data?.viewer?.accounts?.[0]?.kvOperationsAdaptiveGroups;
    if (!Array.isArray(groups)) return { verified: false, reason: String(body?.errors?.[0]?.message || "http_" + r.status).slice(0, 80) };
    const by = (t) => groups.filter((g) => g.dimensions?.actionType === t).reduce((a, g) => a + (g.sum?.requests || 0), 0);
    const writes = by("write") + by("delete");
    // Writes per namespace: the quota is per ACCOUNT, shared with every other project on it.
    const perNs = {};
    for (const g of groups) if (["write", "delete"].includes(g.dimensions?.actionType)) { const ns = String(g.dimensions?.namespaceId || "?"); perNs[ns] = (perNs[ns] || 0) + (g.sum?.requests || 0); }
    const ours = perNs[process.env.KV_NAMESPACE_ID || ""] || 0;
    const byNamespace = Object.entries(perNs).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([ns, n]) => ({ ns: ns.slice(0, 8), writes: n, zevanory: ns === process.env.KV_NAMESPACE_ID }));
    return { verified: true, day, writes, reads: by("read"), limit: KV_DAILY_WRITE_LIMIT, pct: Math.round((writes / KV_DAILY_WRITE_LIMIT) * 100), zevanoryWrites: ours, byNamespace };
  } catch (e) { return { verified: false, reason: String(e?.name || "error") }; }
}

// Early warning (Marco B / P0): 60% of the daily write quota, or a linear projection to midnight UTC
// that would cross 90%, is flagged BEFORE the Worker starts shedding at 70% and long before a full
// quota stops the financial proof (sales close, as on 12/10). Pure function: no writes, no network.
export function kvQuotaForecast(q, now = Date.now()) {
  if (!q?.verified || !Number.isFinite(q.writes) || !q.limit) return null;
  const d = new Date(now), midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const elapsedH = Math.max((now - midnight) / 3600e3, 1);
  const projected = Math.round((q.writes / elapsedH) * 24);
  const pct = q.writes / q.limit, projPct = projected / q.limit;
  const level = pct >= 0.9 || projPct >= 1 ? "critical" : pct >= 0.7 ? "shedding" : pct >= 0.6 || projPct >= 0.9 ? "early" : "ok";
  return { level, writes: q.writes, limit: q.limit, pct: Math.round(pct * 100), projectedEndOfDay: projected, projectedPct: Math.round(projPct * 100), hoursElapsedUtc: Math.round(elapsedH * 10) / 10 };
}

async function probe(url) {
  const t0 = Date.now();
  try { const r = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { "user-agent": "zevanory-command-center/1" } }); return { url, http: r.status, ms: Date.now() - t0, ok: r.ok }; }
  catch (e) { return { url, http: 0, ms: Date.now() - t0, ok: false, error: String(e?.name || "error") }; }
}

// What a buyer actually sees after clicking "Comprar" on the official site. /comprar/<SKU> is the OWN
// checkout (Mercado Pago; Asaas failover): "checkout" = its pre-payment page; a Hotmart link there is not
// the own checkout ("foreign_checkout"). Which state is correct depends on the owner switch
// (evaluateBuyFlow): with sales closed, "closed" is the expected, healthy state.
export function classifyBuyPage(status, html) {
  const t = String(html || "");
  if (status !== 200) return "error";
  if (/Vendas abrem em breve|ainda não está à venda/i.test(t)) return "closed";
  if (/pay\.hotmart\.com|go\.hotmart\.com/i.test(t)) return "foreign_checkout";
  if (/Ir para o pagamento seguro/i.test(t)) return "checkout";
  return "unknown";
}
async function probeBuyFlow() {
  const out = [];
  for (const sku of ["ZEV-IA-011", "ZEV-LCX-011", "ZEV-NGC-011"]) {
    // One retry on a network error/timeout, recorded as such (never hidden).
    let rec = null;
    for (let attempt = 1; attempt <= 2 && (!rec || rec.http === 0); attempt++) {
      try {
        const r = await fetch("https://vendas.zevanory.api.br/comprar/" + sku, { signal: AbortSignal.timeout(15000), headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36 zevanory-command-center" } });
        rec = { sku, http: r.status, state: classifyBuyPage(r.status, await r.text()), ...(attempt > 1 ? { retried: true } : {}) };
      } catch { rec = { sku, http: 0, state: "error", ...(attempt > 1 ? { retried: true } : {}) }; }
    }
    out.push(rec);
  }
  return out;
}

// Is each Hotmart checkout actually able to take a payment? (public URLs only)
const HOTMART_CHECKOUTS = { "ia-na-pratica": "https://pay.hotmart.com/F107979716H?off=g9knd34r", "vendas-na-pratica": "https://pay.hotmart.com/Y107979937I?off=8mg88sdd", "lucro-e-caixa": "https://pay.hotmart.com/L107979973K?off=ksb5di36", "combo-ia-vendas": "https://pay.hotmart.com/H107979990T?off=b3ytmah4", "negocio-completo": "https://pay.hotmart.com/U107980005X?off=weo47apk", "conteudo-pronto": "https://pay.hotmart.com/X107980075B?off=4ydutio7" };
async function probeHotmart() {
  const out = [];
  for (const [slug, url] of Object.entries(HOTMART_CHECKOUTS)) {
    try {
      const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15000), headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36", "accept-language": "pt-BR" } });
      const html = await r.text();
      const title = (html.match(/<title[^>]*>([^<]{0,120})/i) || [])[1] || "";
      const blocked = HOTMART_CLOSED_RE.test(html) || /em an[aá]lise/i.test(html);
      const fin = new URL(r.url);
      // Hotmart's closed offer redirects to /error?errorMessage=<code> (049 = sales temporarily closed).
      const errorCode = /^\/error/i.test(fin.pathname) ? String(fin.searchParams.get("errorMessage") || "error").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12) : null;
      // Positive evidence of the offer itself (its product code in the page); the closed page has none.
      const code = new URL(url).pathname.slice(1);
      out.push({ slug, http: r.status, finalHost: fin.host, finalPath: fin.pathname.slice(0, 40), errorCode, title: title.trim().slice(0, 80), blockedText: blocked, offerMarker: !!code && html.includes(code), bytes: html.length });
    } catch (e) { out.push({ slug, http: 0, error: String(e?.name || "error") }); }
  }
  return out;
}

async function collectReach(now) {
  const out = {};
  try { const p = await j("https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=zevanoryoficial.bsky.social"); out.bluesky = p._http ? null : { followers: p.followersCount ?? null, posts: p.postsCount ?? null }; } catch { out.bluesky = null; }
  try { const t = process.env.TELEGRAM_BOT_TOKEN, c = process.env.TELEGRAM_CHANNEL_ID; const r = t && c ? await j(`https://api.telegram.org/bot${t}/getChatMemberCount?chat_id=${encodeURIComponent(c)}`) : {}; out.telegram = r.result != null ? { members: r.result } : null; } catch { out.telegram = null; }
  try {
    const token = await getYoutubeAccessToken();
    const a = { headers: { authorization: "Bearer " + token } };
    const ch = await j("https://www.googleapis.com/youtube/v3/channels?part=statistics,contentDetails&mine=true", a);
    const st = ch.items?.[0]?.statistics || {};
    out.youtube = { subscribers: Number(st.subscriberCount || 0), views: Number(st.viewCount || 0), videos: Number(st.videoCount || 0) };
    const up = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    const pl = up ? await j(`https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=15&playlistId=${up}`, a) : {};
    const ids = (pl.items || []).map((x) => x.contentDetails.videoId).join(",");
    if (ids) { const v = await j(`https://www.googleapis.com/youtube/v3/videos?part=statistics,status,snippet&id=${ids}`, a); out.youtube.recent = (v.items || []).map((x) => ({ t: x.snippet.title.slice(0, 60), d: x.snippet.publishedAt, views: Number(x.statistics.viewCount || 0), likes: Number(x.statistics.likeCount || 0), privacy: x.status.privacyStatus, url: "https://youtube.com/shorts/" + x.id })); }
  } catch { out.youtube = null; }
  out.at = iso(now);
  return out;
}

async function collectRuns() {
  const repo = process.env.GITHUB_REPOSITORY, tk = process.env.GITHUB_TOKEN;
  if (!repo || !tk) return null;
  const runs = [];
  for (const wf of OBSERVED_WORKFLOWS) {
    const r = await j(`https://api.github.com/repos/${repo}/actions/workflows/${wf}/runs?per_page=60&created=>${iso(Date.now() - 8 * DAY).slice(0, 10)}`, { headers: { authorization: "Bearer " + tk, accept: "application/vnd.github+json" } });
    for (const x of r.workflow_runs || []) runs.push({ path: x.path, event: x.event, actor: x.triggering_actor?.login || x.actor?.login || null, status: x.status, conclusion: x.conclusion, created_at: x.created_at, updated_at: x.updated_at, name: x.name });
  }
  for (const wf of PANEL_WORKFLOWS) {
    const r = await j(`https://api.github.com/repos/${PANEL_REPO}/actions/workflows/${wf}/runs?per_page=30&created=>${iso(Date.now() - 8 * DAY).slice(0, 10)}`, { headers: { authorization: "Bearer " + tk, accept: "application/vnd.github+json" } });
    for (const x of r.workflow_runs || []) runs.push({ path: "panel:" + x.path, event: x.event, actor: x.triggering_actor?.login || x.actor?.login || null, status: x.status, conclusion: x.conclusion, created_at: x.created_at, updated_at: x.updated_at, name: x.name });
  }
  return runs;
}

// Shorts published by the engine (30+ days), with their slot and current views.
async function collectShortVideos() {
  const keys = (await kvList("zpc:acquisition:daily:")).filter((k) => /:youtube(_dica|_calc)?$/.test(k));
  const recs = [];
  for (const k of keys) { const v = await kvGet(k); if (v?.provider_post_id) recs.push({ id: String(v.provider_post_id), slot: v.slot || (k.endsWith("_dica") ? "dica" : k.endsWith("_calc") ? "calc" : "oferta") }); }
  if (!recs.length) return [];
  const token = await getYoutubeAccessToken();
  const out = [];
  for (let i = 0; i < recs.length; i += 50) {
    const batch = recs.slice(i, i + 50);
    const r = await j(`https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${batch.map((x) => x.id).join(",")}`, { headers: { authorization: "Bearer " + token } });
    for (const it of r.items || []) { const rec = batch.find((x) => x.id === it.id); out.push({ id: it.id, slot: rec?.slot, views: Number(it.statistics?.viewCount || 0), publishedAt: it.snippet?.publishedAt }); }
  }
  return out;
}

async function collectPublications(now) {
  const byDay = {};
  const today = [];
  for (let i = 0; i < 7; i++) {
    const day = localDay(now - i * DAY);
    const keys = (await kvList("zpc:acquisition:daily:" + day + ":")).filter((k) => !k.endsWith(":owner-digest"));
    const entries = {};
    for (const k of keys) {
      const ch = k.split(":").pop();
      const v = await kvGet(k);
      if (v) entries[ch] = { status: v.status, url: v.url || null, at: v.at || null, code: v.code || null, privacy: v.privacy || null };
    }
    const state = await kvGet("zpc:acquisition:daily:" + day);
    const blog = (state?.outcomes || []).find((o) => o.channel === "blog");
    if (blog) entries.blog = { status: blog.status, url: blog.url || null, at: blog.at || null };
    byDay[day] = entries;
    if (i === 0) for (const [ch, e] of Object.entries(entries)) today.push({ channel: ch, ...e });
  }
  return { byDay, today };
}

// Uptime history (P2 "monitor de uptime"): each snapshot run (about hourly) appends the result of
// its availability probes to the previous snapshot's history. No extra KV write: it rides the
// snapshot itself. Keeps 7 days; availability = probes ok / probes taken, with the denominator.
export const UPTIME_KEEP_MS = 7 * 24 * 3600e3;
export function updateUptime(prev, probes, now = Date.now()) {
  const entry = { t: new Date(now).toISOString(), r: probes.map((p) => ({ u: p?.url || "", ok: p?.ok === true, ms: p?.ms ?? null })) };
  const history = [...(Array.isArray(prev?.history) ? prev.history : []), entry].filter((e) => now - Date.parse(e.t) <= UPTIME_KEEP_MS);
  const urls = [...new Set(history.flatMap((e) => e.r.map((x) => x.u)))].filter(Boolean);
  const window = (ms) => Object.fromEntries(urls.map((u) => {
    const xs = history.filter((e) => now - Date.parse(e.t) <= ms).flatMap((e) => e.r.filter((x) => x.u === u));
    const ok = xs.filter((x) => x.ok).length;
    return [u, { ok, total: xs.length, pct: xs.length ? Math.round((ok / xs.length) * 1000) / 10 : null }];
  }));
  return { history, last24h: window(24 * 3600e3), last7d: window(UPTIME_KEEP_MS), since: history[0]?.t || null };
}

export async function main() {
  const now = Date.now();
  const [funnel, sales, reach, runs, pubs, health, salesStatus, coreStatus, site, control] = await Promise.all([
    kvGet("zpc-funnel:v1:summary"), kvGet("zpc:sales:v1:summary"), collectReach(now), collectRuns().catch(() => null), collectPublications(now),
    probe("https://zevanory.api.br/api/health"), j("https://zevanory.api.br/api/sales/status").catch(() => null), j("https://zevanory.api.br/api/status").catch(() => null), probe("https://vendas.zevanory.api.br/solucoes"), probe("https://controle.zevanory.api.br/"),
  ]);
  const prevSnapshot = await kvGet(SNAPSHOT_KEY).catch(() => null);
  const uptime = updateUptime(prevSnapshot?.operations?.uptime, [health, site, control], now);
  const salesOpen = salesStatus && !salesStatus._http ? salesStatus.open === true : null;
  const buyFlow = evaluateBuyFlow(await probeBuyFlow().catch(() => []), salesOpen);
  const hotmart = await probeHotmart().catch(() => []);
  const videos = await collectShortVideos().catch(() => []);
  let registry = null;
  try { registry = JSON.parse(readFileSync(new URL("../../data/experiments.json", import.meta.url), "utf8")); } catch {}
  let catalogDef = null;
  try { catalogDef = JSON.parse(readFileSync(new URL("../../data/products.json", import.meta.url), "utf8")); } catch {}
  let commitmentsDef = null;
  try { commitmentsDef = JSON.parse(readFileSync(new URL("../../data/commitments.json", import.meta.url), "utf8")); } catch {}
  const commitments = commitmentsDef ? { rule: commitmentsDef.rule, counts: commitmentsDef.commitments.reduce((a, c) => ((a[c.status] = (a[c.status] || 0) + 1), a), {}), items: commitmentsDef.commitments } : null;
  let providersDef = null;
  try { providersDef = JSON.parse(readFileSync(new URL("../../data/providers.json", import.meta.url), "utf8")); } catch {}
  const usageToday = (await kvGet("zpc:usage:v1:" + new Date(now).toISOString().slice(0, 10))) || {};
  const GUARDS = { youtube_units: 8500, gemini_tts_calls: 40 };
  const costs = providersDef ? { rule: providersDef.rule, incrementalCostBRL: 0, usageAt: usageToday.updatedAt || null, providers: providersDef.providers.map((p) => ({ ...p, usedToday: p.usageField ? Number(usageToday[p.usageField]) || 0 : null, guard: p.usageField ? GUARDS[p.usageField] ?? null : null })) } : null;
  let inventoryDef = null;
  try { inventoryDef = JSON.parse(readFileSync(new URL("../../data/process-inventory.json", import.meta.url), "utf8")); } catch {}
  const market = await kvGet("zpc:market:v1:weekly");
  const matrix = await kvGet("zpc:matrix:v1");
  const support = await kvGet("zpc:support:v1:eval");
  const voiceEval = await kvGet("zpc:support:v1:voice-eval");
  const backup = await kvGet("zpc:backup:v1:report");
  const cronBeat = await kvGet("zpc:cron:v1:hourly");
  const isolatedBeat = await kvGet("zpc:cron:v1:isolated");
  const funnelBeat = await kvGet("zpc:cron:v1:funnel");
  const inventory = evaluateInventory(inventoryDef, { support, voiceEval, backup, cronBeats: [cronBeat, isolatedBeat, funnelBeat].filter(Boolean), marketAt: market?.generatedAt || null, byDay: pubs.byDay, runs: runs || [], funnelAt: funnel?.generatedAt || null, buyFlow, hotmart, salesOpen, probes: [health, site, control] }, now);
  const experiments = evaluateExperiments(registry, { videos, productDaily: funnel?.productDaily || {}, campaigns: funnel?.topCampaigns || [] }, now);

  // Reach history: one point per local day (latest of the day wins), 120 days.
  const history = (await kvGet(REACH_HISTORY_KEY)) || [];
  const day = localDay(now);
  const point = { day, youtube_subs: reach.youtube?.subscribers ?? null, youtube_views: reach.youtube?.views ?? null, telegram: reach.telegram?.members ?? null, bluesky: reach.bluesky?.followers ?? null };
  const nextHistory = [...history.filter((p) => p.day !== day), point].sort((a, b) => a.day.localeCompare(b.day)).slice(-120);
  // KV write budget: rewrite the history only when today's reach point changed.
  const prevPoint = history.find((p) => p.day === day);
  if (!prevPoint || JSON.stringify(prevPoint) !== JSON.stringify(point)) await kvPut(REACH_HISTORY_KEY, nextHistory);
  const weekAgo = nextHistory.find((p) => p.day === localDay(now - 7 * DAY)) || nextHistory[0];
  const delta = (k) => (point[k] != null && weekAgo?.[k] != null ? point[k] - weekAgo[k] : null);

  const funnelAt = funnel?.generatedAt || null;
  const funnelIntegrity = funnelAt && now - Date.parse(funnelAt) < 3 * HOUR ? "aggregated" : "stale";
  const salesAt = sales?.updatedAt || null;
  const monthPrefix = day.slice(0, 7);
  // Funnel taxonomy v2 (AVAL Sol 23/10): every metric with window, numerator, denominator, dedup, sources,
  // freshness and integrity class; waitlist interest, real intent, leads and sales never mixed.
  const own = funnel?.ownCheckout;
  const fm = funnelMetrics({ funnel, sales, own, now, funnelAt, salesAt });
  const monthDays = windowDays(now, 31).filter((d) => d.startsWith(monthPrefix));
  const salesAllc = combineSales({ sales, own });
  const salesMonthc = combineSales({ sales, own, days: monthDays });
  const salesTodayc = combineSales({ sales, own, days: windowDays(now, 1) });
  const salesUpd = fm.sales30.updatedAt;
  const salesAllM = salesMetric(salesAllc, { window: "desde o início dos registros", updatedAt: salesUpd, now, definition: "Vendas aprovadas acumuladas" });
  const salesMonthM = salesMetric(salesMonthc, { window: "mês corrente (America/Sao_Paulo)", updatedAt: salesUpd, now, definition: "Vendas aprovadas no mês" });
  // Consumers (milestones, forecast, recommendations, owner list) only claim what is known: unknown = null.
  const salesKnown = knownCount(salesAllM);
  const salesCount = salesKnown.value;
  const grossKnown = (c, m) => (knownCount(m).value == null ? null : knownCount(m).lowerBound ? null : c.grossCents);
  const salesGoal = (base, value, m) => ({ ...base, current: value, integrityClass: m.integrityClass, lowerBound: knownCount(m).lowerBound, source: m.source });
  const hotmartLock = hotmartLockState(hotmart, salesOpen);
  if (hotmartLock.severity === "P0") console.log("::error title=P0_HOTMART_BYPASS::" + JSON.stringify({ accepting: hotmartLock.accepting, salesOpen }));

  const autonomy = runs ? computeAutonomy(runs.filter((r) => ENGINE_WORKFLOWS.some((w) => r.path.endsWith(w))), now) : null;
  const publications = computePublications(pubs.byDay);
  const dailyAll = mergeDaily(sales, funnel?.ownCheckout);
  const firstSalesDay = Object.keys(dailyAll).sort()[0] || null;

  const kvQuota = await kvWritesToday(now);
  const kvForecast = kvQuotaForecast(kvQuota, now);
  // P19 (B0): uso de Workers da conta no último dia UTC COMPLETO (consulta GraphQL somente leitura; sem escopo = verified:false).
  const workersUsage = await workersUsageForDay(prevUtcDay(now)).catch(() => ({ verified: false, reason: "error" }));
  if (kvForecast && kvForecast.level !== "ok") console.log("::warning title=KV_QUOTA_" + kvForecast.level.toUpperCase() + "::" + JSON.stringify(kvForecast));
  // Hand-off to the owner-notification step (scripts/audit/kv-quota-issue.mjs); file only, no KV write.
  if (kvForecast && process.env.KV_FORECAST_OUT) { try { writeFileSync(process.env.KV_FORECAST_OUT, JSON.stringify({ day: kvQuota.day, ...kvForecast })); } catch {} }
  if (kvQuota?.verified && kvQuota.writes >= 0.7 * KV_DAILY_WRITE_LIMIT) console.log("::warning title=KV_QUOTA::" + JSON.stringify(kvQuota));
  // The Worker reads this reading to shed observability writes at 70% (worker/kv-meter.mjs).
  if (kvQuota?.verified) await kvPut("zpc:kv:v1:budget", { day: kvQuota.day, pct: kvQuota.pct, writes: kvQuota.writes, limit: kvQuota.limit, at: iso(now) }).catch(() => {});
  const snapshot = {
    schema: "zevanory-command-center/v1",
    platform: { kvQuota, kvForecast, workersUsage },
    generatedAt: iso(now),
    day,
    goals: [
      salesGoal({ id: "first-sale", label: "1ª venda", target: 1, unit: "vendas", deadline: "2026-10-18" }, salesCount, salesAllM),
      salesGoal({ id: "fortnight", label: "Quinzena", target: 80000, unit: "centavos", deadline: "2026-10-25" }, grossKnown(salesMonthc, salesMonthM), salesMonthM),
      salesGoal({ id: "month", label: "Mês", target: 200000, unit: "centavos", deadline: "2026-11-10" }, grossKnown(salesAllc, salesAllM), salesAllM),
      salesGoal({ id: "paid-traffic", label: "Vendas para liberar tráfego pago", target: 7, unit: "vendas", deadline: null }, salesCount, salesAllM),
    ],
    revenue: {
      // Only the combined view (checkout próprio + Hotmart) is published; the old Hotmart-only metrics are gone.
      salesToday: salesMetric(salesTodayc, { window: "hoje (America/Sao_Paulo)", updatedAt: salesUpd, now, definition: "Vendas aprovadas hoje" }),
      salesMonth: salesMonthM,
      salesTotal: salesAllM,
      grossMonthCents: { ...salesMonthM, value: grossKnown(salesMonthc, salesMonthM), unit: "centavos", numerator: "valor bruto pago das vendas aprovadas", definition: "Valor bruto das vendas aprovadas no mês (checkout próprio + Hotmart), antes de taxas; nulo se alguma fonte faltar." },
      grossTotalCents: { ...salesAllM, value: grossKnown(salesAllc, salesAllM), unit: "centavos", numerator: "valor bruto pago das vendas aprovadas", definition: "Valor bruto acumulado das vendas aprovadas (checkout próprio + Hotmart), antes de taxas; nulo se alguma fonte faltar." },
      reversals30: fm.reversals30,
      ledgerStartedAt: firstSalesDay,
      // Per-source detail of the combined view (no Hotmart-only revenue metric is published).
      ownCheckout: { status: salesAllc.checkoutProprio.status, mode: own?.mode || null, reason: own?.reason || null, salesToday: salesTodayc.checkoutProprio.total, salesMonth: salesMonthc.checkoutProprio.total, grossMonthCents: salesMonthc.checkoutProprio.grossCents, byProvider: salesAllc.checkoutProprio.byProvider, integrity: own?.integrity || null },
    },
    funnel: {
      taxonomy: "v2",
      visitors7: fm.visitorPageDays7,
      visitorDays7: fm.visitorDays7,
      visitors7Raw: metric(funnel?.last7Days?.visitors ?? null, "Site (inclui dias antes do filtro de robôs)", funnelAt, "Total bruto de 7 dias, contaminado por robôs antes de 12/10", "estimated"),
      views7: metric(funnel?.last7Days?.views ?? null, "Site", funnelAt, "Páginas vistas em 7 dias", funnelIntegrity),
      // Keys the panel already renders keep their names; their meaning is now exact (see each definition).
      leads7: fm.leadsConfirmed7,
      leadsPending7: fm.leadsPending7,
      views30: fm.pageviews30,
      intents30: fm.transactionalIntent30,
      legacyMixedClicks30: fm.legacyMixedClicks30,
      waitlistCtaViews30: fm.waitlistCtaViews30,
      waitlistClicks30: fm.waitlistClicks30,
      waitlistLeadsPending: fm.waitlistLeadsPending,
      waitlistLeadsConfirmed: fm.waitlistLeadsConfirmed,
      sales30: fm.sales30,
      reversals30: fm.reversals30,
      conversions: fm.conversions,
      sources: funnel?.sources || {},
      topCampaigns: (funnel?.topCampaigns || []).slice(0, 8),
      pages: Object.entries(funnel?.pages || {}).sort((a, b) => (b[1].views || 0) - (a[1].views || 0)).slice(0, 10).map(([page, v]) => ({ page, views: v.views || 0, visitors: v.visitors || 0 })),
    },
    acquisition: {
      reachAt: reach.at,
      channels: [
        { channel: "YouTube", audience: metric(reach.youtube?.subscribers ?? null, "YouTube Data API", reach.at, "Inscritos"), views: metric(reach.youtube?.views ?? null, "YouTube Data API", reach.at, "Visualizações totais do canal"), delta7: delta("youtube_subs"), viewsDelta7: delta("youtube_views") },
        { channel: "Telegram", audience: metric(reach.telegram?.members ?? null, "Telegram Bot API", reach.at, "Membros do canal"), delta7: delta("telegram") },
        { channel: "Bluesky", audience: metric(reach.bluesky?.followers ?? null, "Bluesky API pública", reach.at, "Seguidores"), posts: reach.bluesky?.posts ?? null, delta7: delta("bluesky") },
        { channel: "TikTok", audience: metric(null, "Sem API de leitura liberada", null, "Seguidores"), note: "Publicação por agendamento no TikTok Studio" },
        { channel: "Instagram/Facebook", audience: metric(null, "Aguardando aprovação da Meta", null, "Seguidores") },
      ],
      youtubeRecent: reach.youtube?.recent || [],
      history: nextHistory.slice(-30),
      publications,
      today: pubs.today,
    },
    autonomy: {
      runs: autonomy,
      runsIntegrity: autonomy ? "real" : "missing",
      publications,
      agenda: AGENDA.map((a) => ({ ...a, next: nextRun(a.cron, now) })).sort((x, y) => String(x.next).localeCompare(String(y.next))),
      ownerOnly: [
        { what: "Aprovar Instagram/Facebook", why: "Aguardando revisão da Meta; ao aprovar, Reels e vídeos entram sozinhos", status: "aguardando terceiro" },
        { what: "Aprovar Pinterest", why: "Aguardando aprovação do app", status: "aguardando terceiro" },
        { what: "Trocar nome do TikTok para ZEVANORY", why: "TikTok libera a troca a partir de 18/10", status: "agendado" },
        { what: "Liberar tráfego pago", why: "Só após a 7ª venda, com sua autorização", status: salesCount == null ? `bloqueado (vendas ${salesKnown.integrityClass}: não verificadas)` : salesCount >= 7 && !salesKnown.lowerBound ? "pronto para decidir" : `bloqueado (${salesKnown.lowerBound ? "≥" : ""}${salesCount}/7)` },
      ],
    },
    operations: {
      probes: [health, site, control],
      uptime,
      kvQuota, salesSwitch: salesStatus && !salesStatus._http ? { open: salesStatus.open === true } : null,
      // Derived from the switch and the six Hotmart probes; never a constant.
      checkoutMode: (salesOpen === true ? "Vendas abertas: checkout próprio vendendo" : salesOpen === false ? "Vendas fechadas (interruptor do dono): checkout próprio e rotas Hotmart do site fechados" : "Interruptor de vendas NÃO VERIFICADO nesta leitura") + "; " + hotmartModeText(hotmartLock) + (hotmartLock.severity === "P0" ? " — P0: oferta Hotmart aceitando pagamento com vendas fechadas" : ""),
      hotmartLock,
      buyFlow,
      runtime: coreStatus && !coreStatus._http ? coreStatus.runtime || null : null,
      hotmart,
      deploys: runs ? runs.filter((r) => r.path.endsWith("central-production-deploy.yml")).slice(0, 5).map((r) => ({ at: r.created_at, conclusion: r.conclusion })) : [],
    },
    // A forecast needs every source: with a source missing it refuses instead of extrapolating a false zero.
    forecast: salesKnown.value == null || salesKnown.lowerBound ? { status: "unverified", reason: `vendas ${salesAllM.integrityClass}: checkout próprio ${ownCheckoutStatus(own)}, Hotmart ${hotmartStatus(sales)}` } : forecastSales(dailyAll, firstSalesDay, now),
    experiments,
    commitments,
    catalog: catalogDef ? { guaranteeDays: catalogDef.guaranteeDays, products: catalogDef.products, subscription: catalogDef.subscription || null } : null,
    matrix: matrix ? { generatedAt: matrix.generatedAt, counts: matrix.counts, total: matrix.total, passPct: matrix.passPct, open: (matrix.items || []).filter((i) => i.state !== "PASS").slice(0, 60).map((i) => ({ id: i.id, kind: i.kind, name: i.name, state: i.state, owner: i.owner, evidence: i.evidence, at: i.at || null })) } : null,
    inventory,
    costs,
    support: support ? { generatedAt: support.generatedAt, scorePct: support.scorePct, aiAnsweredPct: support.aiAnsweredPct, questions: support.questions, failures: support.failures || [], method: support.method } : null,
    market: market ? { generatedAt: market.generatedAt, method: market.method, integrity: market.integrity, top: (market.ranking || []).slice(0, 12).map((r) => ({ name: r.name, slug: r.slug, score: r.score, product: r.product, topQueries: (r.topQueries || []).slice(0, 3) })), ideas: market.ideas || [] } : null,
    recommendations: [
      ...(hotmartLock.severity === "P0" ? [{ title: "P0: oferta Hotmart aceitando pagamento com vendas fechadas", evidence: `${hotmartLock.accepting.join(", ")}: página da oferta respondeu sem o aviso de vendas encerradas`, action: "Dono: encerrar a oferta na Hotmart agora; fechar release comercial e registrar incidente P0", confidence: "alta", risk: "crítico", cost: "R$ 0" }] : []),
      ...(buyFlow.some((b) => b.expected != null && !b.ok && b.state !== "error") ? [{ title: "Caminho de compra diverge do interruptor de vendas", evidence: buyFlow.filter((b) => b.expected != null && !b.ok).map((b) => `${b.sku}: ${b.state} (esperado ${b.expected})`).join("; "), action: salesOpen ? "Conferir /api/sales/status e o Worker de vendas: com vendas abertas o botão deve abrir o pagamento" : "Fechar imediatamente o caminho de compra: com vendas fechadas nenhum pagamento pode abrir", confidence: "alta", risk: "alto", cost: "R$ 0" }] : []),
      ...recommend({ funnel, reach, publications, salesKnown }),
    ],
  };
  await kvPut(SNAPSHOT_KEY, snapshot);
  console.log("::notice title=COMMAND_CENTER::" + JSON.stringify({ at: snapshot.generatedAt, autonomy: autonomy && { pct: autonomy.autonomyPct, runs: autonomy.scheduledRuns, failed: autonomy.failed, recovered: autonomy.recoveredAutomatically, mttr: autonomy.mttrMinutes }, publications, runtime: coreStatus?.runtime || null, inventory: { eligible: inventory.eligible, proven: inventory.provenAutonomous, pct: inventory.pct, byState: inventory.byState, unproven: inventory.processes.filter((x) => x.eligible && !x.proven).map((x) => x.id) }, experiments: experiments.map((e) => ({ id: e.id, status: e.status, progress: e.progress || null })), buyFlow, hotmart, serverCycle: cronBeat ? { at: cronBeat.finishedAt || null, tasks: cronBeat.tasks || {}, nurture: cronBeat.nurture || null } : null, kvQuota: kvQuota || null, workersUsage: workersUsage || null, isolatedCycle: isolatedBeat ? { at: isolatedBeat.finishedAt || null, tasks: isolatedBeat.tasks || {} } : null, funnelCycle: funnelBeat ? { at: funnelBeat.finishedAt || null, tasks: funnelBeat.tasks || {} } : null, salesSwitch: salesOpen, sales: salesCount, salesClass: salesKnown.integrityClass, salesBySource: { checkoutProprio: salesAllc.checkoutProprio.total, hotmart: salesAllc.hotmart.total }, salesIntegrity: fm.sales30.integrityClass, hotmartLock: { state: hotmartLock.state, accepting: hotmartLock.accepting.length, closed: hotmartLock.closed.length, total: hotmartLock.total }, visitors7: funnel?.last7Days?.cleanVisitors ?? null, visitors7Raw: funnel?.last7Days?.visitors ?? null, reach: point }));
  // Aggregate-only commercial diagnosis (no PII): clean page/source/campaign/traffic-class counts since
  // the bot filter. Visitor-controlled labels (utm) outside our own naming are masked as "outro" because
  // this notice is public. "visitorDays" = sum of daily uniques (the hash rotates daily), not people.
  try {
    const cl = funnel?.clean;
    if (cl) {
      const OWN_SOURCES = /^(direto|google|bing|youtube|telegram|bluesky|instagram|facebook|tiktok|pinterest|hotmart|site|interno|outro|guia|ferramentas|blog|email|whatsapp|threads|linkedin)$/;
      const OWN_CAMPAIGNS = /^(calc|dica|oferta|conteudo|ia-para|ferramentas|guia|short|blog|nurture|material)[a-z0-9_-]*$/;
      const sources = {};
      for (const [k, v] of Object.entries(cl.sources || {})) { const key = OWN_SOURCES.test(k) ? k : "outro"; const b = (sources[key] = sources[key] || { views: 0 }); b.views += v?.views || 0; b.legacyMixedClicks = (b.legacyMixedClicks || 0) + (v?.checkout_intent || 0) + (v?.hotmart_view || 0) + (v?.subscribe_click || 0); b.waitlistCtaViews = (b.waitlistCtaViews || 0) + (v?.waitlist_cta_view || 0); b.transactionalIntent = (b.transactionalIntent || 0) + (v?.own_checkout_started || 0); }
      const campaigns = {};
      for (const [k, v] of Object.entries(cl.campaigns || {})) { const key = OWN_CAMPAIGNS.test(k) ? k : "outro"; campaigns[key] = (campaigns[key] || 0) + (Number(v) || 0); }
      const pages = Object.fromEntries(Object.entries(cl.pages || {}).sort((a, b) => (b[1]?.views || 0) - (a[1]?.views || 0)).slice(0, 15).map(([k, v]) => [k, { views: v?.views || 0, visitorPageDays: v?.visitors || 0, legacyMixedClicks: (v?.checkout_intent || 0) + (v?.hotmart_view || 0) + (v?.subscribe_click || 0) }]));
      const products30 = Object.fromEntries(Object.entries(funnel?.products || {}).map(([k, v]) => [k, { checkouts: v?.checkouts || 0, paid: v?.paid || 0, checkoutErrors: v?.checkoutErrors || 0 }]));
      // Public notice: networks with fewer than 3 visits are aggregated as "outros" so a small regional ISP
      // cannot single out one visitor; the full per-ASN count stays only in the private KV summary.
      const diag = { at: funnel.generatedAt, since: cl.since, products30, checkoutDiag: funnel?.checkoutDiag || null, leads7: funnel?.last7Days?.leads ?? null, checkouts7: funnel?.last7Days?.checkouts ?? null, classes: cl.classes || {}, asnTop: (() => { const k = Object.entries(cl.asn || {}).sort((a, b) => b[1] - a[1]); const shown = k.filter(([, n]) => n >= 3).slice(0, 12); const rest = k.reduce((t, [, n]) => t + n, 0) - shown.reduce((t, [, n]) => t + n, 0); return rest > 0 ? [...shown, ["outros", rest]] : shown; })(), sources, campaigns: Object.entries(campaigns).sort((a, b) => b[1] - a[1]).slice(0, 10), pages };
      let text = JSON.stringify(diag);
      if (text.length > 3800) { delete diag.pages; text = JSON.stringify(diag); }
      console.log("::notice title=FUNNEL_DIAG::" + text);
    }
  } catch (e) { console.log("::warning title=FUNNEL_DIAG::" + String(e?.message || e).slice(0, 200)); }
}

const isMain = process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href;
if (isMain) main().catch((e) => { console.log("::error title=COMMAND_CENTER::" + String(e?.message || e).slice(0, 200)); process.exit(1); });
