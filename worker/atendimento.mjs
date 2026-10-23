// Atendimento ao consumidor por formulário web (Decreto 7.962/2013, art. 4º, V: serviço adequado e eficaz
// de atendimento em meio eletrônico, com confirmação imediata do recebimento e resposta em até 5 dias).
// Canal oficial: suporte@zevanory.api.br (a conta de mensagens da Meta foi banida em 2026-10-10;
// data/politica-unica.json, contato_publico). Este formulário complementa o mailto, sem substituí-lo.
//
// Tipos: suporte, reclamação, cancelamento e reembolso/arrependimento. O arrependimento continua
// disponível pela mesma ferramenta usada na contratação (/pedir-reembolso, worker/refund-flow.mjs): o
// formulário registra o pedido com protocolo e aponta para lá.
//
// Protocolo idempotente: o mesmo envio (tipo + e-mail + pedido + mensagem) em 24 h devolve o MESMO
// protocolo e não reenvia e-mails (duplo clique, reenvio do formulário, refresh do POST).
// LGPD / dados mínimos: o registro guardado tem só protocolo, tipo, datas, e-mail mascarado e hashes;
// o conteúdo vai por e-mail ao proprietário (resposta pelo e-mail informado). Só se esse e-mail falhar o
// conteúdo fica guardado, por 14 dias, para reenvio. Nada de dado pessoal em log (nenhum console.*).
// Anti-spam: campo isca (honeypot), limite por IP e por e-mail (KV), tamanho máximo; sem captcha de terceiros.
// Sem JavaScript: o formulário funciona com POST HTML e a confirmação aparece na tela na mesma resposta.
import { LEGAL_IDENTITY, SLA_TEXT, SUPPORT_EMAIL } from "./politica-unica.mjs";

export const ATENDIMENTO_PATH = "/atendimento";
export const ATENDIMENTO_API = "/api/atendimento";
export const RESPONSE_DAYS = 5;
export const TIPOS = Object.freeze({
  suporte: "Suporte (dúvida, acesso, entrega ou arquivo)",
  reclamacao: "Reclamação",
  cancelamento: "Cancelamento (assinatura ou pedido)",
  reembolso: "Reembolso ou direito de arrependimento",
});
const PREFIX = "atendimento:";
const RECORD_TTL = 180 * 24 * 3600;   // prova do atendimento ao consumidor (protocolo, sem conteúdo)
const PENDING_TTL = 14 * 24 * 3600;
const IDEM_TTL = 24 * 3600;           // reenvio idêntico em 24 h devolve o mesmo protocolo   // conteúdo só quando o e-mail ao proprietário falhou
const MAX_MESSAGE = 4000;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clean = (v, max) => String(v ?? "").normalize("NFKC").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);
const HTML_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer" };
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };

async function sha256(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function maskEmail(email) {
  const [u, d] = String(email).split("@");
  return (u || "").slice(0, 2) + "***@" + (d || "");
}
const brDate = (ms) => new Date(ms - 3 * 3600 * 1000).toISOString().slice(0, 10).split("-").reverse().join("/");

// Protocolo: ZEV-AAAAMMDD-XXXXXXXXXX (data de Brasília do primeiro envio + 10 hex do hash do envio).
export function protocolFor(hash, nowMs) {
  const day = new Date(nowMs - 3 * 3600 * 1000).toISOString().slice(0, 10).replaceAll("-", "");
  return `ZEV-${day}-${hash.slice(0, 10).toUpperCase()}`;
}

async function sendEmail(env, { to, subject, text, replyTo }) {
  if (!env.RESEND_API_KEY || !to) return false;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: `ZEVANORY <${SUPPORT_EMAIL}>`, to: [to], reply_to: replyTo || SUPPORT_EMAIL, subject, text }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => null);
  return Boolean(r?.ok);
}

async function overLimit(kv, key, max, ttl) {
  // Melhor esforço: falha de armazenamento nunca bloqueia um pedido de consumo.
  try {
    const n = Number(await kv.get(key) || 0);
    if (n >= max) return true;
    await kv.put(key, String(n + 1), { expirationTtl: ttl });
  } catch {}
  return false;
}

export function parseInput(raw = {}) {
  const tipo = clean(raw.tipo, 20);
  return {
    tipo: Object.hasOwn(TIPOS, tipo) ? tipo : "",
    email: clean(raw.email, 254).toLowerCase(),
    pedido: clean(raw.pedido, 64).toLowerCase(),
    mensagem: clean(raw.mensagem, MAX_MESSAGE + 1),
    isca: clean(raw.website, 200),
  };
}

