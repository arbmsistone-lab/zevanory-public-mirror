// ZEVANORY Conteúdo Pronto — fully automatic monthly service sold on Hotmart.
// Hotmart owns billing, recurrence, cancellation and refunds. This module only:
//   1) receives the authenticated Hotmart postback (hottok, constant-time compare);
//   2) on an approved charge, emails a one-time briefing link (first cycle) or, on renewal,
//      generates the new monthly package from the stored briefing;
//   3) generates the package with Workers AI (12 posts + 4 WhatsApp messages + 30-day
//      calendar), validates it, stores it privately and emails it with a private link;
//   4) stops on refund / chargeback / cancellation.
// No Mercado Pago, checkout, pricing or sales-switch code is touched. Buyer e-mail/name are
// kept only in the private KV (needed for delivery), never in logs or the activity ledger.
import { brandedEmailHtml } from "./brand-email.mjs";
import { emitActivity } from "./activity-ledger.mjs";
import { recordHotmartSale } from "./sales-ledger.mjs";

export const SERVICE_PRODUCT_NAME = "ZEVANORY Conteúdo Pronto";
const SUB = "zpc:cp:sub:";        // subscriber record
const TOKEN = "zpc:cp:token:";    // briefing/package access token -> subscriber key
const TXN = "zpc:cp:txn:";        // processed transaction (idempotency)
const PKG = "zpc:cp:pkg:";        // generated package
const PENDING = "zpc:cp:pending"; // list of subscriber keys awaiting generation retry
const ORIGIN = "https://zevanory.api.br";
const MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct-fp8-fast"];
const enc = new TextEncoder();
const DAY = 86400;

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const b64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const rand = () => b64(crypto.getRandomValues(new Uint8Array(32)));
async function sha(s) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(String(s))))].map((x) => x.toString(16).padStart(2, "0")).join(""); }
function eq(a, b) { const x = enc.encode(String(a)), y = enc.encode(String(b)); let n = x.length ^ y.length; for (let i = 0; i < Math.max(x.length, y.length); i++) n |= (x[i] || 0) ^ (y[i] || 0); return n === 0; }
async function readJson(kv, key, fallback = null) { try { return JSON.parse(String(await kv.get(key) || "null")) ?? fallback; } catch { return fallback; } }

function bundle(env) { try { const raw = env.CHANNEL_CREDENTIALS_JSON; return raw && typeof raw === "object" ? raw : JSON.parse(String(raw || "{}")); } catch { return {}; } }
export function hottok(env) { return String(env.HOTMART_HOTTOK || bundle(env).HOTMART_HOTTOK || "").trim(); }

export function isServiceProduct(data = {}, ids = "") {
  const name = String(data?.product?.name || "");
  const list = String(ids || "").split(",").map((x) => x.trim()).filter(Boolean);
  return name.trim() === SERVICE_PRODUCT_NAME || list.includes(String(data?.product?.id || ""));
}

const ACTIVE_EVENTS = new Set(["PURCHASE_APPROVED", "PURCHASE_COMPLETE"]);
const STOP_EVENTS = new Set(["PURCHASE_REFUNDED", "PURCHASE_CHARGEBACK", "PURCHASE_CANCELED", "PURCHASE_PROTEST", "SUBSCRIPTION_CANCELLATION"]);

async function sendEmail(env, to, subject, text, fetchImpl = fetch) {
  if (!env.RESEND_API_KEY || !to) return false;
  const r = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: "Bearer " + String(env.RESEND_API_KEY), "content-type": "application/json" },
    body: JSON.stringify({ from: String(env.RESEND_FROM_ADDRESS || "ZEVANORY <contato@zevanory.api.br>"), to: [to], reply_to: "suporte@zevanory.api.br", subject, text, html: brandedEmailHtml(text) }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => null);
  return Boolean(r?.ok);
}
async function ownerAlert(env, subject, text, fetchImpl) {
  return sendEmail(env, String(env.OWNER_ALERT_EMAIL || "zevanory@gmail.com"), "ZEVANORY · " + subject, text, fetchImpl);
}

