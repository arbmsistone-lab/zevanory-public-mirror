// Chat do Proprietário (12/11/2026): a ZEVANORY conversa com o dono em tempo real.
// Página autenticada /admin/proprietario + API /api/admin/owner-chat/* no Worker central.
// Garantias (testes em tests/owner-chat.test.mjs):
// * Basic auth do console (isAdminAuthorized) em TODAS as rotas; 401 antes de qualquer leitura.
// * Escrita só por POST same-origin com cabeçalho x-owner-chat: 1 (o navegador reenvia Basic auth
//   em pedidos cruzados; Origin + cabeçalho próprio fecham CSRF).
// * Respostas só com dados reais (snapshot de aquisição, livro de vendas, pausa criativa). Sem dado,
//   diz que não sabe. A IA (Workers AI gratuita) só reescreve; número que não está no contexto derruba
//   a resposta gerada para a determinística.
// * Ações só da lista branca (pausar/retomar a autopublicação criativa), com proposta que expira em
//   10 min e confirmação explícita por botão. Toda ação fica registrada na conversa.
// * Sentinela proativa (cron :05/:35): canal sem publicação depois do horário esperado vira alerta
//   CANAL_PARADO com o motivo (pausado, sem credencial, erro); venda aprovada nova vira aviso.
//   Deduplicação por dia+canal+motivo. Escreve no KV só quando há novidade.
// * Uma única chave KV (thread), leitura estrita: ausente = conversa nova; ilegível = cópia preservada
//   em chave de quarentena e conversa reiniciada com aviso (nunca sobrescreve sem preservar).
import { acquisitionSnapshot, OWNER_DISABLED_CHANNELS } from "./acquisition-engine.mjs";
import { SALES_SUMMARY_KEY } from "./sales-ledger.mjs";
import { CREATIVE_AUTOPUBLISH_PAUSE_KEY } from "./creative-autonomy.mjs";

export const OWNER_CHAT_THREAD_KEY = "zpc:owner-chat:thread:v1";
export const OWNER_CHAT_QUARANTINE_PREFIX = "zpc:owner-chat:thread:quarentena:";
const MAX_MESSAGES = 200, MAX_TEXT = 1500, ACTION_TTL_MS = 10 * 60 * 1000;
// Horário local (São Paulo) a partir do qual a publicação do dia é esperada; +1h de tolerância.
export const EXPECTED_HOUR = Object.freeze({ blog: 9, bluesky: 19 });
const TOLERANCE_H = 1;
const AI_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8-fast";
const ACTIONS = Object.freeze({
  pausar_criativos: { label: "Pausar a autopublicação (blog e Bluesky)", value: "1", done: "Autopublicação PAUSADA. Nada novo será publicado até você retomar." },
  retomar_criativos: { label: "Retomar a autopublicação", value: "0", done: "Autopublicação RETOMADA. Os canais voltam a publicar no próximo horário." },
});

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
const obj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");
const localParts = (now) => {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const g = (t) => f.find((x) => x.type === t)?.value;
  return { day: `${g("year")}-${g("month")}-${g("day")}`, hour: Number(g("hour")) };
};

const validMessage = (m) => obj(m) && typeof m.id === "string" && /^[0-9]{13}-[0-9a-f]{12}$/.test(m.id) && typeof m.at === "string" && Number.isFinite(Date.parse(m.at)) && ["owner", "zevanory"].includes(m.from) && typeof m.text === "string" && m.text.length <= 4000 && ["chat", "alerta", "venda", "acao", "sistema"].includes(m.kind) && (m.action === undefined || (obj(m.action) && Object.hasOwn(ACTIONS, m.action.type) && Number.isFinite(m.action.expiresAt) && typeof m.action.used === "boolean"));
export const validThread = (t) => obj(t) && t.schema === "owner-chat/v1" && Array.isArray(t.messages) && t.messages.length <= MAX_MESSAGES && t.messages.every(validMessage) && obj(t.alerts) && Object.values(t.alerts).every((v) => typeof v === "string") && obj(t.seen) && Number.isSafeInteger(t.seen.approved ?? 0);
const emptyThread = () => ({ schema: "owner-chat/v1", messages: [], alerts: {}, seen: { approved: 0 } });

