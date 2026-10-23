// P01 Fase A: rotas públicas da lista de espera no Worker de vendas (vendas.zevanory.api.br).
// Bandeira FASE_A_WAITLIST="on" obrigatória (padrão: ausente = DESLIGADO -> 404 em todas as rotas).
// Mesmas proteções do formulário do material gratuito: agente de automação recusado, limite por IP
// (BUY_LIMITER, chave própria), honeypot "website". O IP nunca vai ao núcleo para inscrições; nas
// visitas, IP e navegador vão ao núcleo só para o código pseudônimo diário (HMAC com segredo dedicado),
// processados de forma transitória e nunca gravados em claro. Identificador da pessoa experimental:
// cookie próprio "zvfa" (aleatório, assinado pelo núcleo, Path=/lista-de-espera, expira no fim da janela,
// no máximo 60 dias), confirmado quando o navegador o devolve (folha de estilo /lista-de-espera/c/<nicho>.css).
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
      src: SOURCE_RE.test(src) ? src : "sem_tag", ua, asn: Number(request.cf?.asn) || 0, vid: readCookie(request) };
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

  // Confirmação do identificador: a folha de estilo vazia é pedida pelo navegador com o cookie; só quem
  // devolve o cookie vira pessoa experimental confirmada (navegador sem cookie = só exposição pessoa-dia).
  const c = path.match(/^\/lista-de-espera\/c\/([a-z-]{3,40})\.css$/);
  if (c) {
    if (!Object.prototype.hasOwnProperty.call(WAITLIST_PAGES, c[1]) || request.method !== "GET") return notFound();
    const vid = readCookie(request);
    if (vid && ctx?.waitUntil) ctx.waitUntil(env.CORE.fetch("https://waitlist.internal/confirmar", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nicho: c[1], vid }) }).catch(() => null));
    return new Response("/* fase-a */\n", { status: 200, headers: applySecurityHeaders(new Headers({ "content-type": "text/css; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" })) });
  }
  const m = path.match(/^\/lista-de-espera\/([a-z-]{3,40})$/);
  const slug = m && Object.prototype.hasOwnProperty.call(WAITLIST_PAGES, m[1]) ? m[1] : null;
  if (!slug || (request.method !== "GET" && request.method !== "HEAD")) return notFound();
  const asset = await env.ASSETS.fetch(new Request(new URL("/" + WAITLIST_PAGES[slug] + ".html", request.url), { method: "GET" }));
  if (asset.status !== 200) return notFound();
  let html = await asset.text();
  const headers = applySecurityHeaders(new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" }));
  if (request.method === "GET") {
    // A visita é registrada ANTES da resposta, porque o núcleo pode emitir o identificador (cookie).
    // IP e navegador seguem só para o código pseudônimo; nunca são gravados em claro.
    // Origem (protocolo v3): utm_source cru (rótulo curto) e se houve referer externo; o núcleo classifica
    // pela lista fechada e devolve o rótulo, que vai no campo oculto "origem" do formulário.
    const utm = String(url.searchParams.get("utm_source") || "").toLowerCase().slice(0, 40);
    let refExt = false; try { const h = new URL(request.headers.get("referer") || "").hostname; refExt = Boolean(h) && h !== url.hostname; } catch {}
    const body = { nicho: slug, method: "GET", ua: request.headers.get("user-agent") || "", ip: request.headers.get("cf-connecting-ip") || "", asn: Number(request.cf?.asn) || 0, purpose: request.headers.get("sec-purpose") || request.headers.get("purpose") || "", vid: readCookie(request), utm: /^[a-z0-9_-]{1,40}$/.test(utm) ? utm : (utm ? "x" : ""), ref_ext: refExt };
    try {
      const { data } = await core(env, "/visita", body);
      if (/^[a-z0-9_]{1,32}$/.test(String(data?.src || ""))) html = html.replace('name="origem" value="sem_tag"', `name="origem" value="${esc(data.src)}"`);
      const ck = data?.cookie;
      if (ck && ck.name === COOKIE && COOKIE_VALUE.test(String(ck.value)) && Number.isInteger(ck.maxAge) && ck.maxAge > 0 && ck.maxAge <= 60 * 86400)
        headers.append("set-cookie", `${COOKIE}=${ck.value}; Path=/lista-de-espera; Max-Age=${ck.maxAge}; Secure; HttpOnly; SameSite=Lax`);
    } catch {}
  }
  return new Response(request.method === "HEAD" ? null : html, { status: 200, headers });
}