// ---------- Hotmart postback ----------
export async function handleHotmartWebhook(request, env, ctx, fetchImpl = fetch) {
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  const secret = hottok(env);
  if (!kv?.get || !kv?.put) return json(503, { error: "secure_store_unavailable" });
  if (secret.length < 16) return json(503, { error: "hotmart_not_configured" });
  let body = null;
  try { body = await request.json(); } catch { return json(400, { error: "invalid_json" }); }
  const provided = request.headers.get("x-hotmart-hottok") || String(body?.hottok || "");
  if (!eq(provided, secret)) return json(401, { error: "unauthorized" });
  const serviceIds = String(env.HOTMART_SERVICE_PRODUCT_IDS || bundle(env).HOTMART_SERVICE_PRODUCT_IDS || "8704905");
  const event = String(body?.event || "").toUpperCase();
  const data = body?.data || {};
  const txn = String(data?.purchase?.transaction || "");
  if (!event || !txn) return json(400, { error: "missing_event_or_transaction" });
  const dedupe = TXN + (await sha(event + ":" + txn)).slice(0, 40);
  if (await kv.get(dedupe)) return json(200, { ok: true, duplicate: true });
  await kv.put(dedupe, "1", { expirationTtl: 400 * DAY });
  // Revenue ledger for the command center (aggregate, PII-free, idempotent per txn/outcome).
  await recordHotmartSale(kv, event, data).catch(() => null);

  if (!isServiceProduct(data, serviceIds)) {
    // Digital products: Hotmart itself delivers the files. Only record visibility.
    if (ACTIVE_EVENTS.has(event)) await emitActivity(env, { type: "delivery_sent", channel: "store", status: "hotmart_approved", ref: "hotmart:" + txn }).catch(() => null);
    if (STOP_EVENTS.has(event)) await emitActivity(env, { type: "refund_requested", channel: "store", status: "hotmart_" + event.toLowerCase().slice(0, 40), ref: "hotmart:" + txn }).catch(() => null);
    return json(200, { ok: true, scope: "digital_product" });
  }

  const subscriber = String(data?.subscription?.subscriber?.code || "") || "txn-" + txn;
  const key = SUB + (await sha(subscriber)).slice(0, 40);
  const email = String(data?.buyer?.email || "").trim().toLowerCase();
  const name = String(data?.buyer?.name || "").trim().slice(0, 80);
  const current = await readJson(kv, key, null);

  if (STOP_EVENTS.has(event)) {
    if (current) await kv.put(key, JSON.stringify({ ...current, status: "inactive", stoppedAt: new Date().toISOString(), stopEvent: event }), { expirationTtl: 400 * DAY });
    await emitActivity(env, { type: "refund_requested", channel: "store", status: "service_stopped", ref: "cp:" + subscriber }).catch(() => null);
    return json(200, { ok: true, status: "inactive" });
  }
  if (!ACTIVE_EVENTS.has(event)) return json(200, { ok: true, ignored: event });
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) return json(200, { ok: true, status: "no_buyer_email" });

  const record = {
    schema: "zpc.cp.v1", status: "active", email, name,
    cycles: Number(current?.cycles || 0) + 1, lastTxn: txn,
    briefing: current?.briefing || null, createdAt: current?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  await kv.put(key, JSON.stringify(record), { expirationTtl: 400 * DAY });
  await emitActivity(env, { type: "delivery_sent", channel: "store", status: record.cycles === 1 ? "service_started" : "service_renewed", ref: "cp:" + subscriber + ":" + record.cycles }).catch(() => null);

  if (!record.briefing) {
    const token = rand();
    await kv.put(TOKEN + token, key, { expirationTtl: 60 * DAY });
    const link = `${ORIGIN}/conteudo-pronto/briefing?t=${token}`;
    await sendEmail(env, email, "Bem-vindo ao Conteúdo Pronto — falta só 1 passo",
      `Olá${name ? ", " + name.split(" ")[0] : ""}!\n\nSeu pagamento foi confirmado. Para a ZEVANORY preparar o seu pacote do mês, responda este formulário curto (leva 3 minutos):\n\n${link}\n\nAssim que você enviar, o pacote com 12 posts, 4 mensagens de venda para WhatsApp e o calendário de 30 dias chega neste e-mail em poucos minutos.\n\nDúvidas: suporte@zevanory.api.br`, fetchImpl);
    await emitActivity(env, { type: "email_sent", channel: "email", status: "briefing_requested", ref: "cp-brief:" + subscriber + ":" + record.cycles }).catch(() => null);
    await ownerAlert(env, "novo assinante do Conteúdo Pronto", `Novo assinante (ciclo ${record.cycles}). O formulário foi enviado automaticamente. Nenhuma ação necessária.`, fetchImpl);
    return json(200, { ok: true, status: "briefing_requested" });
  }
  const job = generateAndDeliver(env, key, fetchImpl);
  if (ctx?.waitUntil) ctx.waitUntil(job); else await job;
  return json(200, { ok: true, status: "generation_started" });
}