// Leitura estrita com recuperação segura (padrão do #1019/#1020).
export async function readThread(kv, now = new Date()) {
  const raw = await kv.get(OWNER_CHAT_THREAD_KEY); // erro de leitura propaga: nada é gravado
  if (raw === null) return { thread: emptyThread(), recovered: false };
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch {}
  if (validThread(parsed)) return { thread: parsed, recovered: false };
  await kv.put(OWNER_CHAT_QUARANTINE_PREFIX + now.getTime(), String(raw).slice(0, 24 * 1024 * 1024), { expirationTtl: 30 * 86400 });
  const thread = emptyThread();
  push(thread, { from: "zevanory", kind: "sistema", text: "O histórico anterior estava ilegível. Guardei uma cópia por 30 dias e comecei uma conversa nova." }, now);
  return { thread, recovered: true };
}

function push(thread, msg, now) {
  const m = { id: `${now.getTime()}-${rid()}`, at: now.toISOString(), ...msg };
  thread.messages.push(m);
  thread.messages = thread.messages.slice(-MAX_MESSAGES);
  return m;
}

// Gravação com conferência: o KV não tem compare-and-set. Relê, junta as mensagens novas e confere.
async function commit(kv, mutate, now) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { thread } = await readThread(kv, now);
    const added = await mutate(thread);
    if (!added) return { thread, added: [] };
    await kv.put(OWNER_CHAT_THREAD_KEY, JSON.stringify(thread), { expirationTtl: 365 * 86400 });
    const check = await kv.get(OWNER_CHAT_THREAD_KEY);
    let back = null; try { back = JSON.parse(check); } catch {}
    const ids = new Set((back?.messages || []).map((m) => m.id));
    if (added.every((m) => ids.has(m.id))) return { thread: back, added };
  }
  throw new Error("owner_chat_commit_conflict");
}

// ---------- Dados reais ----------
async function salesSummary(kv) {
  const raw = await kv.get(SALES_SUMMARY_KEY);
  if (raw === null) return { ok: true, value: null };
  try { const v = JSON.parse(raw); if (obj(v) && obj(v.totals) && Number.isSafeInteger(v.totals.approved)) return { ok: true, value: v }; } catch {}
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
  const [snap, sales, pause] = await Promise.all([
    snapshot(env, now).catch(() => null),
    salesSummary(kv).catch(() => ({ ok: false, value: null })),
    pauseState(kv).catch(() => "ilegivel"),
  ]);
  return { day, hour, snap, sales, pause };
}

// Canal esperado e sem publicação depois do horário + tolerância = CANAL_PARADO, sempre com motivo.
export function findStoppedChannels(facts) {
  const out = [];
  if (!facts.snap) return [{ channel: "motor", reason: "snapshot_indisponivel", text: "Não consegui ler o estado de publicação de hoje." }];
  for (const [channel, h] of Object.entries(EXPECTED_HOUR)) {
    if (OWNER_DISABLED_CHANNELS.includes(channel) || facts.hour < h + TOLERANCE_H) continue;
    const row = (facts.snap.today || []).find((r) => r.channel === channel);
    if (row?.status === "publicado") continue;
    const reason = facts.pause === "pausada" ? "pausado" : row?.status === "aguardando credencial" ? "sem_credencial" : row?.error || row?.status || "sem_registro";
    const why = reason === "pausado" ? "a autopublicação está PAUSADA" : reason === "sem_credencial" ? "a credencial do canal está ausente" : reason === "sem_registro" || reason === "sem dados" ? "o motor não registrou nenhuma execução hoje" : `motivo: ${reason}`;
    out.push({ channel, reason, text: `${channel}: não publicou hoje (esperado às ${h}h). ${why[0].toUpperCase() + why.slice(1)}.` });
  }
  return out;
}