export function validate(input) {
  const errors = {};
  if (!input.tipo) errors.tipo = "Escolha o tipo de solicitação.";
  if (!EMAIL_RE.test(input.email)) errors.email = "Informe um e-mail válido: a resposta chega por ele.";
  if (input.pedido && !UUID.test(input.pedido)) errors.pedido = "O código do pedido está no e-mail de entrega (formato xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx). Deixe em branco se não tiver.";
  if (input.mensagem.length < 10) errors.mensagem = "Descreva a solicitação (pelo menos 10 caracteres).";
  if (input.mensagem.length > MAX_MESSAGE) errors.mensagem = `Use no máximo ${MAX_MESSAGE} caracteres.`;
  return errors;
}

// Registra (ou reencontra) a solicitação e confirma imediatamente. Retorna {status, body}.
export async function registerRequest(env, input, { ip = "unknown", now = Date.now() } = {}) {
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  if (!kv) return { status: 503, body: { error: "atendimento_indisponivel", message: `Não foi possível registrar agora. Escreva para ${SUPPORT_EMAIL}.` } };
  // Isca preenchida: robô. Resposta genérica, nada é gravado nem enviado.
  if (input.isca) return { status: 200, body: { received: true, ignored: true } };
  const errors = validate(input);
  if (Object.keys(errors).length) return { status: 400, body: { error: "dados_invalidos", errors } };
  const hash = await sha256([input.tipo, input.email, input.pedido, input.mensagem.replace(/\s+/g, " ")].join("␟"));
  const idemKey = `${PREFIX}idem:${hash}`;
  const existing = await kv.get(idemKey, { type: "json" }).catch(() => null);
  if (existing?.protocolo) return { status: 200, body: { received: true, duplicate: true, ...publicView(existing) } };
  const hour = new Date(now).toISOString().slice(0, 13);
  const emailHash = await sha256(input.email);
  if (await overLimit(kv, `${PREFIX}rate:ip:${hour}:${await sha256(ip)}`, 5, 3600) || await overLimit(kv, `${PREFIX}rate:email:${new Date(now).toISOString().slice(0, 10)}:${emailHash}`, 4, 86400)) {
    return { status: 429, body: { error: "muitas_tentativas", message: `Muitas solicitações em pouco tempo. Tente de novo mais tarde ou escreva para ${SUPPORT_EMAIL}.` } };
  }
  const protocolo = protocolFor(hash, now);
  const record = {
    protocolo,
    tipo: input.tipo,
    status: "recebido",
    recebido_em: new Date(now).toISOString(),
    responder_ate: new Date(now + RESPONSE_DAYS * 86400000).toISOString(),
    email_mascarado: maskEmail(input.email),
    email_hash: emailHash,
    pedido_informado: Boolean(input.pedido),
    canal_resposta: "email",
  };
  await kv.put(idemKey, JSON.stringify(record), { expirationTtl: IDEM_TTL });
  await kv.put(`${PREFIX}protocolo:${protocolo}`, JSON.stringify(record), { expirationTtl: RECORD_TTL });
  const prazo = brDate(now + RESPONSE_DAYS * 86400000);
  const ownerTo = String(env.OWNER_ALERT_EMAIL || "zevanory@gmail.com");
  const ownerOk = await sendEmail(env, {
    to: ownerTo,
    replyTo: input.email,
    subject: `ZEVANORY atendimento ${protocolo} — ${TIPOS[input.tipo]}`,
    text: `Protocolo: ${protocolo}\nTipo: ${TIPOS[input.tipo]}\nRecebido em: ${record.recebido_em}\nResponder até: ${prazo} (resposta conclusiva em até ${RESPONSE_DAYS} dias)\nPedido: ${input.pedido || "não informado"}\nResponder para: ${input.email} (responda este e-mail)\n\n${input.mensagem}\n`,
  });
  if (!ownerOk) {
    // Sem perder a solicitação: conteúdo guardado só até o reenvio (14 dias).
    try { await kv.put(`${PREFIX}alerta-pendente:${protocolo}`, JSON.stringify({ ...record, email: input.email, pedido: input.pedido, mensagem: input.mensagem }), { expirationTtl: PENDING_TTL }); } catch {}
  }
  const reembolso = input.tipo === "reembolso"
    ? `\nSe o pedido foi pago, você também pode registrar o reembolso automaticamente, pela mesma ferramenta usada na compra: https://zevanory.api.br/pedir-reembolso (código do pedido + e-mail do pagamento).`
    : "";
  const customerOk = await sendEmail(env, {
    to: input.email,
    subject: `ZEVANORY — recebemos sua solicitação (protocolo ${protocolo})`,
    text: `Recebemos sua solicitação.\n\nProtocolo: ${protocolo}\nTipo: ${TIPOS[input.tipo]}\nRecebida em: ${brDate(now)}\nResposta conclusiva até: ${prazo}, por este e-mail.${reembolso}\n\nPara acrescentar informações, responda este e-mail informando o protocolo.\n\n${LEGAL_IDENTITY} · ${SUPPORT_EMAIL}`,
  });
  return { status: 200, body: { received: true, ...publicView(record), email_confirmacao: customerOk ? "enviado" : "pendente" } };
}

