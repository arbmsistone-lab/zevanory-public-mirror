// Widget "Fale com a ZEVANORY" (sales-overlay/site-chat.{js,css} -> sales-public): acessibilidade WCAG 2.2 AA,
// CSP, nenhuma abertura/mensagem proativa, cabe em 390/320/256 px sem invadir a .buy-bar, aviso pré-chat completo.
// Estático e determinístico (sem navegador); a verificação com leitor de tela real é exigida antes do GO (AVAL Sol 111).
import test from "node:test";
import assert from "node:assert/strict";
import { readTextNormalized } from "./helpers/text.mjs";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// Código sem as linhas de comentário (o cabeçalho cita "innerHTML" justamente para proibi-lo).
const JS = readTextNormalized(join(ROOT, "sales-overlay/site-chat.js")).replace(/^\s*\/\/.*$/gm, "");
const CSS = readTextNormalized(join(ROOT, "sales-overlay/site-chat.css"));
const POLICY = JSON.parse(readTextNormalized(join(ROOT, "data/site-chat-policy.json")));
const PU = JSON.parse(readTextNormalized(join(ROOT, "data/politica-unica.json")));

// Corpo de uma função nomeada (casamento de chaves).
function fnBody(src, name) {
  const i = src.indexOf("function " + name + "(");
  assert.ok(i >= 0, "[SW00.1] " + ("função ausente: " + name));
  let j = src.indexOf("{", i), depth = 0, k = j;
  for (; k < src.length; k++) { if (src[k] === "{") depth++; else if (src[k] === "}") { depth--; if (!depth) break; } }
  return src.slice(j, k + 1);
}
// Declarações por seletor, opcionalmente dentro de um @media.
function rules(css, media) {
  let scope = css.replace(/\/\*[\s\S]*?\*\//g, "");
  if (media) {
    const start = scope.indexOf(media);
    assert.ok(start >= 0, "[SW00.2] " + ("media ausente: " + media));
    let i = scope.indexOf("{", start) + 1, depth = 1, k = i;
    for (; k < scope.length && depth; k++) { if (scope[k] === "{") depth++; else if (scope[k] === "}") depth--; }
    scope = scope.slice(i, k - 1);
  } else scope = scope.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  const out = new Map();
  for (const r of scope.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decl = {};
    for (const d of r[2].split(";")) { const c = d.indexOf(":"); if (c > 0) decl[d.slice(0, c).trim()] = d.slice(c + 1).trim(); }
    for (const sel of r[1].split(",")) out.set(sel.trim(), { ...(out.get(sel.trim()) || {}), ...decl });
  }
  return out;
}
const lum = (hex) => { const v = hex.replace("#", "").match(/../g).map((x) => parseInt(x, 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

test("SW01 marcação acessível: diálogo rotulado, log com aria-live polite, rótulos, aria-expanded/controls, Esc, Tab e retorno do foco", () => {
  for (const needle of ['role: "dialog"', '"aria-modal": "true"', '"aria-labelledby": "zc-title"', 'role: "log"', '"aria-live": "polite"', '"aria-label": "Histórico da conversa"',
    '"aria-haspopup": "dialog"', '"aria-expanded": "false"', '"aria-controls": "zc-panel"', 'for: "zc-input"', 'for: "zc-email"', 'autocomplete: "email"', '"aria-label": "Fechar o chat"',
    'role: "status"', 'role: "alert"', '"aria-describedby": "zc-hint zc-count"', 'className: "zc-sr"', '"aria-invalid"', 'tabindex: "0"']) assert.ok(JS.includes(needle), "[SW01.1] " + ("falta: " + needle));
  assert.match(JS, /e\.key === "Escape"[\s\S]{0,40}close\(\)/, "[SW01.2] Esc fecha (sem armadilha de teclado)");
  assert.match(JS, /e\.key !== "Tab"/, "[SW01.3] Tab circula dentro do diálogo");
  assert.match(fnBody(JS, "close"), /\.focus\(\)/, "[SW01.4] foco volta para quem abriu");
  assert.match(fnBody(JS, "open"), /zc-title"\)\.focus\(\)/, "[SW01.5] foco no título ao abrir (ação da pessoa)");
  // O histórico (role=log) é que anuncia as respostas: o "aria-live" do erro do e-mail não substitui o dele.
  assert.match(JS, /el\("ol", \{[^}]*role: "log"[^}]*"aria-live": "polite"/, "[SW01.6] o histórico (role=log) tem aria-live polite");
});

test("SW02 nova resposta não sequestra o foco; histórico navegável; tempo ajustável (aviso + continuar)", () => {
  assert.doesNotMatch(fnBody(JS, "addMessage"), /\.focus\(/, "[SW02.1]");
  assert.doesNotMatch(fnBody(JS, "send"), /\.focus\(/, "[SW02.2] resposta do servidor nunca move o foco");
  assert.match(fnBody(JS, "armIdle"), /timeout\.hidden = false/, "[SW02.3] aviso antes de encerrar");
  assert.match(JS, /extendBtn\.addEventListener\("click"[\s\S]{0,120}renew/, "[SW02.4] continuar renova a sessão");
  assert.match(JS, /Math\.max\(ms - 120000, 20000\)/, "[SW02.5] aviso com pelo menos 20 s (WCAG 2.2.1)");
});

test("SW03 nada proativo: só abre e só envia por ação da pessoa", () => {
  const opens = [...JS.matchAll(/(?<!function )\bopen\(\)/g)].length;
  assert.equal(opens, 0, "[SW03.1] open() nunca é chamado diretamente");
  assert.match(JS, /launch\.addEventListener\("click", open\)/, "[SW03.2]");
  assert.equal([...JS.matchAll(/addEventListener\("click", open\)/g)].length, 1, "[SW03.3]");
  assert.doesNotMatch(JS, /setTimeout\([^)]*(open|send|request)\b/, "[SW03.4]");
  assert.match(fnBody(JS, "open"), /loadStatus\(\)/, "[SW03.5] nem o aviso é buscado antes do clique");
  const top = JS.replace(/function \w+\([^)]*\) \{[\s\S]*?\n  \}/g, "");
  assert.doesNotMatch(top.replace(/addEventListener\([\s\S]*?\}\);/g, ""), /\b(send|request|loadStatus|ensureSession)\(/, "[SW03.6] nenhuma chamada de rede no carregamento");
});

test("SW04 CSP e privacidade: sem innerHTML/eval/estilo inline/cookie/localStorage/terceiros; links só https dos nossos domínios e nunca checkout", () => {
  for (const bad of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function/, /\.style\./, /setAttribute\("style"/, /document\.cookie/, /localStorage/, /\/comprar\//, /\/assinar\//, /hotmart/i, /mercadopago/i, /wa\.me/, /<script/i])
    assert.doesNotMatch(JS, bad, "[SW04.1] " + (String(bad)));
  const urls = [...JS.matchAll(/https?:\/\/[a-z0-9.-]+/gi)].map((m) => m[0]);
  for (const u of urls) assert.match(u, /^https:\/\/(vendas\.)?zevanory\.api\.br$/, "[SW04.2] " + (u));
  assert.match(JS, /sessionStorage/, "[SW04.3] token só nesta aba");
  assert.match(JS, /!\/\^\\\/\(comprar\|assinar\)\\b\/\.test\(u\.pathname\)/, "[SW04.4] richText nunca transforma checkout em link");
  assert.doesNotMatch(CSS, /url\(|@import|https?:/, "[SW04.5] CSS sem recursos externos");
});

test("SW05 cabe em 390/320/256 px e não invade a .buy-bar: painel tela cheia acima da barra, sem largura fixa, alvos de 44 px, foco visível", () => {
  const base = rules(CSS), mob = rules(CSS, "@media (max-width:760px)");
  const pcss = readTextNormalized(join(ROOT, "product.css"));
  const buyZ = Number((pcss.match(/\.buy-bar\{position:sticky;bottom:0;z-index:(\d+)/) || [])[1]);
  assert.ok(buyZ > 0, "[SW05.1] z-index da .buy-bar encontrado");
  assert.ok(Number(base.get(".zc-panel")["z-index"]) > buyZ, "[SW05.2] painel aberto fica acima da barra");
  const pm = mob.get(".zc-panel");
  assert.equal(pm.inset, "0", "[SW05.3]");
  assert.equal(pm.width, "100%", "[SW05.4]");
  assert.equal(pm["max-width"], "100%", "[SW05.5]");
  assert.equal(base.get(".zc-panel").position, "fixed", "[SW05.6]");
  assert.equal(base.get(".zc-entry").position, undefined, "[SW05.7] entrada no fluxo: nada flutua sobre a barra fechado");
  assert.equal(base.get(".zc-entry")["max-width"], "100%", "[SW05.8]");
  for (const [sel, d] of [...base, ...mob]) for (const prop of ["width", "min-width", "flex-basis"]) {
    const v = d[prop]; if (!v) continue;
    for (const m of v.replace(/(min|max|calc)\([^)]*\)/g, "").matchAll(/(\d+(?:\.\d+)?)px/g)) assert.ok(Number(m[1]) <= 44, `[SW05.9] ${sel} ${prop}:${v} (largura fixa quebraria 256 px)`);
  }
  assert.equal(base.get(".zc-button")["min-height"], "44px", "[SW05.10]");
  assert.equal(base.get(".zc-button")["min-width"], "44px", "[SW05.11]");
  assert.equal(base.get(".zc-input")["min-height"], "44px", "[SW05.12]");
  assert.equal(base.get(".zc-button")["white-space"], "normal", "[SW05.13]");
  assert.match(base.get(".zc-panel :focus-visible").outline, /^3px solid/, "[SW05.14]");
  assert.equal(base.get(".zc-msg")["overflow-wrap"], "anywhere", "[SW05.15]");
  assert.equal(base.get(".zc-panel *")["box-sizing"], "border-box", "[SW05.16]");
});

test("SW06 contraste AA dos tokens (texto >= 4.5:1; foco >= 3:1)", () => {
  const t = Object.fromEntries([...CSS.matchAll(/--zc-([a-z-]+):(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
  for (const [fg, bg] of [["fg", "bg"], ["muted", "bg"], ["link", "bg"], ["accent-fg", "accent"], ["fg", "user"], ["error", "bg"], ["link", "user"]])
    assert.ok(contrast(t[fg], t[bg]) >= 4.5, `[SW06.1] ${fg}/${bg} = ${contrast(t[fg], t[bg]).toFixed(2)}`);
  for (const ui of ["focus", "line"]) assert.ok(contrast(t[ui], t.bg) >= 3, `[SW06.2] ${ui}/bg`);
});

test("SW07 aviso pré-chat completo (quem responde, erros, dados proibidos, controlador, finalidade, dados, base legal, operadores, compartilhamento, transferência, retenção, direitos) e renderizado pelo widget", () => {
  const n = POLICY.notice;
  assert.match(n.who_answers, /assistente automático da ZEVANORY/, "[SW07.1]");
  assert.match(n.who_answers, /pode cometer erros/, "[SW07.2]");
  assert.match(n.who_answers, /e-mail/, "[SW07.3]");
  assert.match(n.do_not_send, /senha/, "[SW07.4]"); assert.match(n.do_not_send, /cartão/, "[SW07.5]"); assert.match(n.do_not_send, /documentos/, "[SW07.6]"); assert.match(n.do_not_send, /sensíveis/, "[SW07.7]");
  assert.match(n.controller, /\{legal_identity\}/, "[SW07.8]");
  assert.match(n.purpose, /sem cookies de rastreamento/i, "[SW07.9]");
  assert.match(n.legal_basis, /Não pedimos consentimento genérico/, "[SW07.10]");
  assert.match(n.operators, /Cloudflare/, "[SW07.11]"); assert.match(n.operators, /Neon/, "[SW07.12]"); assert.match(n.operators, /Resend/, "[SW07.13]");
  assert.match(n.transfer, /art\. 33/, "[SW07.14]");
  assert.match(n.retention, /30 dias/, "[SW07.15]"); assert.match(n.retention, /180 dias após o encerramento/, "[SW07.16]");
  assert.match(n.rights, /art\. 18/, "[SW07.17]");
  assert.match(n.optional, /pedir-reembolso/, "[SW07.18]");
  assert.equal(n.privacy_href, "/privacidade", "[SW07.19]");
  for (const k of ["who_answers", "do_not_send", "controller", "purpose", "data", "legal_basis", "operators", "sharing", "transfer", "retention", "rights", "optional"]) assert.ok(JS.includes(`"${k}"`), "[SW07.20] " + ("widget mostra " + k));
  const R = POLICY.retention;
  assert.ok(R.transcript_days <= 30 && R.technical_logs_days <= 30 && R.ticket_days_after_closure <= 180, "[SW07.21]");
  for (const k of ["transcript_days", "ticket_days_after_closure", "technical_logs_days", "counters_days", "metricas"]) assert.ok(R.justificativas[k], "[SW07.22] " + ("justificativa: " + k));
  assert.equal(PU.resumo_oferta.fornecedor.email, POLICY.owner_queue_to, "[SW07.23]");
});

test("SW08 chat opcional: páginas do chat seguem com e-mail sem JavaScript; cópias publicadas idênticas à fonte; nenhum checkout", () => {
  for (const f of ["site-chat.js", "site-chat.css"]) assert.equal(readTextNormalized(join(ROOT, "sales-public", f)), readTextNormalized(join(ROOT, "sales-overlay", f)), "[SW08.1] " + (f + ": build_sales_public.py copia a fonte"));
  for (const slug of ["solucoes", "ia-na-pratica", "vendas-na-pratica", "lucro-e-caixa", "combo-ia-vendas", "negocio-completo", "conteudo-pronto", "termos", "privacidade", "reembolso"]) {
    const html = readTextNormalized(join(ROOT, "sales-public", slug + ".html"));
    assert.ok(html.includes("suporte@zevanory.api.br"), "[SW08.2] " + (slug + ": e-mail sem JS"));
    assert.ok(!html.includes("site-chat"), "[SW08.3] " + (slug + ": HTML estático não carrega o chat (só o Worker, se ligado)"));
  }
  assert.ok(readdirSync(join(ROOT, "sales-public")).includes("site-chat.js"), "[SW08.4]");
});