function statusText(facts) {
  if (!facts.snap) return "Não consegui ler o estado de publicação agora. Tente de novo em alguns minutos.";
  const lines = (facts.snap.today || []).filter((r) => !["whatsapp"].includes(r.channel)).map((r) => `• ${r.channel}: ${r.status}${r.link ? " — " + r.link : ""}${r.error && r.status !== "publicado" ? ` (${r.error})` : ""}`);
  return [`Hoje (${facts.day}), publicações:`, ...lines, `Autopublicação: ${facts.pause}.`].join("\n");
}
function salesText(facts) {
  if (!facts.sales.ok) return "O registro de vendas está ilegível agora; não vou chutar um número.";
  const s = facts.sales.value;
  if (!s) return "Ainda não há nenhuma venda registrada pelo postback da Hotmart.";
  const today = s.byDay?.[facts.day];
  return [`Vendas aprovadas no total: ${s.totals.approved} (${brl(s.totals.grossCents || 0)} bruto).`, today ? `Hoje: ${today.approved} (${brl(today.grossCents || 0)}).` : "Hoje: nenhuma até agora.", s.totals.refunded ? `Reembolsos: ${s.totals.refunded}.` : ""].filter(Boolean).join("\n");
}
function problemsText(facts) {
  const stopped = findStoppedChannels(facts);
  return stopped.length ? ["O que está parado agora:", ...stopped.map((s) => "• " + s.text)].join("\n") : "Nenhum canal esperado está parado neste momento.";
}
const HELP = "Posso responder: \"status\" (o que publicou hoje), \"vendas\", \"o que está parado\", \"pausar\" ou \"retomar\" a autopublicação. Também te aviso sozinha quando um canal parar ou entrar uma venda.";

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

// Toda cifra da resposta gerada precisa existir no contexto; senão, vale a determinística.
export function groundedNumbers(reply, context) {
  const nums = String(reply).match(/\d+(?:[.,]\d+)*/g) || [];
  return nums.every((n) => context.includes(n) || context.includes(n.replace(/\./g, "").replace(",", ".")));
}
async function freeAnswer(env, text, facts) {
  const fallback = "Ainda não sei responder isso com dados confiáveis. " + HELP;
  if (!env.AI?.run) return fallback;
  const context = [statusText(facts), salesText(facts), problemsText(facts)].join("\n\n");
  try {
    const r = await Promise.race([
      env.AI.run(AI_MODEL, { messages: [{ role: "system", content: "Você é a ZEVANORY falando com o dono da empresa, em português do Brasil, em até 4 frases. Use SOMENTE os fatos abaixo. Se o fato não estiver abaixo, diga que não tem esse dado. Nunca invente número, venda, prazo ou promessa.\n\nFATOS:\n" + context }, { role: "user", content: text.slice(0, 600) }], max_tokens: 220, temperature: 0.2 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("ai_timeout")), 8000)),
    ]);
    const reply = String(r?.response || "").trim();
    return reply && reply.length <= 1200 && groundedNumbers(reply, context) && !/whatsapp|wa\.me/i.test(reply) ? reply : fallback;
  } catch { return fallback; }
}

export async function answer(env, text, facts, now) {
  const intent = intentOf(text);
  if (intent === "status") return { text: statusText(facts) };
  if (intent === "vendas") return { text: salesText(facts) };
  if (intent === "problemas") return { text: problemsText(facts) };
  if (intent === "ajuda") return { text: HELP };
  if (intent === "pausar" || intent === "retomar") {
    const type = intent === "pausar" ? "pausar_criativos" : "retomar_criativos";
    return { text: `Confirma? ${ACTIONS[type].label}. Toque no botão em até 10 minutos.`, action: { type, expiresAt: now.getTime() + ACTION_TTL_MS, used: false }, kind: "acao" };
  }
  return { text: await freeAnswer(env, text, facts) };
}

