// Customer ratings (fidelização + prova social honesta).
// * Only paying customers can rate: each link is HMAC-bound to a paid order (D+5 post-sale e-mail).
// * One click picks the score; the comment and the permission to publish it are optional.
// * The sales pages show the average only with 3+ real ratings — never invented social proof.
// * Every rating reaches the control panel (Atendimento) so the owner can act on low scores.

import { alertOwnerNow } from "./owner-alerts.mjs";

const CORE = "https://zevanory.api.br";
const SUPPORT_EMAIL = "suporte@zevanory.api.br";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MIN_PUBLIC = 3;
let schemaReady = false;

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const json = (status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff", ...extra } });
const page = (status, title, body) => new Response(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1220;color:#e6edf6;margin:0;display:grid;place-items:center;min-height:100vh;padding:16px}main{width:100%;max-width:480px;background:#111a2c;border:1px solid #1f2b44;border-radius:12px;padding:28px}h1{font-size:21px;margin:0 0 12px}p,label{color:#a9b6c9;line-height:1.55}.stars{font-size:34px;letter-spacing:4px;color:#fbbf24}textarea{width:100%;box-sizing:border-box;min-height:110px;border-radius:8px;border:1px solid #2a3a58;background:#0b1220;color:#e6edf6;padding:12px;font:inherit;margin:6px 0 12px}.c{display:flex;gap:10px;align-items:flex-start}.c input{min-width:22px;min-height:22px}button{width:100%;min-height:48px;background:#2dd4a7;color:#04241b;border:0;border-radius:8px;font-weight:700;font-size:16px;cursor:pointer;margin-top:8px}</style></head><body><main><h1>${esc(title)}</h1>${body}<p>Dúvidas: ${SUPPORT_EMAIL}</p></main></body></html>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer" } });

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(value))))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const secretFor = (env) => (env.RESEND_API_KEY ? "zevanory-review-v1:" + env.RESEND_API_KEY : "");

export async function reviewLinks(env, orderId) {
  const secret = secretFor(env);
  if (!secret || !UUID.test(String(orderId))) return [];
  const t = (await hmacHex(secret, String(orderId).toLowerCase())).slice(0, 32);
  return [1, 2, 3, 4, 5].map((n) => `${CORE}/avaliar?o=${String(orderId).toLowerCase()}&n=${n}&t=${t}`);
}

async function validToken(env, orderId, token) {
  const secret = secretFor(env);
  if (!secret || !UUID.test(orderId) || !/^[0-9a-f]{32}$/.test(token)) return false;
  return (await hmacHex(secret, orderId)).slice(0, 32) === token;
}

export async function ensureReviewSchema(sql) {
  if (schemaReady) return;
  await sql.query(`create table if not exists zevanory_reviews (
    order_id uuid primary key, offer_id text not null, rating smallint not null check (rating between 1 and 5),
    comment text, publish_consent boolean not null default false, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`, []);
  schemaReady = true;
}

const mask = (text) => String(text || "").replace(/[^\s@<>()]+@[^\s@<>()]+/g, "***@***").replace(/\+?\d[\d\s().-]{7,}\d/g, "***").slice(0, 1000);

export async function reviewSummary(sql) {
  await ensureReviewSchema(sql);
  const rows = await sql.query(`select offer_id, count(*)::int as n, round(avg(rating)::numeric, 1)::float as avg
      from zevanory_reviews group by offer_id`, []);
  const out = {};
  for (const r of rows) if (Number(r.n) >= MIN_PUBLIC) out[r.offer_id] = { count: Number(r.n), average: Number(r.avg) };
  return out;
}

