// Blog com publicação automática e gate de qualidade (Plano Mestre v1.2, seção 9, aprovado pelo proprietário em
// 10/11/2026 com PASS do GPT-6; F1 item 3). Este arquivo SUBSTITUI tests/r117-blog-owner-gate.test.mjs: a DEC-21
// ("blog só rascunho", R123/R124, docs/R124-DEC21-BLOG-DRAFT-ONLY.md) foi substituída de forma expressa pela seção 9.
// Contratos: no máximo 3 artigos por semana ISO (seg/qua/sex), contador idempotente, gate que rejeita cada caso
// negativo (mutantes de entrada), status diário com no máximo 1 gravação por dia, CTA conforme a trava de vendas e o
// modo Hotmart, pausa criativa respeitada. Só fakes locais: nenhuma rede, nenhum KV real.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureDailyBlog, BLOG_STATUS_PREFIX, BLOG_WEEK_PREFIX, BLOG_INDEX_KEY, renderBlogArticle } from "../worker/multichannel-autonomy.mjs";
import { blogQualityGate, blogCtaUrl, isoWeekOf, BLOG_WEEKLY_CAP, BLOG_GATE_REASONS } from "../worker/blog-quality-gate.mjs";
import { dailyEditorialArticle } from "../worker/blog-editorial.mjs";
import { runAcquisitionEngine } from "../worker/acquisition-engine.mjs";
import { CREATIVE_AUTOPUBLISH_PAUSE_KEY } from "../worker/creative-autonomy.mjs";
import { resetSalesSwitchCache, resetHotmartSwitchCache } from "../worker/sales-control.mjs";

const MON = "2026-10-12", TUE = "2026-10-13", WED = "2026-10-14", FRI = "2026-10-16";
const at = (day, hhmm = "12:35") => new Date(day + "T" + hhmm + ":00Z");
const fresh = () => { resetSalesSwitchCache(); resetHotmartSwitchCache(); };
function fake(extra = {}, { failPut = null } = {}) {
  const data = new Map(Object.entries(extra)), writes = [], fetches = [];
  const kv = {
    get: async (k) => data.get(k) ?? null,
    put: async (k, v) => { if (failPut && failPut(k)) { failPut = null; throw new Error("kv_put_failed"); } writes.push(k); data.set(k, String(v)); },
  };
  const fetchImpl = async (url) => { fetches.push(String(url)); return { ok: true, status: 200, json: async () => ({}) }; };
  return { data, writes, fetches, kv, fetchImpl, env: { ZEVANORY_PRIVATE_ARTIFACTS: kv, PUBLIC_BASE_URL: "https://zevanory.api.br" } };
}
const json = (x, k) => JSON.parse(x.data.get(k));
const RUBRIC_OK = Object.freeze({ action: "publish", compliance: 100, score: 92 });
const CLOSED = Object.freeze({ full: false, hotmart: false });

