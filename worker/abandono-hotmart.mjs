// ZEVANORY | Lembrete ÚNICO de compra não concluída na Hotmart (PURCHASE_OUT_OF_SHOPPING_CART), legítimo interesse.
// Plano: e-mail de abandono, Revisão 5b (seções 2 e 3), PR-2. Entra DESLIGADO (ABANDONO_STAGE = "desligado").
//
// Estágios (cada troca é um PR com rótulo do proprietário; nunca por variável de ambiente):
//   desligado   nada é gravado (nem KV nem D1, inclusive o gancho de compra), nada é enviado e o SELF não é chamado.
//               A ingestão só autentica, roda a sonda de formato (6 booleanos) e responde 200 "disabled".
//   aquecimento grava o marcador de compra (abandono_compra_v1); abandono não vira pendência; retenção diária roda.
//   ativo       cria pendência, envia 1 lembrete por pessoa a cada 30 dias (teto de 20 por dia), retenção diária.
//
// Armazenamento: pendência com o e-mail em claro só no KV (abandono:v1:pend:<ref>, TTL 72 h); estado, reserva atômica,
// marcador de compra e supressão no D1 DIARIO (migrations/d1/0003_abandono_v1.sql), só com pseudônimos HMAC.
//
// D1 só no PRIMÁRIO: o binding é usado direto (env.DIARIO.prepare), NUNCA com a API de sessões (withSession) nem read
// replicas. Sem sessões, o D1 encaminha toda consulta ao banco primário. Além disso, as decisões que impedem o envio
// não dependem de leitura separada: a reserva é UMA instrução (INSERT ... SELECT ... WHERE NOT EXISTS(compra)
// AND NOT EXISTS(supressão) AND count(dia) < teto ON CONFLICT DO NOTHING), avaliada no primário no instante da
// gravação; o gancho de compra é aguardado e grava no primário antes de a resposta voltar à Hotmart.
//
// Fail-closed: todo acesso ao D1 passa por d1(), que captura QUALQUER falha (binding ausente, tabela ausente, exceção
// de prepare/first/run, resultado sem meta) e devolve {unavailable:true}. O texto do erro nunca é logado.
// Logs: só códigos e contadores. Nenhum e-mail, ref, hottok, token, nome, ID de produto ou corpo.
import { productBySlug } from "./product-prices.mjs";
import { purchaseOpenFor, hotmartLockViolations } from "./sales-lock-content.mjs";
import { currentBudgetPct, SHED_AT_PCT } from "./kv-meter.mjs";
import { brandedEmailHtml } from "./brand-email.mjs";
import { LEGAL_IDENTITY } from "./politica-unica.mjs";
import { verifyOperatorToken } from "./operator-credential.mjs";
import ALLOW from "../data/p18-commercial-allowlist.json" with { type: "json" };

export const ABANDONO_STAGE = "desligado"; // "desligado" | "aquecimento" | "ativo"; cada troca = PR com rótulo
export const ABANDONO_STAGES = Object.freeze(["desligado", "aquecimento", "ativo"]);
export const ABANDONO_DAILY_CAP = 20;
export const RETRY_WINDOW_MS = 23 * 3600_000; // < 24 h da Idempotency-Key do Resend
export const RECONCILE_MAX = 3;
export const RECONCILE_MAX_PAGES = 10; // páginas de GET /emails por reconciliação (limite de subrequisições)
export const RECONCILE_MAX_CANDIDATES = 5; // GET /emails/{id} por reconciliação
export const LEASE_MS = 30 * 60_000;
export const DEDUPE_MS = 30 * 86400_000;
export const PEND_TTL_S = 72 * 3600;
export const DUE_DELAY_MS = 60 * 60_000;
export const STALE_MS = 24 * 3600_000;
export const MAX_PER_RUN = 5;
export const DRAIN_PATH = "/api/internal/abandono/drain";
export const RETENTION_PATH = "/api/internal/abandono/retencao";
export const OPTOUT_PATH = "/abandono/sair";
export const MANUAL_SUPPRESSION_PATH = "/api/internal/abandono/supressao";
export const PEND_PREFIX = "abandono:v1:pend:";
export const SUPKV_PREFIX = "abandono:v1:supkv:";
export const RETENTION_FAIL_KEY = "abandono:v1:retencao:falhas";
export const RESEND_TAG = Object.freeze({ name: "flow", value: "hotmart_abandono" });
export const PURCHASE_HOOK_EVENTS = Object.freeze(["PURCHASE_APPROVED", "PURCHASE_COMPLETE", "PURCHASE_BILLET_PRINTED", "PURCHASE_DELAYED"]);
const RESEND_EMAILS = "https://api.resend.com/emails";
const CORE = "https://zevanory.api.br";
const SALES = "https://vendas.zevanory.api.br";
const SUPPORT = "suporte@zevanory.api.br";

// ID Hotmart -> slug: só os 5 kits (kind "kit") da lista fechada P18. Conteúdo Pronto e Gestão ficam fora.
export const KIT_BY_PRODUCT_ID = Object.freeze(Object.fromEntries(
  ALLOW.products.filter((p) => p.kind === "kit" && /^[0-9]{6,12}$/.test(String(p.hotmart_product_id))).map((p) => [String(p.hotmart_product_id), p.slug])));

const te = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
const stageOf = (opts) => (ABANDONO_STAGES.includes(opts?.stage) ? opts.stage : ABANDONO_STAGE);
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const REF_RE = /^[0-9a-f]{64}$/;
const T_RE = /^[0-9a-f]{32}$/;
const RESEND_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

async function sha256(value) { return new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(String(value)))); }
export async function sha256Hex(value) { return hex(await sha256(value)); }
async function hmacHex(key, value) {
  const k = await crypto.subtle.importKey("raw", te.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, te.encode(String(value))));
}
// Tempo constante sobre DIGESTS de tamanho fixo (32 bytes): o tamanho do valor recebido nunca encurta a comparação.
function bytesEqual(a, b) {
  const subtle = globalThis.crypto?.subtle;
  if (typeof subtle?.timingSafeEqual === "function") return subtle.timingSafeEqual(a, b) === true;
  if (a.length !== b.length) return false;
  let v = 0;
  for (let i = 0; i < a.length; i++) v |= a[i] ^ b[i];
  return v === 0;
}
export async function constantTimeEqual(given, expected) {
  const [a, b] = await Promise.all([sha256(String(given ?? "")), sha256(String(expected ?? ""))]);
  return bytesEqual(a, b) && String(expected ?? "").length > 0;
}

