// Chat do Proprietário (12/11/2026): a ZEVANORY conversa com o dono em tempo real.
// Página /admin/proprietario (redireciona para /api/admin/owner-chat/app, fora da injeção do chat público)
// + API /api/admin/owner-chat/{feed,message,action} no Worker central.
//
// Garantias (tests/owner-chat.test.mjs; rodada 2 após o NO-GO do Codex, NC-1030-01..07):
// * Autenticação do console (isAdminAuthorized) ANTES de qualquer KV/banco; a rota é despachada no topo do
//   processFetch, antes da leitura do interruptor de vendas (NC-07).
// * Escrita só por POST same-origin com cabeçalho x-owner-chat: 1 (CSRF).
// * Fonte de verdade em PostgreSQL (mesmo DATABASE_URL/sqlFactory do chat do site), não em documento KV:
//   cada mensagem é uma linha (bigserial), alertas e vendas deduplicam por chave única com ON CONFLICT
//   (NC-01: gravações concorrentes não apagam nada).
// * Ação = transição atômica proposta -> executando -> executado|falhou por UPDATE condicional; uma proposta
//   nunca executa duas vezes, nem depois de erro (NC-02).
// * A IA (Workers AI gratuita) NUNCA escreve texto para o dono: só classifica a pergunta numa intenção da lista
//   fechada; toda resposta exibida é determinística e vem dos dados (NC-03). Cota diária reservada no banco
//   ANTES da chamada (no máximo 40/dia; NC-06).
// * Livro de vendas validado campo a campo (inteiros seguros >= 0); qualquer desvio = "ilegível" (NC-04).
// * Feed por SEQUÊNCIA DE COMMIT (NC-CX-1030-05, rodada 5): cada mensagem recebe seq de um contador numa linha
//   única travada até o commit (UPSERT no mesmo comando do INSERT). Quem pega seq N espera o commit de N-1, então
//   seq visível implica todas as menores visíveis: o cursor "seq > after" nunca pula commit atrasado. O servidor
//   devolve o cursor (última seq da página); sem sobreposição que faça o cliente saltar. Marcador KV é só dica.
// * Sentinela proativa (cron 5,35, depois do motor): canal esperado sem publicação depois do horário vira
//   "CANAL PARADO" com o motivo (pausado, sem credencial, erro); venda aprovada nova vira aviso.
import { acquisitionSnapshot, OWNER_DISABLED_CHANNELS } from "./acquisition-engine.mjs";
import { SALES_SUMMARY_KEY } from "./sales-ledger.mjs";
import { CREATIVE_AUTOPUBLISH_PAUSE_KEY } from "./creative-autonomy.mjs";
import { ensureSiteChatSchema, reserveChatNeurons } from "./site-chat.mjs";
import { collectObservations } from "./vigia.mjs";
import { runIncidents } from "./vigia-incidents.mjs";

export const OWNER_CHAT_VERSION_KEY = "zpc:owner-chat:versao:v1";
export const OWNER_CHAT_HINT_PREFIX = "zpc:owner-chat:avisados:";
export const OWNER_CHAT_PATHS = Object.freeze({ page: "/admin/proprietario", app: "/api/admin/owner-chat/app" });
export const AI_DAILY_LIMIT = 40;
const MAX_TEXT = 1500, ACTION_TTL_SECONDS = 600, FEED_LIMIT = 100, FEED_PAGE = 500, RECONCILE_AFTER_S = 90;
export const EXPECTED_HOUR = Object.freeze({ blog: 9, bluesky: 19 });
const TOLERANCE_H = 1;
const AI_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8-fast";
export const ACTIONS = Object.freeze({
  pausar_criativos: { label: "Pausar a autopublicação (blog e Bluesky)", value: "1", done: "Autopublicação PAUSADA. Nada novo será publicado até você retomar." },
  retomar_criativos: { label: "Retomar a autopublicação", value: "0", done: "Autopublicação RETOMADA. Os canais voltam a publicar no próximo horário." },
});
export const INTENTS = Object.freeze(["status", "vendas", "problemas", "pausar", "retomar", "ajuda"]);

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
const obj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const uint = (v) => Number.isSafeInteger(v) && v >= 0;
const localParts = (now) => {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const g = (t) => f.find((x) => x.type === t)?.value;
  return { day: `${g("year")}-${g("month")}-${g("day")}`, hour: Number(g("hour")) };
};