function publicView(r) {
  return { protocolo: r.protocolo, tipo: r.tipo, recebido_em: r.recebido_em, responder_ate: r.responder_ate, canal_resposta: "email" };
}

const STYLE = "body{margin:0;font-family:system-ui,sans-serif;background:#05070b;color:#e7ecf7}main{max-width:560px;margin:0 auto;padding:32px 20px}.zv-brand{display:block;margin:0 0 22px}.zv-brand img{display:block;height:44px;width:auto}a{color:#7fd3ff}h1{font-size:26px}p,li{color:#b9c4dc;line-height:1.5}fieldset{border:1px solid #24324f;border-radius:10px;margin:18px 0 0;padding:10px 14px}legend{font-weight:600;padding:0 6px}.opt{display:flex;gap:10px;align-items:center;min-height:44px}.opt input{width:22px;height:22px}label.f{display:block;margin:18px 0 6px;font-weight:600}input[type=email],input[type=text],textarea{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #24324f;background:#0b1220;color:#fff;font-size:16px}textarea{min-height:140px}:focus-visible{outline:3px solid #7fd3ff;outline-offset:2px}.hint{font-size:14px;color:#94a3bf;margin:4px 0 0}.err{color:#ffb4b4;font-weight:600;margin:6px 0 0}button{margin-top:22px;width:100%;min-height:48px;padding:14px;border:0;border-radius:10px;background:#00b8ff;color:#04121f;font-weight:700;font-size:16px;cursor:pointer}.isca{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}.ok{border:1px solid #2f6f4f;background:#0b1a14;border-radius:10px;padding:16px}.proto{font-size:22px;font-weight:700;color:#fff;letter-spacing:.02em}.zv-legal{margin-top:24px;padding-top:14px;border-top:1px solid #1c2a44;font-size:12px;color:#7f8ca3;line-height:1.6}";

function shell(title, body) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · ZEVANORY</title><meta name="robots" content="noindex"><link rel="icon" href="/brand/export/avatar-400.png"><style>${STYLE}</style></head><body><main id="conteudo"><a class="zv-brand" href="https://vendas.zevanory.api.br/"><img src="/brand/zevanory-logo-dark.svg" alt="ZEVANORY" width="224" height="51"></a>${body}<p class="zv-legal">${esc(LEGAL_IDENTITY)} · <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> · <a href="https://vendas.zevanory.api.br/termos">Termos</a> · <a href="https://vendas.zevanory.api.br/privacidade">Privacidade</a> · <a href="https://vendas.zevanory.api.br/reembolso">Reembolso</a></p></main></body></html>`;
}

export function formPage({ values = {}, errors = {}, tipo = "" } = {}) {
  const sel = values.tipo || (Object.hasOwn(TIPOS, tipo) ? tipo : "");
  const err = (k) => errors[k] ? `<p class="err" id="err-${k}">${esc(errors[k])}</p>` : "";
  const desc = (k, hint) => `aria-describedby="${hint ? `hint-${k}` : ""}${errors[k] ? ` err-${k}` : ""}"${errors[k] ? ' aria-invalid="true"' : ""}`;
  const summary = Object.keys(errors).length ? `<div role="alert"><p class="err">Corrija os campos indicados abaixo.</p></div>` : "";
  const opts = Object.entries(TIPOS).map(([k, label]) => `<div class="opt"><input type="radio" id="tipo-${k}" name="tipo" value="${k}" required${sel === k ? " checked" : ""}><label for="tipo-${k}">${esc(label)}</label></div>`).join("");
  return shell("Atendimento", `<h1>Atendimento</h1>
