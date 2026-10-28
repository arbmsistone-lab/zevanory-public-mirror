#!/usr/bin/env node
// P09 Nutrição: gate de CI da sequência de e-mails (Roteiro Mestre v4.7, seção 5).
//   Gate antes de agir (PI): sem promessa de ganho; descadastro em 1 clique; nada sem consentimento.
//   Métrica depois: cliques e ações (abertura não decide [3.1]); taxa de descadastro (LB).
// Confere as sequências versionadas em content/p09/<id>/ E a sequência que está hoje no Worker
// (worker/lead-magnet.mjs, nurtureEmail), além do texto de consentimento publicado nas páginas (P08).
// Sem rede, sem segredo, não envia nada. Uso: node scripts/p09/nurture_gate.mjs [--root DIR]
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const ROOT = args.includes("--root") ? args[args.indexOf("--root") + 1] : process.cwd();
const rd = (rel) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const mod = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

const { CONSENT_FOLLOWUPS, nurtureEmail } = await mod("worker/lead-magnet.mjs");
const { hasCheckoutCta, bannedPolicyHits } = await mod("worker/politica-unica.mjs");
const P = await mod("scripts/p09/nurture-sequence.mjs");

const errs = [];
const notes = [];
const err = (m) => errs.push(m);
const strip = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// Promessa de ganho, urgência artificial e prova social inventada (comparação sem acento e sem caixa).
export const INCOME = [/ganh\w* (de )?dinheiro/, /renda (extra|passiva)/, /\bfatur(e|ar|ou|amento) (mais|alto|ate)/, /lucr\w* garantid/, /garantid[oa]s?\b/,
  /resultado(s)? garantido/, /retorno garantido/, /\b(dobr|tripl|multiplic)\w* (suas |as |seu |o )?(vendas|faturamento|lucro|clientes|renda)/, /\bvend(er|a) mais\b/,
  /aumentar? (suas |as |seu |o )?(vendas|faturamento|lucro)/, /fique rico|enriquec/, /liberdade financeira/, /r\$ ?\d[\d.,]* (por|ao|a cada) (dia|semana|mes)/,
  /\d+ ?% (a mais|de aumento|mais vendas)/, /sem esforco/, /dinheiro facil/];
export const URGENCY = [/ultimas? (vagas|horas|unidades)/, /(so|somente|apenas) hoje/, /tempo limitado/, /oferta (relampago|termina|expira|acaba)/, /\bcorra\b/, /nao perca/,
  /desconto (expira|ate|so)/, /promocao/, /contagem regressiva/, /vagas limitadas/, /agora ou nunca/, /antes que acabe/];
export const TESTIMONIAL = [/depoimento/, /clientes? (dizem|aprovam|amaram|recomendam)/, /mais de \d+ (clientes|alunos|pessoas|empresas)/, /veja o que/, /\bestrelas\b/, /aprovado por/, /\bnota \d/];
// Promessas corrigidas no #927 (Vendas sem prospecção; Combo sem IA integrada ao fluxo comercial).
export const PROMISE_927 = [/prospec/, /quem abordar/, /dentro do (fluxo|processo comercial)/];

export function lexiconHits(text) {
  const t = strip(text);
  const hits = [];
  for (const [label, list] of [["promessa de ganho", INCOME], ["urgência", URGENCY], ["prova social", TESTIMONIAL], ["promessa corrigida no #927", PROMISE_927]]) {
    for (const re of list) if (re.test(t)) hits.push(`${label} (${re.source})`);
  }
  return hits;
}