// ---------- Banco ----------
const schemaReady = new WeakSet();
export async function ensureOwnerChatSchema(sql) {
  if (schemaReady.has(sql)) return;
  await sql.query(`create table if not exists zevanory_owner_chat_messages (
    id bigserial primary key, seq bigint not null unique, created_at timestamptz not null default now(), sender text not null, kind text not null,
    body text not null, action_type text, action_expires_at timestamptz, action_state text, dedupe_key text unique)`, []);
  await sql.query(`create table if not exists zevanory_owner_chat_seq (
    k smallint primary key, n bigint not null)`, []);
  await sql.query(`create table if not exists zevanory_owner_chat_ai_usage (
    day date primary key, n integer not null default 0)`, []);
  await sql.query(`create table if not exists zevanory_owner_chat_action_lock (
    k smallint primary key, holder bigint, since timestamptz)`, []);
  schemaReady.add(sql);
}
const ROW = "id::text as id, seq::text as seq, created_at, sender, kind, body, action_type, action_expires_at, action_state";
const toMessage = (r) => ({ id: String(r.id), seq: String(r.seq), at: new Date(r.created_at).toISOString(), from: r.sender, kind: r.kind, text: r.body,
  ...(r.action_type ? { action: { type: r.action_type, expiresAt: Date.parse(r.action_expires_at), state: r.action_state } } : {}) });

async function insertMessage(sql, { from, kind, text, action = null, dedupe = null }) {
  // O contador é travado pelo UPSERT até o commit deste comando: seq segue a ordem de commit.
  const rows = await sql.query(`/*owner-chat:insert*/ with c as (insert into zevanory_owner_chat_seq (k, n) values (1, 1)
      on conflict (k) do update set n = zevanory_owner_chat_seq.n + 1 returning n)
    insert into zevanory_owner_chat_messages (seq, sender, kind, body, action_type, action_expires_at, action_state, dedupe_key)
    select c.n, $1, $2, $3, $4, case when $4::text is null then null else now() + ($5::integer * interval '1 second') end, case when $4::text is null then null else 'proposta' end, $6 from c
    on conflict (dedupe_key) do nothing returning ${ROW}`, [from, kind, String(text).slice(0, 4000), action, ACTION_TTL_SECONDS, dedupe]);
  return rows[0] ? toMessage(rows[0]) : null;
}
export async function insertOwnerMessage(sql, m) { await ensureOwnerChatSchema(sql); return insertMessage(sql, m); }
async function bumpVersion(kv) { try { await kv?.put?.(OWNER_CHAT_VERSION_KEY, Date.now() + "-" + crypto.randomUUID().slice(0, 8), { expirationTtl: 30 * 86400 }); return true; } catch { return false; } }
// O marcador KV é só otimização (NC-G6-1030-08): a página refaz a leitura completa no PostgreSQL pelo menos a cada
// FEED_MAX_STALE_MS, então falha de atualização, colisão ou marcador velho nunca escondem mensagem por mais que isso.
export const FEED_MAX_STALE_MS = 30000;

