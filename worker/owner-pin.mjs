// ZEVANORY | Acesso do proprietário ao chat por PIN de 6 dígitos (pedido do proprietário, 26/11/2026).
// Só para o chat do proprietário (/admin/proprietario e /api/admin/owner-chat/*). O Basic do console continua valendo.
// * PIN: segredo do Worker `OWNER_CHAT_PIN` (exatamente 6 dígitos). Ausente ou fora do formato => PIN DESLIGADO
//   (comportamento anterior: só Basic). O valor nunca é logado nem devolvido.
// * Sessão (R1): token aleatório de 32 bytes em cookie HttpOnly+Secure+SameSite=Strict (12 h). A AUTORIDADE é a linha
//   em zevanory_owner_chat_sessions no PostgreSQL primário (só o SHA-256 do token; validade pelo relógio do banco).
//   O KV não participa. Banco indisponível = acesso negado. Ver worker/owner-session.mjs.
// * Força bruta (O1): por IP, 5 tentativas em 15 min; no total, 20 por hora UTC. Contadores atômicos no PostgreSQL,
//   reservados ANTES da comparação (exatos sob tentativas simultâneas em pontos de presença diferentes).
// * CSRF: login/saída só por POST com Origin igual e cabeçalho x-owner-chat: 1.
// * Encerramento pendente (R2): cookie `zv_owner_chat_end=1` gravado pela página ao clicar em Sair. Com ele, o servidor
//   não entrega nada privado (409 logout_pending) até um logout confirmado; só o POST de logout (com CSRF) revoga.
import { SESSION_AUTHORITY, SESSION_TTL_S, PIN_IP_MAX, PIN_IP_WINDOW_S, PIN_GLOBAL_MAX, checkSession, createSession, revokeSession, reserveAttempt, releaseAttempt } from "./owner-session.mjs";
export { PIN_IP_MAX, PIN_IP_WINDOW_S, PIN_GLOBAL_MAX };
export const OWNER_PIN_PATHS = Object.freeze({ login: "/api/admin/owner-chat/pin", logout: "/api/admin/owner-chat/logout" });
export const PIN_COOKIE = "zv_owner_chat";
export const END_COOKIE = "zv_owner_chat_end";
export const PIN_SESSION_TTL_S = SESSION_TTL_S;

export function pinConfigured(env = {}) { return /^\d{6}$/.test(String(env.OWNER_CHAT_PIN ?? "")); }