function caracteristicas(slug) {
  const f = join(ROOT, "sales-public", `${slug}.html`);
  if (!existsSync(f)) return null;
  const m = /Características essenciais<\/dt><dd>([^<]*)/.exec(readFileSync(f, "utf8"));
  return m ? m[1].replace(/&amp;/g, "&").replace(/&#39;/g, "'") : null;
}

function checkSource(src, where) {
  if (!src || src.kind !== "repo" || typeof src.ref !== "string" || src.ref.startsWith("/") || src.ref.split(/[\\/]/).includes("..")) { err(`${where}: fonte deve ser {kind: repo, ref, contains}`); return false; }
  const f = join(ROOT, src.ref);
  if (!existsSync(f)) { err(`${where}: fonte inexistente ${src.ref}`); return false; }
  if (typeof src.contains !== "string" || src.contains.length < 3 || !readFileSync(f, "utf8").includes(src.contains)) { err(`${where}: trecho ${JSON.stringify(src.contains)} não aparece em ${src.ref}`); return false; }
  return true;
}

const products = JSON.parse(rd("data/products.json")).products;
const leadSrc = rd("worker/lead-magnet.mjs");
const currentConsent = (/const CONSENT_VERSION = "([^"]+)"/.exec(leadSrc) || [])[1];
if (!currentConsent || !Number.isInteger(CONSENT_FOLLOWUPS[currentConsent])) err("P08: versão de consentimento atual (CONSENT_VERSION) sem limite em CONSENT_FOLLOWUPS");

