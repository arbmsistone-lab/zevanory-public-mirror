// ZEVANORY Conteúdo Pronto — fully automatic monthly service sold on Hotmart.
// Hotmart owns billing, recurrence, cancellation and refunds. This module only:
//   1) receives the authenticated Hotmart postback (hottok, constant-time compare);
//   2) on an approved charge, emails a one-time briefing link (first cycle) or, on renewal,
//      generates the new monthly package from the stored briefing;
//   3) generates the package with Workers AI (12 posts + 4 multichannel sales/follow-up scripts,
//      each with a short and an e-mail version, + 30-day calendar), validates it, stores it
//      privately and emails it with a private link;
//   4) stops on refund / chargeback / cancellation.
// No Mercado Pago, checkout, pricing or sales-switch code is touched. Buyer e-mail/name are
// kept only in the private KV (needed for delivery), never in logs or the activity ledger.
import { brandedEmailHtml } from "./brand-email.mjs";
import { emitActivity } from "./activity-ledger.mjs";
import { recordHotmartSale } from "./sales-ledger.mjs";
import { BANNED_NUMBERS, CONTEUDO_PRONTO } from "./politica-unica.mjs";
import { resendFailureIsTransient } from "./atendimento.mjs";

// Contrato versionado da oferta (data/politica-unica.json, conteudo_pronto): a página
// /conteudo-pronto, o resumo da oferta e este gerador leem as mesmas quantidades, objetivos e
// canais. A conta de mensagens da ZEVANORY na Meta foi banida: os roteiros são para canais
// autorizados pelo cliente, revisados por ele, sem disparo automático.
export const CONTENT_SCHEMA_VERSION = CONTEUDO_PRONTO.content_schema_version;
export const PACKAGE_SCHEMA = CONTEUDO_PRONTO.package_schema;
export const ROTEIRO_OBJETIVOS = Object.freeze(CONTEUDO_PRONTO.objetivos.map((o) => Object.freeze({ ...o })));
const N_POSTS = CONTEUDO_PRONTO.posts;
const N_ROTEIROS = CONTEUDO_PRONTO.roteiros;
const CANAIS = CONTEUDO_PRONTO.canais_autorizados_exemplo;
const CANAIS_TEXTO = CANAIS.slice(0, -1).join(", ") + " ou " + CANAIS[CANAIS.length - 1];
// Canal banido e disparo em massa nunca entram num roteiro (termos em conteudo_pronto.termos_proibidos_regex);
// \b evita falso positivo em palavras como "zapier".
const ROTEIRO_PROIBIDO = new RegExp("\\b(?:" + CONTEUDO_PRONTO.termos_proibidos_regex.join("|") + ")\\b", "i");
// Número banido de contato_publico.numeros_banidos em qualquer grafia: completo, formatado ("(88) 9 9254-5413")
// ou mascarado ("88 9****-5413"). Corridas com cara de telefone são comparadas só pelos dígitos.
const PHONE_RUN = /[+(]?\d[\d\s().*•#-]{6,}\d/g;
// Máscara: DDD do número banido, de 2 a 6 posições com ao menos um caractere de máscara, e os 4 últimos dígitos.
const MASKED_RES = BANNED_NUMBERS.map((n) => new RegExp(`(?<!\\d)(?:\\+?55[\\s().-]*)?\\(?${n.slice(2, 4)}\\)?[\\s.-]*(?=[\\d\\s.*•#-]*[*•#])[\\d*•#][\\d\\s*•#]{1,6}[\\s.-]*${n.slice(-4)}(?!\\d)`));
export function bannedNumberIn(text) {
  const str = String(text ?? "");
  if (MASKED_RES.some((re) => re.test(str))) return true;
  for (const run of str.match(PHONE_RUN) || []) {
    const d = run.replace(/\D/g, "");
    if (BANNED_NUMBERS.some((n) => d.includes(n.slice(-8)))) return true;
  }
  return false;
}
// Canal banido, disparo em massa ou número banido: nada disso é gerado, exibido ou reenviado.
export const contaminated = (text) => ROTEIRO_PROIBIDO.test(String(text ?? "")) || bannedNumberIn(text);

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
      `Olá${name ? ", " + name.split(" ")[0] : ""}!\n\nSeu pagamento foi confirmado. Para a ZEVANORY preparar o seu pacote do mês, responda este formulário curto (leva 3 minutos):\n\n${link}\n\nAssim que você enviar, o pacote com ${N_POSTS} posts, ${N_ROTEIROS} roteiros multicanal de venda e acompanhamento (cada um com versão curta e versão de e-mail) e o calendário de 30 dias chega neste e-mail em poucos minutos. Os roteiros são para canais que seus clientes autorizaram, como ${CANAIS_TEXTO}; você revisa antes de usar e nada é enviado automaticamente.\n\nDúvidas: suporte@zevanory.api.br`, fetchImpl);
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
  ["contato", "Canais que seus clientes autorizaram para falar com você (ex.: e-mail, Instagram Direct, Telegram, chat do site)", 160, false],
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
    if (contaminated([tema, legenda, cta, ...hashtags, imagem].join(" "))) return null;
    out.push({ tema, legenda, cta, hashtags, imagem });
  }
  return out;
}
// Roteiros multicanal: exatamente os objetivos do contrato, na ordem; cada um com versão curta
// (Direct, Telegram, chat do site) e versão de e-mail (assunto + corpo). O objetivo exibido vem do
// contrato, nunca do modelo, para a saída não divergir da oferta.
export function validateRoteiros(list) {
  if (!Array.isArray(list) || list.length < N_ROTEIROS) return null;
  const out = [];
  for (const [i, obj] of ROTEIRO_OBJETIVOS.entries()) {
    const r = list[i];
    const id = String(r?.objetivo_id || r?.objetivo || "").trim();
    const curta = String(r?.curta || "").trim();
    const assunto = String(r?.email?.assunto ?? r?.email_assunto ?? "").trim();
    const corpo = String(r?.email?.corpo ?? r?.email_corpo ?? "").trim();
    if (id !== obj.id) return null;
    if (curta.length < 60 || curta.length > 600) return null;
    if (assunto.length < 5 || assunto.length > 120 || corpo.length < 200 || corpo.length > 1600) return null;
    const all = [curta, assunto, corpo].join(" ");
    if (FORBIDDEN.test(all) || contaminated(all)) return null;
    out.push({ objetivo_id: obj.id, objetivo: obj.titulo, curta, email: { assunto, corpo } });
  }
  return out;
}
export function roteirosPrompt(brief) {
  const objetivos = ROTEIRO_OBJETIVOS.map((o, i) => `${i + 1}) "${o.id}": ${o.regra}`).join("; ");
  return `Briefing do negócio:\n${brief}\n\nCrie ${N_ROTEIROS} roteiros multicanal de venda e acompanhamento para o negócio usar em canais que o cliente autorizou, como ${CANAIS_TEXTO}. O dono revisa antes de usar; nada é enviado automaticamente. Objetivos, nesta ordem: ${objetivos}. Cada roteiro tem uma versão curta (mensagem direta de 150 a 450 caracteres) e uma versão de e-mail (assunto curto e corpo de 400 a 1200 caracteres). Não cite aplicativos de mensagem que o cliente não autorizou, não proponha envio em massa e não invente nomes, preços ou prazos. JSON: {"roteiros":[{"objetivo_id":"${ROTEIRO_OBJETIVOS[0].id}","curta":"...","email":{"assunto":"...","corpo":"..."}}]}`;
}
async function ask(ai, system, user, validate) {
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let timer;
      try {
        const out = await Promise.race([
          ai.run(model, { messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: 3000, temperature: 0.6 }),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("ai_timeout")), 60000); }),
        ]);
        const parsed = extractJson(aiText(out));
        const ok = parsed && validate(parsed);
        if (ok) return ok;
      } catch {} finally { clearTimeout(timer); }
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
  const m = await ask(ai, SYSTEM, roteirosPrompt(brief), (j) => validateRoteiros(j.roteiros));
  if (!m) return null;
  const posts = [...a, ...b];
  if (posts.length !== N_POSTS) return null;
  const days = [1, 3, 6, 8, 10, 13, 15, 17, 20, 22, 25, 28];
  const calendar = posts.map((p, i) => ({ dia: days[i], tipo: "post", tema: p.tema }));
  [5, 12, 19, 26].forEach((dia, i) => calendar.push({ dia, tipo: "roteiro", tema: m[i].objetivo }));
  calendar.sort((x, y) => x.dia - y.dia);
  return { schema: PACKAGE_SCHEMA, content_schema_version: CONTENT_SCHEMA_VERSION, cycle, generatedAt: new Date().toISOString(), posts, roteiros: m, calendario: calendar };
}
// Pacotes antigos (zpc.cp.package.v1, campo "mensagens") continuam legíveis no link privado, com
// rótulo neutro: nenhum canal é prometido na reexibição.
function roteirosOf(pkg) {
  if (Array.isArray(pkg?.roteiros)) return pkg.roteiros;
  return (Array.isArray(pkg?.mensagens) ? pkg.mensagens : []).map((m) => ({ objetivo: String(m?.objetivo || ""), curta: String(m?.texto || ""), email: null }));
}
// Tudo o que a leitura exibe ou reenvia (o "tipo" do calendário nunca é exibido: vira Post/Roteiro).
export function displayedText(pkg) {
  const posts = (Array.isArray(pkg?.posts) ? pkg.posts : []).flatMap((p) => [p?.tema, p?.legenda, p?.cta, ...(Array.isArray(p?.hashtags) ? p.hashtags : [p?.hashtags]), p?.imagem]);
  const rots = roteirosOf(pkg).flatMap((r) => [r?.objetivo, r?.curta, r?.email?.assunto, r?.email?.corpo]);
  const cal = (Array.isArray(pkg?.calendario) ? pkg.calendario : []).map((c) => c?.tema);
  return [...posts, ...rots, ...cal].filter((x) => x != null).map(String).join("\n");
}
// Decisão (AVAL Sol #898): pacote gravado que cita canal banido ou o número banido NÃO é saneado nem exibido —
// é bloqueado na leitura; os bytes gravados ficam intactos e o assinante ativo pode gerar, sem custo, uma versão
// nova no formato atual (chave nova). Sanear texto de IA trocaria o sentido das mensagens sem revisão humana.
export const packageBlocked = (pkg) => contaminated(displayedText(pkg));
export const BLOQUEIO_TEXTO = "Este pacote foi gerado no formato anterior e cita um canal de contato que a ZEVANORY não usa mais. Por segurança ele não é exibido nem reenviado; a versão gravada fica guardada sem alteração. Você pode gerar, sem custo, uma versão nova no formato atual (roteiros multicanal, cada um com versão curta e versão de e-mail).";
const CAL_LABEL = { post: "Post", roteiro: "Roteiro" };
const calLabel = (tipo) => CAL_LABEL[tipo] || "Roteiro";
export const ROTEIROS_TITULO = `${N_ROTEIROS} ROTEIROS MULTICANAL DE VENDA E ACOMPANHAMENTO`;
export const ROTEIROS_AVISO = `Os roteiros são para canais que seus clientes autorizaram, como ${CANAIS_TEXTO}. Use a reativação só com relacionamento ativo ou consentimento registrado. Você revisa antes de usar; não há disparo automático.`;
export function packageText(pkg, name = "") {
  if (packageBlocked(pkg)) return `Seu pacote Conteúdo Pronto — mês ${pkg?.cycle ?? ""}\n\n${BLOQUEIO_TEXTO}\nPeça a versão nova pelo link privado do pacote ou em suporte@zevanory.api.br.`;
  const lines = [`Seu pacote Conteúdo Pronto — mês ${pkg.cycle}${name ? ` (${name})` : ""}`, "", "CALENDÁRIO DE 30 DIAS"];
  for (const c of pkg.calendario) lines.push(`Dia ${String(c.dia).padStart(2, "0")} · ${calLabel(c.tipo)} · ${c.tema}`);
  lines.push("", `${pkg.posts.length} POSTS`);
  pkg.posts.forEach((p, i) => lines.push("", `POST ${i + 1} — ${p.tema}`, p.legenda, `Chamada: ${p.cta}`, p.hashtags.join(" "), `Imagem sugerida: ${p.imagem || "foto real do seu negócio"}`));
  lines.push("", ROTEIROS_TITULO, ROTEIROS_AVISO);
  roteirosOf(pkg).forEach((r, i) => {
    lines.push("", `ROTEIRO ${i + 1} — ${r.objetivo}`, "Versão curta:", r.curta);
    if (r.email) lines.push("Versão de e-mail:", `Assunto: ${r.email.assunto}`, r.email.corpo);
  });
  lines.push("", "Revise e ajuste o que quiser antes de publicar ou enviar. Fale só com quem autorizou o contato com você.");
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
  // Chave com a versão do schema: uma regeneração nunca sobrescreve um pacote antigo gravado.
  const pkgKey = PKG + key.slice(SUB.length) + ":" + record.cycles + ":v" + CONTENT_SCHEMA_VERSION;
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
  // Mesmo cron: candidatos de regeneração (nova tentativa com a mesma chave; confirmação de entrega pelo email_id).
  const regen = await reconcileRegenCandidates(env, fetchImpl).catch(() => ({ ok: false }));
  return { ok: true, tried: results.length + Number(regen.tried || 0), delivered: results.filter((r) => r.ok).length, regen };
}
// ---------- Regeneração de pacote bloqueado (critério de aceite Sol #898) ----------
// Estados do PACOTE (separados dos estados de ENTREGA):
//   bloqueado — o pacote antigo contaminado: imutável, nunca exibido, nunca reenviado, nunca volta a ser atual;
//   candidato — a versão nova válida, imutável (candidate_key nova, hash SHA-256, protocolo, email_id e estado de
//               entrega próprio); UM candidato ativo por pacote bloqueado + ciclo + versão de schema (chave
//               determinística), reaproveitado em toda tentativa com a MESMA Idempotency-Key;
//   atual     — record.lastPackage. O candidato só vira atual com entrega CONFIRMADA: evento `delivered` obtido
//               do Resend pelo MESMO email_id (reconciliação no cron, reconcileRegenCandidates; o projeto ainda
//               não tem webhook assinado de eventos de envio — o de suporte@ só aceita email.received).
// Entrega: pending -> accepted -> delivered, ou pending/accepted -> dead.
//   pending  : candidato e outbox gravados ANTES de qualquer envio. Falha de rede, tempo esgotado, 429, 5xx, 2xx
//              sem id ou envio não configurado => continua pending (202), cron tenta de novo com a mesma chave.
//   accepted : 2xx + id do Resend. NÃO promove e NÃO registra delivery_sent: 2xx só diz que o envio foi aceito
//              (HTTP 202 ao cliente, como pending: entrega ainda não confirmada).
//   delivered: last_event delivered, ou evento posterior que prova a entrega (opened/clicked/complained)
//              ("email.delivered: Resend handed the email off to the recipient's mail server"). Promove UMA vez
//              (evento duplicado não promove nem notifica de novo).
//   dead     : 4xx permanente (mesma regra de worker/atendimento.mjs, PR #892), last_event bounced/failed/
//              suppressed/canceled, janela de 23 h da Idempotency-Key esgotada em pending ou 72 h sem confirmação
//              em accepted => alerta ao proprietário. Candidato dead nunca vira atual sem uma operação nova
//              registrada (reopenDeadRegenCandidate, com operador e motivo).
// Resend: Idempotency-Key até 256 caracteres, retida 24 h; mesma chave + mesmo payload => resposta original sem
// reenviar; payload diferente => 409 invalid_idempotent_request (https://resend.com/docs/dashboard/emails/idempotency-keys).
// Por isso destinatário, assunto e texto ficam gravados no candidato. Consulta: GET https://api.resend.com/emails/{id}
// devolve last_event (https://resend.com/docs/api-reference/emails/retrieve-email); eventos em
// https://resend.com/docs/dashboard/webhooks/event-types.
// Queda entre o envio e a gravação do estado: a nova tentativa repete chave + payload e o Resend devolve o mesmo id
// sem enviar outro e-mail; queda entre "delivered" e a promoção: a reconciliação seguinte promove (converge).
export const REGEN_SEND_WINDOW_HOURS = 23;
export const REGEN_ACCEPTED_MAX_HOURS = 72;
const REGEN = "zpc:cp:regen:";               // candidato (estado de entrega) por pacote bloqueado + ciclo + schema
const REGEN_OUTBOX = "zpc:cp:regen-outbox";  // candidatos pending/accepted para o cron
const RESEND_URL = "https://api.resend.com/emails";
const DELIVERED_EVENTS = new Set(["delivered", "opened", "clicked", "complained"]);
const DEAD_EVENTS = new Set(["bounced", "failed", "suppressed", "canceled"]);
export const REGEN_MSG = Object.freeze({
  delivered: "Pronto! A entrega da versão nova foi confirmada no seu e-mail.",
  accepted: "A versão nova foi gerada e o provedor aceitou o envio. A entrega ao seu e-mail ainda está sendo confirmada.",
  pending: (p) => `A versão nova foi gerada, mas o envio ainda está pendente. Continuaremos tentando sem gerar outra cópia nem fazer qualquer cobrança. Use o protocolo ${p} para acompanhar pelo suporte.`,
  persist: "Não foi possível registrar a regeneração com segurança agora. A versão antiga continua bloqueada e não foi exibida nem alterada. Tente novamente mais tarde ou escreva para suporte@zevanory.api.br. Nenhuma nova entrega foi confirmada.",
  dead: (p) => `Não foi possível concluir o envio da versão nova. A versão antiga continua bloqueada e não foi exibida nem alterada, e a equipe da ZEVANORY foi avisada. Use o protocolo ${p} para acompanhar pelo suporte.`,
});
const putJson = (kv, k, v) => kv.put(k, JSON.stringify(v), { expirationTtl: 400 * DAY });
export async function regenCandidateKey(key, record) {
  return REGEN + (await sha(key + "|" + record.lastPackage + "|" + record.cycles + "|v" + CONTENT_SCHEMA_VERSION)).slice(0, 40);
}
async function resendIdempotent(env, { to, subject, text, idempotencyKey }, fetchImpl) {
  if (!env.RESEND_API_KEY || !to) return { ok: false, transient: true, reason: "resend_not_configured" };
  try {
    const r = await fetchImpl(RESEND_URL, {
      method: "POST",
      headers: { authorization: "Bearer " + String(env.RESEND_API_KEY), "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify({ from: String(env.RESEND_FROM_ADDRESS || "ZEVANORY <contato@zevanory.api.br>"), to: [to], reply_to: "suporte@zevanory.api.br", subject, text, html: brandedEmailHtml(text) }),
      signal: AbortSignal.timeout(10000),
    });
    let data = null;
    try { data = await r.json(); } catch {}
    if (r.ok && data?.id) return { ok: true, id: String(data.id) };
    if (r.ok) return { ok: false, transient: true, reason: "resend_no_id" };
    // Mesma classificação de worker/atendimento.mjs (#892): 408/429/5xx/rede e 409 concurrent_idempotent_requests
    // (outro pedido com a mesma chave em andamento, ex.: clique duplo) são temporários; 409 de outro nome é permanente.
    return { ok: false, transient: resendFailureIsTransient(r.status, data), reason: "resend_" + r.status };
  } catch { return { ok: false, transient: true, reason: "resend_network" }; }
}
async function resendLastEvent(env, emailId, fetchImpl) {
  if (!env.RESEND_API_KEY || !emailId) return null;
  try {
    const r = await fetchImpl(RESEND_URL + "/" + encodeURIComponent(emailId), { method: "GET", headers: { authorization: "Bearer " + String(env.RESEND_API_KEY) }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const data = await r.json().catch(() => null);
    return data && String(data.id || "") === String(emailId) ? String(data.last_event || "") : null;
  } catch { return null; }
}
async function outboxAdd(kv, candKey) {
  const list = await readJson(kv, REGEN_OUTBOX, []);
  if (!list.includes(candKey)) await kv.put(REGEN_OUTBOX, JSON.stringify([...list, candKey].slice(-500)));
}
async function outboxRemove(kv, candKey) {
  const list = await readJson(kv, REGEN_OUTBOX, []);
  if (list.includes(candKey)) await kv.put(REGEN_OUTBOX, JSON.stringify(list.filter((k) => k !== candKey)));
}
async function markDead(env, kv, candKey, cand, reason, fetchImpl) {
  const dead = { ...cand, delivery: "dead", deadReason: reason, deadAt: new Date().toISOString() };
  await putJson(kv, candKey, dead);
  await outboxRemove(kv, candKey).catch(() => null);
  await ownerAlert(env, "regeneração do Conteúdo Pronto sem entrega", `Protocolo ${cand.protocolo}: o envio da versão nova terminou em dead (${reason}). O pacote antigo continua bloqueado e nada foi promovido. Tratar manualmente; reabrir só com operação registrada (reopenDeadRegenCandidate).`, fetchImpl).catch(() => null);
  return dead;
}
// Uma tentativa de envio de um candidato pending (página ou cron).
async function attemptSend(env, kv, candKey, cand, fetchImpl, now) {
  if (!(now - Date.parse(cand.firstAttemptAt) < REGEN_SEND_WINDOW_HOURS * 3600000)) return markDead(env, kv, candKey, cand, "window_expired", fetchImpl);
  const r = await resendIdempotent(env, { to: cand.to, subject: cand.subject, text: cand.text, idempotencyKey: cand.idempotencyKey }, fetchImpl);
  if (r.ok) {
    const accepted = { ...cand, delivery: "accepted", email_id: r.id, acceptedAt: new Date(now).toISOString(), attempts: Number(cand.attempts || 0) + 1, lastError: null };
    await putJson(kv, candKey, accepted);
    return accepted;
  }
  if (!r.transient) return markDead(env, kv, candKey, { ...cand, attempts: Number(cand.attempts || 0) + 1, lastError: r.reason }, r.reason, fetchImpl);
  const pending = { ...cand, attempts: Number(cand.attempts || 0) + 1, lastError: r.reason };
  await putJson(kv, candKey, pending);
  return pending;
}
// Entrega confirmada pelo MESMO email_id: promove uma única vez; dead nunca promove; duplicado não promove nem notifica.
export async function applyRegenDelivered(env, candKey, emailId, fetchImpl = fetch) {
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  const cand = await readJson(kv, candKey, null);
  if (!cand || !cand.email_id || String(emailId) !== String(cand.email_id)) return { promoted: false, reason: "unknown_email_id" };
  if (cand.delivery === "dead") return { promoted: false, reason: "dead_not_promoted" };
  if (cand.delivery === "delivered" && cand.promotedAt) return { promoted: false, reason: "duplicate" };
  let c = cand;
  if (c.delivery !== "delivered") { c = { ...c, delivery: "delivered", deliveredAt: new Date().toISOString() }; await putJson(kv, candKey, c); }
  const record = await readJson(kv, cand.sub, null);
  const notify = () => emitActivity(env, { type: "delivery_sent", channel: "email", status: "service_package_regenerated", ref: "cp-regen:" + cand.protocolo }).catch(() => null);
  if (record?.lastPackage === cand.candidate_key) {
    // Queda depois da promoção e antes de fechar o candidato: converge sem nova promoção (o ledger deduplica a ref).
    await notify();
    await putJson(kv, candKey, { ...c, promotedAt: record.regeneratedAt || new Date().toISOString() });
    await outboxRemove(kv, candKey);
    return { promoted: false, reason: "already_promoted" };
  }
  if (!record || record.lastPackage !== cand.blockedPackage || record.cycles !== cand.cycle) {
    await putJson(kv, candKey, { ...c, promotedAt: null, superseded: true });
    await outboxRemove(kv, candKey);
    return { promoted: false, reason: "superseded" };
  }
  const stored = await kv.get(cand.candidate_key);
  if (!stored || (await sha(stored)) !== cand.hash) { await markDead(env, kv, candKey, c, "candidate_hash_mismatch", fetchImpl); return { promoted: false, reason: "candidate_hash_mismatch" }; }
  const at = new Date().toISOString();
  await putJson(kv, cand.sub, { ...record, lastPackage: cand.candidate_key, blockedPackage: cand.blockedPackage, regeneratedAt: at, regenProtocolo: cand.protocolo, regenEmailId: cand.email_id });
  await notify();
  await putJson(kv, candKey, { ...c, promotedAt: at });
  await outboxRemove(kv, candKey);
  return { promoted: true, reason: "delivered" };
}
// Reconciliação (cron): pending => nova tentativa com a mesma chave; accepted => consulta pelo email_id.
export async function reconcileRegenCandidates(env, fetchImpl = fetch, { limit = 10, now = Date.now() } = {}) {
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  if (!kv?.get) return { ok: false };
  const out = { ok: true, tried: 0, promoted: 0, accepted: 0, dead: 0, pending: 0 };
  for (const candKey of (await readJson(kv, REGEN_OUTBOX, [])).slice(0, limit)) {
    out.tried++;
    const cand = await readJson(kv, candKey, null);
    if (!cand || cand.delivery === "dead" || cand.promotedAt || cand.superseded) { await outboxRemove(kv, candKey); continue; }
    if (cand.delivery === "pending") { const c = await attemptSend(env, kv, candKey, cand, fetchImpl, now); out[c.delivery === "dead" ? "dead" : c.delivery === "accepted" ? "accepted" : "pending"]++; continue; }
    if (cand.delivery === "delivered") { if ((await applyRegenDelivered(env, candKey, cand.email_id, fetchImpl)).promoted) out.promoted++; continue; }
    const ev = await resendLastEvent(env, cand.email_id, fetchImpl);
    if (ev && DELIVERED_EVENTS.has(ev)) { if ((await applyRegenDelivered(env, candKey, cand.email_id, fetchImpl)).promoted) out.promoted++; }
    else if (ev && DEAD_EVENTS.has(ev)) { await markDead(env, kv, candKey, cand, "resend_" + ev, fetchImpl); out.dead++; }
    else if (!(now - Date.parse(cand.acceptedAt) < REGEN_ACCEPTED_MAX_HOURS * 3600000)) { await markDead(env, kv, candKey, cand, "delivery_unconfirmed", fetchImpl); out.dead++; }
    else out.accepted++;
  }
  return out;
}
// Operação explícita e registrada para reabrir um candidato dead (nova Idempotency-Key, mesmo pacote imutável).
export async function reopenDeadRegenCandidate(env, candKey, { operator, reason, now = Date.now() } = {}) {
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  const cand = await readJson(kv, candKey, null);
  if (!cand || cand.delivery !== "dead") return { ok: false, reason: "not_dead" };
  if (!String(operator || "").trim() || !String(reason || "").trim()) return { ok: false, reason: "operation_must_be_recorded" };
  const operations = [...(cand.operations || []), { at: new Date(now).toISOString(), op: "reopen", operator: String(operator).slice(0, 80), reason: String(reason).slice(0, 300), previous: { idempotencyKey: cand.idempotencyKey, email_id: cand.email_id || null, deadReason: cand.deadReason } }];
  const reopened = { ...cand, delivery: "pending", email_id: null, deadReason: null, idempotencyKey: cand.baseIdempotencyKey + "/op" + operations.length, firstAttemptAt: new Date(now).toISOString(), attempts: 0, operations };
  await putJson(kv, candKey, reopened);
  await outboxAdd(kv, candKey);
  return { ok: true, idempotencyKey: reopened.idempotencyKey };
}
// Pedido do cliente (POST da página): cria ou reaproveita o candidato e faz UMA tentativa de envio.
export async function regenerateBlockedPackage(env, key, fetchImpl = fetch, { now = Date.now() } = {}) {
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  const record = await readJson(kv, key, null);
  if (!record || record.status !== "active" || !record.briefing) return { ok: false, reason: "not_eligible" };
  const current = record.lastPackage ? await readJson(kv, record.lastPackage, null) : null;
  if (!current || !packageBlocked(current)) return { ok: true, reason: "not_blocked" };
  const candKey = await regenCandidateKey(key, record);
  let cand = await readJson(kv, candKey, null);
  if (!cand) {
    const h = candKey.slice(REGEN.length);
    const candidate_key = PKG + key.slice(SUB.length) + ":" + record.cycles + ":v" + CONTENT_SCHEMA_VERSION + ":c" + h.slice(0, 12);
    let stored = await kv.get(candidate_key);
    if (!stored) {
      const pkg = await generatePackage(env, record.briefing, record.cycles);
      if (!pkg || packageBlocked(pkg)) {
        await ownerAlert(env, "regeneração do Conteúdo Pronto adiada", "A IA não gerou um pacote válido para substituir um pacote antigo bloqueado; o assinante pode tentar de novo.", fetchImpl);
        return { ok: false, reason: "generation_failed" };
      }
      stored = JSON.stringify(pkg);
    }
    const protocolo = "CPR-" + h.slice(0, 10).toUpperCase();
    const baseIdempotencyKey = "cp-regen/" + h;
    try {
      const token = rand();
      const text = packageText(JSON.parse(stored), record.briefing.negocio) + `\n\nProtocolo: ${protocolo}\nVersão para consulta online (fica disponível assim que a entrega for confirmada): ${ORIGIN}/conteudo-pronto/pacote?t=${token}\n\nDúvidas ou ajustes: responda este e-mail ou escreva para suporte@zevanory.api.br.`;
      if (!(await kv.get(candidate_key))) await kv.put(candidate_key, stored, { expirationTtl: 400 * DAY });
      await kv.put(TOKEN + token, key, { expirationTtl: 120 * DAY });
      cand = { schema: "zpc.cp.regen.v1", sub: key, blockedPackage: record.lastPackage, cycle: record.cycles, content_schema_version: CONTENT_SCHEMA_VERSION,
        candidate_key, hash: await sha(stored), protocolo, baseIdempotencyKey, idempotencyKey: baseIdempotencyKey, email_id: null, delivery: "pending",
        to: record.email, subject: `Seu Conteúdo Pronto do mês ${record.cycles} — nova versão (protocolo ${protocolo})`, text,
        firstAttemptAt: new Date(now).toISOString(), attempts: 0, operations: [] };
      await putJson(kv, candKey, cand);
      await outboxAdd(kv, candKey);
    } catch { return { ok: false, reason: "persist_failed" }; }
  } else if (cand.delivery === "pending" || cand.delivery === "accepted") {
    try { await outboxAdd(kv, candKey); } catch { return { ok: false, reason: "persist_failed" }; }
  }
  if (cand.delivery === "delivered" && !cand.promotedAt) {
    await applyRegenDelivered(env, candKey, cand.email_id, fetchImpl); // converge uma promoção interrompida
  }
  if (cand.delivery === "pending") {
    try { cand = await attemptSend(env, kv, candKey, cand, fetchImpl, now); }
    catch { return { ok: false, reason: "persist_failed" }; }
  }
  return { ok: cand.delivery !== "dead", reason: cand.delivery, protocolo: cand.protocolo };
}
// Mensagem e status HTTP de cada estado: o 2xx do envio nunca vira afirmação de entrega (teste g7).
export function regenResponse(out) {
  if (out.reason === "delivered") return [200, REGEN_MSG.delivered];
  if (out.reason === "accepted") return [202, REGEN_MSG.accepted]; // aceito pelo provedor, entrega ainda não confirmada
  if (out.reason === "pending") return [202, REGEN_MSG.pending(out.protocolo)];
  if (out.reason === "dead") return [409, REGEN_MSG.dead(out.protocolo)];
  if (out.reason === "persist_failed") return [503, REGEN_MSG.persist];
  return [503, "Não foi possível gerar a versão nova agora. A versão antiga continua bloqueada e não foi exibida nem alterada. Tente novamente mais tarde ou escreva para suporte@zevanory.api.br."];
}
export async function handlePackageView(request, env, ctx, fetchImpl = fetch) {
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  const token = new URL(request.url).searchParams.get("t") || "";
  const found = kv?.get ? await resolveToken(kv, token) : null;
  const pkg = found?.record?.lastPackage ? await readJson(kv, found.record.lastPackage, null) : null;
  if (!pkg) return page("Pacote não encontrado", "<h1>Pacote não encontrado ou link expirado.</h1>", 404);
  const eligible = found.record.status === "active" && Boolean(found.record.briefing);
  if (request.method === "POST") {
    if (!packageBlocked(pkg)) return page("Pacote atualizado", found.record.regenProtocolo ? `<h1>${esc(REGEN_MSG.delivered)}</h1>` : "<h1>Este pacote já está no formato atual.</h1>");
    if (!eligible) return page("Versão nova", `<h1>Versão nova sem custo</h1><p>${esc(BLOQUEIO_TEXTO)}</p><p>Peça em suporte@zevanory.api.br.</p>`, 409);
    const [status, msg] = regenResponse(await regenerateBlockedPackage(env, found.key, fetchImpl));
    return page("Versão nova", `<h1>Conteúdo Pronto · versão nova</h1><p>${esc(msg)}</p>`, status);
  }
  if (request.method !== "GET" && request.method !== "HEAD") return page("Método inválido", "<h1>Método inválido.</h1>", 405);
  if (packageBlocked(pkg)) {
    const cand = eligible ? await readJson(kv, await regenCandidateKey(found.key, found.record), null) : null;
    const button = `<form method="post" action="?t=${esc(token)}"><input type="hidden" name="acao" value="regenerar"><button type="submit">Gerar versão nova sem custo</button></form>`;
    const offer = !eligible ? "<p>Para receber a versão nova sem custo, escreva para suporte@zevanory.api.br.</p>"
      : !cand ? button
      : `<p>${esc(regenResponse({ reason: cand.delivery, protocolo: cand.protocolo })[1])}</p>${cand.delivery === "pending" ? button : ""}`;
    return page("Pacote no formato anterior", `<h1>Conteúdo Pronto · mês ${esc(pkg.cycle)}</h1><p>${esc(BLOQUEIO_TEXTO)}</p>${offer}`);
  }
  const posts = pkg.posts.map((p, i) => `<article><h2>Post ${i + 1} — ${esc(p.tema)}</h2><p style="white-space:pre-wrap">${esc(p.legenda)}</p><p><b>Chamada:</b> ${esc(p.cta)}</p><p>${esc(p.hashtags.join(" "))}</p><small>Imagem sugerida: ${esc(p.imagem)}</small></article>`).join("");
  const rots = roteirosOf(pkg).map((r, i) => `<article><h2>Roteiro ${i + 1} — ${esc(r.objetivo)}</h2><h3>Versão curta</h3><p style="white-space:pre-wrap">${esc(r.curta)}</p>${r.email ? `<h3>Versão de e-mail</h3><p><b>Assunto:</b> ${esc(r.email.assunto)}</p><p style="white-space:pre-wrap">${esc(r.email.corpo)}</p>` : ""}</article>`).join("");
  const cal = pkg.calendario.map((c) => `<li>Dia ${c.dia} · ${calLabel(c.tipo)} · ${esc(c.tema)}</li>`).join("");
  return page("Seu pacote", `<h1>Conteúdo Pronto · mês ${pkg.cycle}</h1><h2>Calendário</h2><ul>${cal}</ul><h2>${pkg.posts.length} posts</h2>${posts}<h2>${esc(ROTEIROS_TITULO.charAt(0) + ROTEIROS_TITULO.slice(1).toLowerCase())}</h2><p>${esc(ROTEIROS_AVISO)}</p>${rots}`);
}