// ---------- Sentinela proativa ----------
export async function runOwnerChatSentinel(env, now = new Date(), deps = {}) {
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  if (!kv?.get || !kv?.put) return { ok: false, code: "kv_unavailable" };
  const facts = await gatherFacts(env, now, deps);
  const stopped = findStoppedChannels(facts);
  const { added } = await commit(kv, (thread) => {
    const added = [];
    for (const s of stopped) {
      const key = `${facts.day}:${s.channel}:${s.reason}`;
      if (thread.alerts[key]) continue;
      thread.alerts[key] = now.toISOString();
      added.push(push(thread, { from: "zevanory", kind: "alerta", text: "⚠️ CANAL PARADO — " + s.text + (s.reason === "pausado" ? " Diga \"retomar\" para religar." : "") }, now));
    }
    const approved = facts.sales.ok ? facts.sales.value?.totals?.approved ?? 0 : null;
    if (approved !== null && approved > (thread.seen.approved || 0)) {
      if (thread.seen.approved || approved > 0) added.push(push(thread, { from: "zevanory", kind: "venda", text: `💰 Nova venda aprovada! Total de vendas: ${approved}.\n${salesText(facts)}` }, now));
      thread.seen.approved = approved;
    }
    // Poda de alertas antigos (mantém 14 dias).
    for (const k of Object.keys(thread.alerts)) if (k.slice(0, 10) < new Date(now.getTime() - 14 * 86400000).toISOString().slice(0, 10)) delete thread.alerts[k];
    return added.length ? added : null;
  }, now);
  return { ok: true, alerts: added.length };
}

// ---------- HTTP ----------
function sameOrigin(request, url) {
  const origin = request.headers.get("origin");
  return origin === url.origin && request.headers.get("x-owner-chat") === "1";
}
const unauthorized = () => new Response("autenticação necessária", { status: 401, headers: { "www-authenticate": 'Basic realm="ZEVANORY proprietario", charset="UTF-8"', "cache-control": "no-store" } });

