import { brandedEmailHtml } from "./brand-email.mjs";
// Post-sale robot (fidelização) — only for customers who actually paid and received a product.
// D+1: onboarding ("como começar"); D+5: satisfaction check + the natural next step in the catalog.
// Hard rules:
//   * never contacts anyone who did not buy (no cold outreach);
//   * production payments only (MERCADOPAGO_ENV=production), never certification/sandbox orders;
//   * stops on refund, on opt-out (one-click List-Unsubscribe, RFC 8058) and after 15 days;
//   * idempotent per order+step (KV marker + Resend Idempotency-Key);
//   * every send is mirrored to the control panel through the shared-activity bridge.

import { reviewLinks } from "./reviews.mjs";

const ORIGIN = "https://zevanory.api.br";
const SALES = "https://vendas.zevanory.api.br";
const WHATSAPP = "https://wa.me/5588992545413";
const SUPPORT_EMAIL = "suporte@zevanory.api.br";
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const STEPS = [
  { id: "d1", minAge: 20 * HOUR },
  { id: "d5", minAge: 5 * DAY },
];
const MAX_AGE = 15 * DAY;
const EXCLUDED_RECIPIENTS = new Set(["prova-sandbox@zevanory.api.br", "delivered@resend.dev"]);
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const html = (status, body) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer" } });
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const POST_SALE_CATALOG = Object.freeze({
  "ZEV-IA-011": { name: "IA na Prática", slug: "ia-na-pratica", next: "ZEV-CMB-011" },
  "ZEV-VEN-011": { name: "Vendas na Prática", slug: "vendas-na-pratica", next: "ZEV-CMB-011" },
  "ZEV-LCX-011": { name: "Lucro & Caixa", slug: "lucro-e-caixa", next: "ZEV-NGC-011" },
  "ZEV-CMB-011": { name: "Combo IA + Vendas", slug: "combo-ia-vendas", next: "ZEV-NGC-011" },
  "ZEV-NGC-011": { name: "Negócio Completo", slug: "negocio-completo", next: null },
});

function timingSafeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function sha256Hex(value) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(value)));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function optOutSecret(env) {
  const base = String(env.RESEND_API_KEY || "");
  return base ? "zevanory-post-sale-optout-v1:" + base : "";
}

export function maskEmail(email) {
  const [u, d] = String(email).split("@");
  return (u || "").slice(0, 2) + "***@" + (d || "");
}

export async function optOutLink(env, email) {
  const secret = optOutSecret(env);
  const id = await sha256Hex(String(email).trim().toLowerCase());
  const token = secret ? (await hmacHex(secret, id)).slice(0, 32) : "";
  return `${ORIGIN}/pos-venda/descadastrar?i=${id}&t=${token}`;
}

async function verifyOptOut(env, id, token) {
  const secret = optOutSecret(env);
  if (!secret || !/^[0-9a-f]{64}$/.test(String(id)) || !/^[0-9a-f]{32}$/.test(String(token))) return false;
  return timingSafeEqual((await hmacHex(secret, id)).slice(0, 32), token);
}