// ---------------------------------------------------------------- 1. sequências versionadas
const seqDirs = existsSync(join(ROOT, "content/p09")) ? readdirSync(join(ROOT, "content/p09")).filter((d) => statSync(join(ROOT, "content/p09", d)).isDirectory()).sort() : [];
if (!seqDirs.length) err("content/p09: nenhuma sequência versionada");
const summary = [];
for (const dir of seqDirs) {
  const base = `content/p09/${dir}`;
  let seq;
  try { seq = JSON.parse(rd(`${base}/sequence.json`)); } catch (e) { err(`${base}: sequence.json ilegível (${e.message})`); continue; }
  const W = `sequência ${seq.id || dir}`;
  if (seq.schema !== "zevanory-p09-sequence/v1") err(`${W}: schema deve ser zevanory-p09-sequence/v1`);
  if (seq.id !== dir) err(`${W}: id deve ser igual ao diretório (${dir})`);
  if (typeof seq.version !== "string" || !/^\d{4}-\d{2}-\d{2}\.\d+$/.test(seq.version)) err(`${W}: version deve ser AAAA-MM-DD.N`);
  const sw = seq.send_switch || {};
  if (sw.default !== "off" || sw.on_value !== seq.id || sw.env !== "P09_NURTURE_SEND") err(`${W}: interruptor deve ser P09_NURTURE_SEND, desligado por padrão, ligado só com o id da sequência`);
  if (seq.retroactive !== false) err(`${W}: retroactive deve ser false (a sequência nunca se aplica a contatos cujo consentimento não cobre os passos)`);
  if (typeof seq.consent?.coverage_rule !== "string" || !/nunca retroativo/i.test(seq.consent.coverage_rule)) err(`${W}: consent.coverage_rule deve declarar a regra 'nunca retroativo'`);
  const accepted = seq.consent?.accepted_versions;
  if (!Array.isArray(accepted) || !accepted.length) err(`${W}: consent.accepted_versions vazio (nada sem consentimento)`);
  else for (const v of accepted) if (!Number.isInteger(CONSENT_FOLLOWUPS[v])) err(`${W}: versão de consentimento ${v} não existe no modelo do P08 (worker/lead-magnet.mjs CONSENT_FOLLOWUPS)`);
  const met = seq.metrics || {};
  if (!Array.isArray(met.decide_by) || !met.decide_by.length || met.decide_by.some((m) => !["clicks", "actions"].includes(m))) err(`${W}: metrics.decide_by só aceita clicks e actions`);
  if (!Array.isArray(met.never) || !met.never.includes("opens")) err(`${W}: metrics.never deve conter opens (abertura não decide [3.1])`);
  const emails = Array.isArray(seq.emails) ? seq.emails : [];
  if (!emails.length) err(`${W}: sem e-mails`);
  const camps = new Set();
  let lastDay = -1;
  emails.forEach((e, i) => {
    const E = `${W} passo ${e.step}`;
    if (e.step !== i) err(`${E}: passos devem ser 0..n-1 em ordem`);
    if (!Number.isInteger(e.day) || e.day <= lastDay) err(`${E}: day deve crescer`);
    lastDay = e.day;
    if (i === 0 && e.commercial !== false) err(`${E}: o passo 0 é a entrega do checklist e não pode ser comercial`);
    if (typeof e.commercial !== "boolean") err(`${E}: commercial deve ser booleano`);
    if (!["clicks", "actions"].includes(e.metric)) err(`${E}: metric deve ser clicks ou actions (abertura não decide)`);
    if (typeof e.campaign !== "string" || !/^p09v\d+-e\d+-[a-z0-9-]+$/.test(e.campaign) || camps.has(e.campaign)) err(`${E}: campaign única por e-mail (p09vN-eN-...)`);
    camps.add(e.campaign);
    let raw;
    try { raw = rd(`${base}/${e.file}`); } catch { err(`${E}: arquivo ${e.file} inexistente`); return; }
    let tpl;
    try { tpl = P.parseTemplate(raw); } catch (x) { err(`${E}: ${x.message}`); return; }
    const all = tpl.subject + "\n" + tpl.body;
    if (/<img|<script|<iframe|pixel|https?:\/\//i.test(all)) err(`${E}: link cru, imagem ou pixel no texto (links só por {{link:...}} com utm; sem rastreio de abertura)`);
    const ph = P.placeholdersOf(all);
    for (const p of ph) if (!P.KNOWN_PLACEHOLDERS.includes(p.name)) err(`${E}: marcador desconhecido ${p.raw}`);
    if (ph.filter((p) => p.name === "assinatura").length !== 1) err(`${E}: precisa de exatamente um {{assinatura}} (assinatura + descadastro em 1 clique)`);
    if (ph.filter((p) => p.name === "saudacao").length !== 1) err(`${E}: precisa de exatamente um {{saudacao}}`);
    const usedLinks = new Set(ph.filter((p) => p.name === "link").map((p) => p.arg));
    for (const id of usedLinks) if (!e.links?.[id]) err(`${E}: {{link:${id}}} sem URL declarada`);
    for (const [id, url] of Object.entries(e.links || {})) {
      if (!usedLinks.has(id)) err(`${E}: link ${id} declarado e não usado`);
      let u;
      try { u = new URL(url); } catch { err(`${E}: URL inválida ${url}`); continue; }
      if (u.protocol !== "https:" || !P.ALLOWED_LINK_HOSTS.includes(u.hostname)) err(`${E}: link fora dos domínios da ZEVANORY: ${url}`);
      if (hasCheckoutCta(url) || /\/comprar\b|\/checkout\b|\/assinar\b/.test(u.pathname)) err(`${E}: link de checkout no e-mail (${url}); leve para a página do produto`);
    }
    const priced = ph.filter((p) => p.name === "preco");
    const productLink = Object.values(e.links || {}).some((url) => products.some((p) => new URL(url).pathname.replace(/\/$/, "") === `/${p.slug}`));
    if ((priced.length || productLink) && e.commercial !== true) err(`${E}: e-mail com preço ou página de produto precisa de commercial=true (só sai com vendas abertas)`);
    if (e.commercial === true) {
      if (!ph.some((p) => p.name === "regra_7d")) err(`${E}: e-mail comercial sem {{regra_7d}} (direito de arrependimento, CDC art. 49)`);
      if (!ph.some((p) => p.name === "identificacao")) err(`${E}: e-mail comercial sem {{identificacao}} (fornecedor e CNPJ, Decreto 7.962/2013, art. 2º)`);
    }
    for (const p of priced) if (!products.some((x) => x.slug === p.arg)) err(`${E}: {{preco:${p.arg}}} sem produto em data/products.json`);
    // Números: todo número literal precisa de fonte no repositório (marcadores de lista "1." não contam).
    const literal = all.replace(P.PLACEHOLDER_RE, " ").replace(/^\d+\.\s/gm, "");
    const found = new Set(literal.match(/\d+(?:[.,]\d+)*/g) || []);
    const declared = new Map((e.numbers || []).map((n) => [String(n.value), n]));
    for (const n of found) if (!declared.has(n)) err(`${E}: número ${n} sem fonte declarada (nada de número inventado)`);
    for (const [v, n] of declared) { if (!found.has(v)) err(`${E}: número ${v} declarado e não usado`); checkSource(n.source, `${E} número ${v}`); }
    // Conteúdo prometido: só o que a página de venda lista em "Características essenciais".
    for (const c of e.claims || []) {
      const car = caracteristicas(c.slug);
      if (!car) { err(`${E}: página sales-public/${c.slug}.html sem Características essenciais`); continue; }
      if (!strip(all).includes(strip(c.text))) err(`${E}: afirmação declarada não aparece no texto: ${c.text}`);
      if (!strip(car).includes(strip(c.text))) err(`${E}: afirmação "${c.text}" não está nas Características essenciais de ${c.slug}`);
    }
    if (e.commercial === true && !(e.claims || []).length) err(`${E}: e-mail comercial precisa declarar claims conferidas contra a página`);
    // Renderização: descadastro em 1 clique e léxico proibido no texto final.
    const opt = "https://zevanory.api.br/material-gratuito/sair?r=" + "a".repeat(64) + "&t=" + "b".repeat(32);
    let msg;
    try { msg = P.renderEmail({ sequence: seq, templates: { [e.file]: raw }, step: e.step, name: "Ana", optOutUrl: opt, products }); } catch (x) { err(`${E}: não renderiza (${x.message})`); return; }
    if (!msg.text.includes(opt)) err(`${E}: texto final sem o link de descadastro`);
    if (msg.headers["List-Unsubscribe"] !== `<${opt}>, <mailto:suporte@zevanory.api.br?subject=descadastrar>` || msg.headers["List-Unsubscribe-Post"] !== "List-Unsubscribe=One-Click") err(`${E}: cabeçalhos de descadastro em 1 clique ausentes (RFC 8058)`);
    for (const h of lexiconHits(msg.subject + "\n" + msg.text)) err(`${E}: ${h}`);
    for (const h of bannedPolicyHits(msg.subject + "\n" + msg.text)) err(`${E}: formulação de política proibida: ${h}`);
    if (e.commercial !== true && hasCheckoutCta(msg.text)) err(`${E}: chamada de compra em e-mail não comercial`);
  });
  // Consentimento: quais passos o modelo do P08 permite hoje.
  for (const v of Array.isArray(accepted) ? accepted : []) {
    const lead = { status: "confirmed", confirmed_at: "x", consent_at: "x", consent_version: v };
    const env = { P09_NURTURE_SEND: seq.id };
    const ok = emails.filter((e) => P.canSend({ env, sequence: seq, step: e.step, lead, salesOpen: true }).ok).map((e) => e.step);
    const blocked = emails.map((e) => e.step).filter((s) => !ok.includes(s));
    for (const s of ok) if (s > CONSENT_FOLLOWUPS[v]) err(`${W}: passo ${s} sairia além do consentimento ${v} (${CONSENT_FOLLOWUPS[v]} e-mails depois do checklist)`);
    if (P.canSend({ env: {}, sequence: seq, step: 0, lead, salesOpen: true }).ok) err(`${W}: envio com o interruptor desligado`);
    summary.push(`P09_CONSENT sequence=${seq.id} version=${v} followups=${CONSENT_FOLLOWUPS[v]} sendable_steps=${ok.join(",") || "-"} blocked_steps=${blocked.join(",") || "-"}`);
    if (blocked.length) notes.push(`${seq.id}: passos ${blocked.join(",")} ficam bloqueados pelo limite informativo ou pela ausência deliberada de consentimento comercial separado; salesOpen não os libera`);
  }
  summary.push(`P09_SEQUENCE id=${seq.id} version=${seq.version} emails=${emails.length} commercial=${emails.filter((e) => e.commercial).length} switch=${sw.env}:off-by-default metric=${[...new Set(emails.map((e) => e.metric))].join("+")}`);
}

// ---------------------------------------------------------------- 2. consentimento publicado (P08) x modelo
const pages = [];
const walk = (d) => { for (const n of readdirSync(join(ROOT, d))) { if (n.startsWith(".") || n === "node_modules") continue; const r = d ? `${d}/${n}` : n; const s = statSync(join(ROOT, r)); if (s.isDirectory()) walk(r); else if (n.endsWith(".html")) pages.push(r); } };
walk("");
let formPages = 0;
for (const r of pages) {
  const html = readFileSync(join(ROOT, r), "utf8");
  if (!html.includes('name="consentimento"')) continue;
  formPages += 1;
  const counts = [...html.matchAll(/até (\d+) e-mails/g)].map((m) => Number(m[1]));
  if (!counts.length) err(`P08 ${r}: formulário de lead sem o limite de e-mails no texto de consentimento`);
  for (const n of counts) if (n !== CONSENT_FOLLOWUPS[currentConsent]) err(`P08 ${r}: consentimento publicado diz "até ${n} e-mails", mas o modelo (${currentConsent}) permite ${CONSENT_FOLLOWUPS[currentConsent]}`);
}
if (!formPages) err("P08: nenhuma página com formulário de consentimento encontrada");

// ---------------------------------------------------------------- 3. sequência viva do Worker (worker/lead-magnet.mjs)
let liveMails = 0;
const opt = "https://zevanory.api.br/material-gratuito/sair?r=" + "c".repeat(64) + "&t=" + "d".repeat(32);
for (const salesOpen of [false, true]) for (const interest of ["ia", "vendas", "caixa"]) for (let step = 0; step <= 4; step += 1) {
  let mail;
  try { mail = nurtureEmail(step, { name: "Ana", optOutUrl: opt, interest, salesOpen }); } catch (x) { err(`Worker passo ${step} (${interest}, vendas ${salesOpen ? "abertas" : "fechadas"}): ${x.message}`); continue; }
  if (!mail) continue;
  liveMails += 1;
  const L = `Worker passo ${step} (${interest}, vendas ${salesOpen ? "abertas" : "fechadas"})`;
  if (!mail.text.includes(opt)) err(`${L}: sem link de descadastro`);
  for (const h of lexiconHits(mail.subject + "\n" + mail.text)) err(`${L}: ${h}`);
  if (!salesOpen && hasCheckoutCta(mail.subject + " " + mail.text)) err(`${L}: chamada de compra com vendas fechadas`);
}
const LIVE_ANCHORS = [
  ['"List-Unsubscribe-Post": "List-Unsubscribe=One-Click"', "cabeçalho de descadastro em 1 clique no envio"],
  ["const cap = 1 + (CONSENT_FOLLOWUPS[lead.consent_version] ?? 0);", "limite do consentimento por lead"],
  ["if (step >= 2) return null;", "ofertas antigas permanentemente retiradas da base gratuita"],
  ["if (consent !== true) return", "inscrição só com consentimento marcado"],
];
for (const [a, what] of LIVE_ANCHORS) if (!leadSrc.includes(a)) err(`Worker: salvaguarda ausente em worker/lead-magnet.mjs (${what})`);
if (/open_?tracking|track_?opens|"opens?"\s*:\s*true/i.test(leadSrc)) err("Worker: rastreio de abertura ligado (abertura não decide)");

// ---------------------------------------------------------------- 4. nada envia a partir do CI nem deste módulo
const wfDir = join(ROOT, ".github/workflows");
if (existsSync(wfDir)) for (const f of readdirSync(wfDir)) if (/\.ya?ml$/.test(f) && /P09_NURTURE_SEND\s*[:=]/.test(readFileSync(join(wfDir, f), "utf8"))) err(`CI: .github/workflows/${f} define P09_NURTURE_SEND (o CI nunca liga o envio)`);
// O próprio gate fica fora (ele contém os padrões que procura); os demais módulos do P09 não podem ter rede.
for (const f of readdirSync(join(ROOT, "scripts/p09")).filter((x) => x !== "nurture_gate.mjs")) {
  const src = readFileSync(join(ROOT, "scripts/p09", f), "utf8");
  if (/\bfetch\s*\(|api\.resend\.com|node:(https?|net|tls)|XMLHttpRequest/.test(src.replace(/^\s*\/\/.*$/gm, ""))) err(`scripts/p09/${f}: acesso de rede no código do P09 (o envio fica só no Worker)`);
}

for (const s of summary) console.log(s);
console.log(`P09_CONSENT_COPY pages=${formPages} version=${currentConsent} followups=${CONSENT_FOLLOWUPS[currentConsent]}`);
console.log(`P09_LIVE_WORKER mails_checked=${liveMails}`);
for (const n of notes) console.log(`::notice title=P09::${n}`);
for (const e of errs) console.log(`::error title=P09::${e}`);
console.log(`P09_GATE=${errs.length ? "FAIL" : "PASS"} errors=${errs.length}`);
process.exitCode = errs.length ? 1 : 0;