// ---------- Dados reais ----------
// Livro canônico (worker/sales-ledger.mjs): todo campo usado precisa existir e ser inteiro seguro >= 0; ausência
// não vale zero (NC-CX-1030-04). Chave inexistente = "sem vendas"; livro incompleto = inconclusivo.
export function validSalesSummary(v) {
  if (!obj(v) || v.schema !== "zevanory-sales/v1" || !obj(v.totals) || !obj(v.byDay)) return false;
  if (!uint(v.totals.approved) || !uint(v.totals.grossCents) || !uint(v.totals.refunded)) return false;
  return Object.entries(v.byDay).every(([d, x]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && obj(x) && uint(x.approved) && uint(x.grossCents));
}
async function salesSummary(kv) {
  const raw = await kv.get(SALES_SUMMARY_KEY);
  if (raw === null) return { ok: true, value: null };
  try { const v = JSON.parse(raw); if (validSalesSummary(v)) return { ok: true, value: v }; } catch {}
  return { ok: false, value: null };
}
async function pauseState(kv) {
  const v = await kv.get(CREATIVE_AUTOPUBLISH_PAUSE_KEY);
  if (v === null || v === "0") return "ativa";
  if (v === "1") return "pausada";
  return "ilegivel";
}
const brl = (cents) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export async function gatherFacts(env, now = new Date(), { snapshot = acquisitionSnapshot } = {}) {
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  const { day, hour } = localParts(now);
  const [snap, sales, pause, vigia] = await Promise.all([
    snapshot(env, now).catch(() => null),
    salesSummary(kv).catch(() => ({ ok: false, value: null })),
    pauseState(kv).catch(() => "ilegivel"),
    collectObservations(env, now).catch(() => []),
  ]);
  return { day, hour, snap: obj(snap) && Array.isArray(snap.today) ? snap : null, sales, pause, vigia };
}

// Só códigos conhecidos do motor (worker/acquisition-engine.mjs) aparecem em texto; o resto vira categoria fixa
// (NC-CX-1031-04: nada de texto livre que possa carregar segredo).
export const KNOWN_CHANNEL_STATUS = Object.freeze(["publicado", "erro", "pausado", "desligado", "agendado", "aguardando credencial", "aguardando aprovação", "sem dados", "fora_da_agenda", "rascunho", "pending", "published", "sent"]);
export const KNOWN_CHANNEL_CODES = Object.freeze(["blog_generation_failed", "creative_autopublish_paused", "digest_marker_unreadable", "digest_source_unreadable", "engine_exception", "history_unreadable", "kv_unavailable", "legacy_receipt_unreadable", "legacy_telegram_unverified", "owner_digest_unverified", "pause_unreadable", "receipt_unreadable", "status_unreadable", "draft_only_publication_disabled"]);
const safeStatus = (v) => (KNOWN_CHANNEL_STATUS.includes(v) ? v : "status_nao_reconhecido");
const safeCode = (v) => (v === null || v === undefined || v === "" ? null : KNOWN_CHANNEL_CODES.includes(v) ? v : "erro_nao_classificado");
const safeLink = (v) => { try { const u = new URL(String(v)); return u.protocol === "https:" && !u.username && !u.password ? u.origin + u.pathname : null; } catch { return null; } };
export function findStoppedChannels(facts) {
  if (!facts.snap) return [{ channel: "motor", reason: "snapshot_indisponivel", text: "Não consegui ler o estado de publicação de hoje." }];
  const out = [];
  for (const [channel, h] of Object.entries(EXPECTED_HOUR)) {
    if (OWNER_DISABLED_CHANNELS.includes(channel) || facts.hour < h + TOLERANCE_H) continue;
    const row = facts.snap.today.find((r) => r?.channel === channel);
    // A agenda é a do próprio motor (NC-G6-1030-10): dia sem publicação prevista chega como "fora_da_agenda".
    if (["publicado", "fora_da_agenda", "desligado"].includes(row?.status)) continue;
    const reason = facts.pause === "pausada" ? "pausado" : row?.status === "aguardando credencial" ? "sem_credencial" : !row ? "sem_registro" : safeCode(row.error) || safeStatus(row.status);
    const why = reason === "pausado" ? "A autopublicação está PAUSADA" : reason === "sem_credencial" ? "A credencial do canal está ausente" : reason === "sem_registro" || reason === "sem dados" ? "O motor não registrou nenhuma execução hoje" : `Motivo: ${reason}`;
    out.push({ channel, reason, text: `${channel}: não publicou hoje (esperado às ${h}h). ${why}.` });
  }
  return out;
}
function statusText(facts) {
  if (!facts.snap) return "Não consegui ler o estado de publicação agora. Tente de novo em alguns minutos.";
  const lines = facts.snap.today.filter((r) => obj(r) && r.channel !== "whatsapp").filter((r) => Object.hasOwn(EXPECTED_HOUR, r.channel) || r.channel === "telegram").map((r) => { const link = safeLink(r.link), code = safeCode(r.error); return `• ${r.channel}: ${safeStatus(r.status)}${link ? " — " + link : ""}${code && r.status !== "publicado" ? ` (${code})` : ""}`; });
  return [`Hoje (${facts.day}), publicações:`, ...lines, `Autopublicação: ${facts.pause}.`].join("\n");
}
function salesText(facts) {
  if (!facts.sales.ok) return "O registro de vendas está ilegível agora; não vou chutar um número.";
  const s = facts.sales.value;
  if (!s) return "Ainda não há nenhuma venda registrada pelo postback da Hotmart.";
  const today = s.byDay?.[facts.day];
  return [`Vendas aprovadas no total: ${s.totals.approved} (${brl(s.totals.grossCents)} bruto).`, today ? `Hoje: ${today.approved} (${brl(today.grossCents)}).` : "Hoje: nenhuma até agora.", s.totals.refunded ? `Reembolsos: ${s.totals.refunded}.` : ""].filter(Boolean).join("\n");
}
function problemsText(facts) {
  const failing = [...findStoppedChannels(facts).map((s) => s.text), ...(facts.vigia || []).filter((o) => o.health === "falha").map((o) => o.text.split("\n")[0] + (o.fix ? " → " + o.fix : ""))];
  return failing.length ? ["Problemas abertos agora:", ...failing.map((t) => "• " + t)].join("\n") : "Nenhum problema observado agora: canais, ciclo automático, pós-venda e workflows sem falha registrada. O que não tenho como observar não conto como saudável.";
}
const HELP = "Sou o Epaminondas, o vigia da ZEVANORY e a ponte direta com você. Posso responder: \"status\" (o que publicou hoje), \"vendas\", \"o que está parado\", \"pausar\" ou \"retomar\" a autopublicação. Também te aviso sozinho quando algo parar, falhar ou entrar uma venda, digo o que já corrigi e só aviso RESOLVIDO com prova de que voltou ao normal.";
const UNKNOWN = "Ainda não sei responder isso com dados confiáveis, então não vou inventar. " + HELP;

export function intentOf(text) {
  const t = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  if (/\b(retom|despaus|religa|volta[r]? a publicar)/.test(t)) return "retomar";
  if (/\b(pausa|pausar|para[r]? tudo|suspend)/.test(t)) return "pausar";
  if (/\b(vend|faturou|faturamento|receita|compra)/.test(t)) return "vendas";
  if (/\b(parad|problema|falh|erro|alerta|quebr)/.test(t)) return "problemas";
  if (/\b(status|publicou|publicac|canais|canal|postou|hoje)/.test(t)) return "status";
  if (/\b(ajuda|comando|o que voce faz|menu)\b/.test(t)) return "ajuda";
  return "livre";
}

// A IA só escolhe uma palavra da lista fechada; qualquer outra saída = desconhecido. Cota reservada antes.
async function reserveAi(sql, day) {
  const rows = await sql.query(`/*owner-chat:ai-reserve*/ insert into zevanory_owner_chat_ai_usage (day, n) values ($1::date, 1)
    on conflict (day) do update set n = zevanory_owner_chat_ai_usage.n + 1 where zevanory_owner_chat_ai_usage.n < $2 returning n`, [day, AI_DAILY_LIMIT]);
  return rows.length === 1;
}
export async function classifyWithAi(env, sql, text, day) {
  if (!env.AI?.run) return "livre";
  if (!(await reserveAi(sql, day).catch(() => false))) return "livre";
  // Orçamento compartilhado de neurônios do Workers AI (o mesmo do chat do site; NC-CX-1030-06). Sem reserva
  // confirmada nos dois níveis, nenhuma chamada.
  try { await ensureSiteChatSchema(sql); if (!(await reserveChatNeurons(sql))) return "livre"; } catch { return "livre"; }
  try {
    const r = await Promise.race([
      env.AI.run(AI_MODEL, { messages: [{ role: "system", content: "Classifique a mensagem do dono da empresa em UMA palavra desta lista e responda só a palavra: status, vendas, problemas, ajuda, nenhum. status = o que foi publicado; vendas = vendas e receita; problemas = algo parado ou com erro; ajuda = o que você sabe fazer." }, { role: "user", content: text.slice(0, 400) }], max_tokens: 4, temperature: 0 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("ai_timeout")), 6000)),
    ]);
    const word = String(r?.response || "").trim().toLowerCase().replace(/[^a-z]/g, "");
    return ["status", "vendas", "problemas", "ajuda"].includes(word) ? word : "livre";
  } catch { return "livre"; }
}

