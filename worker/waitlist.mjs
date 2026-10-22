// P01 Fase A (Ordem 080 AVAL, aprovação do proprietário 22/10 18:09): lista de espera SEM cobrança
// para medir demanda em 3 nichos (confeitaria, loja de roupas, salão/barbearia).
// * Só é alcançável pelo binding privado do Worker de vendas (host waitlist.internal) e só responde
//   com a bandeira FASE_A_WAITLIST="on" (padrão: ausente = DESLIGADO, nada é gravado).
// * Mesmo padrão dos leads do material gratuito (worker/lead-magnet.mjs): esquema criado em tempo de
//   execução (create table if not exists), contato guardado normalizado para poder avisar a pessoa,
//   e uma referência PSEUDONIMIZADA com chave (HMAC com LEAD_PRIVACY_SECRET, nunca hash simples) como
//   índice único por nicho (idempotência) e nos links de saída. Sem a chave: indisponível (fail-closed).
// * Consentimento LGPD explícito obrigatório (versão do texto + data gravadas); saída (opt-out) com
//   link assinado APAGA todas as inscrições daquele contato; o registro de auditoria guarda só a
//   referência pseudonimizada, o nicho, o evento e a versão do consentimento.
// * Dupla confirmação (double opt-in) é a P08 (issue #871): nada é enviado à pessoa por este módulo.
// * Métricas sem dado pessoal: visitantes elegíveis (filtro de robôs/datacenter do funil), inscrições,
//   inscrições qualificadas, conversão e intervalo de Wilson 95% por nicho (docs/p01/FASE_A_PROTOCOLO.md).
import { isAutomationUA, DATACENTER_ASNS } from "./funnel.mjs";

export const WAITLIST_NICHES = Object.freeze(["confeitaria", "loja-de-roupas", "salao-e-barbearia"]);
export const CONSENT_VERSION = "fase-a-lista-v1-2026-10-22";
export const RETENTION_MONTHS = 12;
export const EVENT_RETENTION_DAYS = 730;
export const VISITOR_RETENTION_DAYS = 400;
const SALES = "https://vendas.zevanory.api.br";
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;
const RETENTION_MARKER = "zpc:waitlist:retention:v1:last";
let schemaReady = false;

const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: HEADERS });

export const flagOn = (env) => String(env?.FASE_A_WAITLIST || "").trim().toLowerCase() === "on";

async function sha256Hex(value) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(value))))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// Mesmo anel de chaves do lead-magnet (atual + anterior durante rotação), prefixo próprio.
const keyOf = (v) => (v && String(v).length >= 32 ? "zevanory-waitlist-privacy-v1:" + v : "");
const privacyKeys = (env) => [keyOf(env.LEAD_PRIVACY_SECRET), keyOf(env.LEAD_PRIVACY_SECRET_PREVIOUS)].filter(Boolean);

// Contato: e-mail (minúsculas) ou WhatsApp brasileiro (só dígitos, com 55). Qualquer outra coisa é inválida.
export function normalizeContact(raw) {
  const s = String(raw ?? "").trim();
  if (!s || s.length > 254) return null;
  if (s.includes("@")) {
    const email = s.toLowerCase();
    return EMAIL_RE.test(email) ? { kind: "email", value: email } : null;
  }
  if (!/^[\d\s()+.-]+$/.test(s)) return null;
  let d = s.replace(/\D/g, "");
  if (d.length === 10 || d.length === 11) d = "55" + d;
  if (!/^55[1-9][0-9]9?[0-9]{8}$/.test(d)) return null;
  return { kind: "whatsapp", value: d };
}
export async function contactRef(env, contact) {
  const key = privacyKeys(env)[0];
  return key ? hmacHex(key, "contact:" + contact.kind + ":" + contact.value) : null;
}
const tokenWith = async (key, ref) => (await hmacHex(key, "waitlist-optout:" + ref)).slice(0, 32);
export async function optOutLink(env, ref) {
  const key = privacyKeys(env)[0];
  return key && ref ? `${SALES}/lista-de-espera/sair?r=${ref}&t=${await tokenWith(key, ref)}` : null;
}
async function optOutTokenValid(env, ref, t) {
  for (const key of privacyKeys(env)) if ((await tokenWith(key, ref)) === t) return true;
  return false;
}