export async function handleReviews(request, env, { sqlFactory } = {}) {
  const url = new URL(request.url);
  if (url.pathname !== "/avaliar" && url.pathname !== "/api/reviews/summary") return null;
  if (!sqlFactory || !env.DATABASE_URL) return json(503, { ok: false });
  const sql = sqlFactory(env.DATABASE_URL);

  if (url.pathname === "/api/reviews/summary") {
    if (request.method !== "GET") return json(405, { ok: false });
    try { return json(200, { ok: true, minimum: MIN_PUBLIC, products: await reviewSummary(sql) }, { "cache-control": "public, max-age=600" }); }
    catch { return json(200, { ok: true, minimum: MIN_PUBLIC, products: {} }, { "cache-control": "no-store" }); }
  }

  const orderId = String(url.searchParams.get("o") || "").toLowerCase();
  const token = String(url.searchParams.get("t") || "");
  const preset = Math.min(5, Math.max(1, Number(url.searchParams.get("n")) || 5));
  if (!(await validToken(env, orderId, token))) return page(400, "Link inválido", "<p>Use o link do e-mail de acompanhamento da sua compra.</p>");
  const order = (await sql.query("select order_id, offer_id, status, certification_pilot from orders where order_id=$1 limit 1", [orderId]))[0];
  if (!order || !["paid", "refunded", "partially_refunded"].includes(String(order.status))) return page(400, "Pedido não encontrado", "<p>Escreva para o suporte se precisar de ajuda.</p>");

  if (request.method === "GET" || request.method === "HEAD") {
    return page(200, "Sua avaliação", `<p class="stars" aria-label="${preset} de 5">${"★".repeat(preset)}${"☆".repeat(5 - preset)}</p><form method="post"><input type="hidden" name="n" value="${preset}"><label for="c">Quer contar o que funcionou ou o que faltou? (opcional)</label><textarea id="c" name="comentario" maxlength="800"></textarea><label class="c"><input type="checkbox" name="publicar" value="sim"> Autorizo a ZEVANORY a publicar meu comentário com o meu primeiro nome.</label><button type="submit">Enviar avaliação</button></form>`);
  }
  if (request.method !== "POST") return json(405, { ok: false });
  let form; try { form = await request.formData(); } catch { form = new FormData(); }
  const rating = Math.min(5, Math.max(1, Number(form.get("n")) || preset));
  const comment = String(form.get("comentario") || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 800);
  const consent = String(form.get("publicar") || "") === "sim";
  await ensureReviewSchema(sql);
  await sql.query(`insert into zevanory_reviews (order_id, offer_id, rating, comment, publish_consent) values ($1::uuid, $2, $3, $4, $5)
      on conflict (order_id) do update set rating = excluded.rating, comment = excluded.comment, publish_consent = excluded.publish_consent, updated_at = now()`,
    [orderId, String(order.offer_id || ""), rating, comment || null, consent]);
  try {
    await env.ZEVANORY_PRIVATE_ARTIFACTS?.put?.(`zpc-activity:v1:support:${Date.now()}:review-${orderId.slice(0, 8)}`, JSON.stringify({
      title: `Avaliação ${rating}/5 · ${String(order.offer_id || "")}${rating <= 3 ? " · ATENÇÃO" : ""}`,
      detail: (comment ? `Comentário: ${mask(comment)}` : "Sem comentário.") + (consent ? "\n\nCliente autorizou publicar com o primeiro nome." : ""),
      status: rating <= 3 ? "open" : "resolved", channel: "email", product: String(order.offer_id || ""),
      sourceKey: `review:${orderId}`, evidence: [`order:${orderId.slice(0, 8)}`, `rating:${rating}`, `publish_consent:${consent}`, new Date().toISOString()],
    }), { expirationTtl: 30 * 24 * 3600 });
  } catch {}
  if (rating <= 3) await alertOwnerNow(env, { category: "complaint", channel: "Avaliação", contact: orderId, excerpt: comment || `nota ${rating}/5 sem comentário`, reason: `nota ${rating}/5 no ${String(order.offer_id || "")} (pedido ${orderId.slice(0, 8)})` }).catch(() => null);
  return page(200, "Obrigado pela avaliação!", rating <= 3
    ? "<p>Sentimos que não atendeu como esperado. Nossa equipe vai entrar em contato pelo e-mail da compra para ajudar. Lembre: você tem 7 dias de garantia a partir da compra.</p>"
    : "<p>Sua nota ajuda outros empreendedores a decidir e nos ajuda a melhorar o material.</p>");
}
