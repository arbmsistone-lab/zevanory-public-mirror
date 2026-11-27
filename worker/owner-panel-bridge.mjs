// ZEVANORY | Epaminondas sem PIN separado: a sessão do chat nasce da sessão do PAINEL (controle.zevanory.api.br).
//
// Fluxo (nenhum segredo nem sessão do painel passa pelo navegador do chat):
//  1. A borda do painel confere a sessão do proprietário (verifyEdgeSession) e emite um PASSE de 60 s, assinado com a
//     chave da ponte do proprietário (a mesma do OAuth, com rótulo próprio: domínio separado), que leva o vencimento da
//     sessão do painel.
//  2. O painel entrega o passe ao iframe do chat por postMessage (origem fixa nos dois lados).
//  3. A página do chat (mesma origem deste Worker) troca o passe aqui: assinatura, janela de 60 s, formato, uso ÚNICO
//     (linha-marcador no PostgreSQL) e vencimento do painel. Sai uma sessão do chat CURTA (até 5 min, nunca além da
//     sessão do painel), no mesmo cookie HttpOnly/Secure/Strict e na mesma tabela das sessões por PIN.
//  4. O painel renova o passe a cada 2 min enquanto a sessão dele for válida. Sair do painel manda o chat encerrar
//     (logout com revogação confirmada); sessão do painel vencida ou revogada = sem passe novo = o chat cai em até 5 min.
import { bridgeSecret } from "./owner-oauth.mjs";
import { claimTicket, createSession, revokeSession } from "./owner-session.mjs";
import { PIN_COOKIE, END_COOKIE, sha256Hex, sessionHash } from "./owner-pin.mjs";

export const PANEL_SESSION_PATH = "/api/admin/owner-chat/panel-session";
export const PANEL_TICKET_PURPOSE = "zpc-owner-chat-v1";
export const PANEL_TICKET_WINDOW_MS = 60_000;
export const PANEL_SESSION_TTL_S = 300;
export const PANEL_MIN_SESSION_S = 30;
export const PANEL_MAX_SESSION_AHEAD_MS = 13 * 3600_000;

const enc = new TextEncoder();
const noStore = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const json = (data, status = 200, cookies = []) => {
  const h = new Headers({ "content-type": "application/json; charset=utf-8", ...noStore });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(JSON.stringify(data), { status, headers: h });
};
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const same = (a, b) => { if (a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; };

export async function ticketSignature(key, { ts, nonce, exp }) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", k, enc.encode([PANEL_TICKET_PURPOSE, "session", ts, nonce, exp].join("\n"))));
}

// Confere o passe sem efeito colateral. -> { ok, reason, exp }
export async function verifyPanelTicket(key, t, now = Date.now()) {
  if (String(key || "").length < 32) return { ok: false, reason: "bridge_not_configured" };
  const ts = String(t?.ts ?? ""), nonce = String(t?.nonce ?? ""), exp = String(t?.exp ?? ""), sig = String(t?.sig ?? "");
  if (!/^\d{13}$/.test(ts) || !/^\d{13}$/.test(exp) || !/^[A-Za-z0-9_-]{40,128}$/.test(nonce) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return { ok: false, reason: "ticket_invalid" };
  if (Math.abs(now - Number(ts)) > PANEL_TICKET_WINDOW_MS) return { ok: false, reason: "ticket_expired" };
  const e = Number(exp);
  if (e - now < PANEL_MIN_SESSION_S * 1000) return { ok: false, reason: "panel_session_expired" };
  if (e - now > PANEL_MAX_SESSION_AHEAD_MS) return { ok: false, reason: "ticket_invalid" };
  if (!same(await ticketSignature(key, { ts, nonce, exp }), sig)) return { ok: false, reason: "ticket_invalid" };
  return { ok: true, exp: e, nonce };
}

// POST /api/admin/owner-chat/panel-session {ts, nonce, exp, sig}
export async function handlePanelSession(request, env = {}, { sql, authority, kv, now = () => Date.now() } = {}) {
  const url = new URL(request.url);
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (request.headers.get("origin") !== url.origin || request.headers.get("x-owner-chat") !== "1") return json({ error: "forbidden" }, 403);
  if (authority !== "postgres") return json({ error: "owner_chat_maintenance" }, 503);
  if (!sql) return json({ error: "owner_chat_unavailable" }, 503);
  let t = {};
  try { t = await request.json(); } catch { return json({ error: "ticket_invalid" }, 400); }
  let key = "";
  try { key = await bridgeSecret(env, kv); } catch { key = ""; }
  const at = now();
  const v = await verifyPanelTicket(key, t, at);
  if (!v.ok) return json({ error: v.reason }, v.reason === "bridge_not_configured" ? 503 : 401);
  try { if (!(await claimTicket(sql, await sha256Hex("panel-ticket:" + v.nonce)))) return json({ error: "ticket_used" }, 401); }
  catch { return json({ error: "owner_chat_unavailable" }, 503); }
  const ttl = Math.min(PANEL_SESSION_TTL_S, Math.floor((v.exp - at) / 1000));
  const previous = await sessionHash(request);
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
  try { if (!(await createSession(sql, await sha256Hex(token), ttl))) throw new Error("no_row"); }
  catch { return json({ error: "owner_chat_unavailable" }, 503); }
  // Renovação: a sessão anterior deste navegador é revogada (melhor esforço; ela venceria sozinha em até 5 min).
  if (previous) { try { await revokeSession(sql, previous); } catch { /* vence sozinha */ } }
  console.info(JSON.stringify({ event: "owner_chat_panel_session", ttl_s: ttl, renewed: Boolean(previous) }));
  return json({ ok: true, expires_in: ttl }, 200, [
    `${PIN_COOKIE}=${token}; Path=/; Max-Age=${ttl}; HttpOnly; Secure; SameSite=Strict`,
    `${END_COOKIE}=; Path=/; Max-Age=0; Secure; SameSite=Strict`,
  ]);
}