test("caso bom: segunda-feira publica 1 artigo com URL, CTA do material gratuito com UTM e status ok gravado 1 vez", async () => {
  fresh();
  const x = fake(), env = { ...x.env, INDEXNOW_KEY: "chave-publica-fake" };
  const out = await ensureDailyBlog(env, at(MON), x.fetchImpl);
  assert.equal(out.reason, "published"); assert.equal(out.created.length, 1);
  const art = json(x, "zpc:blog:article:" + out.latest.slug);
  assert.equal(art.status, "published"); assert.equal(art.url, "https://zevanory.api.br/blog/" + art.slug);
  assert.equal(art.cta_url, "https://vendas.zevanory.api.br/material-gratuito?utm_source=blog&utm_medium=organic&utm_campaign=blog_20261012");
  assert.equal(art.cta_kind, "material_gratuito"); assert.equal(art.compliance, 100); assert.ok(art.score >= 85);
  assert.doesNotMatch(JSON.stringify(art), /\/comprar\//, "nenhum checkout próprio com vendas fechadas");
  const status = json(x, BLOG_STATUS_PREFIX + MON);
  assert.deepEqual([status.resultado, status.url, status.slug], ["ok", art.url, art.slug]);
  assert.deepEqual(json(x, BLOG_WEEK_PREFIX + isoWeekOf(MON)).days, [MON]);
  assert.equal(json(x, BLOG_INDEX_KEY).articles.at(-1).slug, art.slug);
  assert.equal(x.writes.filter((k) => k === BLOG_STATUS_PREFIX + MON).length, 1);
  assert.deepEqual(x.writes.filter((k) => !/^zpc:blog:(article:|index:v1$|week:v1:|status:v1:)/.test(k)), [], "só chaves do blog");
  assert.equal(x.writes.some((k) => k.startsWith("zpc:blog:draft:")), false, "rascunho privado da DEC-21 não é mais gravado");
  assert.deepEqual(x.fetches, ["https://api.indexnow.org/indexnow"]);
  assert.match(await renderBlogArticle(env, art.slug, { salesOpen: false, hotmartOpen: false }), /<h1>/);
});

test("gate: cada mutante negativo é rejeitado pelo seu motivo e o caso bom passa", () => {
  const good = dailyEditorialArticle(MON);
  const cta = blogCtaUrl(good, CLOSED);
  const gate = (patch = {}, opts = {}) => blogQualityGate({ article: { ...good, ...patch }, priorArticles: opts.prior || [], rubric: "rubric" in opts ? opts.rubric : RUBRIC_OK, ctaUrl: opts.cta ?? cta, mode: opts.mode || CLOSED });
  assert.deepEqual(gate().reasons, [], "caso bom");
  const withSection = (t) => good.body + "\n\n## Nota\n\n" + t;
  const prior = [{ ...good, slug: "outro-" + good.slug, title: "Outro título" }];
  const mutants = [
    ["fonte_ausente", "percentual sem fonte", { body: withSection("Cerca de 62% dos pequenos negócios respondem tarde.") }],
    ["fonte_ausente", "pesquisa citada sem fonte", { body: withSection("Segundo pesquisa do Sebrae, o atendimento decide a compra.") }],
    ["fonte_ausente", "ano explícito sem fonte", { body: withSection("Em 2025 o volume de mensagens dobrou.") }],
    ["fonte_ausente", "fonte do próprio site não é verificável", { body: withSection("Cerca de 62% respondem tarde."), sources: [{ url: "https://zevanory.api.br/blog/x" }] }],
    ["fonte_ausente", "fonte sem https", { body: withSection("Cerca de 62% respondem tarde."), sources: [{ url: "http://exemplo.org/estudo" }] }],
    ["duplicado", "corpo igual a artigo anterior", {}, { prior }],
    ["duplicado", "mesmo título de artigo anterior", {}, { prior: [{ slug: "x", title: good.title.toUpperCase(), body: "texto diferente" }] }],
    ["promessa_ou_termo_proibido", "lucro garantido", { body: withSection("Com o roteiro você tem lucro garantido.") }],
    ["promessa_ou_termo_proibido", "ganhe dinheiro", { description: "Ganhe dinheiro com IA." }],
    ["promessa_ou_termo_proibido", "grátis (filtro forbidden)", { title: good.title + " grátis" }],
    ["promessa_ou_termo_proibido", "depoimento inventado", { body: withSection("Depoimento real: cliente comprovou o método.") }],
    ["sem_utilidade", "curto demais", { body: good.body.split(/\s+/).slice(0, 300).join(" ") }],
    ["sem_utilidade", "curto com seções e roteiro", { body: ["Contexto", "Roteiro", "Exemplo", "Próximo passo"].map((h) => "## " + h + "\n\nRoteiro curto com um exemplo de atendimento revisado por uma pessoa.").join("\n\n") }],
    ["sem_utilidade", "sem seções", { body: good.body.replace(/^## /gm, "") }],
    ["sem_utilidade", "sem passos nem exemplo", { body: good.body.replace(/roteiro|passo a passo|passos|exemplo|caso prático|checklist/giu, "trecho") }],
    ["compliance_score", "compliance 90", {}, { rubric: { ...RUBRIC_OK, compliance: 90 } }],
    ["compliance_score", "score 84", {}, { rubric: { ...RUBRIC_OK, score: 84 } }],
    ["compliance_score", "rubrica pede revisão", {}, { rubric: { ...RUBRIC_OK, action: "review" } }],
    ["compliance_score", "sem rubrica", {}, { rubric: null }],
    ["cta_invalido", "checkout próprio", {}, { cta: "https://vendas.zevanory.api.br/comprar/ZEV-IA-011?utm_source=blog&utm_medium=organic&utm_campaign=blog_20261012" }],
    ["cta_invalido", "sem UTM", {}, { cta: "https://vendas.zevanory.api.br/material-gratuito" }],
    ["cta_invalido", "campanha de outro dia", {}, { cta: cta.replace("blog_20261012", "blog_20261013") }],
    ["cta_invalido", "outro host", {}, { cta: cta.replace("vendas.zevanory.api.br", "vendas.zevanory.api.br.evil.example") }],
    ["cta_invalido", "Hotmart do próprio kit com o modo fechado", {}, { cta: blogCtaUrl(good, { full: false, hotmart: true }) }],
    ["trava_de_vendas", "preço com vendas fechadas", { body: withSection("O guia custa R$ 97,00 e o roteiro ajuda.") }],
    ["trava_de_vendas", "chamada de compra com vendas fechadas", { body: withSection("Compre já o roteiro completo.") }],
  ];
  for (const [reason, name, patch, opts = {}] of mutants) assert.deepEqual(gate(patch, opts).reasons, [reason], name);
  assert.deepEqual(new Set(mutants.map((m) => m[0])), new Set(BLOG_GATE_REASONS), "todo motivo do gate tem mutante");
  // Dado factual COM fonte externa verificável passa; o gate não exige fonte de texto sem dado factual.
  assert.deepEqual(gate({ body: withSection("Cerca de 62% respondem tarde."), sources: [{ title: "Estudo", url: "https://www.ibge.gov.br/estatisticas" }] }).reasons, []);
});

test("modo Hotmart: CTA /hotmart/<kit do artigo> com UTM; outro kit e checkout próprio rejeitados; interruptor completo leva ao material gratuito", async () => {
  const good = dailyEditorialArticle(MON), kitSlug = { "ZEV-IA-011": "ia-na-pratica", "ZEV-VEN-011": "vendas-na-pratica", "ZEV-LCX-011": "lucro-e-caixa", "ZEV-CMB-011": "combo-ia-vendas", "ZEV-NGC-011": "negocio-completo" }[good.product];
  const hm = { full: false, hotmart: true };
  const cta = blogCtaUrl(good, hm);
  assert.equal(cta, `https://vendas.zevanory.api.br/hotmart/${kitSlug}?utm_source=blog&utm_medium=organic&utm_campaign=blog_20261012`);
  assert.deepEqual(blogQualityGate({ article: good, rubric: RUBRIC_OK, ctaUrl: cta, mode: hm }).reasons, []);
  const other = cta.replace("/hotmart/" + kitSlug, "/hotmart/" + (kitSlug === "lucro-e-caixa" ? "ia-na-pratica" : "lucro-e-caixa"));
  assert.deepEqual(blogQualityGate({ article: good, rubric: RUBRIC_OK, ctaUrl: other, mode: hm }).reasons, ["cta_invalido"]);
  assert.match(blogCtaUrl(good, { full: true, hotmart: true }), /\/material-gratuito\?/);
  // Ponta a ponta com o interruptor Hotmart real (autorização do dono no KV falso).
  fresh();
  const x = fake({ "sales:hotmart:v1": JSON.stringify({ enabled: true, channel: "hotmart", authorization: "LIBERAR VENDAS", by: "owner-test", at: new Date(Date.now() - 60_000).toISOString(), ref: "teste/blog" }) });
  const out = await ensureDailyBlog(x.env, at(MON), x.fetchImpl);
  fresh();
  assert.equal(out.reason, "published");
  assert.equal(json(x, "zpc:blog:article:" + out.latest.slug).cta_url, cta);
  const html = await renderBlogArticle(x.env, out.latest.slug, { salesOpen: false, hotmartOpen: true });
  assert.ok(html.includes(`href="https://vendas.zevanory.api.br/hotmart/${kitSlug}?utm_source=blog&utm_medium=organic&utm_campaign=blog_20261012">Comprar pela Hotmart</a>`));
  assert.doesNotMatch(html, /\/comprar\//);
});

test("agenda e teto: só seg/qua/sex; no máximo 3 por semana ISO; o teto rejeita com status único e não regrava", async () => {
  fresh();
  const x = fake();
  const published = [];
  for (let i = 0; i < 28; i++) {
    const day = new Date(Date.UTC(2026, 9, 12 + i)).toISOString().slice(0, 10);
    const before = x.writes.length;
    const out = await ensureDailyBlog(x.env, at(day), x.fetchImpl);
    const wd = new Date(day + "T12:00:00Z").getUTCDay();
    if ([1, 3, 5].includes(wd)) { assert.equal(out.reason, "published", day); published.push(day); }
    else { assert.equal(out.reason, "not_publication_day", day); assert.equal(x.writes.length, before, "nenhuma gravação fora da agenda " + day); }
  }
  const perWeek = {};
  for (const d of published) perWeek[isoWeekOf(d)] = (perWeek[isoWeekOf(d)] || 0) + 1;
  assert.ok(Object.values(perWeek).every((n) => n <= BLOG_WEEKLY_CAP), JSON.stringify(perWeek));
  assert.equal(published.length, 12);
  // Contador já cheio com outros 3 dias (ex.: publicação recuperada): sexta é rejeitada pelo teto.
  const y = fake({ [BLOG_WEEK_PREFIX + isoWeekOf(FRI)]: JSON.stringify({ days: ["2026-10-12", "2026-10-13", "2026-10-14"] }) });
  const capped = await ensureDailyBlog(y.env, at(FRI), y.fetchImpl);
  assert.equal(capped.reason, "rejected:teto_semanal");
  assert.deepEqual(y.writes, [BLOG_STATUS_PREFIX + FRI], "só o status do dia");
  const again = await ensureDailyBlog(y.env, at(FRI, "20:00"), y.fetchImpl);
  assert.equal(again.reason, "rejected:teto_semanal"); assert.equal(y.writes.length, 1, "no máximo 1 gravação de status por dia");
  // O mesmo dia já contado não é barrado pelo próprio teto (idempotência do contador).
  const z = fake({ [BLOG_WEEK_PREFIX + isoWeekOf(FRI)]: JSON.stringify({ days: ["2026-10-12", "2026-10-14", FRI] }) });
  assert.equal((await ensureDailyBlog(z.env, at(FRI), z.fetchImpl)).reason, "published");
  assert.deepEqual(json(z, BLOG_WEEK_PREFIX + isoWeekOf(FRI)).days, ["2026-10-12", "2026-10-14", FRI]);
});

test("idempotência: reexecução no dia não grava; queda antes do status repete sem duplicar índice nem contador", async () => {
  fresh();
  const x = fake();
  const first = await ensureDailyBlog(x.env, at(WED), x.fetchImpl);
  const n = x.writes.length;
  const again = await ensureDailyBlog(x.env, at(WED, "22:00"), x.fetchImpl);
  assert.equal(again.reason, "already_published"); assert.equal(again.latest.slug, first.latest.slug); assert.equal(x.writes.length, n);
  assert.equal((await ensureDailyBlog(x.env, at(TUE), x.fetchImpl)).reason, "not_publication_day");
  // Queda na gravação do status: a nova tentativa publica o MESMO artigo, sem segunda entrada no índice nem no contador.
  const y = fake({}, { failPut: (k) => k.startsWith(BLOG_STATUS_PREFIX) });
  await assert.rejects(ensureDailyBlog(y.env, at(WED), y.fetchImpl), /kv_put_failed/);
  const retry = await ensureDailyBlog(y.env, at(WED), y.fetchImpl);
  assert.equal(retry.reason, "published"); assert.equal(retry.latest.slug, first.latest.slug);
  assert.equal(json(y, BLOG_INDEX_KEY).articles.filter((a) => a.slug === first.latest.slug).length, 1);
  assert.deepEqual(json(y, BLOG_WEEK_PREFIX + isoWeekOf(WED)).days, [WED]);
  assert.equal(y.writes.filter((k) => k.startsWith(BLOG_WEEK_PREFIX)).length, 1, "contador gravado uma vez");
});

test("rejeição ponta a ponta: duplicata grava só o status com o motivo; o motor reporta erro com o código; pausa não grava", async () => {
  fresh();
  const art = dailyEditorialArticle(MON);
  const x = fake({ [BLOG_INDEX_KEY]: JSON.stringify({ articles: [{ ...art, slug: "copia-" + art.slug, title: "Cópia antiga" }] }) });
  const out = await ensureDailyBlog(x.env, at(MON), x.fetchImpl);
  assert.equal(out.reason, "rejected:duplicado");
  assert.deepEqual(x.writes, [BLOG_STATUS_PREFIX + MON]);
  const st = json(x, BLOG_STATUS_PREFIX + MON);
  assert.deepEqual([st.resultado, st.motivos, st.slug], ["rejeitado", ["duplicado"], art.slug]);
  assert.equal(x.data.has("zpc:blog:article:" + art.slug), false);
  const eng = await runAcquisitionEngine({ ZEVANORY_PRIVATE_ARTIFACTS: x.kv }, at(MON), x.fetchImpl);
  assert.deepEqual(((o) => [o.status, o.code])(eng.outcomes.find((o) => o.channel === "blog")), ["erro", "rejected:duplicado"]);
  assert.equal(x.writes.filter((k) => k === BLOG_STATUS_PREFIX + MON).length, 1, "status do dia gravado uma única vez");
  const p = fake({ [CREATIVE_AUTOPUBLISH_PAUSE_KEY]: "1" });
  assert.equal((await ensureDailyBlog(p.env, at(MON), p.fetchImpl)).reason, "creative_autopublish_paused");
  assert.deepEqual(p.writes, []);
});

test("motor de aquisição: segunda após as 9h publica o blog com URL e evidência; sábado fica fora da agenda", async () => {
  fresh();
  const x = fake();
  const a = await runAcquisitionEngine({ ZEVANORY_PRIVATE_ARTIFACTS: x.kv }, at(MON), x.fetchImpl);
  const blog = a.outcomes.find((o) => o.channel === "blog");
  assert.equal(blog.status, "publicado"); assert.match(blog.url, /^https:\/\/zevanory\.api\.br\/blog\//);
  const b = await runAcquisitionEngine({ ZEVANORY_PRIVATE_ARTIFACTS: x.kv }, at(MON, "15:35"), x.fetchImpl);
  assert.equal(b.outcomes.find((o) => o.channel === "blog").url, blog.url);
  assert.equal(json(x, BLOG_INDEX_KEY).articles.length, 1);
  const s = await runAcquisitionEngine({ ZEVANORY_PRIVATE_ARTIFACTS: fake().kv }, at("2026-10-17"), x.fetchImpl);
  assert.deepEqual(((o) => [o.status, o.code])(s.outcomes.find((o) => o.channel === "blog")), ["fora_da_agenda", "not_publication_day"]);
});