<p>Suporte, reclamação, cancelamento ou reembolso. Você recebe na hora um <strong>número de protocolo</strong>, na tela e por e-mail. ${esc(SLA_TEXT)} A resposta chega pelo e-mail que você informar.</p>
<p>Prefere e-mail? Escreva para <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>. Para desistir de uma compra (direito de arrependimento), use também a <a href="/pedir-reembolso">mesma ferramenta usada na compra</a>.</p>
${summary}<form method="post" action="${ATENDIMENTO_API}" novalidate>
<fieldset ${errors.tipo ? 'aria-describedby="err-tipo" aria-invalid="true"' : ""}><legend>Tipo de solicitação</legend>${opts}${err("tipo")}</fieldset>
<label class="f" for="email">Seu e-mail (a resposta chega por ele)</label><input id="email" name="email" type="email" required autocomplete="email" inputmode="email" maxlength="254" value="${esc(values.email || "")}" ${desc("email", false)}>${err("email")}
<label class="f" for="pedido">Código do pedido (opcional)</label><input id="pedido" name="pedido" type="text" autocomplete="off" maxlength="64" value="${esc(values.pedido || "")}" ${desc("pedido", true)}><p class="hint" id="hint-pedido">Está no e-mail de entrega. Deixe em branco se não tiver.</p>${err("pedido")}
<label class="f" for="mensagem">Descreva a solicitação</label><textarea id="mensagem" name="mensagem" required minlength="10" maxlength="${MAX_MESSAGE}" ${desc("mensagem", true)}>${esc(values.mensagem || "")}</textarea><p class="hint" id="hint-mensagem">Não envie senhas nem dados de cartão.</p>${err("mensagem")}
<div class="isca" aria-hidden="true"><label for="website">Não preencha este campo</label><input id="website" name="website" type="text" tabindex="-1" autocomplete="off"></div>
<button type="submit">Enviar e receber protocolo</button></form>
<p class="hint">Usamos seu e-mail e a mensagem só para responder esta solicitação (LGPD, art. 7º, V). Detalhes na <a href="https://vendas.zevanory.api.br/privacidade">Política de Privacidade</a>.</p>`);
}

export function confirmationPage(view, { emailSent = true } = {}) {
  const reembolso = view.tipo === "reembolso" ? `<p>Se o pedido foi pago, você também pode registrar o reembolso automaticamente, pela mesma ferramenta usada na compra: <a href="/pedir-reembolso">zevanory.api.br/pedir-reembolso</a>.</p>` : "";
  return shell("Solicitação recebida", `<div class="ok" role="status" aria-live="polite"><h1>Solicitação recebida</h1><p>Seu número de protocolo:</p><p class="proto" id="protocolo">${esc(view.protocolo)}</p>
<p>Tipo: ${esc(TIPOS[view.tipo] || view.tipo)}. Resposta conclusiva até <strong>${esc(brDate(Date.parse(view.responder_ate)))}</strong>, pelo e-mail informado.</p>
<p>${emailSent ? "Enviamos uma confirmação com este protocolo para o seu e-mail." : `Guarde este protocolo. Se a confirmação não chegar por e-mail, escreva para <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> informando o protocolo.`}</p>${reembolso}</div>
<p><a href="${ATENDIMENTO_PATH}">Enviar outra solicitação</a></p>`);
}

export async function handleAtendimento(request, env = {}, { now = Date.now() } = {}) {
  const url = new URL(request.url);
  if (url.pathname !== ATENDIMENTO_PATH && url.pathname !== ATENDIMENTO_API) return null;
  if (url.pathname === ATENDIMENTO_PATH) {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("method_not_allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    return new Response(formPage({ tipo: url.searchParams.get("tipo") || "" }), { status: 200, headers: HTML_HEADERS });
  }
  if (request.method !== "POST") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: { ...JSON_HEADERS, allow: "POST" } });
  const type = String(request.headers.get("content-type") || "");
  const wantsJson = type.includes("application/json");
  let raw = {};
  try {
    if (wantsJson) raw = await request.json();
    else { const f = await request.formData(); for (const k of ["tipo", "email", "pedido", "mensagem", "website"]) raw[k] = f.get(k) || ""; }
  } catch {}
  const input = parseInput(raw);
  let out;
  try { out = await registerRequest(env, input, { ip: request.headers.get("cf-connecting-ip") || "unknown", now }); }
  catch { out = { status: 503, body: { error: "atendimento_indisponivel", message: `Não foi possível registrar agora. Escreva para ${SUPPORT_EMAIL}.` } }; }
  if (wantsJson) return new Response(JSON.stringify(out.body), { status: out.status, headers: JSON_HEADERS });
  if (out.status === 400) return new Response(formPage({ values: input, errors: out.body.errors }), { status: 400, headers: HTML_HEADERS });
  if (out.status !== 200) return new Response(shell("Atendimento", `<div role="alert"><h1>Não foi possível registrar agora</h1><p>${esc(out.body.message || "")}</p></div><p><a href="${ATENDIMENTO_PATH}">Voltar ao formulário</a></p>`), { status: out.status, headers: HTML_HEADERS });
  if (out.body.ignored) return new Response(shell("Atendimento", `<div role="status"><h1>Recebido</h1></div>`), { status: 200, headers: HTML_HEADERS });
  return new Response(confirmationPage(out.body, { emailSent: out.body.email_confirmacao !== "pendente" }), { status: 200, headers: HTML_HEADERS });
}
