// P01 Fase A: rotas públicas da lista de espera no Worker de vendas (vendas.zevanory.api.br).
// Bandeira FASE_A_WAITLIST="on" obrigatória (padrão: ausente = DESLIGADO -> 404 em todas as rotas).
// Mesmas proteções do formulário do material gratuito: agente de automação recusado, limite por IP
// (BUY_LIMITER, chave própria), honeypot "website". O IP NUNCA vai ao núcleo; navegador (UA) e ASN só para o
// filtro de robôs, transitórios (AVAL 101 §2). Unidade: navegador/dispositivo pseudônimo, cookie próprio "zvfa"
// (aleatório, assinado pelo núcleo, Path=/lista-de-espera, expira no fim da janela ativa).
// Aviso antes da coleta (AVAL 101 §3): abrir a página NÃO mede nada. A medição só começa quando o navegador pede a
// folha de estilo do aviso (/lista-de-espera/a/<nicho>.css?aviso=<versão>), posicionada no FIM do bloco do aviso:
// ela registra a visita, emite o cookie e importa /lista-de-espera/c/<nicho>.css, que confirma o identificador
// (o navegador devolve o cookie). Não participação: marcador zvfa_optout=1 ou Sec-GPC: 1 => nenhuma chamada de
// medição, nenhum cookie; o identificador existente é apagado quando localizável.
// Páginas: noindex, fora da navegação e do sitemap; só existem nos assets se o build da Fase A rodou
// com ZEVANORY_FASE_A_PAGES=on (scripts/fase_a/build_fase_a.py). Sem link /comprar/, sem Offer.
export const WAITLIST_PAGES = Object.freeze({ "confeitaria": "lista-de-espera-confeitaria", "loja-de-roupas": "lista-de-espera-loja-de-roupas", "salao-e-barbearia": "lista-de-espera-salao-e-barbearia" });
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const flagOn = (env) => String(env?.FASE_A_WAITLIST || "").trim().toLowerCase() === "on";
const hits = new Map();
function memLimited(key) { const now = Date.now(); const e = hits.get(key); if (!e || now - e.t > 60000) { hits.set(key, { t: now, n: 1 }); return false; } e.n += 1; return e.n > 10; }
export function resetWaitlistLimiter() { hits.clear(); }
async function limited(env, ip) {
  if (env?.BUY_LIMITER?.limit) { try { const r = await env.BUY_LIMITER.limit({ key: "buy:waitlist:" + ip }); return !r.success; } catch {} }
  return memLimited("waitlist:" + ip);
}
// Mensagens fixas por código do núcleo (nenhum texto do núcleo vai para o HTML).
export const MESSAGES = Object.freeze({
  inscrito: ["Você entrou na lista de espera", "Obrigado! Guardamos o seu contato. Não há cobrança nem reserva: avisaremos se as vendas do kit abrirem."],
  ja_inscrito: ["Você já está na lista de espera", "Este contato já estava na lista deste kit. Nada foi duplicado."],
  contato: ["Confira o seu contato", "Informe um WhatsApp com DDD (só números) ou um e-mail válido."],
  consentimento: ["Falta a sua autorização", "Para entrar na lista, marque a caixa de autorização do uso dos seus dados."],
  perguntas: ["Faltam respostas", "Responda às duas perguntas (sim ou não) para entrar na lista."],
  nicho: ["Página inválida", "Volte à página da lista de espera e tente de novo."],
  indisponivel: ["Não foi possível concluir", "Tente novamente em instantes."],
});
function page(applySecurityHeaders, status, title, body) {
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)} | ZEVANORY</title><link rel="stylesheet" href="/product.css"></head><body><main class="wrap" id="conteudo"><h1>${esc(title)}</h1>${body}<p><a href="/privacidade">Política de Privacidade</a> · <a href="mailto:suporte@zevanory.api.br">suporte@zevanory.api.br</a></p></main></body></html>`;
  return new Response(html, { status, headers: applySecurityHeaders(new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" })) });
}
export const COOKIE = "zvfa";
export const OPTOUT_COOKIE = "zvfa_optout";
import { sourceTag, AVISO_VERSION } from "./waitlist.mjs";
const cookieOf = (request, name) => { for (const part of String(request.headers.get("cookie") || "").split(";")) { const [k, ...v] = part.trim().split("="); if (k === name) return v.join("="); } return ""; };
// Não participação: marcador first-party ou Sec-GPC: 1 (preferência global de privacidade).
export const notParticipating = (request) => cookieOf(request, OPTOUT_COOKIE) === "1" || String(request.headers.get("sec-gpc") || "").trim() === "1";
const clearCookie = `${"zvfa"}=; Path=/lista-de-espera; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
const css = (applySecurityHeaders, body, extra = []) => { const h = applySecurityHeaders(new Headers({ "content-type": "text/css; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" })); for (const c of extra) h.append("set-cookie", c); return new Response(body, { status: 200, headers: h }); };
const utmOf = (url) => { const u = String(url.searchParams.get("utm_source") || "").toLowerCase().slice(0, 40); return /^[a-z0-9_-]{1,40}$/.test(u) ? u : (u ? "x" : ""); };
const COOKIE_VALUE = /^[0-9a-f]{32}\.[0-9a-f]{32}$/;
export function readCookie(request) {
  for (const part of String(request.headers.get("cookie") || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE && COOKIE_VALUE.test(v.join("="))) return v.join("=");
  }
  return "";
}
const OPTOUT_RE = /^https:\/\/vendas\.zevanory\.api\.br\/lista-de-espera\/sair\?r=[0-9a-f]{64}&t=[0-9a-f]{32}$/;
const SOURCE_RE = /^[a-z0-9_]{1,32}$/;