export async function answer(env, sql, text, facts) {
  let intent = intentOf(text);
  if (intent === "livre") intent = await classifyWithAi(env, sql, text, facts.day);
  if (intent === "status") return { text: statusText(facts) };
  if (intent === "vendas") return { text: salesText(facts) };
  if (intent === "problemas") return { text: problemsText(facts) };
  if (intent === "ajuda") return { text: HELP };
  if (intent === "pausar" || intent === "retomar") {
    const type = intent === "pausar" ? "pausar_criativos" : "retomar_criativos";
    return { text: `Confirma? ${ACTIONS[type].label}. Toque no botão em até 10 minutos.`, action: type, kind: "acao" };
  }
  return { text: UNKNOWN };
}

// ---------- Sentinela ----------
// Canais como observações do vigia: "publicado" é evidência saudável (com o horário da publicação); dia sem agenda,
// canal desligado, snapshot ausente ou antes do horário = desconhecido (sem observação).
export function observeChannels(facts, now) {
  if (!facts.snap) return [];
  const out = [];
  for (const [channel] of Object.entries(EXPECTED_HOUR)) {
    if (OWNER_DISABLED_CHANNELS.includes(channel)) continue;
    const row = facts.snap.today.find((r) => r?.channel === channel);
    // Publicação só é evidência com data válida, de hoje e não futura (NC-CX-1031-01); sem data = desconhecido.
    if (row?.status === "publicado") { const at = Date.parse(row.at); if (Number.isFinite(at) && at <= now.getTime() + 5 * 60000 && localParts(new Date(at)).day === facts.day) out.push({ key: "canal:" + channel, health: "saudavel", at }); }
  }
  for (const s of findStoppedChannels(facts)) {
    if (s.channel === "motor") continue;
    out.push({ key: "canal:" + s.channel, health: "falha", at: now.getTime(), text: "CANAL PARADO — " + s.text + (s.reason === "pausado" ? " Diga \"retomar\" para religar." : ""), fix: s.reason === "pausado" ? "Nível 2: um toque seu (retomar)." : s.reason === "sem_credencial" ? "Nível 2: refazer o login da plataforma." : "Nível 1: o motor tenta de novo no próximo horário; se repetir, nível 3." });
  }
  return out;
}