export function renderPostSaleEmail(step, { productName, productSlug, nextOffer, optOutUrl, test = false, ratingLinks = [] }) {
  const prefix = test ? "[TESTE] " : "";
  const productUrl = `${SALES}/${productSlug}`;
  const sign = `\n\nEquipe ZEVANORY\n${SUPPORT_EMAIL} · WhatsApp: ${WHATSAPP}\n\nNão quer mais receber estes e-mails de acompanhamento? ${optOutUrl}`;
  if (step === "d1") {
    return {
      subject: `${prefix}Como tirar o máximo do ${productName}`,
      text: `Olá!\n\nObrigado por escolher o ${productName}. Para ter resultado já nesta semana:\n\n1. Abra o arquivo 00_COMECE_AQUI e o Guia Rápido em PDF (leitura curta).\n2. Escolha UM processo do seu negócio e aplique o primeiro modelo ou a planilha hoje.\n3. Travou em algo? Responda este e-mail ou chame no WhatsApp — respondemos com base no próprio material.\n\nPerdeu o link de download? Peça outro em https://zevanory.api.br/entrega/reenviar\n\nPágina do produto: ${productUrl}` + sign,
    };
  }
  const nextLine = nextOffer
    ? `\n\nQuando quiser ir além: o ${nextOffer.name} reúne este material e acrescenta as outras frentes (${SALES}/${nextOffer.slug}).`
    : `\n\nVocê já tem o pacote mais completo da ZEVANORY. Se precisar de ajuda para aplicar alguma parte, é só chamar.`;
  return {
    subject: `${prefix}Como está indo com o ${productName}?`,
    text: `Olá!\n\nJá faz alguns dias que você começou com o ${productName}. De 1 a 5, quanto ele já ajudou no seu negócio? Clique na sua nota (leva 5 segundos):\n\n${ratingLinks.length === 5 ? ratingLinks.map((link, i) => `${i + 1} ${'★'.repeat(i + 1)} — ${link}`).join('\n') : 'Responda este e-mail com o número.'}\n\nSua resposta melhora o material para todos os clientes.` + nextLine + sign,
  };
}

export function dueStep(ageMs, sent) {
  if (ageMs > MAX_AGE) return null;
  for (const step of [...STEPS].reverse()) {
    if (ageMs >= step.minAge && !sent.has(step.id)) {
      // Never send D+5 without D+1 having gone first; a late order only gets the latest due step.
      if (step.id === "d5" && !sent.has("d1") && ageMs < 7 * DAY) return "d1";
      return step.id;
    }
  }
  return null;
}

function parseEvidence(raw) {
  try {
    const text = String(raw || "").trim();
    return text.startsWith("{") ? JSON.parse(text) : {};
  } catch { return {}; }
}