export async function handleOwnerChat(request, env = {}, { isAdminAuthorized, now = () => new Date(), deps = {} } = {}) {
  const url = new URL(request.url);
  if (!(url.pathname === "/admin/proprietario" || url.pathname.startsWith("/api/admin/owner-chat/"))) return null;
  if (typeof isAdminAuthorized !== "function" || !isAdminAuthorized(request, env)) return unauthorized();
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  if (!kv?.get || !kv?.put) return json({ error: "kv_unavailable" }, 503);
  try {
    if (url.pathname === "/admin/proprietario") {
      if (request.method !== "GET") return new Response(null, { status: 405 });
      return new Response(OWNER_CHAT_PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" } });
    }
    if (url.pathname === "/api/admin/owner-chat/feed") {
      if (request.method !== "GET") return new Response(null, { status: 405 });
      const raw = await kv.get(OWNER_CHAT_THREAD_KEY);
      let t = null; try { t = raw === null ? emptyThread() : JSON.parse(raw); } catch {}
      if (!validThread(t)) return json({ error: "thread_unreadable" }, 503);
      const after = url.searchParams.get("after") || "";
      return json({ messages: t.messages.filter((m) => m.id > after) });
    }
    if (request.method !== "POST" || !sameOrigin(request, url)) return json({ error: "forbidden" }, 403);
    const body = await request.json().catch(() => null);
    const at = now();
    if (url.pathname === "/api/admin/owner-chat/message") {
      const text = typeof body?.text === "string" ? body.text.trim() : "";
      if (!text || text.length > MAX_TEXT) return json({ error: "text_invalid" }, 400);
      const facts = await gatherFacts(env, at, deps);
      const reply = await answer(env, text, facts, at);
      const { added } = await commit(kv, (thread) => [push(thread, { from: "owner", kind: "chat", text }, at), push(thread, { from: "zevanory", kind: reply.kind || "chat", text: reply.text, ...(reply.action ? { action: reply.action } : {}) }, new Date(at.getTime() + 1))], at);
      return json({ messages: added });
    }
    if (url.pathname === "/api/admin/owner-chat/action") {
      const id = typeof body?.id === "string" ? body.id : "";
      let result = null;
      const { added } = await commit(kv, async (thread) => {
        const msg = thread.messages.find((m) => m.id === id && m.action);
        if (!msg) { result = { error: "action_not_found", status: 404 }; return null; }
        if (msg.action.used) { result = { error: "action_already_used", status: 409 }; return null; }
        if (at.getTime() > msg.action.expiresAt) { result = { error: "action_expired", status: 410 }; return null; }
        const def = ACTIONS[msg.action.type];
        await kv.put(CREATIVE_AUTOPUBLISH_PAUSE_KEY, def.value);
        msg.action.used = true;
        return [push(thread, { from: "zevanory", kind: "sistema", text: "✅ " + def.done + " (ordem registrada em " + at.toISOString() + ")" }, at)];
      }, at);
      if (result) return json({ error: result.error }, result.status);
      return json({ messages: added });
    }
    return json({ error: "not_found" }, 404);
  } catch {
    return json({ error: "owner_chat_unavailable" }, 503);
  }
}

export const OWNER_CHAT_PAGE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>ZEVANORY — Chat do Proprietário</title>
<style>:root{--bg:#0b1220;--card:#121b2e;--me:#1d4ed8;--zv:#1e293b;--tx:#e5e7eb;--mu:#94a3b8;--al:#b45309;--ok:#15803d}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;flex-direction:column;height:100dvh}
header{padding:12px 16px;background:var(--card);font-weight:700;display:flex;justify-content:space-between;align-items:center}header small{color:var(--mu);font-weight:400}
#log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
.m{max-width:min(680px,88%);padding:10px 12px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word}.owner{align-self:flex-end;background:var(--me)}.zevanory{align-self:flex-start;background:var(--zv)}
.alerta{border-left:4px solid var(--al)}.venda{border-left:4px solid var(--ok)}.t{display:block;color:var(--mu);font-size:12px;margin-top:4px}
button{font:inherit;border:0;border-radius:10px;padding:10px 14px;background:#2563eb;color:#fff;cursor:pointer}button:disabled{opacity:.5}
form{display:flex;gap:8px;padding:12px 16px;background:var(--card)}input{flex:1;font:inherit;padding:12px;border-radius:10px;border:1px solid #334155;background:#0f172a;color:var(--tx)}
</style></head><body><header>ZEVANORY <small id="st">conectando…</small></header><main id="log" aria-live="polite"></main>
<form id="f"><input id="q" autocomplete="off" maxlength="1500" placeholder="Fale com a ZEVANORY (ex.: status, vendas, o que está parado)"><button id="b">Enviar</button></form>
<script>(()=>{const log=document.getElementById('log'),st=document.getElementById('st'),q=document.getElementById('q'),b=document.getElementById('b');let last='';const seen=new Set();
const H={'content-type':'application/json','x-owner-chat':'1'};
function add(m){if(seen.has(m.id))return;seen.add(m.id);if(m.id>last)last=m.id;const d=document.createElement('div');d.className='m '+m.from+' '+m.kind;d.textContent=m.text;
if(m.action&&!m.action.used&&Date.now()<m.action.expiresAt){const k=document.createElement('button');k.textContent='Confirmar';k.style.marginTop='8px';k.style.display='block';k.onclick=async()=>{k.disabled=true;const r=await fetch('/api/admin/owner-chat/action',{method:'POST',headers:H,body:JSON.stringify({id:m.id})});const j=await r.json().catch(()=>({}));(j.messages||[]).forEach(add);if(!r.ok)k.textContent='Não executado ('+(j.error||r.status)+')';};d.appendChild(k);}
const t=document.createElement('span');t.className='t';t.textContent=new Date(m.at).toLocaleString('pt-BR');d.appendChild(t);log.appendChild(d);log.scrollTop=log.scrollHeight;}
async function poll(){try{const r=await fetch('/api/admin/owner-chat/feed?after='+encodeURIComponent(last));const j=await r.json();if(r.ok){(j.messages||[]).forEach(add);st.textContent='ao vivo';}else st.textContent='instável ('+(j.error||r.status)+')';}catch{st.textContent='sem conexão';}}
document.getElementById('f').onsubmit=async e=>{e.preventDefault();const text=q.value.trim();if(!text)return;b.disabled=true;q.value='';try{const r=await fetch('/api/admin/owner-chat/message',{method:'POST',headers:H,body:JSON.stringify({text})});const j=await r.json().catch(()=>({}));(j.messages||[]).forEach(add);if(!r.ok)st.textContent='erro ('+(j.error||r.status)+')';}finally{b.disabled=false;q.focus();}};
poll();setInterval(poll,5000);})();</script></body></html>`;