// ---------- Briefing form ----------
const FIELDS = [
  ["negocio", "Nome do negócio", 80, true],
  ["ramo", "Ramo / o que você faz (ex.: salão de beleza, loja de roupas, contabilidade)", 160, true],
  ["publico", "Quem é o seu cliente ideal", 240, true],
  ["produtos", "Principais produtos ou serviços que quer divulgar", 400, true],
  ["diferencial", "Por que escolher você (diferencial)", 300, true],
  ["cidade", "Cidade / região de atendimento", 80, false],
  ["tom", "Tom de voz (ex.: próximo e divertido, sério e técnico)", 120, true],
  ["contato", "Como o cliente fala com você (WhatsApp, Instagram, site)", 160, false],
];
function page(title, inner, status = 200) {
  return new Response(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} · ZEVANORY</title><style>body{margin:0;background:#05070b;color:#f5f7fb;font:16px/1.55 system-ui,Arial,sans-serif}main{max-width:720px;margin:0 auto;padding:24px 16px}label{display:block;margin:16px 0 6px;font-weight:600}input,textarea{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #2a3344;background:#0b0f16;color:#f5f7fb;font:inherit}button{margin-top:20px;padding:14px 20px;border:0;border-radius:12px;background:#dbe6ff;color:#05070b;font-weight:700;font-size:16px;cursor:pointer}article{background:#0b0f16;border:1px solid #1d2533;border-radius:12px;padding:14px;margin:12px 0}h1{font-size:28px;line-height:1.2}small{color:#9aa6bd}</style></head><body><main>${inner}</main></body></html>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", "referrer-policy": "no-referrer", "x-frame-options": "DENY" } });
}
async function resolveToken(kv, token) {
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(String(token || ""))) return null;
  const key = await kv.get(TOKEN + token);
  return key ? { key, record: await readJson(kv, key, null) } : null;
}
export async function handleBriefing(request, env, ctx, fetchImpl = fetch) {
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  const url = new URL(request.url);
  if (!kv?.get) return page("Indisponível", "<h1>Tente novamente em instantes.</h1>", 503);
  const token = url.searchParams.get("t") || "";
  const found = await resolveToken(kv, token);
  if (!found?.record || found.record.status !== "active") return page("Link inválido", "<h1>Link inválido ou expirado.</h1><p>Fale com suporte@zevanory.api.br.</p>", 404);
  if (request.method === "GET") {
    const b = found.record.briefing || {};
    const inputs = FIELDS.map(([id, label, max, req]) => `<label for="${id}">${esc(label)}${req ? "" : " <small>(opcional)</small>"}</label>${max > 120 ? `<textarea id="${id}" name="${id}" maxlength="${max}" rows="3"${req ? " required" : ""}>${esc(b[id] || "")}</textarea>` : `<input id="${id}" name="${id}" maxlength="${max}" value="${esc(b[id] || "")}"${req ? " required" : ""}>`}`).join("");
    return page("Briefing", `<h1>Conteúdo Pronto · seu briefing</h1><p>Responda com o jeito que você fala com seus clientes. Com isso a ZEVANORY prepara seu pacote do mês e envia por e-mail em poucos minutos.</p><form method="post">${inputs}<button type="submit">Enviar e gerar meu pacote</button></form>`);
  }
  if (request.method !== "POST") return page("Método inválido", "<h1>Método inválido.</h1>", 405);
  let form; try { form = await request.formData(); } catch { form = new FormData(); }
  const briefing = {};
  for (const [id, , max, req] of FIELDS) {
    const v = String(form.get(id) || "").replace(/\s+/g, " ").trim().slice(0, max);
    if (req && v.length < 2) return page("Faltou um campo", `<h1>Faltou preencher: ${esc(FIELDS.find((f) => f[0] === id)[1])}</h1><p><a href="?t=${esc(token)}" style="color:#dbe6ff">Voltar</a></p>`, 400);
    briefing[id] = v;
  }
  await kv.put(found.key, JSON.stringify({ ...found.record, briefing, briefedAt: new Date().toISOString() }), { expirationTtl: 400 * DAY });
  const job = generateAndDeliver(env, found.key, fetchImpl);
  if (ctx?.waitUntil) ctx.waitUntil(job); else await job;
  return page("Recebido", "<h1>Pronto! Seu pacote está sendo gerado.</h1><p>Ele chega no seu e-mail em poucos minutos. Confira também a caixa de spam ou promoções.</p>");
}

