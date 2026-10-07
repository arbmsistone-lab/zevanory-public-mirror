// Owner alerts: the robots never silently drop a customer who needs a human.
// * WhatsApp: sensitive messages (complaint, refund, "falar com humano"...) email the owner at once
//   (max 1 per contact every 6h).
// * Other Workers (control panel: Instagram/Facebook) drop `zpc-alert:v1:*` entries in the shared
//   KV; the hourly cron emails one digest and deletes them.

export const ESCALATION_RE = /golpe|fraude|procon|advogad|processo|absurdo|n[aã]o recebi|cad[eê] (meu|o) (produto|acesso|link)|reembols|estorno|cancelar|humano|atendente|pessoa real|reclame aqui/i;

async function sha256Hex(value) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function maskExcerpt(text) {
  return String(text || "")
    .replace(/[^\s@<>()]+@[^\s@<>()]+/g, "***@***")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "***")
    .slice(0, 280);
}

async function sendOwnerEmail(env, subject, text) {
  const to = String(env.OWNER_ALERT_EMAIL || "zevanory@gmail.com");
  if (!env.RESEND_API_KEY) return false;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: String(env.RESEND_FROM_ADDRESS || "ZEVANORY <contato@zevanory.api.br>"), to: [to], subject, text }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => null);
  return Boolean(r?.ok);
}

export async function alertOwnerNow(env, { channel, contact, excerpt, reason }) {
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  const contactHash = (await sha256Hex(String(contact || "anon"))).slice(0, 16);
  const key = `owner-alert:sent:${channel}:${contactHash}`;
  try { if (kv?.get && await kv.get(key)) return { sent: false, reason: "recently_alerted" }; } catch {}
  const sent = await sendOwnerEmail(env, `ZEVANORY — cliente precisa de você (${channel})`,
    `Um cliente no ${channel} precisa de atendimento humano.\n\nMotivo: ${reason}\nMensagem: "${maskExcerpt(excerpt)}"\nContato (ref.): ${contactHash}\n\nO robô já respondeu de forma segura e avisou que um atendente vai continuar. Responda pelo próprio ${channel}.`);
  if (sent) { try { await kv?.put?.(key, "1", { expirationTtl: 6 * 3600 }); } catch {} }
  return { sent };
}

export async function runOwnerAlertDigest(env) {
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  if (!kv?.list) return { ok: false, reason: "kv_unavailable" };
  const listed = await kv.list({ prefix: "zpc-alert:v1:", limit: 50 });
  const keys = (listed.keys || []).map((k) => String(k.name));
  if (!keys.length) return { ok: true, alerts: 0 };
  const lines = [];
  for (const name of keys) {
    try {
      const item = JSON.parse(String(await kv.get(name) || "null"));
      if (item) lines.push(`• [${item.channel}] ${item.reason === "sem-resposta-na-base" ? "robô não tinha a resposta" : "assunto sensível"} — "${maskExcerpt(item.excerpt)}" (${item.at})`);
    } catch {}
  }
  const sent = lines.length ? await sendOwnerEmail(env, `ZEVANORY — ${lines.length} conversa(s) pedem sua atenção`, `Conversas no Instagram/Facebook que o robô encaminhou para você:\n\n${lines.join("\n")}\n\nResponda pelo próprio Instagram/Facebook. Detalhes no painel: https://controle.zevanory.api.br (Atendimento).`) : true;
  if (sent) for (const name of keys) { try { await kv.delete(name); } catch {} }
  return { ok: true, alerts: lines.length, sent };
}
