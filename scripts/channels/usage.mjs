// Zero-cost guard (Cláusula de Custo Zero): every metered free quota we consume is counted
// per day in the shared KV, and each engine checks the guard BEFORE consuming. Guards sit
// below the provider's free limit; reaching one stops the action (or switches to a free
// local fallback) and is reported — never a migration to a paid plan.
export const FREE_LIMITS = Object.freeze({ youtube_units: 10000, gemini_tts_calls: 100, kv_api_writes: 1000, resend_emails: 100 });
export const GUARDS = Object.freeze({ youtube_units: 8500, gemini_tts_calls: 40, kv_api_writes: 700, resend_emails: 80 });
export const usageDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10); // providers reset on UTC/Pacific days
export const usageKey = (day = usageDay()) => "zpc:usage:v1:" + day;

export async function getUsage(kv, day = usageDay()) {
  try { return JSON.parse(String((await kv.get(usageKey(day))) || "{}")) || {}; } catch { return {}; }
}
export function allow(usage, field, need = 1) {
  const guard = GUARDS[field];
  return guard == null ? true : (Number(usage?.[field]) || 0) + need <= guard;
}
export async function addUsage(kv, field, n = 1, day = usageDay()) {
  const u = await getUsage(kv, day);
  u[field] = (Number(u[field]) || 0) + n;
  u.updatedAt = new Date().toISOString();
  await kv.put(usageKey(day), JSON.stringify(u), { expirationTtl: 40 * 86400 });
  return u;
}
