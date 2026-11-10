// Gate de qualidade do blog (Plano Mestre v1.2, seção 9, substituição da DEC-21; F1 item 3).
// Funções puras: decidem se um artigo do calendário editorial pode ser publicado sozinho.
// Rejeita (cada motivo é independente e todos são reportados):
//   fonte_ausente               dado factual (percentual, pesquisa, instituto, ano) sem fonte verificável (https externa)
//   duplicado                   mesmo título ou similaridade de trigramas >= 0,5 com artigo já publicado
//   promessa_ou_termo_proibido  filtro `forbidden` do creative-autonomy + promessas de ganho do motor de aquisição
//   sem_utilidade               menos de 400 palavras, menos de 4 seções ou sem roteiro/passos/exemplo
//   compliance_score            rubrica do creative-autonomy sem compliance 100 e score >= 85
//   cta_invalido                CTA fora de /hotmart/<kit do artigo> (só no modo Hotmart) ou material/calculadora gratuitos,
//                               sem UTM do blog, ou com checkout próprio
//   trava_de_vendas             texto com preço, link de checkout ou chamada de compra que a trava atual não permite
// Nada aqui grava, publica ou lê segredo.
import { CREATIVE_FORBIDDEN_RE } from "./creative-autonomy.mjs";
import { trigramSimilarity } from "./blog-editorial.mjs";
import { hotmartKit, hotmartLockViolations, salesLockViolations } from "./sales-lock-content.mjs";

export const BLOG_GATE_VERSION = "blog-gate/v1";
export const BLOG_WEEKLY_CAP = 3;
// Dias de publicação (getUTCDay do dia local): segunda, quarta e sexta.
export const BLOG_PUBLICATION_WEEKDAYS = Object.freeze([1, 3, 5]);
export const BLOG_MIN_WORDS = 400;
export const BLOG_MIN_SECTIONS = 4;
export const BLOG_DUPLICATE_THRESHOLD = 0.5;
export const BLOG_MIN_COMPLIANCE = 100;
export const BLOG_MIN_SCORE = 85;
export const BLOG_SALES_ORIGIN = "https://vendas.zevanory.api.br";
export const BLOG_GATE_REASONS = Object.freeze(["fonte_ausente", "duplicado", "promessa_ou_termo_proibido", "sem_utilidade", "compliance_score", "cta_invalido", "trava_de_vendas"]);

// Promessas de ganho e falsa prova social (mesma lista do validateDraft do motor de aquisição, com fronteiras Unicode).
const CLAIMS_RE = /(?<![\p{L}\p{N}])(?:lucro garantido|renda garantida|renda extra garantida|faturamento garantido|ganhe dinheiro|dinheiro f[aá]cil|fique rico|resultado garantido|retorno garantido|depoimento real|cliente comprovou)(?![\p{L}\p{N}])/iu;
// Dado factual que exige fonte: percentual, "segundo/de acordo com" + pesquisa/estudo/instituto, pesquisa/estudo citados,
// institutos e órgãos com estatística pública, ano explícito.
const FACTUAL_RE = /\d+(?:[.,]\d+)?\s*(?:%|por cento)|(?<![\p{L}])(?:segundo|de acordo com|conforme)\s+(?:(?:o|a|os|as|um|uma)\s+)?(?:pesquisa|estudo|levantamento|relat[oó]rio|censo|ibge|sebrae|ipea|fgv|serasa|banco central)(?![\p{L}])|(?<![\p{L}])(?:pesquisa|estudo|levantamento|censo)\s+(?:do|da|de|realizad[oa]|publicad[oa]|recente)(?![\p{L}])|(?<![\p{L}\p{N}])(?:ibge|sebrae|ipea|fgv|serasa|banco central|receita federal)(?![\p{L}\p{N}])|(?<![\p{N}])(?:19|20)\d{2}(?![\p{N}])/iu;
const PRACTICAL_RE = /(?<![\p{L}])(?:roteiro|passo a passo|passos|exemplo|caso pr[aá]tico|checklist)(?![\p{L}])/iu;
const FREE_PATH_RE = /^\/(?:material-gratuito|calculadora-[a-z-]{2,60}|ferramentas)$/;
const OWN_HOSTS = /(^|\.)zevanory\.api\.br$/;