// Visitante elegível / inscrição contável: o MESMO filtro do funil (worker/funnel.mjs): agente de
// automação, rede de datacenter, prefetch/prerender e método diferente de GET (para visitas) ficam fora.
export function isEligibleTraffic({ userAgent, asn = 0, purpose = "" }) {
  if (DATACENTER_ASNS.has(Number(asn))) return false;
  if (isAutomationUA(userAgent)) return false;
  if (/prefetch|prerender/i.test(String(purpose || ""))) return false;
  return true;
}
const label = (v, max) => { const x = String(v || "").toLowerCase().trim(); return new RegExp(`^[a-z0-9_-]{1,${max}}$`).test(x) ? x : ""; };
const yesNo = (v) => (v === true || v === "sim" ? true : v === false || v === "nao" ? false : null);

// DDL única (fonte de verdade), idempotente. Segue a prática dos leads (zevanory_leads também é criada
// em tempo de execução e não está em db/migrations, cuja contagem exata é conferida pela restauração).
export const WAITLIST_DDL = [
  `create table if not exists waitlist_signups (
    id bigserial primary key,
    niche text not null check (niche in ('confeitaria','loja-de-roupas','salao-e-barbearia')),
    contact_kind text not null check (contact_kind in ('email','whatsapp')),
    contact text not null check (char_length(contact) between 5 and 254),
    contact_ref text not null check (contact_ref ~ '^[0-9a-f]{64}$'),
    name text check (name is null or char_length(name) <= 60),
    q_recurring boolean not null,
    q_digital boolean not null,
    consent_version text not null check (char_length(consent_version) between 1 and 60),
    consent_at timestamptz not null,
    src text check (src is null or src ~ '^[a-z0-9_-]{1,24}$'),
    camp text check (camp is null or camp ~ '^[a-z0-9_-]{1,48}$'),
    counted boolean not null default true,
    created_at timestamptz not null default now(),
    unique (niche, contact_ref))`,
  `create table if not exists waitlist_events (id bigserial primary key, contact_ref text, niche text, event text not null,
    consent_version text, at timestamptz not null default now())`,
  `create table if not exists waitlist_visitors (day date not null, niche text not null, vhash text not null,
    primary key (day, niche, vhash))`,
];
export async function ensureWaitlistSchema(sql) {
  if (schemaReady) return;
  for (const ddl of WAITLIST_DDL) await sql.query(ddl, []);
  schemaReady = true;
}
export function resetWaitlistSchemaCache() { schemaReady = false; }

async function recordEvent(sql, ref, niche, event, version = null) {
  await sql.query("insert into waitlist_events (contact_ref, niche, event, consent_version) values ($1, $2, $3, $4)", [ref || null, niche || null, event, version]);
}

export async function subscribe(env, sql, body = {}) {
  const niche = String(body.nicho || "");
  if (!WAITLIST_NICHES.includes(niche)) return { status: 400, body: { ok: false, code: "nicho" } };
  const contact = normalizeContact(body.contato);
  if (!contact) return { status: 400, body: { ok: false, code: "contato" } };
  if (body.consent !== true) return { status: 400, body: { ok: false, code: "consentimento" } };
  const qRecurring = yesNo(body.q1), qDigital = yesNo(body.q2);
  if (qRecurring === null || qDigital === null) return { status: 400, body: { ok: false, code: "perguntas" } };
  const ref = await contactRef(env, contact);
  if (!ref) return { status: 503, body: { ok: false, code: "indisponivel" } };
  const name = String(body.nome || "").trim().replace(/[\r\n<>]/g, " ").slice(0, 60) || null;
  const counted = isEligibleTraffic({ userAgent: String(body.ua || ""), asn: body.asn });
  await ensureWaitlistSchema(sql);
  // Idempotente por contato + nicho: a segunda inscrição não cria linha nem altera a primeira.
  const rows = await sql.query(`insert into waitlist_signups (niche, contact_kind, contact, contact_ref, name, q_recurring, q_digital,
      consent_version, consent_at, src, camp, counted) values ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9, $10, $11)
      on conflict (niche, contact_ref) do nothing returning id`,
    [niche, contact.kind, contact.value, ref, name, qRecurring, qDigital, CONSENT_VERSION, label(body.src, 24) || null, label(body.camp, 48) || null, counted]);
  const created = rows.length > 0;
  if (created) await recordEvent(sql, ref, niche, "consent_given", CONSENT_VERSION);
  return { status: 200, body: { ok: true, code: created ? "inscrito" : "ja_inscrito", optout: await optOutLink(env, ref) } };
}