// ---------- Generation ----------
function aiText(out) { return String(out?.response ?? out?.result?.response ?? out ?? ""); }
function extractJson(text) { const s = text.indexOf("{"), e = text.lastIndexOf("}"); if (s < 0 || e <= s) return null; try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; } }
const FORBIDDEN = /(garant\w* (de )?(resultado|venda|lucro)|100% garantido|fique rico|renda garantida|milagr)/i;
function briefingText(b) { return FIELDS.filter(([id]) => b[id]).map(([id, label]) => `${label}: ${b[id]}`).join("\n"); }
export function validatePosts(list, n) {
  if (!Array.isArray(list) || list.length < n) return null;
  const out = [];
  for (const p of list.slice(0, n)) {
    const tema = String(p?.tema || "").trim(), legenda = String(p?.legenda || "").trim(), cta = String(p?.cta || "").trim();
    const hashtags = (Array.isArray(p?.hashtags) ? p.hashtags : String(p?.hashtags || "").split(/[\s,]+/)).map((h) => String(h).trim()).filter(Boolean).map((h) => h.startsWith("#") ? h : "#" + h).slice(0, 8);
    const imagem = String(p?.imagem || "").trim();
    if (tema.length < 3 || legenda.length < 120 || legenda.length > 1600 || cta.length < 3 || FORBIDDEN.test(legenda + " " + cta)) return null;
    out.push({ tema, legenda, cta, hashtags, imagem });
  }
  return out;
}
export function validateMessages(list) {
  if (!Array.isArray(list) || list.length < 4) return null;
  const out = [];
  for (const m of list.slice(0, 4)) {
    const objetivo = String(m?.objetivo || "").trim(), texto = String(m?.texto || "").trim();
    if (objetivo.length < 3 || texto.length < 60 || texto.length > 900 || FORBIDDEN.test(texto)) return null;
    out.push({ objetivo, texto });
  }
  return out;
}
async function ask(ai, system, user, validate) {
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await Promise.race([
          ai.run(model, { messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: 3000, temperature: 0.6 }),
          new Promise((_, rej) => setTimeout(() => rej(new Error("ai_timeout")), 60000)),
        ]);
        const parsed = extractJson(aiText(out));
        const ok = parsed && validate(parsed);
        if (ok) return ok;
      } catch {}
    }
  }
  return null;
}
const SYSTEM = "Você é redator sênior de marketing para pequenos negócios brasileiros. Escreva em português do Brasil, no tom pedido, de forma concreta, sem promessas de resultado, sem preços inventados, sem emojis em excesso. Responda SOMENTE com JSON válido.";
export async function generatePackage(env, briefing, cycle = 1) {
  const ai = env.AI;
  if (!ai?.run) return null;
  const brief = briefingText(briefing);
  const postSpec = (from) => `Briefing do negócio:\n${brief}\n\nCrie 6 posts para redes sociais (mês ${cycle}, posts ${from} a ${from + 5}), variando entre: educativo, prova/bastidor, oferta, dúvida frequente, história de cliente (sem inventar nomes reais) e engajamento. JSON: {"posts":[{"tema":"...","legenda":"legenda completa de 400 a 900 caracteres","cta":"chamada para ação curta","hashtags":["#...",5 a 8],"imagem":"sugestão objetiva de foto ou arte"}]}`;
  const a = await ask(ai, SYSTEM, postSpec(1), (j) => validatePosts(j.posts, 6));
  if (!a) return null;
  const b = await ask(ai, SYSTEM, postSpec(7) + `\nNão repita estes temas: ${a.map((p) => p.tema).join("; ")}.`, (j) => validatePosts(j.posts, 6));
  if (!b) return null;
  const m = await ask(ai, SYSTEM, `Briefing do negócio:\n${brief}\n\nCrie 4 mensagens de WhatsApp para clientes que já conversaram com o negócio (respeitando quem pediu contato): 1) apresentar a oferta principal, 2) acompanhamento de quem não respondeu, 3) reativar cliente antigo, 4) pedir indicação. JSON: {"mensagens":[{"objetivo":"...","texto":"mensagem de 150 a 500 caracteres"}]}`, (j) => validateMessages(j.mensagens));
  if (!m) return null;
  const posts = [...a, ...b];
  const days = [1, 3, 6, 8, 10, 13, 15, 17, 20, 22, 25, 28];
  const calendar = posts.map((p, i) => ({ dia: days[i], tipo: "post", tema: p.tema }));
  calendar.push({ dia: 5, tipo: "whatsapp", tema: m[0].objetivo }, { dia: 12, tipo: "whatsapp", tema: m[1].objetivo }, { dia: 19, tipo: "whatsapp", tema: m[2].objetivo }, { dia: 26, tipo: "whatsapp", tema: m[3].objetivo });
  calendar.sort((x, y) => x.dia - y.dia);
  return { schema: "zpc.cp.package.v1", cycle, generatedAt: new Date().toISOString(), posts, mensagens: m, calendario: calendar };
}
export function packageText(pkg, name = "") {
  const lines = [`Seu pacote Conteúdo Pronto — mês ${pkg.cycle}${name ? ` (${name})` : ""}`, "", "CALENDÁRIO DE 30 DIAS"];
  for (const c of pkg.calendario) lines.push(`Dia ${String(c.dia).padStart(2, "0")} · ${c.tipo === "post" ? "Post" : "WhatsApp"} · ${c.tema}`);
  lines.push("", "12 POSTS");
  pkg.posts.forEach((p, i) => lines.push("", `POST ${i + 1} — ${p.tema}`, p.legenda, `Chamada: ${p.cta}`, p.hashtags.join(" "), `Imagem sugerida: ${p.imagem || "foto real do seu negócio"}`));
  lines.push("", "4 MENSAGENS PARA WHATSAPP");
  pkg.mensagens.forEach((m, i) => lines.push("", `MENSAGEM ${i + 1} — ${m.objetivo}`, m.texto));
  lines.push("", "Revise e ajuste o que quiser antes de publicar. Envie mensagens só para quem pediu contato com você.");
  return lines.join("\n");
}
export async function generateAndDeliver(env, key, fetchImpl = fetch) {
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  const record = await readJson(kv, key, null);
  if (!record || record.status !== "active" || !record.briefing) return { ok: false, reason: "not_ready" };
  if (record.deliveredCycle === record.cycles) return { ok: true, reason: "already_delivered" };
  const pkg = await generatePackage(env, record.briefing, record.cycles);
  if (!pkg) {
    const pending = await readJson(kv, PENDING, []);
    if (!pending.includes(key)) await kv.put(PENDING, JSON.stringify([...pending, key].slice(-200)));
    await ownerAlert(env, "geração do Conteúdo Pronto adiada", "A IA não gerou um pacote válido agora; nova tentativa automática em até 1 hora.", fetchImpl);
    return { ok: false, reason: "generation_failed_retry_scheduled" };
  }
  const pkgKey = PKG + key.slice(SUB.length) + ":" + record.cycles;
  await kv.put(pkgKey, JSON.stringify(pkg), { expirationTtl: 400 * DAY });
  const token = rand();
  await kv.put(TOKEN + token, key, { expirationTtl: 120 * DAY });
  const text = packageText(pkg, record.briefing.negocio) + `\n\nVersão para consulta online: ${ORIGIN}/conteudo-pronto/pacote?t=${token}\n\nDúvidas ou ajustes: responda este e-mail ou escreva para suporte@zevanory.api.br.`;
  const sent = await sendEmail(env, record.email, `Seu Conteúdo Pronto do mês ${record.cycles} chegou`, text, fetchImpl);
  if (!sent) {
    const pending = await readJson(kv, PENDING, []);
    if (!pending.includes(key)) await kv.put(PENDING, JSON.stringify([...pending, key].slice(-200)));
    return { ok: false, reason: "email_failed_retry_scheduled" };
  }
  await kv.put(key, JSON.stringify({ ...record, deliveredCycle: record.cycles, deliveredAt: new Date().toISOString(), lastPackage: pkgKey }), { expirationTtl: 400 * DAY });
  const pending = await readJson(kv, PENDING, []);
  if (pending.includes(key)) await kv.put(PENDING, JSON.stringify(pending.filter((k) => k !== key)));
  await emitActivity(env, { type: "delivery_sent", channel: "email", status: "service_package_delivered", ref: "cp-pkg:" + key.slice(-16) + ":" + record.cycles }).catch(() => null);
  return { ok: true, reason: "delivered" };
}
export async function retryPendingPackages(env, fetchImpl = fetch, limit = 2) {
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  if (!kv?.get) return { ok: false };
  const pending = await readJson(kv, PENDING, []);
  const results = [];
  for (const key of pending.slice(0, limit)) results.push(await generateAndDeliver(env, key, fetchImpl));
  return { ok: true, tried: results.length, delivered: results.filter((r) => r.ok).length };
}
export async function handlePackageView(request, env) {
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  const found = kv?.get ? await resolveToken(kv, new URL(request.url).searchParams.get("t")) : null;
  const pkg = found?.record?.lastPackage ? await readJson(kv, found.record.lastPackage, null) : null;
  if (!pkg) return page("Pacote não encontrado", "<h1>Pacote não encontrado ou link expirado.</h1>", 404);
  const posts = pkg.posts.map((p, i) => `<article><h2>Post ${i + 1} — ${esc(p.tema)}</h2><p style="white-space:pre-wrap">${esc(p.legenda)}</p><p><b>Chamada:</b> ${esc(p.cta)}</p><p>${esc(p.hashtags.join(" "))}</p><small>Imagem sugerida: ${esc(p.imagem)}</small></article>`).join("");
  const msgs = pkg.mensagens.map((m, i) => `<article><h2>Mensagem ${i + 1} — ${esc(m.objetivo)}</h2><p style="white-space:pre-wrap">${esc(m.texto)}</p></article>`).join("");
  const cal = pkg.calendario.map((c) => `<li>Dia ${c.dia} · ${c.tipo === "post" ? "Post" : "WhatsApp"} · ${esc(c.tema)}</li>`).join("");
  return page("Seu pacote", `<h1>Conteúdo Pronto · mês ${pkg.cycle}</h1><h2>Calendário</h2><ul>${cal}</ul><h2>12 posts</h2>${posts}<h2>4 mensagens para WhatsApp</h2>${msgs}`);
}