const str = (v) => String(v ?? "");
export const articleText = (a = {}) => [a.title, a.description, a.body, ...(Array.isArray(a.faq) ? a.faq.flatMap((x) => [x?.q, x?.a]) : [])].map(str).join("\n");
export const hasFactualClaim = (text) => FACTUAL_RE.test(str(text));
export const hasForbiddenClaim = (text) => CREATIVE_FORBIDDEN_RE.test(str(text)) || CLAIMS_RE.test(str(text));
export const weekdayOf = (day) => new Date(str(day) + "T12:00:00Z").getUTCDay();
export const isPublicationDay = (day) => BLOG_PUBLICATION_WEEKDAYS.includes(weekdayOf(day));
export const isoWeekOf = (day) => {
  const d = new Date(str(day) + "T12:00:00Z");
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - y) / 86400000 + 1) / 7)).padStart(2, "0")}`;
};

// Fonte verificável: URL https externa, sem credencial nem porta, com host público (não é o próprio site).
export function verifiableSource(src) {
  let u; try { u = new URL(str(src?.url ?? src)); } catch { return false; }
  return u.protocol === "https:" && !u.username && !u.password && !u.port && u.hostname.includes(".") && !OWN_HOSTS.test(u.hostname);
}

export function usefulness(article = {}) {
  const body = str(article.body);
  const words = body.trim() ? body.trim().split(/\s+/u).length : 0;
  const sections = (body.match(/^## \S/gmu) || []).length;
  const practical = PRACTICAL_RE.test(body);
  return { words, sections, practical, ok: words >= BLOG_MIN_WORDS && sections >= BLOG_MIN_SECTIONS && practical };
}

export const blogCampaignOf = (day) => "blog_" + str(day).replaceAll("-", "");

// CTA do artigo, decidido pela trava no momento da publicação: modo Hotmart (interruptor completo fechado) e o produto
// é um dos 5 kits -> /hotmart/<slug>; qualquer outro caso -> material gratuito. Nunca o checkout próprio.
export function blogCtaUrl(article = {}, mode = {}) {
  const kit = mode?.full !== true && mode?.hotmart === true ? hotmartKit(article.product) : null;
  const u = new URL(BLOG_SALES_ORIGIN + (kit ? "/hotmart/" + kit.slug : "/material-gratuito"));
  u.searchParams.set("utm_source", "blog"); u.searchParams.set("utm_medium", "organic"); u.searchParams.set("utm_campaign", blogCampaignOf(article.day));
  return u.toString();
}

export function validBlogCta(url, article = {}, mode = {}) {
  let u; try { u = new URL(str(url)); } catch { return false; }
  if (u.protocol !== "https:" || u.hostname !== "vendas.zevanory.api.br" || u.username || u.password || u.port) return false;
  if (u.searchParams.get("utm_source") !== "blog" || u.searchParams.get("utm_medium") !== "organic" || u.searchParams.get("utm_campaign") !== blogCampaignOf(article.day)) return false;
  if (FREE_PATH_RE.test(u.pathname)) return true;
  const kit = mode?.full !== true && mode?.hotmart === true ? hotmartKit(article.product) : null;
  return Boolean(kit) && u.pathname === "/hotmart/" + kit.slug;
}

export function salesLockReasons(article = {}, mode = {}) {
  if (mode?.full === true) return [];
  const text = articleText(article);
  const kit = mode?.hotmart === true ? hotmartKit(article.product) : null;
  return kit ? hotmartLockViolations(text, kit.sku) : salesLockViolations(text);
}

export function blogQualityGate({ article = {}, priorArticles = [], rubric = null, ctaUrl = "", mode = {} } = {}) {
  const reasons = [];
  const text = articleText(article);
  const sources = Array.isArray(article.sources) ? article.sources : [];
  if (hasFactualClaim(text) && !sources.some(verifiableSource)) reasons.push("fonte_ausente");
  const norm = (s) => str(s).toLocaleLowerCase("pt-BR").replace(/\s+/g, " ").trim();
  const prior = (Array.isArray(priorArticles) ? priorArticles : []).filter((p) => p && p.slug !== article.slug);
  const sims = prior.filter((p) => p.body).map((p) => trigramSimilarity(article.body, p.body));
  const similarityMax = sims.length ? Math.max(...sims) : 0;
  if (prior.some((p) => p.title && norm(p.title) === norm(article.title)) || similarityMax >= BLOG_DUPLICATE_THRESHOLD) reasons.push("duplicado");
  if (hasForbiddenClaim(text)) reasons.push("promessa_ou_termo_proibido");
  const use = usefulness(article);
  if (!use.ok) reasons.push("sem_utilidade");
  if (!rubric || rubric.action !== "publish" || Number(rubric.compliance) !== BLOG_MIN_COMPLIANCE || !(Number(rubric.score) >= BLOG_MIN_SCORE)) reasons.push("compliance_score");
  if (!validBlogCta(ctaUrl, article, mode)) reasons.push("cta_invalido");
  if (salesLockReasons(article, mode).length) reasons.push("trava_de_vendas");
  return { ok: reasons.length === 0, version: BLOG_GATE_VERSION, reasons, similarityMax: Math.round(similarityMax * 1000) / 1000, words: use.words, sections: use.sections };
}