async function revoke(env, sql, ref, t) {
  if (!/^[0-9a-f]{64}$/.test(ref) || !/^[0-9a-f]{32}$/.test(t) || !(await optOutTokenValid(env, ref, t))) return { status: 400, body: { ok: false, code: "link_invalido" } };
  await ensureWaitlistSchema(sql);
  const rows = await sql.query("delete from waitlist_signups where contact_ref=$1 returning niche, consent_version", [ref]);
  for (const r of rows) await recordEvent(sql, ref, r.niche, "revoked_and_erased", r.consent_version || null);
  if (!rows.length) await recordEvent(sql, ref, null, "revocation_without_record");
  return { status: 200, body: { ok: true, code: "removido", erased: rows.length } };
}

export async function recordVisit(env, sql, body = {}, now = Date.now()) {
  const niche = String(body.nicho || "");
  if (!WAITLIST_NICHES.includes(niche)) return false;
  const userAgent = String(body.ua || "").slice(0, 300);
  if (String(body.method || "GET") !== "GET" || !isEligibleTraffic({ userAgent, asn: body.asn, purpose: body.purpose })) return false;
  await ensureWaitlistSchema(sql);
  const day = new Date(now).toISOString().slice(0, 10);
  // Mesmo hash diário do funil: (dia|ip|ua|sal) truncado, não reversível e não ligável entre dias.
  const salt = String(env.RESEND_API_KEY || env.DATABASE_URL || "zevanory");
  const vhash = (await sha256Hex(`${day}|${String(body.ip || "")}|${userAgent}|${salt}`)).slice(0, 32);
  await sql.query("insert into waitlist_visitors (day, niche, vhash) values ($1::date, $2, $3) on conflict do nothing", [day, niche, vhash]);
  return true;
}

// Intervalo de score de Wilson (95%, z = 1,959964).
export function wilson(successes, n, z = 1.959964) {
  if (!n) return { low: 0, high: 0 };
  const p = successes / n, z2 = z * z, den = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}
// Regra pré-registrada (docs/p01/FASE_A_PROTOCOLO.md §5). Nunca NO-GO com menos de 300 visitantes.
export const RULE = Object.freeze({ minVisitors: 300, minConversion: 0.08, minWilsonLow: 0.05, minLeads: 20 });
export function decide({ visitors, signups, complianceViolation = false }) {
  if (visitors < RULE.minVisitors) return "INCONCLUSIVO";
  if (complianceViolation) return "NO-GO";
  const conv = signups / visitors;
  return conv >= RULE.minConversion && wilson(signups, visitors).low >= RULE.minWilsonLow && signups >= RULE.minLeads ? "GO" : "NO-GO";
}
// Agregados sem nenhuma coluna de contato: só contagens por nicho.
export const SUMMARY_SQL = `select n.niche,
    (select count(*)::int from waitlist_visitors v where v.niche = n.niche and v.day between $1::date and $2::date) as eligible_visitors,
    (select count(*)::int from waitlist_signups s where s.niche = n.niche and s.counted and s.created_at::date between $1::date and $2::date) as signups,
    (select count(*)::int from waitlist_signups s where s.niche = n.niche and s.counted and s.q_recurring and s.q_digital and s.created_at::date between $1::date and $2::date) as qualified,
    (select count(*)::int from waitlist_signups s where s.niche = n.niche and not s.counted and s.created_at::date between $1::date and $2::date) as excluded_automation,
    (select count(*)::int from waitlist_events e where e.niche = n.niche and e.event = 'revoked_and_erased' and e.at::date between $1::date and $2::date) as revoked
  from unnest($3::text[]) as n(niche) order by n.niche`;
export function summarize(rows, { since, until, complianceViolations = {} } = {}) {
  const niches = {};
  for (const r of rows) {
    const visitors = Number(r.eligible_visitors) || 0, signups = Number(r.signups) || 0, qualified = Number(r.qualified) || 0;
    const ci = wilson(signups, visitors), qci = wilson(qualified, visitors);
    niches[r.niche] = {
      eligible_visitors: visitors, signups, qualified,
      excluded_automation: Number(r.excluded_automation) || 0, revoked: Number(r.revoked) || 0,
      conversion: visitors ? signups / visitors : 0, wilson95: ci,
      qualified_conversion: visitors ? qualified / visitors : 0, qualified_wilson95: qci,
      decision: decide({ visitors, signups, complianceViolation: Boolean(complianceViolations[r.niche]) }),
    };
  }
  return { schema: "zevanory-fase-a/v1", consent_version: CONSENT_VERSION, window: { since, until }, rule: RULE, niches };
}
export async function buildWaitlistSummary(sql, { since = "2026-01-01", until = "2999-12-31" } = {}) {
  await ensureWaitlistSchema(sql);
  return summarize(await sql.query(SUMMARY_SQL, [since, until, [...WAITLIST_NICHES]]), { since, until });
}

