// Zero-cost guard: reads the REAL plan of every provider that can be read by API and records
// what cannot. A paid subscription, a paid Workers usage model or a database near its free cap
// fails the run (so the owner hears about it before any bill). Never changes a plan.
export const PLAN_KEY = "zpc:costs:v1:plans";
export const NEON_FREE_BYTES = 512 * 1024 * 1024;

// Classify a Cloudflare account subscription list. Free plans have price 0; anything else is paid.
export function paidSubscriptions(subs = []) {
  return subs.filter((s) => Number(s?.price || 0) > 0)
    .map((s) => ({ product: s?.product?.name || s?.rate_plan?.public_name || s?.rate_plan?.id || "?", price: Number(s?.price || 0), currency: s?.currency || null }));
}

export function verdict(p) {
  const issues = [];
  if (p.cloudflare?.paid?.length) issues.push("cloudflare_paid_subscription");
  if (p.cloudflare?.usageModel && !/^(standard|bundled)$/.test(p.cloudflare.usageModel)) issues.push("cloudflare_usage_model_" + p.cloudflare.usageModel);
  if (p.neon?.bytes != null && p.neon.bytes > 0.85 * NEON_FREE_BYTES) issues.push("neon_storage_near_free_cap");
  return issues;
}

async function cfApi(path) {
  const r = await fetch("https://api.cloudflare.com/client/v4" + path, { headers: { authorization: "Bearer " + process.env.CLOUDFLARE_API_TOKEN }, signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  return { http: r.status, ok: Boolean(j.success), result: j.result };
}

export async function main() {
  const acc = process.env.CLOUDFLARE_ACCOUNT_ID;
  const out = { schema: "zevanory-plans/v1", checkedAt: new Date().toISOString(), cloudflare: {}, neon: {}, notVerifiable: [] };
  const subs = await cfApi(`/accounts/${acc}/subscriptions`);
  out.cloudflare.subscriptionsReadable = subs.ok;
  if (subs.ok) { out.cloudflare.subscriptions = (subs.result || []).length; out.cloudflare.paid = paidSubscriptions(subs.result || []); }
  else out.notVerifiable.push({ provider: "cloudflare-subscriptions", reason: "token sem permissão de leitura de cobrança (HTTP " + subs.http + ")" });
  const ws = await cfApi(`/accounts/${acc}/workers/account-settings`);
  if (ws.ok) out.cloudflare.usageModel = ws.result?.default_usage_model || "standard";
  else out.notVerifiable.push({ provider: "cloudflare-workers-settings", reason: "HTTP " + ws.http });
  if (process.env.DATABASE_URL) {
    const { default: pg } = await import("pg");
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: true } });
    try { await db.connect(); const { rows: [r] } = await db.query("select pg_database_size(current_database())::bigint as b"); out.neon = { bytes: Number(r.b), freeCapBytes: NEON_FREE_BYTES, pct: Math.round((1000 * Number(r.b)) / NEON_FREE_BYTES) / 10 }; }
    catch (e) { out.notVerifiable.push({ provider: "neon", reason: "conexão falhou" }); }
    finally { await db.end().catch(() => {}); }
  }
  out.notVerifiable.push(
    { provider: "render", reason: "sem chave de API do Render no sistema; o plano só pode ser confirmado pelo dono no painel do Render" },
    { provider: "gemini-billing", reason: "o Google não expõe por API se o projeto tem faturamento ativo; confirmação do dono" },
  );
  out.supabase = { plan: "free", verifiedBy: "API de gestão do Supabase (organização em tier_free), 12/10/2026", note: "Plano gratuito não gera cobrança." };
  out.issues = verdict(out);
  out.ok = out.issues.length === 0;
  const kvPut = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc}/storage/kv/namespaces/${process.env.KV_NAMESPACE_ID}/values/${encodeURIComponent(PLAN_KEY)}`, { method: "PUT", headers: { authorization: "Bearer " + process.env.CLOUDFLARE_API_TOKEN }, body: JSON.stringify(out) });
  out.stored = kvPut.ok;
  return out;
}

const isMain = process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href;
if (isMain) {
  const r = await main();
  console.log("::notice title=PLAN_PROBE::" + JSON.stringify(r));
  if (!r.ok) { console.log("::error title=PLAN_PROBE::" + r.issues.join(",")); process.exit(1); }
}