export async function runOwnerChatSentinel(env, now = new Date(), { sqlFactory, snapshot } = {}) {
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  if (!kv?.get || !sqlFactory || !env.DATABASE_URL) return { ok: false, code: "not_configured" };
  const facts = await gatherFacts(env, now, snapshot ? { snapshot } : {});
  const sql = sqlFactory(env.DATABASE_URL);
  let ensured = false;
  const insert = async (db, m) => { if (!ensured) { await ensureOwnerChatSchema(db); ensured = true; } return insertMessage(db, m); };
  // Incidentes (abrir, resolver com evidência posterior, outbox idempotente) — worker/vigia-incidents.mjs.
  const inc = await runIncidents({ sql, kv, observations: [...observeChannels(facts, now), ...(facts.vigia || [])], insertMessage: insert, now: now.getTime() });
  // Venda nova: aviso único por total aprovado (chave única no banco; dica no KV evita acordar o banco).
  let sales = 0;
  const approved = facts.sales.ok ? facts.sales.value?.totals?.approved ?? 0 : null;
  if (approved) {
    const hintKey = OWNER_CHAT_HINT_PREFIX + "venda";
    let last = null; try { last = await kv.get(hintKey); } catch {}
    if (last !== String(approved)) {
      if (await insert(sql, { from: "zevanory", kind: "venda", dedupe: `venda:${approved}`, text: `💰 Venda aprovada! Total de vendas: ${approved}.\n${salesText(facts)}` })) sales++;
      try { await kv.put(hintKey, String(approved), { expirationTtl: 30 * 86400 }); } catch {}
    }
  }
  if (inc.delivered || sales) await bumpVersion(kv);
  if (inc.db) await reconcileActions(sql, kv).catch(() => null);
  return { ok: true, alerts: inc.delivered + sales, opened: inc.opened, resolved: inc.resolved };
}

// Retenção diária identificável e independente de novidades (NC-G6-1030-09). Chamada pelo cron horário às 06 UTC;
// falha é registrada e a próxima execução tenta de novo (DELETE é idempotente).
export async function runOwnerChatRetention(env, { sqlFactory } = {}) {
  if (!sqlFactory || !env.DATABASE_URL) return { ok: false, code: "not_configured" };
  try {
    const sql = sqlFactory(env.DATABASE_URL);
    await ensureOwnerChatSchema(sql);
    const m = await sql.query(`/*owner-chat:retention*/ with d as (delete from zevanory_owner_chat_messages where created_at < now() - interval '180 days' returning 1) select count(*)::int as n from d`, []);
    const a = await sql.query(`/*owner-chat:retention-ai*/ with d as (delete from zevanory_owner_chat_ai_usage where day < current_date - 60 returning 1) select count(*)::int as n from d`, []);
    return { ok: true, messages: Number(m[0]?.n || 0), ai_days: Number(a[0]?.n || 0) };
  } catch { return { ok: false, code: "retention_failed" }; }
}