// Retenção (texto do consentimento): inscrições apagadas 12 meses após a inscrição; auditoria
// pseudonimizada após 2 anos; visitantes (hash diário) após 400 dias. Uma vez por dia (marcador KV),
// no máximo 4 consultas, e só se a tabela existir (nunca cria esquema com a bandeira desligada).
export async function runWaitlistRetention(env, { sqlFactory, now = Date.now(), force = false } = {}) {
  if (!env?.DATABASE_URL || !sqlFactory) return { ok: false, reason: "waitlist_retention_unconfigured" };
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  const day = new Date(now).toISOString().slice(0, 10);
  if (!force) { try { if ((await kv?.get?.(RETENTION_MARKER)) === day) return { ok: true, skipped: "already_ran_today" }; } catch {} }
  const sql = sqlFactory(env.DATABASE_URL);
  const exists = await sql.query("select to_regclass('waitlist_signups') is not null as present", []);
  let out = { ok: true, erased: 0 };
  if (exists[0]?.present === true || exists[0]?.present === "t") {
    const erased = await sql.query(`delete from waitlist_signups where created_at < now() - ($1::int * interval '1 month') returning contact_ref, niche, consent_version`, [RETENTION_MONTHS]);
    if (erased.length) await sql.query("insert into waitlist_events (contact_ref, niche, event, consent_version) select r, n, 'erased_retention', v from unnest($1::text[], $2::text[], $3::text[]) as t(r, n, v)",
      [erased.map((r) => r.contact_ref), erased.map((r) => r.niche), erased.map((r) => r.consent_version)]);
    await sql.query("delete from waitlist_events where at < now() - ($1::int * interval '1 day')", [EVENT_RETENTION_DAYS]);
    await sql.query("delete from waitlist_visitors where day < current_date - $1::int", [VISITOR_RETENTION_DAYS]);
    out = { ok: true, erased: erased.length };
  }
  try { await kv?.put?.(RETENTION_MARKER, day, { expirationTtl: 3 * 86400 }); } catch {}
  return out;
}

// Endpoint do binding privado (somente o Worker de vendas o alcança).
export async function handleWaitlist(request, env, { sqlFactory, ctx } = {}) {
  const url = new URL(request.url);
  if (url.hostname !== "waitlist.internal") return null;
  if (!flagOn(env)) return json(404, { ok: false, code: "desligado" });
  if (!sqlFactory || !env.DATABASE_URL) return json(503, { ok: false, code: "indisponivel" });
  const sql = sqlFactory(env.DATABASE_URL);
  if (request.method !== "POST") return json(405, { ok: false });
  let body = {};
  try { body = await request.json(); } catch {}
  try {
    if (url.pathname === "/inscrever") { const out = await subscribe(env, sql, body); return json(out.status, out.body); }
    if (url.pathname === "/sair") { const out = await revoke(env, sql, String(body.r || ""), String(body.t || "")); return json(out.status, out.body); }
    if (url.pathname === "/sair/verificar") {
      const ok = /^[0-9a-f]{64}$/.test(String(body.r || "")) && /^[0-9a-f]{32}$/.test(String(body.t || "")) && (await optOutTokenValid(env, String(body.r), String(body.t)));
      return json(ok ? 200 : 400, { ok });
    }
    if (url.pathname === "/visita") {
      const work = recordVisit(env, sql, body).catch((e) => console.error("waitlist_visit_failed", e instanceof Error ? e.message : String(e)));
      if (ctx?.waitUntil) ctx.waitUntil(work); else await work;
      return new Response(null, { status: 204 });
    }
  } catch (error) {
    console.error("waitlist_failed", error instanceof Error ? error.message.slice(0, 120) : String(error));
    return json(503, { ok: false, code: "indisponivel" });
  }
  return json(404, { ok: false });
}