async function core(env, path, payload) {
  const res = await env.CORE.fetch("https://waitlist.internal" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  return { res, data: await res.json().catch(() => ({})) };
}

export async function handleWaitlistPublic(request, env, ctx, { applySecurityHeaders, isAutomationUA, attribution }) {
  const url = new URL(request.url);
  if (url.pathname !== "/lista-de-espera" && !url.pathname.startsWith("/lista-de-espera/")) return null;
  const notFound = () => new Response("Not found", { status: 404, headers: applySecurityHeaders(new Headers({ "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" })) });
  if (!flagOn(env) || !env?.CORE || typeof env.CORE.fetch !== "function") return notFound();
  const path = url.pathname.replace(/\/$/, "");

  if (path === "/lista-de-espera/inscrever") {
    if (request.method !== "POST") return new Response(null, { status: 303, headers: applySecurityHeaders(new Headers({ location: "/solucoes" })) });
    const ua = request.headers.get("user-agent") || "";
    if (isAutomationUA(ua)) return page(applySecurityHeaders, 403, "Acesso não permitido", "<p>Use um navegador.</p>");
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    if (await limited(env, ip)) return page(applySecurityHeaders, 429, "Muitas tentativas", "<p>Aguarde um minuto e tente de novo.</p>");
    let form; try { form = await request.formData(); } catch { form = new FormData(); }
    if (String(form.get("website") || "")) return page(applySecurityHeaders, 200, MESSAGES.inscrito[0], `<p>${MESSAGES.inscrito[1]}</p>`);
    const nicho = String(form.get("nicho") || "");
    const src = String(form.get("origem") || "").toLowerCase();
    const payload = { nicho, contato: String(form.get("contato") || ""), nome: String(form.get("nome") || ""), q1: String(form.get("q1") || ""), q2: String(form.get("q2") || ""),
      consent: String(form.get("consentimento") || "") === "sim", interview: String(form.get("entrevista") || "") === "sim",
      src: SOURCE_RE.test(src) ? src : "sem_tag", ua, asn: Number(request.cf?.asn) || 0, vid: notParticipating(request) ? "" : readCookie(request),
      ...(notParticipating(request) ? { optout: true } : {}) };
    try {
      const { res, data } = await core(env, "/inscrever", payload);
      const code = Object.prototype.hasOwnProperty.call(MESSAGES, data?.code) ? data.code : "indisponivel";
      const [title, text] = MESSAGES[code];
      const back = WAITLIST_PAGES[nicho] ? `/lista-de-espera/${nicho}` : "/solucoes";
      if (res.ok && (code === "inscrito" || code === "ja_inscrito")) {
        const optout = OPTOUT_RE.test(String(data?.optout || "")) ? String(data.optout) : "";
        // Confirmação na tela. A dupla confirmação por e-mail/WhatsApp é a P08 (issue #871): enquanto
        // ela não existir, nenhuma mensagem é enviada; o link de saída é mostrado aqui mesmo.
        return page(applySecurityHeaders, 200, title, `<p>${text}</p>${optout ? `<p>Guarde este link para sair da lista e apagar seus dados quando quiser: <a href="${esc(optout)}">sair da lista de espera</a>.</p>` : ""}<p>Você também pode pedir a remoção pelo e-mail suporte@zevanory.api.br.</p>`);
      }
      return page(applySecurityHeaders, res.status >= 500 ? 503 : 400, title, `<p>${text}</p><p><a class="button primary" href="${back}">Voltar</a></p>`);
    } catch { return page(applySecurityHeaders, 503, MESSAGES.indisponivel[0], `<p>${MESSAGES.indisponivel[1]}</p>`); }
  }

  if (path === "/lista-de-espera/sair") {
    const r = String(url.searchParams.get("r") || ""), t = String(url.searchParams.get("t") || "");
    const how = "<p>Para sair da lista de espera e apagar seus dados, use o link mostrado quando você se inscreveu ou escreva para suporte@zevanory.api.br (ou pelo WhatsApp +55 88 99254-5413) informando o contato cadastrado. Atendemos em até 15 dias.</p>";
    if (request.method === "GET" || request.method === "HEAD") {
      if (!r && !t) return page(applySecurityHeaders, 200, "Sair da lista de espera", how);
      try {
        const { res } = await core(env, "/sair/verificar", { r, t });
        if (!res.ok) return page(applySecurityHeaders, 400, "Link inválido", how);
      } catch { return page(applySecurityHeaders, 503, MESSAGES.indisponivel[0], how); }
      return page(applySecurityHeaders, 200, "Sair da lista e apagar seus dados?", `<p>Ao confirmar, apagamos seu contato, seu nome e suas respostas de todas as listas de espera da Fase A.</p><form method="post" action="/lista-de-espera/sair?r=${esc(r)}&amp;t=${esc(t)}"><button class="button primary" type="submit">Confirmar e sair</button></form>`);
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: applySecurityHeaders(new Headers({ allow: "GET, POST" })) });
    try {
      const { res } = await core(env, "/sair", { r, t });
      if (!res.ok) return page(applySecurityHeaders, 400, "Link inválido", how);
      return page(applySecurityHeaders, 200, "Pronto.", "<p>Você saiu da lista de espera. Seu contato, seu nome e suas respostas foram apagados.</p>");
    } catch { return page(applySecurityHeaders, 503, MESSAGES.indisponivel[0], how); }
  }

  // Não participar da medição (AVAL 101 §4): sem login nem justificativa. GET explica; POST grava zvfa_optout=1
  // (até o fim da janela ativa), apaga o cookie de medição e as linhas localizáveis desse navegador.
  if (path === "/lista-de-espera/nao-participar") {
    const form = `<form method="post" action="/lista-de-espera/nao-participar"><button class="button primary" type="submit">Não participar da medição</button></form>`;
    if (request.method === "GET" || request.method === "HEAD") return page(applySecurityHeaders, 200, "Não participar da medição", `<p>Ao confirmar, este navegador deixa de ser medido: guardamos só um marcador de não participação (zvfa_optout=1) até o fim do teste e apagamos o identificador de medição deste navegador, se houver. A lista de espera continua disponível.</p>${form}`);
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: applySecurityHeaders(new Headers({ allow: "GET, POST" })) });
    let maxAge = 60 * 86400, erased = 0;
    try { const { res, data } = await core(env, "/nao-participar", { vid: readCookie(request) }); if (res.ok) { if (Number.isInteger(data?.maxAge) && data.maxAge > 0 && data.maxAge <= 60 * 86400) maxAge = data.maxAge; erased = Number(data?.erased) || 0; } } catch {}
    const r = page(applySecurityHeaders, 200, "Pronto: este navegador não participa da medição", `<p>Guardamos só o marcador de não participação neste navegador. ${erased ? "O registro de medição deste navegador foi apagado." : "Não havia registro de medição localizável neste navegador."}</p>`);
    r.headers.append("set-cookie", `${OPTOUT_COOKIE}=1; Path=/lista-de-espera; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`);
    r.headers.append("set-cookie", clearCookie);
    return r;
  }
  // Ação local do titular: confirmação simplificada imediata + código opaco de atendimento (nunca o cookie bruto).
  if (path === "/lista-de-espera/meus-dados") {
    if (request.method !== "GET") return notFound();
    const vid = readCookie(request);
    let rows = [], token = null;
    if (vid) { try { const { res, data } = await core(env, "/meus-dados", { vid }); if (res.ok) { rows = Array.isArray(data?.rows) ? data.rows : []; token = /^[0-9a-f]{32}$/.test(String(data?.token || "")) ? data.token : null; } } catch { return page(applySecurityHeaders, 503, MESSAGES.indisponivel[0], `<p>${MESSAGES.indisponivel[1]}</p>`); } }
    const list = rows.filter((x) => WAITLIST_PAGES[x.niche]).map((x) => `<li>${esc(x.niche)}: de ${esc(x.first_day)} a ${esc(x.last_day)} (${esc(String(x.days))} dia(s))</li>`).join("");
    const body = rows.length ? `<p>Há registro de medição pseudônima deste navegador:</p><ul>${list}</ul><p>Código de atendimento (opaco, não é o cookie): <strong>${esc(token || "")}</strong>. Use-o se quiser fazer um pedido pelo canal de privacidade.</p><form method="post" action="/lista-de-espera/nao-participar"><button class="button primary" type="submit">Apagar e não participar da medição</button></form>` : "<p>Não há registro de medição deste navegador.</p>";
    return page(applySecurityHeaders, 200, "Meus dados de medição", body);
  }
  // Folha de estilo do AVISO: só é pedida depois que o navegador recebeu o bloco do aviso (fica no fim dele). É o
  // sinal pré-coleta: registra a visita, emite o cookie e importa a folha de confirmação (que devolve o cookie).
  const a = path.match(/^\/lista-de-espera\/a\/([a-z-]{3,40})\.css$/);
  if (a) {
    if (!Object.prototype.hasOwnProperty.call(WAITLIST_PAGES, a[1]) || request.method !== "GET") return notFound();
    const vid = readCookie(request);
    if (notParticipating(request)) {
      if (vid && ctx?.waitUntil) ctx.waitUntil(core(env, "/nao-participar", { vid }).catch(() => null));
      return css(applySecurityHeaders, "/* fase-a: nao participa */\n", vid ? [clearCookie] : []);
    }
    const body = { nicho: a[1], method: "GET", aviso: String(url.searchParams.get("aviso") || "").slice(0, 60), ua: request.headers.get("user-agent") || "", asn: Number(request.cf?.asn) || 0,
      purpose: request.headers.get("sec-purpose") || request.headers.get("purpose") || "", vid, utm: String(url.searchParams.get("utm") || "").slice(0, 40), ref_ext: url.searchParams.get("ref") === "1" };
    const cookies = [];
    try {
      const { data } = await core(env, "/visita", body);
      const ck = data?.cookie;
      if (ck && ck.name === COOKIE && COOKIE_VALUE.test(String(ck.value)) && Number.isInteger(ck.maxAge) && ck.maxAge > 0 && ck.maxAge <= 60 * 86400)
        cookies.push(`${COOKIE}=${ck.value}; Path=/lista-de-espera; Max-Age=${ck.maxAge}; Secure; HttpOnly; SameSite=Lax`);
    } catch {}
    return css(applySecurityHeaders, `/* fase-a: aviso */\n@import url("/lista-de-espera/c/${a[1]}.css");\n`, cookies);
  }
  // Confirmação do identificador: pedida pelo @import da folha do aviso, já com o cookie; só quem devolve o cookie
  // vira navegador confirmado.
  const c = path.match(/^\/lista-de-espera\/c\/([a-z-]{3,40})\.css$/);
  if (c) {
    if (!Object.prototype.hasOwnProperty.call(WAITLIST_PAGES, c[1]) || request.method !== "GET") return notFound();
    const vid = readCookie(request);
    if (vid && !notParticipating(request) && ctx?.waitUntil) ctx.waitUntil(env.CORE.fetch("https://waitlist.internal/confirmar", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nicho: c[1], vid }) }).catch(() => null));
    return css(applySecurityHeaders, "/* fase-a */\n");
  }
  const m = path.match(/^\/lista-de-espera\/([a-z-]{3,40})$/);
  const slug = m && Object.prototype.hasOwnProperty.call(WAITLIST_PAGES, m[1]) ? m[1] : null;
  if (!slug || (request.method !== "GET" && request.method !== "HEAD")) return notFound();
  const asset = await env.ASSETS.fetch(new Request(new URL("/" + WAITLIST_PAGES[slug] + ".html", request.url), { method: "GET" }));
  if (asset.status !== 200) return notFound();
  let html = await asset.text();
  const headers = applySecurityHeaders(new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" }));
  // Abrir a página NÃO chama o núcleo nem emite cookie (aviso antes da coleta). A origem do link é classificada
  // aqui (lista fechada) para o campo oculto e viaja na folha do aviso, que é quem registra a visita.
  const utm = utmOf(url);
  let refExt = false; try { const h = new URL(request.headers.get("referer") || "").hostname; refExt = Boolean(h) && h !== url.hostname; } catch {}
  html = html.replace('name="origem" value="sem_tag"', `name="origem" value="${esc(sourceTag({ utm: utm === "x" ? "invalido_" : utm, refExternal: refExt }))}"`);
  const avisoHref = `/lista-de-espera/a/${slug}.css?aviso=${AVISO_VERSION}`;
  if (notParticipating(request)) html = html.replace(`<link rel="stylesheet" href="${avisoHref}">`, "");
  else html = html.replace(`<link rel="stylesheet" href="${avisoHref}">`, `<link rel="stylesheet" href="${esc(avisoHref + (utm ? "&utm=" + encodeURIComponent(utm) : "") + (refExt ? "&ref=1" : ""))}">`);
  return new Response(request.method === "HEAD" ? null : html, { status: 200, headers });
}