// ---------- Ações: conferência do resultado ----------
const INCERTO_TEXT = "⚠️ Resultado incerto: a ordem pode ter sido aplicada. Vou conferir sozinho em até 2 minutos e te aviso. Não peça de novo agora.";
async function settleAction(sql, id, state) {
  await sql.query(`/*owner-chat:settle*/ update zevanory_owner_chat_messages set action_state = $2 where id = $1::bigint and action_state in ('executando', 'incerto')`, [id, state]);
}
// A trava ocupada há mais de RECONCILE_AFTER_S indica ação executando (recibo perdido) ou incerta. Confere o efeito
// real; só libera a trava com resultado conhecido. Leitura indisponível mantém tudo como está.
export async function reconcileActions(sql, kv) {
  const held = await sql.query(`/*owner-chat:lock-read*/ select holder::text as holder, extract(epoch from (now() - since))::integer as age from zevanory_owner_chat_action_lock where k = 1 and holder is not null`, []);
  if (!held[0] || held[0].age < RECONCILE_AFTER_S) return { reconciled: 0 };
  const id = held[0].holder;
  const msg = await sql.query(`/*owner-chat:action-state*/ select action_state, action_type from zevanory_owner_chat_messages where id = $1::bigint and action_type is not null`, [id]);
  const def = ACTIONS[msg[0]?.action_type];
  if (!msg[0] || !def || !["executando", "incerto", "executado", "nao_aplicado"].includes(msg[0].action_state)) {
    await sql.query(`/*owner-chat:unlock*/ update zevanory_owner_chat_action_lock set holder = null, since = null where k = 1 and holder = $1::bigint`, [id]);
    return { reconciled: 0 };
  }
  // Já liquidada (recibo gravado, nota/trava pendentes): a conferência repete o resultado gravado, sem reler o KV.
  let ok;
  if (msg[0].action_state === "executado" || msg[0].action_state === "nao_aplicado") ok = msg[0].action_state === "executado";
  else {
    let current;
    try { current = await kv.get(CREATIVE_AUTOPUBLISH_PAUSE_KEY); } catch { return { reconciled: 0 }; }
    ok = current === def.value || (def.value === "0" && current === null);
    await settleAction(sql, id, ok ? "executado" : "nao_aplicado");
  }
  await insertMessage(sql, { from: "zevanory", kind: "sistema", dedupe: "conferido:" + id, text: ok ? "✅ Conferi: a ordem foi aplicada. " + def.done : "Conferi: a ordem NÃO foi aplicada. Nada mudou. Pode pedir de novo." });
  await sql.query(`/*owner-chat:unlock*/ update zevanory_owner_chat_action_lock set holder = null, since = null where k = 1 and holder = $1::bigint`, [id]);
  await bumpVersion(kv);
  return { reconciled: 1 };
}

// ---------- HTTP ----------
function sameOrigin(request, url) { return request.headers.get("origin") === url.origin && request.headers.get("x-owner-chat") === "1"; }
const unauthorized = () => new Response("autenticação necessária", { status: 401, headers: { "www-authenticate": 'Basic realm="ZEVANORY proprietario", charset="UTF-8"', "cache-control": "no-store" } });
export const isOwnerChatPath = (pathname) => pathname === OWNER_CHAT_PATHS.page || pathname.startsWith("/api/admin/owner-chat/");