async function sendResend(env, { to, subject, text, idempotencyKey, unsubscribeUrl }) {
  if (!env.RESEND_API_KEY) return { sent: false, error: "resend_unconfigured" };
  const from = String(env.RESEND_FROM_ADDRESS || "ZEVANORY <contato@zevanory.api.br>");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({
      from,
      to: [to],
      reply_to: SUPPORT_EMAIL,
      subject,
      text,
      html: brandedEmailHtml(text,{unsubscribeUrl}),
      headers: { "List-Unsubscribe": `<${unsubscribeUrl}>, <mailto:${SUPPORT_EMAIL}?subject=descadastrar>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      tags: [{ name: "flow", value: "post_sale" }],
    }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => null);
  return { sent: Boolean(r?.ok), status: r?.status || 0 };
}

async function bridgeActivity(kv, key, entry) {
  try {
    await kv.put(`zpc-activity:v1:event:${Date.now()}:${key}`, JSON.stringify(entry), { expirationTtl: 30 * 24 * 3600 });
  } catch {}
}

async function isTestOrder(kv, order, evidence) {
  if (order.certification_pilot === true) return true;
  if (await kv.get(`sandbox-proof-v2:order:${order.order_id}`)) return true;
  if (evidence.email_destination_kind && evidence.email_destination_kind !== "payer") return true;
  return false;
}

async function deliverStep(env, kv, { order, evidence, step, email, test }) {
  const catalog = POST_SALE_CATALOG[String(order.offer_id || "")];
  if (!catalog) return { skipped: "unknown_offer" };
  const nextOffer = catalog.next ? POST_SALE_CATALOG[catalog.next] : null;
  const unsubscribeUrl = await optOutLink(env, email);
  const ratingLinks = step === "d5" ? await reviewLinks(env, order.order_id) : [];
  const message = renderPostSaleEmail(step, { productName: catalog.name, productSlug: catalog.slug, nextOffer, optOutUrl: unsubscribeUrl, test, ratingLinks });
  const out = await sendResend(env, { to: email, ...message, idempotencyKey: `zevanory-post-sale-${order.order_id}-${step}`, unsubscribeUrl });
  if (!out.sent) return { failed: out.error || `resend_${out.status}` };
  await kv.put(`postsale:sent:${order.order_id}:${step}`, new Date().toISOString(), { expirationTtl: 90 * 24 * 3600 });
  await bridgeActivity(kv, `${order.order_id}-${step}`, {
    title: `${test ? "[TESTE] " : ""}Pós-venda ${step === "d1" ? "D+1 (como começar)" : "D+5 (satisfação + próximo passo)"} enviado · ${catalog.name}`,
    detail: `Pedido ${String(order.order_id).slice(0, 8)}… · cliente ${maskEmail(email)} · assunto: ${message.subject}`,
    status: "post-sale-sent",
    channel: "email",
    product: catalog.name,
    sourceKey: `post-sale:${order.order_id}:${step}`,
    evidence: [`order:${order.order_id}`, `step:${step}`, "paid-customer-only", "opt-out:list-unsubscribe", new Date().toISOString()],
  });
  return { sent: true, step };
}

export async function runPostSale(env, { sqlFactory, now = Date.now(), production = String(env.MERCADOPAGO_ENV || "").toLowerCase() === "production" } = {}) {
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  const summary = { ok: true, at: new Date(now).toISOString(), scanned: 0, sent: 0, skipped: {}, failed: 0 };
  const skip = (reason) => { summary.skipped[reason] = (summary.skipped[reason] || 0) + 1; };
  if (!kv || !sqlFactory || !env.DATABASE_URL) return { ...summary, ok: false, reason: "post_sale_unconfigured" };
  if (!production) {
    const out = { ...summary, idle: "sales_not_in_production" };
    await kv.put("postsale:lastrun", JSON.stringify(out), { expirationTtl: 30 * 24 * 3600 }).catch(() => null);
    return out;
  }
  const sql = sqlFactory(env.DATABASE_URL);
  const rows = await sql.query(
    `select o.order_id, o.offer_id, o.status, o.certification_pilot, sf.evidence_ref, sf.delivered_at
       from orders o
       join service_fulfillment sf on sf.order_id = o.order_id
      where o.status = 'paid' and sf.status = 'delivered' and sf.delivered_at is not null
        and sf.delivered_at > now() - interval '15 days'
        and sf.delivered_at < now() - interval '20 hours'
        and coalesce(o.certification_pilot, false) = false
      order by sf.delivered_at asc
      limit 50`, []);
  for (const order of rows) {
    summary.scanned += 1;
    const evidence = parseEvidence(order.evidence_ref);
    if (await isTestOrder(kv, order, evidence)) { skip("test_order"); continue; }
    const email = String(evidence.email_recipient || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email) || EXCLUDED_RECIPIENTS.has(email)) { skip("no_customer_email"); continue; }
    if (await kv.get(`postsale:optout:${await sha256Hex(email)}`)) { skip("opted_out"); continue; }
    if (await kv.get(`refund:req:${order.order_id}`)) { skip("refund_requested"); continue; }
    const sent = new Set();
    for (const step of STEPS) if (await kv.get(`postsale:sent:${order.order_id}:${step.id}`)) sent.add(step.id);
    const step = dueStep(now - new Date(order.delivered_at).getTime(), sent);
    if (!step) { skip("nothing_due"); continue; }
    const out = await deliverStep(env, kv, { order, evidence, step, email, test: false });
    if (out.sent) summary.sent += 1;
    else if (out.failed) summary.failed += 1;
    else skip(out.skipped || "skipped");
  }
  await kv.put("postsale:lastrun", JSON.stringify(summary), { expirationTtl: 30 * 24 * 3600 }).catch(() => null);
  return summary;
}

const OPT_OUT_PAGE = (state) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>ZEVANORY — e-mails de acompanhamento</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1220;color:#e6edf6;margin:0;display:grid;place-items:center;min-height:100vh;padding:16px}main{max-width:460px;background:#111a2c;border:1px solid #1f2b44;border-radius:12px;padding:28px}h1{font-size:20px;margin:0 0 12px}p{color:#a9b6c9;line-height:1.5}button{background:#2dd4a7;color:#04241b;border:0;border-radius:8px;padding:12px 18px;font-weight:700;cursor:pointer}</style></head><body><main>
${state === "done" ? `<h1>Pronto.</h1><p>Você não receberá mais e-mails de acompanhamento da ZEVANORY. E-mails sobre seu pedido (entrega e reembolso) continuam funcionando normalmente.</p>`
  : state === "invalid" ? `<h1>Link inválido</h1><p>Este link não é válido. Escreva para ${SUPPORT_EMAIL} que removemos seu e-mail na hora.</p>`
  : `<h1>Parar e-mails de acompanhamento?</h1><p>Você deixará de receber as dicas e o acompanhamento pós-compra.</p><form method="post"><button type="submit">Confirmar descadastro</button></form>`}
</main></body></html>`;

export async function handlePostSale(request, env, { sqlFactory, isAdminAuthorized } = {}) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path !== "/pos-venda/descadastrar" && path !== "/admin/post-sale" && path !== "/api/internal/certification/e2e/post-sale") return null;
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  if (!kv) return json(503, { error: "post_sale_state_unavailable" });

  if (path === "/pos-venda/descadastrar") {
    const id = String(url.searchParams.get("i") || "");
    const token = String(url.searchParams.get("t") || "");
    const valid = await verifyOptOut(env, id, token);
    if (request.method === "GET" || request.method === "HEAD") return html(valid ? 200 : 400, OPT_OUT_PAGE(valid ? "confirm" : "invalid"));
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
    if (!valid) return html(400, OPT_OUT_PAGE("invalid"));
    await kv.put(`postsale:optout:${id}`, new Date().toISOString());
    await bridgeActivity(kv, `optout-${id.slice(0, 12)}`, {
      title: "Cliente descadastrou do pós-venda",
      detail: "Pedido de descadastro recebido (one-click). Nenhum outro e-mail de acompanhamento será enviado a este cliente.",
      status: "post-sale-opt-out", channel: "email", sourceKey: `post-sale-optout:${id}`,
      evidence: ["list-unsubscribe", new Date().toISOString()],
    });
    return html(200, OPT_OUT_PAGE("done"));
  }

  if (path === "/admin/post-sale") {
    if (!isAdminAuthorized || !(await isAdminAuthorized(request, env))) {
      return new Response("Autenticação necessária", { status: 401, headers: { "www-authenticate": 'Basic realm="ZEVANORY Admin"', "cache-control": "no-store" } });
    }
    const last = JSON.parse(await kv.get("postsale:lastrun") || "null");
    return json(200, { ok: true, flow: "post_sale_v1", steps: STEPS.map((s) => s.id), lastRun: last });
  }

  // Certification: proves the real template + Resend path on a sandbox order, delivered to its controlled inbox.
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
  const cert = String(env.CERTIFICATION_E2E_TOKEN || "");
  if (cert.length < 32 || !timingSafeEqual(cert, request.headers.get("x-certification-e2e-token") || "")) return json(401, { error: "unauthorized" });
  let input = {};
  try { input = await request.json(); } catch {}
  const oid = String(input.order_id || "").trim().toLowerCase();
  if (!/^[0-9a-f-]{36}$/.test(oid) || !sqlFactory || !env.DATABASE_URL) return json(400, { error: "invalid_order" });
  const sql = sqlFactory(env.DATABASE_URL);
  const order = (await sql.query(
    `select o.order_id, o.offer_id, o.status, o.certification_pilot, sf.evidence_ref, sf.delivered_at
       from orders o join service_fulfillment sf on sf.order_id = o.order_id where o.order_id = $1 limit 1`, [oid]))[0];
  if (!order) return json(404, { error: "order_not_found" });
  const evidence = parseEvidence(order.evidence_ref);
  if (!(await isTestOrder(kv, order, evidence))) return json(409, { error: "not_a_test_order" });
  const email = String(evidence.email_recipient || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return json(409, { error: "no_inbox" });
  const step = input.step === "d5" ? "d5" : "d1";
  const out = await deliverStep(env, kv, { order, evidence, step, email, test: true });
  return json(out.sent ? 200 : 502, { ok: Boolean(out.sent), step, ...out });
}