const enc = new TextEncoder();
export async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// Tempo constante sobre os digests (mesmo comprimento sempre).
async function samePin(a, b) {
  const [x, y] = await Promise.all([sha256Hex("pin:" + a), sha256Hex("pin:" + b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}
export function cookieValue(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
const clientIp = (request) => (request.headers.get("cf-connecting-ip") || "sem-ip").slice(0, 64);
const noStore = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const json = (data, status = 200, cookies = []) => {
  const h = new Headers({ "content-type": "application/json; charset=utf-8", ...noStore });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(JSON.stringify(data), { status, headers: h });
};
const CLEAR_SESSION = `${PIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
const CLEAR_END = `${END_COOKIE}=; Path=/; Max-Age=0; Secure; SameSite=Strict`;

// Hash do token do cookie (formato estrito) ou null.
export async function sessionHash(request) {
  const token = cookieValue(request, PIN_COOKIE);
  return token && /^[0-9a-f]{64}$/.test(token) ? sha256Hex(token) : null;
}
export const logoutPending = (request) => cookieValue(request, END_COOKIE) === "1";

// Sessão válida? PIN ligado, fase "postgres", cookie no formato e linha válida no banco. Qualquer erro = não.
export async function hasPinSession(request, env = {}, { sql, authority = SESSION_AUTHORITY } = {}) {
  if (!pinConfigured(env) || authority !== "postgres" || !sql) return false;
  const hash = await sessionHash(request);
  if (!hash) return false;
  try { return await checkSession(sql, hash); } catch { return false; }
}

// POST /api/admin/owner-chat/pin  {"pin":"123456"}
export async function handlePinLogin(request, env = {}, { sql, authority = SESSION_AUTHORITY } = {}) {
  const url = new URL(request.url);
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (request.headers.get("origin") !== url.origin || request.headers.get("x-owner-chat") !== "1") return json({ error: "forbidden" }, 403);
  if (!pinConfigured(env)) return json({ error: "pin_disabled" }, 404);
  if (authority !== "postgres") return json({ error: "owner_chat_maintenance" }, 503);
  if (!sql) return json({ error: "owner_chat_unavailable" }, 503);
  let pin = "";
  try { pin = String((await request.json())?.pin ?? ""); } catch { return json({ error: "invalid" }, 400); }
  const ipHash = await sha256Hex(clientIp(request));
  let res;
  try { res = await reserveAttempt(sql, ipHash); } catch { return json({ error: "owner_chat_unavailable" }, 503); }
  // Bloqueado: o PIN NÃO é comparado e a reserva é devolvida (como antes, tentativa bloqueada não conta erro nem
  // renova a janela). Sob concorrência a contagem pode ficar momentaneamente acima do limite: só bloqueia a mais.
  if (res.ipN > PIN_IP_MAX || res.globalN > PIN_GLOBAL_MAX) {
    try { await releaseAttempt(sql, ipHash, res); } catch { /* fica contada: conservador */ }
    return json({ error: "locked", retry_after_s: res.ipN > PIN_IP_MAX ? PIN_IP_WINDOW_S : 3600 }, 429);
  }
  const ok = /^\d{6}$/.test(pin) && (await samePin(pin, String(env.OWNER_CHAT_PIN)));
  if (!ok) {
    console.warn(JSON.stringify({ event: "owner_chat_pin_failed", ip_attempts: res.ipN, global_attempts: res.globalN }));
    return json({ error: "pin_incorreto", restantes: Math.max(0, PIN_IP_MAX - res.ipN) }, 401);
  }
  try { await releaseAttempt(sql, ipHash, res); } catch { /* fica contada: conservador */ }
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  // O cookie só sai depois do commit da sessão no banco.
  try { if (!(await createSession(sql, await sha256Hex(token)))) throw new Error("no_row"); }
  catch { return json({ error: "owner_chat_unavailable" }, 503); }
  console.info(JSON.stringify({ event: "owner_chat_pin_login" }));
  return json({ ok: true }, 200, [`${PIN_COOKIE}=${token}; Path=/; Max-Age=${SESSION_TTL_S}; HttpOnly; Secure; SameSite=Strict`, CLEAR_END]);
}

// POST /api/admin/owner-chat/logout
// Confirma só depois do commit da revogação no banco: 200 {ok:true, revoked:true, pending_actions}. Erro de banco =
// 503 SEM apagar o cookie (a nova tentativa ainda revoga a mesma sessão). Sem token: nada a revogar neste navegador.
export async function handlePinLogout(request, env = {}, { sql } = {}) {
  const url = new URL(request.url);
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (request.headers.get("origin") !== url.origin || request.headers.get("x-owner-chat") !== "1") return json({ error: "forbidden" }, 403);
  const hash = await sessionHash(request);
  if (!hash) return json({ ok: true, revoked: false, reason: "no_session" }, 200, [CLEAR_SESSION, CLEAR_END]);
  if (!sql) return json({ ok: false, error: "revoke_unconfirmed" }, 503);
  let out;
  try { out = await revokeSession(sql, hash); }
  catch { console.warn(JSON.stringify({ event: "owner_chat_logout_unconfirmed" })); return json({ ok: false, error: "revoke_unconfirmed" }, 503); }
  return json({ ok: true, revoked: true, pending_actions: out.pendingActions }, 200, [CLEAR_SESSION, CLEAR_END]);
}

export const PIN_PAGE_HEADERS = Object.freeze({
  "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors https://controle.zevanory.api.br",
  "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow",
});

// Tela do chat sem sessão. Desde 27/11/2026 não pede PIN: o painel (controle.zevanory.api.br) entrega um passe de uso
// único, que esta página troca por uma sessão curta (owner-panel-bridge.mjs). Fora do painel, só orienta a abrir pelo
// painel. O nome PIN_PAGE fica por compatibilidade.
export const PIN_PAGE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>ZEVANORY · Epaminondas</title>
<style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1220;color:#e5e7eb;font:15px/1.45 system-ui,Arial,sans-serif}
.c{width:min(320px,calc(100vw - 24px));padding:18px;text-align:center}h1{font-size:17px;margin:0 0 6px}p{color:#94a3b8;margin:0;font-size:14px}a{color:#38bdf8}</style></head><body><main class="c">
<h1>Epaminondas</h1><p id="m" role="status">Conectando ao painel…</p></main>
<script>
const m=document.getElementById("m"),PANEL="https://controle.zevanory.api.br";
// Esc no chat dentro do painel: avisa só a janela do painel (origem fixa); o painel confere origem e janela.
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&window.parent!==window)window.parent.postMessage({type:"zv-owner-chat:escape"},"https://controle.zevanory.api.br");});
let busy=false;
function pedir(){if(window.parent!==window)window.parent.postMessage({type:"zv-owner-chat:need-ticket"},PANEL);}
async function trocar(t){if(busy)return;busy=true;
try{const r=await fetch("/api/admin/owner-chat/panel-session",{method:"POST",headers:{"content-type":"application/json","x-owner-chat":"1"},body:JSON.stringify(t),credentials:"same-origin"});
const j=await r.json().catch(()=>({}));if(r.ok){try{localStorage.removeItem("zv_owner_chat_logout_pending")}catch{}location.replace("/admin/proprietario");return;}
m.textContent=r.status===401?"Sua sessão do painel acabou. Entre de novo no painel para conversar.":"O chat não respondeu agora. Vou tentar de novo em alguns segundos.";if(r.status!==401)setTimeout(pedir,10000);}
catch{m.textContent="Sem conexão. Vou tentar de novo em alguns segundos.";setTimeout(pedir,10000);}finally{busy=false;}}
window.addEventListener("message",e=>{if(e.origin!==PANEL||e.source!==window.parent||!e.data||e.data.type!=="zv-owner-chat:ticket"||!e.data.ticket)return;trocar(e.data.ticket);});
if(window.parent===window){m.innerHTML='O Epaminondas abre dentro do painel. Entre em <a href="https://controle.zevanory.api.br/">controle.zevanory.api.br</a>.';}else pedir();
</script></body></html>`;