export async function handleOwnerChat(request, env = {}, { isAdminAuthorized, sqlFactory, snapshot } = {}) {
  const url = new URL(request.url);
  if (!isOwnerChatPath(url.pathname)) return null;
  if (typeof isAdminAuthorized !== "function" || !isAdminAuthorized(request, env)) return unauthorized();
  if (url.pathname === OWNER_CHAT_PATHS.page) return new Response(null, { status: 302, headers: { location: OWNER_CHAT_PATHS.app, "cache-control": "no-store" } });
  if (url.pathname === OWNER_CHAT_PATHS.app) {
    if (request.method !== "GET") return new Response(null, { status: 405 });
    return new Response(OWNER_CHAT_PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" } });
  }
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  if (!kv?.get || !sqlFactory || !env.DATABASE_URL) return json({ error: "owner_chat_unavailable" }, 503);
  try {
    if (url.pathname === "/api/admin/owner-chat/feed") {
      if (request.method !== "GET") return new Response(null, { status: 405 });
      const seen = url.searchParams.get("v") || "";
      const afterRaw = url.searchParams.get("after");
      const after = afterRaw !== null && /^\d{1,18}$/.test(afterRaw) ? afterRaw : null;
      let version = null;
      try { version = await kv.get(OWNER_CHAT_VERSION_KEY); } catch {}
      if (version !== null && seen && version === seen) return json({ same: true, v: version });
      const sql = sqlFactory(env.DATABASE_URL);
      await ensureOwnerChatSchema(sql);
      await reconcileActions(sql, kv).catch(() => null);
      // Sem cursor: as últimas FEED_LIMIT (histórico inicial). Com cursor: seq > after, em páginas de FEED_PAGE, em
      // ordem; o cursor devolvido é a última seq entregue (nunca a de uma sobreposição).
      if (after === null) {
        const rows = (await sql.query(`/*owner-chat:feed*/ select ${ROW} from zevanory_owner_chat_messages order by seq desc limit $1`, [FEED_LIMIT])).map(toMessage).reverse();
        return json({ v: version, messages: rows, cursor: rows.length ? rows.at(-1).seq : "0", more: false });
      }
      const page = await sql.query(`/*owner-chat:feed-after*/ select ${ROW} from zevanory_owner_chat_messages where seq > $1::bigint order by seq asc limit $2`, [after, FEED_PAGE + 1]);
      const rows = page.slice(0, FEED_PAGE).map(toMessage);
      return json({ v: version, messages: rows, cursor: rows.length ? rows.at(-1).seq : after, more: page.length > FEED_PAGE });
    }
    if (request.method !== "POST" || !sameOrigin(request, url)) return json({ error: "forbidden" }, 403);
    const body = await request.json().catch(() => null);
    const sql = sqlFactory(env.DATABASE_URL);
    await ensureOwnerChatSchema(sql);
    if (url.pathname === "/api/admin/owner-chat/message") {
      const text = typeof body?.text === "string" ? body.text.trim() : "";
      if (!text || text.length > MAX_TEXT) return json({ error: "text_invalid" }, 400);
      const mine = await insertMessage(sql, { from: "owner", kind: "chat", text });
      const facts = await gatherFacts(env, new Date(), snapshot ? { snapshot } : {});
      const reply = await answer(env, sql, text, facts);
      const theirs = await insertMessage(sql, { from: "zevanory", kind: reply.kind || "chat", text: reply.text, action: reply.action || null });
      await bumpVersion(kv);
      return json({ messages: [mine, theirs].filter(Boolean) });
    }
    if (url.pathname === "/api/admin/owner-chat/action") {
      const id = typeof body?.id === "string" && /^\d{1,18}$/.test(body.id) ? body.id : null;
      if (!id) return json({ error: "action_not_found" }, 404);
      await reconcileActions(sql, kv).catch(() => null);
      // Ordem durável (NC-CX-1030-02): uma única ação por vez. A trava só é liberada quando o resultado é conhecido;
      // ação incerta segura a trava até a conferência, então nenhuma ordem posterior a ultrapassa.
      const locked = await sql.query(`/*owner-chat:lock*/ insert into zevanory_owner_chat_action_lock (k, holder, since) values (1, $1::bigint, now())
        on conflict (k) do update set holder = excluded.holder, since = now() where zevanory_owner_chat_action_lock.holder is null returning holder`, [id]);
      if (!locked[0]) return json({ error: "action_in_progress", messages: [] }, 409);
      const release = () => sql.query(`/*owner-chat:unlock*/ update zevanory_owner_chat_action_lock set holder = null, since = null where k = 1 and holder = $1::bigint`, [id]);
      const claimed = await sql.query(`/*owner-chat:claim*/ update zevanory_owner_chat_messages set action_state = 'executando'
        where id = $1::bigint and action_state = 'proposta' and action_expires_at > now() returning action_type`, [id]);
      if (!claimed[0]) {
        await release();
        const cur = await sql.query(`/*owner-chat:action-state*/ select action_state, action_expires_at > now() as live from zevanory_owner_chat_messages where id = $1::bigint and action_type is not null`, [id]);
        if (!cur[0]) return json({ error: "action_not_found" }, 404);
        return json({ error: cur[0].action_state === "proposta" && !cur[0].live ? "action_expired" : "action_already_used" }, cur[0].action_state === "proposta" ? 410 : 409);
      }
      const def = ACTIONS[claimed[0].action_type];
      // Antes do efeito, falha comprovada = nada foi feito. Depois de tentar o PUT, erro = INCERTO (pode ter sido aplicado).
      if (!def) { await settleAction(sql, id, "nao_aplicado"); await release(); return json({ error: "action_unknown" }, 409); }
      // Ordem que não muda nada (já estava no estado pedido) é dita como tal, sem escrita; assim "conferi: aplicada"
      // nunca se apoia num valor que já existia antes da ordem.
      let prior = "desconhecido";
      try { prior = await kv.get(CREATIVE_AUTOPUBLISH_PAUSE_KEY); } catch {}
      const already = prior === def.value || (def.value === "0" && prior === null);
      let applied = already;
      if (!already) { try { await kv.put(CREATIVE_AUTOPUBLISH_PAUSE_KEY, def.value); applied = true; } catch {} }
      // Daqui em diante, qualquer erro = INCERTO com a trava segura: a conferência (até 2 min) liquida e avisa.
      // A trava só é liberada DEPOIS do recibo e da nota gravados, então nenhuma confirmação se perde.
      try {
        if (applied) {
          await settleAction(sql, id, "executado");
          const note = await insertMessage(sql, { from: "zevanory", kind: "sistema", text: (already ? "✅ Já estava assim. " : "✅ ") + def.done, dedupe: "acao:" + id });
          await release();
          await bumpVersion(kv);
          return json({ ok: true, state: "executado", messages: [note].filter(Boolean) });
        }
        await settleAction(sql, id, "incerto");
        const note = await insertMessage(sql, { from: "zevanory", kind: "sistema", text: INCERTO_TEXT, dedupe: "acao:" + id }).catch(() => null);
        await bumpVersion(kv);
        return json({ ok: false, state: "incerto", messages: [note].filter(Boolean) }, 202);
      } catch {
        return json({ ok: false, state: "incerto", messages: [] }, 202);
      }
    }
    return json({ error: "not_found" }, 404);
  } catch {
    return json({ error: "owner_chat_unavailable" }, 503);
  }
}

export const OWNER_CHAT_PAGE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Epaminondas — Chat do Proprietário · ZEVANORY</title>
<style>:root{--bg:#0b1220;--card:#121b2e;--me:#1d4ed8;--zv:#1e293b;--tx:#e5e7eb;--mu:#94a3b8;--al:#b45309;--ok:#15803d}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;flex-direction:column;height:100dvh}
header{padding:12px 16px;background:var(--card);font-weight:700;display:flex;justify-content:space-between;align-items:center}header small{color:var(--mu);font-weight:400}
#log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
.m{max-width:min(680px,88%);padding:10px 12px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word}.owner{align-self:flex-end;background:var(--me)}.zevanory{align-self:flex-start;background:var(--zv)}
.alerta{border-left:4px solid var(--al)}.venda{border-left:4px solid var(--ok)}.t{display:block;color:var(--mu);font-size:12px;margin-top:4px}
button{font:inherit;border:0;border-radius:10px;padding:10px 14px;background:#2563eb;color:#fff;cursor:pointer}button:disabled{opacity:.5}
form{display:flex;gap:8px;padding:12px 16px;background:var(--card)}input{flex:1;font:inherit;padding:12px;border-radius:10px;border:1px solid #334155;background:#0f172a;color:var(--tx)}
</style></head><body><header>Epaminondas · ZEVANORY <small id="st">conectando…</small></header><main id="log" aria-live="polite"></main>
<form id="f"><input id="q" autocomplete="off" maxlength="1500" placeholder="Fale com o Epaminondas (ex.: status, vendas, o que está parado)"><button id="b">Enviar</button></form>
<script>(()=>{const log=document.getElementById('log'),st=document.getElementById('st'),q=document.getElementById('q'),b=document.getElementById('b');let ver='';const nodes=new Map();
const H={'content-type':'application/json','x-owner-chat':'1'};
function render(m){const d=document.createElement('div');d.className='m '+m.from+' '+m.kind;d.textContent=m.text;
if(m.action&&m.action.state==='proposta'&&Date.now()<m.action.expiresAt){const k=document.createElement('button');k.textContent='Confirmar';k.style.marginTop='8px';k.style.display='block';k.onclick=async()=>{k.disabled=true;const r=await fetch('/api/admin/owner-chat/action',{method:'POST',headers:H,body:JSON.stringify({id:m.id})});const j=await r.json().catch(()=>({}));(j.messages||[]).forEach(add);k.textContent=j.state==='executado'?'Executado':j.state==='incerto'?'Resultado incerto — conferindo':r.status>=500?'Sem confirmação — vou conferir e avisar':j.error==='action_in_progress'?'Outra ordem em andamento':'Não executado ('+(j.error||r.status)+')';};d.appendChild(k);}
const t=document.createElement('span');t.className='t';t.textContent=new Date(m.at).toLocaleString('pt-BR');d.appendChild(t);return d;}
function add(m){if(!m||nodes.has(m.id))return;const d=render(m);d.dataset.id=m.id;nodes.set(m.id,d);
d.dataset.seq=m.seq;const after=[...log.children].find(x=>BigInt(x.dataset.seq)>BigInt(m.seq));log.insertBefore(d,after||null);log.scrollTop=log.scrollHeight;}
let full=0,cur='';async function poll(){if(document.hidden)return;const force=Date.now()-full>=${FEED_MAX_STALE_MS};const qs=new URLSearchParams();if(cur)qs.set('after',cur);if(!force&&ver)qs.set('v',ver);try{const r=await fetch('/api/admin/owner-chat/feed?'+qs);const j=await r.json();if(r.ok){if(force)full=Date.now();if(!j.same){(j.messages||[]).forEach(add);if(/^\\d+$/.test(j.cursor||'')&&(!cur||BigInt(j.cursor)>BigInt(cur)))cur=j.cursor;}if(j.v)ver=j.v;st.textContent='ao vivo';if(j.more)setTimeout(poll,0);}else st.textContent='instável ('+(j.error||r.status)+')';}catch{st.textContent='sem conexão';}}
document.getElementById('f').onsubmit=async e=>{e.preventDefault();const text=q.value.trim();if(!text)return;b.disabled=true;q.value='';try{const r=await fetch('/api/admin/owner-chat/message',{method:'POST',headers:H,body:JSON.stringify({text})});const j=await r.json().catch(()=>({}));(j.messages||[]).forEach(add);if(!r.ok)st.textContent='erro ('+(j.error||r.status)+')';}finally{b.disabled=false;q.focus();}};
document.addEventListener('visibilitychange',poll);poll();setInterval(poll,5000);})();</script></body></html>`;
