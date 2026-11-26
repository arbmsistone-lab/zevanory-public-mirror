// ZEVANORY | Acesso do proprietário ao chat por PIN de 6 dígitos (pedido do proprietário, 26/11/2026).
// Só para o chat do proprietário (/admin/proprietario e /api/admin/owner-chat/*). O Basic do console continua valendo.
// * PIN: segredo do Worker `OWNER_CHAT_PIN` (exatamente 6 dígitos). Ausente ou fora do formato => PIN DESLIGADO
//   (comportamento anterior: só Basic). O valor nunca é logado nem devolvido.
// * Sessão: token aleatório de 32 bytes em cookie HttpOnly+Secure+SameSite=Strict (12 h). No KV só fica o SHA-256 do
//   token (TTL 12 h). Sair apaga a sessão.
// * Força bruta (10^6 combinações): por IP, 5 erros em 15 min bloqueiam o IP por 15 min; no total, 20 erros por hora
//   bloqueiam QUALQUER login por PIN até a hora virar (o Basic segue funcionando). Comparação em tempo constante.
// * CSRF: login/saída só por POST com Origin igual e cabeçalho x-owner-chat: 1.
export const OWNER_PIN_PATHS = Object.freeze({ login: "/api/admin/owner-chat/pin", logout: "/api/admin/owner-chat/logout" });
export const PIN_COOKIE = "zv_owner_chat";
export const PIN_SESSION_TTL_S = 12 * 3600;
export const PIN_IP_MAX = 5, PIN_IP_WINDOW_S = 900, PIN_GLOBAL_MAX = 20;
const SESSION_PREFIX = "zpc:owner-chat:pin-session:v1:";
const FAIL_IP_PREFIX = "zpc:owner-chat:pin-fail:ip:v1:";
const FAIL_GLOBAL_PREFIX = "zpc:owner-chat:pin-fail:global:v1:";

export function pinConfigured(env = {}) { return /^\d{6}$/.test(String(env.OWNER_CHAT_PIN ?? "")); }

const enc = new TextEncoder();
async function sha256Hex(s) {
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
function cookieValue(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
const clientIp = (request) => (request.headers.get("cf-connecting-ip") || "sem-ip").slice(0, 64);
const hourKey = (now) => new Date(now).toISOString().slice(0, 13);
const noStore = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...noStore, ...extra } });

// Sessão válida? Só lê o KV se o PIN estiver ligado E houver cookie no formato certo.
export async function hasPinSession(request, env = {}) {
  if (!pinConfigured(env)) return false;
  const token = cookieValue(request, PIN_COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return false;
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  if (!kv?.get) return false;
  try { return (await kv.get(SESSION_PREFIX + (await sha256Hex(token)))) === "1"; } catch { return false; }
}

async function readCount(kv, key) { const v = await kv.get(key); const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; }

// POST /api/admin/owner-chat/pin  {"pin":"123456"}
export async function handlePinLogin(request, env = {}, { now = Date.now() } = {}) {
  const url = new URL(request.url);
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (request.headers.get("origin") !== url.origin || request.headers.get("x-owner-chat") !== "1") return json({ error: "forbidden" }, 403);
  if (!pinConfigured(env)) return json({ error: "pin_disabled" }, 404);
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  if (!kv?.get || !kv?.put) return json({ error: "owner_chat_unavailable" }, 503);
  let pin = "";
  try { pin = String((await request.json())?.pin ?? ""); } catch { return json({ error: "invalid" }, 400); }
  const ipKey = FAIL_IP_PREFIX + (await sha256Hex(clientIp(request)));
  const globalKey = FAIL_GLOBAL_PREFIX + hourKey(now);
  let ipFails, globalFails;
  try { [ipFails, globalFails] = await Promise.all([readCount(kv, ipKey), readCount(kv, globalKey)]); }
  catch { return json({ error: "owner_chat_unavailable" }, 503); }
  if (ipFails >= PIN_IP_MAX || globalFails >= PIN_GLOBAL_MAX) return json({ error: "locked", retry_after_s: ipFails >= PIN_IP_MAX ? PIN_IP_WINDOW_S : 3600 }, 429);
  const ok = /^\d{6}$/.test(pin) && (await samePin(pin, String(env.OWNER_CHAT_PIN)));
  if (!ok) {
    try {
      await kv.put(ipKey, String(ipFails + 1), { expirationTtl: PIN_IP_WINDOW_S });
      await kv.put(globalKey, String(globalFails + 1), { expirationTtl: 3600 });
    } catch { /* falha ao contar não libera nada: a resposta continua 401 */ }
    console.warn(JSON.stringify({ event: "owner_chat_pin_failed", ip_fails: ipFails + 1, global_fails: globalFails + 1 }));
    return json({ error: "pin_incorreto", restantes: Math.max(0, PIN_IP_MAX - ipFails - 1) }, 401);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  try { await kv.put(SESSION_PREFIX + (await sha256Hex(token)), "1", { expirationTtl: PIN_SESSION_TTL_S }); }
  catch { return json({ error: "owner_chat_unavailable" }, 503); }
  console.info(JSON.stringify({ event: "owner_chat_pin_login" }));
  return json({ ok: true }, 200, { "set-cookie": `${PIN_COOKIE}=${token}; Path=/; Max-Age=${PIN_SESSION_TTL_S}; HttpOnly; Secure; SameSite=Strict` });
}

// POST /api/admin/owner-chat/logout
export async function handlePinLogout(request, env = {}) {
  const url = new URL(request.url);
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (request.headers.get("origin") !== url.origin || request.headers.get("x-owner-chat") !== "1") return json({ error: "forbidden" }, 403);
  const token = cookieValue(request, PIN_COOKIE);
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  if (token && /^[0-9a-f]{64}$/.test(token) && kv?.delete) { try { await kv.delete(SESSION_PREFIX + (await sha256Hex(token))); } catch {} }
  return json({ ok: true }, 200, { "set-cookie": `${PIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` });
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
p.addEventListener("input",()=>{p.value=p.value.replace(/\\D/g,"").slice(0,6);if(p.value.length===6)go();});
p.addEventListener("keydown",e=>{if(e.key==="Enter")go();});b.addEventListener("click",go);
async function go(){if(!/^\\d{6}$/.test(p.value)){m.textContent="O PIN tem 6 números.";return;}b.disabled=true;m.textContent="";
try{const r=await fetch("${OWNER_PIN_PATHS.login}",{method:"POST",headers:{"content-type":"application/json","x-owner-chat":"1"},body:JSON.stringify({pin:p.value}),credentials:"same-origin"});
const j=await r.json().catch(()=>({}));if(r.ok){location.replace("/admin/proprietario");return;}
m.textContent=r.status===429?"Muitas tentativas. Aguarde e tente de novo mais tarde.":r.status===401?("PIN incorreto."+(typeof j.restantes==="number"?" Tentativas restantes: "+j.restantes+".":"")):"Não foi possível entrar agora.";}
catch{m.textContent="Sem conexão. Tente de novo.";}p.value="";b.disabled=false;p.focus();}
</script></body></html>`;