function credentials(env) {
  let cfg = {};
  try { cfg = typeof env?.CHANNEL_CREDENTIALS_JSON === "string" ? JSON.parse(env.CHANNEL_CREDENTIALS_JSON) : env?.CHANNEL_CREDENTIALS_JSON || {}; } catch {}
  return cfg && typeof cfg === "object" ? cfg : {};
}
const hottokOf = (env) => String(env?.HOTMART_HOTTOK || credentials(env).HOTMART_HOTTOK || "").trim();
const privacySecret = (env) => { const s = String(env?.LEAD_PRIVACY_SECRET || ""); return s.length >= 32 ? s : ""; };
const keyRef = (s) => "zevanory-abandono-v1:" + s;
const keyDrain = (s) => "zevanory-abandono-drain-v1:" + s;
const keyRetention = (s) => "zevanory-abandono-retencao-v1:" + s;

export const normalizeEmail = (email) => String(email ?? "").trim().toLowerCase();
const EMAIL_RE = /^[^\s@<>()",;:\\[\]]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/;
export const validEmail = (email) => { const e = normalizeEmail(email); return e.length <= 254 && EMAIL_RE.test(e); };
export async function abandonoRef(env, email) {
  const s = privacySecret(env);
  return s ? hmacHex(keyRef(s), "abandono:v1:" + normalizeEmail(email)) : null;
}
export async function optOutToken(env, ref) {
  const s = privacySecret(env);
  return s ? (await hmacHex(keyRef(s), "abandono:v1:optout:" + ref)).slice(0, 32) : null;
}
export async function optOutUrl(env, ref) {
  const t = await optOutToken(env, ref);
  return t ? `${CORE}${OPTOUT_PATH}?r=${ref}&t=${t}` : null;
}

// ---------------------------------------------------------------------------------------------------------
// D1 fail-closed. Toda chamada ao D1 passa por aqui. Sem withSession: consultas vão para o primário.
export async function d1(env, fn) {
  const db = env?.DIARIO;
  if (!db || typeof db.prepare !== "function") return { unavailable: true };
  try { return { ok: true, value: await fn(db) }; } catch { return { unavailable: true }; }
}
// Resultado de run() sem meta.changes inteiro = falha do D1 (lança dentro de d1()).
function changesOf(res) {
  const c = res?.meta?.changes;
  if (!Number.isInteger(c)) throw new Error("d1_sem_meta");
  return c;
}
const run = async (db, sql, ...params) => changesOf(await db.prepare(sql).bind(...params).run());
const first = async (db, sql, ...params) => { const r = await db.prepare(sql).bind(...params).first(); return r ?? null; };
const allRows = async (db, sql, ...params) => { const r = await db.prepare(sql).bind(...params).all(); if (!Array.isArray(r?.results)) throw new Error("d1_sem_results"); return r.results; };

const SQL_RESERVA = `INSERT INTO abandono_envio_v1 (ref,slug,dia,estado,criado_ms,lease_ms,tentativas,body_sha)
SELECT ?1,?2,?3,'reservado',?4,?4,1,?5
WHERE NOT EXISTS (SELECT 1 FROM abandono_compra_v1 WHERE ref=?1 AND criado_ms > ?6)
  AND NOT EXISTS (SELECT 1 FROM abandono_supressao_v1 WHERE ref=?1)
  AND (SELECT count(*) FROM abandono_envio_v1 WHERE dia=?3) < ?7
ON CONFLICT(ref) DO NOTHING`;
const SQL_RETOMADA = `UPDATE abandono_envio_v1 SET lease_ms=?2, tentativas=tentativas+1
WHERE ref=?1 AND estado='reservado' AND lease_ms < ?2-${LEASE_MS} AND criado_ms > ?2-${RETRY_WINDOW_MS} AND tentativas < 3
  AND NOT EXISTS (SELECT 1 FROM abandono_compra_v1 WHERE ref=?1 AND criado_ms > ?3)
  AND NOT EXISTS (SELECT 1 FROM abandono_supressao_v1 WHERE ref=?1)`;
const SQL_ESTADO = `SELECT e.estado AS estado, e.criado_ms AS criado_ms, e.lease_ms AS lease_ms, e.tentativas AS tentativas, e.body_sha AS body_sha,
  (SELECT 1 FROM abandono_compra_v1 WHERE ref=?1 AND criado_ms > ?2) AS compra,
  (SELECT 1 FROM abandono_supressao_v1 WHERE ref=?1) AS sup,
  (SELECT count(*) FROM abandono_envio_v1 WHERE dia=?3) AS hoje
FROM (SELECT 1) AS x LEFT JOIN abandono_envio_v1 AS e ON e.ref=?1`;
const SQL_SUPRIME = "INSERT OR IGNORE INTO abandono_supressao_v1 (ref, criado_ms) VALUES (?1, ?2)";
// Reserva atômica (instrução única no primário): {unavailable} | {value: meta.changes}. changes 1 = dona do envio.
export async function reserveSend(env, { ref, slug, now, bodySha }) {
  return d1(env, (db) => run(db, SQL_RESERVA, ref, slug, dayOf(now), now, bodySha, now - DEDUPE_MS, ABANDONO_DAILY_CAP));
}

// ---------------------------------------------------------------------------------------------------------
// Texto do e-mail (seção 3). Nome e preço SÓ de productBySlug (fonte única, data/products.json).
// Frases fixas que citam a Hotmart como ORIGEM do dado (transparência, art. 9º): são mascaradas por igualdade EXATA
// antes do filtro hotmartLockViolations (mesmo mecanismo das frases oficiais de worker/politica-unica.mjs). Qualquer
// outra menção à Hotmart, outro preço, outro kit, /comprar ou pay.hotmart continua barrado.
const fixedSentences = (name) => [
  `no checkout da Hotmart, mas o pedido não foi concluído.`,
  `Por que você recebeu este e-mail: seu endereço foi informado no checkout da Hotmart ao iniciar a compra do ${name}.`,
];
export const abandonmentSubject = (name) => `Sua compra do ${name} não foi concluída`;
export const productLink = (slug) => `${SALES}/hotmart/${slug}?utm_source=email-abandono`;
export function abandonmentEmail(slug, { optOutUrl: unsubscribe } = {}) {
  const p = productBySlug(slug);
  const [s2, s3] = fixedSentences(p.name);
  const text = [
    "Olá!",
    "",
    `Você começou a compra do ${p.name} (R$ ${p.price}, pagamento único) ${s2}`,
    "",
    "Se aconteceu algum problema no pagamento ou ficou alguma dúvida, é só responder a este e-mail que a gente ajuda.",
    "",
    "Se ainda quiser o material, a página do produto e o checkout oficial estão aqui:",
    productLink(p.slug),
    "",
    "Se não quiser mais, ignore esta mensagem. Este é o único lembrete sobre este pedido.",
    "",
    "Equipe ZEVANORY",
    SUPPORT,
    "",
    "—",
    `${s3} Enviamos um único lembrete com base no legítimo interesse (LGPD, art. 7º, IX). Seu e-mail é apagado da nossa base logo após este envio. Por até 30 dias guardamos só um código derivado do e-mail com chave secreta, para não lhe escrever de novo. O envio é feito pelo nosso operador de e-mail (Resend), conforme a nossa política de privacidade.`,
    `Não quer receber lembretes da ZEVANORY? Clique aqui (1 clique): ${unsubscribe || ""}`,
    "",
    LEGAL_IDENTITY,
    `Privacidade: ${SALES}/privacidade`,
  ].join("\n");
  const subject = abandonmentSubject(p.name);
  return { slug: p.slug, name: p.name, price: p.price, subject, text, html: brandedEmailHtml(text, { unsubscribeUrl: unsubscribe }) };
}
export function abandonmentLockViolations(mail) {
  const masked = fixedSentences(mail.name).reduce((t, s) => t.split(s).join(" "), String(mail.text || ""));
  const out = new Set([...hotmartLockViolations(masked, mail.slug), ...hotmartLockViolations(mail.subject, mail.slug)]);
  return [...out];
}

// Corpo EXATO enviado ao Resend: o body_sha é calculado sobre esta string, e a retomada só reenvia se for idêntica.
export function resendBody(env, { email, ref, mail, unsubscribe }) {
  return JSON.stringify({
    from: String(env?.RESEND_FROM_ADDRESS || "ZEVANORY <contato@zevanory.api.br>"),
    to: [email],
    reply_to: SUPPORT,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    headers: { "List-Unsubscribe": `<${unsubscribe}>, <mailto:${SUPPORT}?subject=descadastrar>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    tags: [{ ...RESEND_TAG }, { name: "abandono_ref", value: ref.slice(0, 40) }],
  });
}
export const idempotencyKey = (ref) => "zevanory-abandono-" + ref.slice(0, 40);

// ---------------------------------------------------------------------------------------------------------
// Ingestão (POST /api/webhooks/hotmart com event PURCHASE_OUT_OF_SHOPPING_CART). Ordem exata do plano, seção 2.3.
export async function handleHotmartAbandonment(request, env, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const stage = stageOf(opts);
  if (request.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });
  const secret = hottokOf(env);
  if (secret.length < 16) return json(503, { ok: false, error: "hotmart_not_configured" });
  const given = request.headers.get("x-hotmart-hottok");
  if (!given || !(await constantTimeEqual(given, secret))) return json(401, { ok: false, error: "unauthorized" });
  let body;
  try { body = await request.json(); } catch { return json(400, { ok: false, error: "invalid_json" }); }
  const data = body && typeof body === "object" ? body.data || {} : {};
  const productId = String(data?.product?.id ?? "");
  const slug = Object.prototype.hasOwnProperty.call(KIT_BY_PRODUCT_ID, productId) ? KIT_BY_PRODUCT_ID[productId] : null;
  const iso = data?.checkout_country?.iso;
  const shape = {
    version_ok: body?.version === "2.0.0",
    event_ok: String(body?.event || "") === "PURCHASE_OUT_OF_SHOPPING_CART",
    has_country_iso: typeof iso === "string" && iso.trim().length > 0,
    has_email: validEmail(data?.buyer?.email),
    has_offer: typeof data?.offer?.code === "string" && data.offer.code.trim().length > 0,
    product_allowed: slug !== null,
  };
  // Sonda de formato (NC-7): depois do hottok, antes de version/event; só os 6 booleanos; não grava nada.
  console.info("abandono_shape", JSON.stringify(shape));
  if (!shape.version_ok || !shape.event_ok) return json(422, { ok: false, error: "invalid_hotmart_event" });
  const done = (code, status = 200) => { console.info("abandono_ingest", code); return json(status, { ok: status < 300, code }); };
  if (stage === "desligado") return done("disabled");
  if (stage === "aquecimento") return done("aquecimento");
  if (!slug) return done("product_not_allowed");
  if ((await purchaseOpenFor(env, slug)) !== true) return done("sales_closed");
  if (!shape.has_email) return done("no_email");
  if (shape.has_country_iso && iso.trim().toUpperCase() !== "BR") return done("non_br");
  const kv = env?.ZEVANORY_PRIVATE_ARTIFACTS;
  if (!kv?.get || !kv?.put) return done("kv_unavailable");
  let pct = null;
  try { pct = await currentBudgetPct(kv, now, { at: 0, pct: null }); } catch { pct = 100; }
  if (pct != null && pct >= SHED_AT_PCT) return done("kv_budget");
  if (!privacySecret(env)) return done("privacy_not_configured", 503);
  if (!env?.DIARIO) return done("d1_unavailable");
  const email = normalizeEmail(data.buyer.email);
  const ref = await abandonoRef(env, email);
  // Primeiro ponto de consulta do marcador de compra (no primário; sem sessão/réplica).
  const check = await d1(env, (db) => first(db, `SELECT (SELECT 1 FROM abandono_supressao_v1 WHERE ref=?1) AS sup,
  (SELECT 1 FROM abandono_compra_v1 WHERE ref=?1 AND criado_ms > ?2) AS compra,
  (SELECT 1 FROM abandono_envio_v1 WHERE ref=?1) AS envio`, ref, now - DEDUPE_MS));
  if (check.unavailable || !check.value) return done("d1_unavailable");
  if (check.value.sup) return done("suppressed");
  if (check.value.compra) return done("buyer");
  if (check.value.envio) return done("dedupe");
  try {
    if (await kv.get(SUPKV_PREFIX + ref)) return done("suppressed");
    if (await kv.get(PEND_PREFIX + ref)) return done("dedupe");
  } catch { return done("kv_failed"); }
  const pend = { email, product_id: productId, slug, received_at: now, due_at: now + DUE_DELAY_MS };
  try { await kv.put(PEND_PREFIX + ref, JSON.stringify(pend), { expirationTtl: PEND_TTL_S }); } catch { return done("kv_failed"); }
  return done("queued", 202);
}

// ---------------------------------------------------------------------------------------------------------
// Marcador de compra (gancho AGUARDADO no roteamento, depois de o nc012 responder ok). desligado = sem leitura nem
// gravação. Qualquer kit bloqueia o lembrete de qualquer kit (a chave é só o e-mail).
export async function noteHotmartPurchase(env, data, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  if (stageOf(opts) === "desligado") return { skipped: "disabled" };
  const productId = String(data?.product?.id ?? "");
  if (!Object.prototype.hasOwnProperty.call(KIT_BY_PRODUCT_ID, productId)) return { skipped: "product_not_allowed" };
  if (!validEmail(data?.buyer?.email)) return { skipped: "no_email" };
  if (!privacySecret(env)) return { skipped: "privacy_not_configured" };
  const ref = await abandonoRef(env, data.buyer.email);
  const wrote = await d1(env, (db) => run(db, "INSERT INTO abandono_compra_v1 (ref, criado_ms) VALUES (?1, ?2) ON CONFLICT(ref) DO UPDATE SET criado_ms=excluded.criado_ms", ref, now));
  if (wrote.unavailable) return { skipped: "d1_unavailable" };
  const kv = env?.ZEVANORY_PRIVATE_ARTIFACTS;
  try { if (kv?.get && (await kv.get(PEND_PREFIX + ref))) await kv.delete(PEND_PREFIX + ref); } catch {}
  return { recorded: true };
}

// ---------------------------------------------------------------------------------------------------------
// Supressão de reserva (supkv:) -> D1. Insere ANTES de apagar a chave do KV. Devolve {fused, pending:Set(ref)}.
async function fuseSupkv(env, kv) {
  const pending = new Set();
  let fused = 0;
  let listed;
  try { listed = await kv.list({ prefix: SUPKV_PREFIX, limit: 100 }); } catch { return { fused, pending, failed: true }; }
  for (const k of listed?.keys || []) {
    const name = String(k?.name || ""), ref = name.slice(SUPKV_PREFIX.length);
    if (!REF_RE.test(ref)) continue;
    let at = Date.now();
    try { at = Number(JSON.parse(String((await kv.get(name)) || "null"))?.at) || at; } catch {}
    const ins = await d1(env, (db) => run(db, SQL_SUPRIME, ref, at));
    if (ins.unavailable) { pending.add(ref); continue; }
    try { await kv.delete(name); fused++; } catch { /* já está no D1; a chave sai na próxima fusão */ fused++; }
  }
  return { fused, pending, failed: false };
}

// ---------------------------------------------------------------------------------------------------------
// Resend
async function postResend(env, fetchImpl, { body, ref }) {
  try {
    const r = await fetchImpl(RESEND_EMAILS, {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json", "Idempotency-Key": idempotencyKey(ref) },
      body,
      signal: AbortSignal.timeout(10000),
    });
    let payload = null;
    try { payload = await r.json(); } catch {}
    if (r.status === 200 && typeof payload?.id === "string" && RESEND_ID_RE.test(payload.id)) return { kind: "sent", id: payload.id };
    if (r.status === 409 && (payload?.name === "invalid_idempotent_request" || payload?.name === "concurrent_idempotent_requests")) return { kind: "reconcile" };
    if (r.status === 429) return { kind: "rate_limited" };
    return { kind: "error" };
  } catch { return { kind: "error" }; }
}

async function getJson(env, fetchImpl, url) {
  try {
    const r = await fetchImpl(url, { method: "GET", headers: { authorization: `Bearer ${env.RESEND_API_KEY}` }, signal: AbortSignal.timeout(10000) });
    if (r.status !== 200) return null;
    const v = await r.json();
    return v && typeof v === "object" ? v : null;
  } catch { return null; }
}
const toList = (to) => (Array.isArray(to) ? to : typeof to === "string" ? [to] : []).map(normalizeEmail);

// Reconciliação verificável (condição (a) do GPT-6): percorre as páginas de GET /emails (mais recentes primeiro,
// cursor "after") até passar do início da janela ou acabar a lista; filtra por subject e janela ANTES de olhar o
// "to"; confirma CADA candidato por GET /emails/{id} (tag flow, tag abandono_ref, subject e to). Resultado:
//   {found:id}       exatamente 1 confirmação, consulta completa
//   {not_found:true} consulta completa e nenhum candidato confirmado
//   {incomplete}     erro HTTP, JSON inválido, has_more ausente, data inválida, cursor ausente, limite de páginas
//                    ou de candidatos, candidato sem confirmação legível
//   {ambiguous}      mais de 1 confirmação
// Só {found} pode virar "enviado".
export async function reconcileLookup(env, fetchImpl, { ref, email, subject, criadoMs }) {
  const start = criadoMs - 60_000, end = criadoMs + 24 * 3600_000, target = normalizeEmail(email);
  const candidates = [];
  let after = null, complete = false;
  for (let page = 0; page < RECONCILE_MAX_PAGES && !complete; page++) {
    const listed = await getJson(env, fetchImpl, `${RESEND_EMAILS}?limit=100${after ? "&after=" + encodeURIComponent(after) : ""}`);
    if (!listed || !Array.isArray(listed.data) || typeof listed.has_more !== "boolean") return { incomplete: "list" };
    let oldest = Infinity;
    for (const item of listed.data) {
      const created = Date.parse(String(item?.created_at ?? ""));
      if (Number.isFinite(created)) oldest = Math.min(oldest, created);
      if (item?.subject !== subject) continue;
      if (!Number.isFinite(created)) return { incomplete: "date" };
      if (created < start || created > end) continue;
      if (toList(item?.to).includes(target)) {
        const id = String(item?.id ?? "");
        if (!RESEND_ID_RE.test(id)) return { incomplete: "id" };
        if (!candidates.includes(id)) candidates.push(id);
      }
    }
    if (!listed.has_more || !listed.data.length || oldest < start) { complete = true; break; }
    const last = listed.data[listed.data.length - 1];
    after = typeof last?.id === "string" && RESEND_ID_RE.test(last.id) ? last.id : null;
    if (!after) return { incomplete: "cursor" };
  }
  if (!complete) return { incomplete: "pages" };
  if (candidates.length > RECONCILE_MAX_CANDIDATES) return { incomplete: "candidates" };
  const confirmed = [];
  for (const id of candidates) {
    const item = await getJson(env, fetchImpl, `${RESEND_EMAILS}/${encodeURIComponent(id)}`);
    if (!item || item.id !== id || !Array.isArray(item.tags)) return { incomplete: "retrieve" };
    const tag = (n) => item.tags.find((t) => t?.name === n)?.value;
    if (tag(RESEND_TAG.name) === RESEND_TAG.value && tag("abandono_ref") === ref.slice(0, 40) && item.subject === subject && toList(item.to).includes(target)) confirmed.push(id);
  }
  if (confirmed.length > 1) return { ambiguous: confirmed.length };
  if (confirmed.length === 1) return { found: confirmed[0] };
  return { not_found: true };
}

// ---------------------------------------------------------------------------------------------------------
// Dreno (só em "ativo"; roda dentro da rota isolada /api/internal/abandono/drain).
export async function runAbandonmentDue(env, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const fetchImpl = typeof opts.fetchImpl === "function" ? opts.fetchImpl : globalThis.fetch;
  const max = Number.isInteger(opts.max) && opts.max > 0 ? Math.min(opts.max, MAX_PER_RUN) : MAX_PER_RUN;
  const beat = { due: 0, sent: 0, retry: 0, reconcile: 0, nao_confirmado: 0, canceled: 0, cap_left: null };
  if (stageOf(opts) !== "ativo") return { ok: true, skipped: "disabled", ...beat };
  const kv = env?.ZEVANORY_PRIVATE_ARTIFACTS;
  if (!env?.DIARIO) return { ok: false, skipped: "d1_unavailable", ...beat };
  if (!kv?.get || !kv?.put || !kv?.list || !kv?.delete) return { ok: false, skipped: "kv_unavailable", ...beat };
  if (!privacySecret(env) || !env?.RESEND_API_KEY) return { ok: false, skipped: "not_configured", ...beat };
  const probe = await d1(env, (db) => first(db, "SELECT count(*) AS hoje FROM abandono_envio_v1 WHERE dia=?1", dayOf(now)));
  if (probe.unavailable || !probe.value) return { ok: false, skipped: "d1_unavailable", ...beat };
  const fusion = await fuseSupkv(env, kv);
  const since = now - DEDUPE_MS, dia = dayOf(now);
  let stop = false, processed = 0;
  const dropPend = async (ref) => { try { await kv.delete(PEND_PREFIX + ref); } catch {} };
  const close = async (ref, from) => { await d1(env, (db) => run(db, `UPDATE abandono_envio_v1 SET estado='nao_confirmado' WHERE ref=?1 AND estado='${from}'`, ref)); await dropPend(ref); beat.nao_confirmado++; };
  // Pendência descartada sem envio: uma linha "reservado" de tentativa anterior não será retomada -> nao_confirmado.
  const abandonPend = async (ref) => { await d1(env, (db) => run(db, "UPDATE abandono_envio_v1 SET estado='nao_confirmado' WHERE ref=?1 AND estado='reservado'", ref)); await dropPend(ref); };
  const cancel = async (ref) => { await d1(env, (db) => run(db, "UPDATE abandono_envio_v1 SET estado='cancelado' WHERE ref=?1 AND estado='reservado'", ref)); await dropPend(ref); beat.canceled++; };

  let listed;
  try { listed = await kv.list({ prefix: PEND_PREFIX, limit: 50 }); } catch { return { ok: false, skipped: "kv_failed", ...beat }; }
  for (const k of listed?.keys || []) {
    if (stop || processed >= max) break;
    const name = String(k?.name || ""), ref = name.slice(PEND_PREFIX.length);
    if (!REF_RE.test(ref)) continue;
    let pend = null;
    try { pend = JSON.parse(String((await kv.get(name)) || "null")); } catch { pend = null; }
    if (!pend || typeof pend !== "object") continue;
    if (!(Number(pend.due_at) <= now)) continue;
    if (fusion.pending.has(ref)) continue; // descadastro ainda não fundido ao D1
    try { if (await kv.get(SUPKV_PREFIX + ref)) { await dropPend(ref); beat.canceled++; continue; } } catch { continue; }
    processed++;
    beat.due++;
    if (!(Number(pend.received_at) >= now - STALE_MS)) { await abandonPend(ref); continue; }
    if (!validEmail(pend.email) || (await abandonoRef(env, pend.email)) !== ref) { await abandonPend(ref); continue; }
    if ((await purchaseOpenFor(env, pend.slug)) !== true) { await abandonPend(ref); continue; }
    let mail, body, bodySha;
    try {
      const unsubscribe = await optOutUrl(env, ref);
      mail = abandonmentEmail(pend.slug, { optOutUrl: unsubscribe });
      if (abandonmentLockViolations(mail).length) throw new Error("lock");
      body = resendBody(env, { email: normalizeEmail(pend.email), ref, mail, unsubscribe });
      bodySha = await sha256Hex(body);
    } catch { await abandonPend(ref); continue; }

    // Reserva atômica = segundo ponto de consulta do marcador de compra (instrução única, no primário).
    const res = await reserveSend(env, { ref, slug: pend.slug, now, bodySha });
    if (res.unavailable) { stop = true; break; }
    let leaseMs = now;
    if (res.value !== 1) {
      const st = await d1(env, (db) => first(db, SQL_ESTADO, ref, since, dia));
      if (st.unavailable || !st.value) { stop = true; break; }
      const row = st.value;
      if (row.estado == null) {
        if (row.compra || row.sup) { await dropPend(ref); beat.canceled++; continue; }
        if (Number(row.hoje) >= ABANDONO_DAILY_CAP) { stop = true; beat.cap_left = 0; break; }
        continue; // motivo desconhecido: mantém a pendência, sem POST
      }
      if (row.estado === "reconciliar") continue;
      if (row.estado !== "reservado") { await dropPend(ref); continue; }
      if (row.compra || row.sup) { await cancel(ref); continue; }
      if (!(Number(row.criado_ms) > now - RETRY_WINDOW_MS) || Number(row.tentativas) >= 3) { await close(ref, "reservado"); continue; }
      if (Number(row.lease_ms) >= now - LEASE_MS) continue; // outra execução é dona da tentativa
      const took = await d1(env, (db) => run(db, SQL_RETOMADA, ref, now, since));
      if (took.unavailable) { stop = true; break; }
      if (took.value !== 1) continue;
      if (row.body_sha !== bodySha) {
        await d1(env, (db) => run(db, "UPDATE abandono_envio_v1 SET estado='reconciliar', tentativas=0 WHERE ref=?1 AND estado='reservado' AND lease_ms=?2", ref, now));
        beat.reconcile++;
        continue;
      }
      leaseMs = now;
    }
    const out = await postResend(env, fetchImpl, { body, ref });
    if (out.kind === "sent") {
      await d1(env, (db) => run(db, "UPDATE abandono_envio_v1 SET estado='enviado', resend_id=?3 WHERE ref=?1 AND estado='reservado' AND lease_ms=?2", ref, leaseMs, out.id));
      await dropPend(ref);
      beat.sent++;
    } else if (out.kind === "reconcile") {
      await d1(env, (db) => run(db, "UPDATE abandono_envio_v1 SET estado='reconciliar', tentativas=0 WHERE ref=?1 AND estado='reservado' AND lease_ms=?2", ref, leaseMs));
      beat.reconcile++;
    } else if (out.kind === "rate_limited") {
      beat.retry++;
      stop = true;
    } else {
      beat.retry++;
    }
  }

  // Reconciliação: no máximo 1 linha por execução, com lease atômico.
  if (!stop) {
    const cand = await d1(env, (db) => first(db, `SELECT ref, criado_ms, tentativas FROM abandono_envio_v1 WHERE estado='reconciliar' AND lease_ms < ?1 ORDER BY criado_ms LIMIT 1`, now - LEASE_MS));
    const row = cand.unavailable ? null : cand.value;
    if (row && REF_RE.test(String(row.ref))) {
      const ref = String(row.ref);
      const took = await d1(env, (db) => run(db, `UPDATE abandono_envio_v1 SET lease_ms=?2, tentativas=tentativas+1 WHERE ref=?1 AND estado='reconciliar' AND lease_ms < ?2-${LEASE_MS}`, ref, now));
      if (!took.unavailable && took.value === 1) {
        const n = Number(row.tentativas) + 1;
        let pend = null;
        try { pend = JSON.parse(String((await kv.get(PEND_PREFIX + ref)) || "null")); } catch {}
        let result = { incomplete: "pend" };
        if (pend && validEmail(pend.email) && Number(row.criado_ms) > now - RETRY_WINDOW_MS) {
          let subject = null;
          try { subject = abandonmentSubject(productBySlug(pend.slug).name); } catch {}
          if (subject) result = await reconcileLookup(env, fetchImpl, { ref, email: pend.email, subject, criadoMs: Number(row.criado_ms) });
        }
        if (result.found) {
          const ok = await d1(env, (db) => run(db, "UPDATE abandono_envio_v1 SET estado='enviado', resend_id=?3 WHERE ref=?1 AND estado='reconciliar' AND lease_ms=?2", ref, now, result.found));
          if (!ok.unavailable && ok.value === 1) { await dropPend(ref); beat.sent++; }
        } else if (n >= RECONCILE_MAX || !pend || !(Number(row.criado_ms) > now - RETRY_WINDOW_MS)) {
          await close(ref, "reconciliar");
        } else {
          beat.reconcile++;
        }
      }
    }
  }
  const left = await d1(env, (db) => first(db, "SELECT count(*) AS hoje FROM abandono_envio_v1 WHERE dia=?1", dia));
  if (!left.unavailable && left.value) beat.cap_left = Math.max(0, ABANDONO_DAILY_CAP - Number(left.value.hoje));
  return { ok: true, supkv_fundidas: fusion.fused, ...beat };
}

// ---------------------------------------------------------------------------------------------------------
// Rotas internas isoladas (SELF) com token HMAC de minuto.
async function minuteToken(key, path, minute) { return hmacHex(key, "POST " + path + " " + minute); }
async function internalAuthorized(request, key, path, nowMs) {
  const minuteText = request.headers.get("x-abandono-minute") || "";
  const token = request.headers.get("x-abandono-token") || "";
  const minute = /^\d{1,12}$/.test(minuteText) ? Number(minuteText) : NaN, cur = Math.floor(nowMs / 60000);
  if (!(minute === cur || minute === cur - 1)) return false;
  return constantTimeEqual(token, await minuteToken(key, path, minute));
}
async function dispatchSelf(env, path, key, nowMs) {
  const self = env?.SELF;
  if (typeof self?.fetch !== "function") return { via: "self_failed", status: null, result: null };
  try {
    const minute = Math.floor(nowMs / 60000);
    const token = await minuteToken(key, path, minute);
    const r = await self.fetch(new Request(CORE + path, { method: "POST", headers: { "x-abandono-token": token, "x-abandono-minute": String(minute) }, signal: AbortSignal.timeout(45000) }));
    const body = await r.json().catch(() => null);
    return { via: "self", status: r.status, result: body && typeof body === "object" ? body : null };
  } catch { return { via: "self_failed", status: 0, result: null }; }
}
// Agregado do batimento: só números e códigos (sem ref, e-mail ou id).
const NUM_KEYS = ["due", "sent", "retry", "reconcile", "nao_confirmado", "canceled", "cap_left", "supkv_fundidas"];
const beatOf = (via, result) => { const b = { via }; for (const k of NUM_KEYS) if (Number.isFinite(result?.[k])) b[k] = Number(result[k]); if (typeof result?.skipped === "string") b.skipped = result.skipped.slice(0, 40); return b; };

// Cron horário -> SELF, só em "ativo" e com D1. Estrito: nunca roda inline.
export async function dispatchAbandonmentDrain(env, opts = {}) {
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  if (stageOf(opts) !== "ativo") return { skipped: "disabled" };
  if (!env?.DIARIO) return { skipped: "d1_unavailable" };
  const s = privacySecret(env);
  if (!s) return { skipped: "not_configured" };
  const out = await dispatchSelf(env, DRAIN_PATH, keyDrain(s), nowMs);
  return beatOf(out.via, out.result);
}
export async function handleAbandonmentDrainRequest(request, env, opts = {}) {
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  if (request.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });
  const s = privacySecret(env);
  if (!s || !(await internalAuthorized(request, keyDrain(s), DRAIN_PATH, nowMs))) return json(401, { ok: false, error: "unauthorized" });
  try {
    const out = await runAbandonmentDue(env, { ...opts, now: nowMs });
    return json(200, beatOf("self", out));
  } catch { return json(503, { ok: false, error: "abandono_drain_failed" }); }
}

// ---------------------------------------------------------------------------------------------------------
// Retenção diária (06 UTC), isolada via SELF, em aquecimento e ativo. desligado: sem SELF e sem gravação.
export async function dispatchAbandonmentRetention(env, opts = {}) {
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  if (stageOf(opts) === "desligado") return { skipped: "disabled" };
  if (!env?.DIARIO) return { at: new Date(nowMs).toISOString(), ok: false, motivo: "d1_unavailable" };
  const s = privacySecret(env);
  if (!s) return { at: new Date(nowMs).toISOString(), ok: false, motivo: "not_configured" };
  const out = await dispatchSelf(env, RETENTION_PATH, keyRetention(s), nowMs);
  const r = out.result || {};
  const beat = { at: new Date(nowMs).toISOString(), ok: out.via === "self" && out.status === 200 && r.ok === true, motivo: out.via === "self" ? String(r.motivo || (out.status === 200 ? "ok" : "self_status")).slice(0, 40) : "self_failed" };
  for (const k of ["apagadas_envio", "apagadas_compra", "supkv_fundidas", "idade_max_envio_dias", "idade_max_compra_dias"]) if (Number.isFinite(r[k])) beat[k] = Number(r[k]);
  if (r.alerta === true) beat.alerta = true;
  return beat;
}
export async function handleAbandonmentRetentionRequest(request, env, opts = {}) {
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  if (request.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });
  const s = privacySecret(env);
  if (!s || !(await internalAuthorized(request, keyRetention(s), RETENTION_PATH, nowMs))) return json(401, { ok: false, error: "unauthorized" });
  const out = await runAbandonmentRetention(env, { ...opts, now: nowMs });
  return json(200, out);
}
export async function runAbandonmentRetention(env, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  if (stageOf(opts) === "desligado") return { ok: false, motivo: "disabled" };
  const kv = env?.ZEVANORY_PRIVATE_ARTIFACTS;
  const out = { ok: false, motivo: "d1_unavailable", apagadas_envio: 0, apagadas_compra: 0, supkv_fundidas: 0, idade_max_envio_dias: 0, idade_max_compra_dias: 0 };
  const probe = await d1(env, (db) => first(db, "SELECT count(*) AS n FROM abandono_supressao_v1"));
  if (!probe.unavailable && probe.value) {
    const fusion = kv?.list ? await fuseSupkv(env, kv) : { fused: 0, pending: new Set() };
    out.supkv_fundidas = fusion.fused;
    const cut = now - DEDUPE_MS;
    const del = await d1(env, async (db) => [await run(db, "DELETE FROM abandono_envio_v1 WHERE criado_ms < ?1", cut), await run(db, "DELETE FROM abandono_compra_v1 WHERE criado_ms < ?1", cut)]);
    const ages = await d1(env, (db) => first(db, "SELECT (SELECT min(criado_ms) FROM abandono_envio_v1) AS envio, (SELECT min(criado_ms) FROM abandono_compra_v1) AS compra"));
    const days = (v) => (v !== null && v !== undefined && Number.isFinite(Number(v)) ? Math.floor((now - Number(v)) / 86400_000) : 0);
    if (!ages.unavailable && ages.value) {
      out.idade_max_envio_dias = days(ages.value.envio);
      out.idade_max_compra_dias = days(ages.value.compra);
    }
    if (!del.unavailable) [out.apagadas_envio, out.apagadas_compra] = del.value;
    if (!del.unavailable && !ages.unavailable && ages.value) { out.ok = true; out.motivo = "ok"; } else out.motivo = "d1_falhou";
  }
  // Alerta: idade máxima acima de 31 dias, ou retenção sem sucesso por 2 dias seguidos. Só contagens.
  let falhas = 0;
  try {
    if (out.ok) { if (await kv?.get?.(RETENTION_FAIL_KEY)) await kv.delete(RETENTION_FAIL_KEY); }
    else { falhas = (Number(await kv?.get?.(RETENTION_FAIL_KEY)) || 0) + 1; await kv?.put?.(RETENTION_FAIL_KEY, String(falhas), { expirationTtl: 7 * 86400 }); }
  } catch {}
  if (out.idade_max_envio_dias > 31 || out.idade_max_compra_dias > 31 || falhas >= 2) {
    out.alerta = true;
    console.error("abandono_retencao_atrasada", JSON.stringify({ idade_max_envio_dias: out.idade_max_envio_dias, idade_max_compra_dias: out.idade_max_compra_dias, falhas }));
    try {
      await kv?.put?.("zpc-alert:v1:abandono-retencao:" + dayOf(now), JSON.stringify({ channel: "abandono", category: "abandono_retencao_atrasada", excerpt: `retenção do lembrete de abandono atrasada: idade máxima envio ${out.idade_max_envio_dias} dias, compra ${out.idade_max_compra_dias} dias, falhas seguidas ${falhas}`, at: new Date(now).toISOString() }), { expirationTtl: 3 * 86400 });
    } catch {}
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Descadastro (GET ou POST One-Click /abandono/sair?r=<ref>&t=<token>).
const page = (status, title, msg) => new Response(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>body{font-family:system-ui,sans-serif;background:#040a12;color:#f5f8fc;margin:0;padding:16px}main{max-width:480px;margin:10vh auto}p{color:#a9b6c9;line-height:1.55}</style></head><body><main><h1>${title}</h1><p>${msg}</p><p>Dúvidas: ${SUPPORT}</p></main></body></html>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer" } });
export async function handleAbandonmentOptOut(request, env, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  if (request.method !== "GET" && request.method !== "POST") return page(405, "Método inválido", "Use o link do e-mail.");
  if (stageOf(opts) === "desligado") return page(503, "Link indisponível", `Este link não está ativo. Para não receber lembretes, escreva para ${SUPPORT}.`);
  const url = new URL(request.url);
  const ref = url.searchParams.get("r") || "", t = url.searchParams.get("t") || "";
  if (!REF_RE.test(ref) || !T_RE.test(t)) return page(400, "Link inválido", "O link de descadastro está incompleto.");
  const expected = await optOutToken(env, ref);
  if (!expected) return page(503, "Indisponível", `Não foi possível registrar agora. Escreva para ${SUPPORT}.`);
  if (!(await constantTimeEqual(t, expected))) return page(400, "Link inválido", "O link de descadastro não confere.");
  const kv = env?.ZEVANORY_PRIVATE_ARTIFACTS;
  let kvOk = false;
  try { await kv.put(SUPKV_PREFIX + ref, JSON.stringify({ at: now })); kvOk = true; } catch {}
  try { await kv?.delete?.(PEND_PREFIX + ref); } catch {}
  const db = await d1(env, async (d) => { await run(d, SQL_SUPRIME, ref, now); await run(d, "UPDATE abandono_envio_v1 SET estado='cancelado' WHERE ref=?1 AND estado='reservado'", ref); return true; });
  if (!kvOk && db.unavailable) return page(503, "Indisponível", `Não foi possível registrar agora. Escreva para ${SUPPORT} que a gente faz o descadastro.`);
  console.info("abandono_optout", "ok");
  return page(200, "Pronto", "Você não vai receber lembretes de compra da ZEVANORY.");
}

// ---------------------------------------------------------------------------------------------------------
// Supressão MANUAL (oposição pedida por e-mail a suporte@, política de privacidade): o proprietário ou a central
// registra a partir do e-mail informado. POST /api/internal/abandono/supressao, Authorization: Bearer <token de
// operador> (ZEVANORY_OPERATOR_TOKEN, verifyOperatorToken, tempo constante), corpo JSON {"email": "..."}.
// Grava SÓ o pseudônimo (supkv: no KV e INSERT OR IGNORE em abandono_supressao_v1), apaga a pendência e cancela uma
// reserva; o e-mail nunca é gravado, devolvido nem logado. Em "desligado" não grava nada (503 abandono_desligado):
// pedidos recebidos nesse estágio ficam na caixa do suporte e são registrados ao iniciar o aquecimento.
export async function handleAbandonmentManualSuppression(request, env, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  if (request.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });
  const bearer = String(request.headers.get("authorization") || "").replace(/^Bearer /, "");
  if (!bearer || !verifyOperatorToken(env, bearer, { minLength: 32, log: null })) return json(401, { ok: false, error: "unauthorized" });
  if (stageOf(opts) === "desligado") return json(503, { ok: false, error: "abandono_desligado" });
  if (!String(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) return json(415, { ok: false, error: "json_required" });
  let body;
  try { const raw = await request.text(); if (raw.length > 2048) return json(413, { ok: false, error: "too_large" }); body = JSON.parse(raw); } catch { return json(400, { ok: false, error: "invalid_json" }); }
  if (!validEmail(body?.email)) return json(400, { ok: false, error: "invalid_email" });
  if (!privacySecret(env)) return json(503, { ok: false, error: "privacy_not_configured" });
  const ref = await abandonoRef(env, body.email);
  const kv = env?.ZEVANORY_PRIVATE_ARTIFACTS;
  let kvOk = false;
  try { await kv.put(SUPKV_PREFIX + ref, JSON.stringify({ at: now })); kvOk = true; } catch {}
  try { await kv?.delete?.(PEND_PREFIX + ref); } catch {}
  const db = await d1(env, async (d) => { await run(d, SQL_SUPRIME, ref, now); await run(d, "UPDATE abandono_envio_v1 SET estado='cancelado' WHERE ref=?1 AND estado='reservado'", ref); return true; });
  if (!kvOk && db.unavailable) return json(503, { ok: false, error: "suppression_not_recorded" });
  console.info("abandono_supressao_manual", JSON.stringify({ kv: kvOk, d1: !db.unavailable }));
  return json(200, { ok: true, kv: kvOk, d1: !db.unavailable });
}
