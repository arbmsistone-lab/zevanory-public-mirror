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

export const PIN_PAGE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>ZEVANORY · Chat do proprietário</title>
<style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#05070b;color:#f5f8fc;font:16px/1.4 system-ui,Arial,sans-serif}
.c{width:min(340px,calc(100vw - 32px));background:#0b0f17;border:1px solid #1e2633;border-radius:16px;padding:28px}h1{font-size:20px;margin:0 0 6px}p{color:#a9b4c2;margin:0 0 18px;font-size:14px}
input{width:100%;box-sizing:border-box;font-size:28px;letter-spacing:10px;text-align:center;padding:12px;border-radius:10px;border:1px solid #2b3647;background:#05070b;color:#fff}
button{margin-top:14px;width:100%;padding:12px;border:0;border-radius:10px;background:#00b8ff;color:#05070b;font-weight:700;font-size:16px;cursor:pointer}button:disabled{opacity:.5}
#m{min-height:20px;margin-top:12px;font-size:14px;color:#ffb4a8}</style></head><body><main class="c">
<h1>Chat do proprietário</h1><p>Digite seu PIN de 6 dígitos.</p>
<input id="p" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" aria-label="PIN de 6 dígitos" autofocus>
<button id="b" type="button">Entrar</button><div id="m" role="status"></div></main>
<script>
const p=document.getElementById("p"),b=document.getElementById("b"),m=document.getElementById("m");
// Esc no PIN dentro do painel: avisa só a janela do painel (origem fixa); o painel confere origem e janela.
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&window.parent!==window)window.parent.postMessage({type:"zv-owner-chat:escape"},"https://controle.zevanory.api.br");});
p.addEventListener("input",()=>{p.value=p.value.replace(/\\D/g,"").slice(0,6);if(p.value.length===6)go();});
p.addEventListener("keydown",e=>{if(e.key==="Enter")go();});b.addEventListener("click",go);
async function go(){if(!/^\\d{6}$/.test(p.value)){m.textContent="O PIN tem 6 números.";return;}b.disabled=true;m.textContent="";
try{const r=await fetch("${OWNER_PIN_PATHS.login}",{method:"POST",headers:{"content-type":"application/json","x-owner-chat":"1"},body:JSON.stringify({pin:p.value}),credentials:"same-origin"});
const j=await r.json().catch(()=>({}));if(r.ok){try{localStorage.removeItem("zv_owner_chat_logout_pending")}catch{}location.replace("/admin/proprietario");return;}
m.textContent=r.status===429?"Muitas tentativas. Aguarde e tente de novo mais tarde.":r.status===401?("PIN incorreto."+(typeof j.restantes==="number"?" Tentativas restantes: "+j.restantes+".":"")):"Não foi possível entrar agora.";}
catch{m.textContent="Sem conexão. Tente de novo.";}p.value="";b.disabled=false;p.focus();}
</script></body></html>`;
