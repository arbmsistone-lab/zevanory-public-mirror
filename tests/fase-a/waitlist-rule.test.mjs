// P01 Fase A: regra de decisão pré-registrada (docs/p01/FASE_A_PROTOCOLO.md §5) e intervalo de Wilson.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
// WAITLIST_MODULE: o executor de mutantes troca o módulo testado.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { wilson, decide, RULE, normalizeContact, isEligibleTraffic, visitorSecret, windowOf, personFromCookie, sourceTag, sourceGroup, channelBalance, finalistsOf, testWeekSummary, TEST_WEEK } =
  await import(pathToFileURL(path.resolve(process.env.WAITLIST_MODULE || path.join(ROOT, "worker", "waitlist.mjs"))).href);

const near = (a, b, eps = 5e-4) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("Wilson 95%: valores de referência", () => {
  near(wilson(0, 10).low, 0); near(wilson(0, 10).high, 0.2775);
  near(wilson(5, 10).low, 0.2366); near(wilson(5, 10).high, 0.7634);
  near(wilson(24, 300).low, 0.0543); near(wilson(24, 300).high, 0.1163);
  assert.deepEqual(wilson(0, 0), { low: 0, high: 0 });
});

test("regra: <300 visitantes é INCONCLUSIVO (nunca NO-GO); GO exige conversão >= 8%, Wilson inferior >= 5% e >= 20 leads", () => {
  assert.deepEqual({ ...RULE }, { minVisitors: 300, minConversion: 0.08, minWilsonLow: 0.05, minLeads: 20 });
  assert.equal(decide({ visitors: 299, signups: 200 }), "INCONCLUSIVO");
  assert.equal(decide({ visitors: 0, signups: 0 }), "INCONCLUSIVO");
  assert.equal(decide({ visitors: 299, signups: 0, complianceViolation: true }), "INCONCLUSIVO");
  assert.equal(decide({ visitors: 300, signups: 24 }), "GO");
  assert.equal(decide({ visitors: 300, signups: 23 }), "NO-GO", "7,67% < 8%");
  assert.equal(decide({ visitors: 1000, signups: 80 }), "GO");
  assert.equal(decide({ visitors: 1000, signups: 79 }), "NO-GO");
  assert.equal(decide({ visitors: 300, signups: 30, complianceViolation: true }), "NO-GO", "violação de conformidade impede GO");
  // Wilson inferior < 5% com conversão >= 8% só ocorre com n pequeno, que já é INCONCLUSIVO (< 300);
  // com >= 300 visitantes e 8%, o limite inferior é >= 5,4%: os critérios são coerentes.
  assert.ok(wilson(24, 300).low >= RULE.minWilsonLow);
  for (const b of ["segredo_de_visitante_ausente", "identificador_nao_estabelecido", "inscricao_sem_identificador", "oraculo_divergente"])
    assert.equal(decide({ visitors: 1000, signups: 200, blockers: [b] }), "INCONCLUSIVO", b);
});

test("segredo de visitante: dedicado, >= 32 bytes, sem fallback; janela válida limita o cookie a 60 dias e vence no fim", async () => {
  assert.equal(visitorSecret({ RESEND_API_KEY: "r".repeat(60), DATABASE_URL: "postgres://" + "d".repeat(60), LEAD_PRIVACY_SECRET: "l".repeat(60) }), null);
  assert.equal(visitorSecret({ WAITLIST_VISITOR_SECRET: "x".repeat(31) }), null);
  assert.equal(visitorSecret({ WAITLIST_VISITOR_SECRET: "x".repeat(32) }), "x".repeat(32));
  const now = Date.parse("2026-11-02T12:00:00Z");
  assert.equal(windowOf({ FASE_A_WINDOW_ID: "fa1" }, now), null);
  assert.equal(windowOf({ FASE_A_WINDOW_ID: "FA 1", FASE_A_WINDOW_END: "2026-11-30" }, now), null);
  assert.equal(windowOf({ FASE_A_WINDOW_ID: "fa1", FASE_A_WINDOW_END: "2026-11-01" }, now), null);
  assert.equal(windowOf({ FASE_A_WINDOW_ID: "fa1", FASE_A_WINDOW_END: "2027-06-30" }, now).maxAge, 60 * 86400);
  const env = { WAITLIST_VISITOR_SECRET: "v".repeat(40), FASE_A_WINDOW_ID: "fa1", FASE_A_WINDOW_END: "2026-11-30" };
  assert.equal(await personFromCookie(env, "a".repeat(32) + "." + "b".repeat(32), now), null, "assinatura forjada");
  assert.equal(await personFromCookie({ ...env, WAITLIST_VISITOR_SECRET: "" }, "a".repeat(65), now), null);
});

test("protocolo registrado contém exatamente os limiares implementados", () => {
  const doc = fs.readFileSync(new URL("../../docs/p01/FASE_A_PROTOCOLO.md", import.meta.url), "utf8");
  for (const s of ["300 pessoas experimentais", "≥ 8%", "≥ 5%", "≥ 20", "INCONCLUSIVO", "R$ 27", "R$ 47", "Wilson", "WAITLIST_VISITOR_SECRET", "M-SOL-085", "sensibilidade", "oráculo", "30 dias após a decisão", "180 dias", "8 dias", "**v3 (22/10/2026)**", "semana de teste", "≥ 98 visitas qualificadas", "21 dias", "`wa_status`", "`parc_<nome>`", "`meta_<nome>`", "Mistura de canais", "origem ausente **nunca** conta"]) assert.ok(doc.includes(s), s);
});

test("contato: e-mail e WhatsApp brasileiro normalizados; outros formatos recusados", () => {
  assert.deepEqual(normalizeContact(" Ana@Exemplo.COM "), { kind: "email", value: "ana@exemplo.com" });
  assert.deepEqual(normalizeContact("(88) 99254-0000"), { kind: "whatsapp", value: "5588992540000" });
  assert.deepEqual(normalizeContact("+55 11 3333-4444"), { kind: "whatsapp", value: "551133334444" });
  for (const bad of ["", "abc", "123456", "+1 415 555 0100", "ana@", "<a>@x.com", "5500992540000", "x".repeat(300) + "@a.com"]) assert.equal(normalizeContact(bad), null, bad);
});

test("tráfego elegível = mesmo filtro do funil (UA de automação, ASN de datacenter, prefetch)", () => {
  const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
  assert.equal(isEligibleTraffic({ userAgent: ua, asn: 26599 }), true);
  assert.equal(isEligibleTraffic({ userAgent: ua, asn: 16509 }), false);
  assert.equal(isEligibleTraffic({ userAgent: ua, purpose: "prefetch" }), false);
  assert.equal(isEligibleTraffic({ userAgent: "Mozilla/5.0 (compatible; bingbot/2.0)" }), false);
  assert.equal(isEligibleTraffic({ userAgent: "" }), false);
});

test("origem (v3): lista fechada wa_status, wa_lista, ig_story, ig_post, ig_reel, fb_grupo, parc_*, organico, direto, meta_* reservado; grupos pré-registrados", () => {
  for (const t of ["wa_status", "wa_lista", "ig_story", "ig_post", "ig_reel", "fb_grupo", "organico", "direto", "parc_x1", "meta_ads"]) assert.equal(sourceTag({ utm: t }), t);
  assert.equal(sourceTag({ utm: "WA_STATUS" }), "wa_status");
  for (const t of ["youtube", "parc_", "meta_", "parc_" + "a".repeat(21), "x"]) assert.equal(sourceTag({ utm: t }), "invalido", t);
  assert.equal(sourceTag({ refExternal: true }), "organico");
  assert.equal(sourceTag({}), "direto");
  assert.deepEqual(["wa_status", "wa_lista", "parc_x", "meta_y", "sem_tag", "invalido", "ig_post", "direto"].map(sourceGroup), ["rede_pessoal", "rede_pessoal", "parceiro", "reservado_meta", "sem_origem", "sem_origem", "canal", "canal"]);
});

test("mistura de canais entre os braços: origem ausente NUNCA conta como equilibrada; diferença > 10 pontos = desequilibrada; finalistas só com mistura equilibrada", () => {
  const same = { ig_post: 50, direto: 50 };
  assert.equal(channelBalance({ confeitaria: same, "loja-de-roupas": same, "salao-e-barbearia": same }).status, "EQUILIBRADO");
  const missing = { sem_tag: 100 };
  const nb = channelBalance({ confeitaria: missing, "loja-de-roupas": missing, "salao-e-barbearia": missing });
  assert.deepEqual([nb.status, nb.reason], ["NAO_VERIFICAVEL", "origem_ausente"]);
  assert.equal(channelBalance({ confeitaria: { ig_post: 94, invalido: 6 }, "loja-de-roupas": { ig_post: 94, invalido: 6 }, "salao-e-barbearia": { ig_post: 94, invalido: 6 } }).status, "NAO_VERIFICAVEL");
  assert.equal(channelBalance({ confeitaria: { ig_post: 96, sem_tag: 4 }, "loja-de-roupas": { ig_post: 96, sem_tag: 4 }, "salao-e-barbearia": { ig_post: 96, sem_tag: 4 } }).status, "EQUILIBRADO");
  assert.equal(channelBalance({ confeitaria: { ig_post: 70, direto: 30 }, "loja-de-roupas": same, "salao-e-barbearia": same }).status, "DESEQUILIBRADO");
  assert.equal(channelBalance({ confeitaria: same, "loja-de-roupas": {}, "salao-e-barbearia": same }).status, "NAO_VERIFICAVEL");
  const go = (low, signups) => ({ decision: "GO", wilson95: { low }, signups });
  const niches = { confeitaria: go(0.06, 30), "loja-de-roupas": go(0.07, 25), "salao-e-barbearia": go(0.06, 31) };
  assert.deepEqual(finalistsOf(niches, { status: "EQUILIBRADO" }).finalists, ["loja-de-roupas", "salao-e-barbearia"]);
  assert.deepEqual(finalistsOf(niches, { status: "NAO_VERIFICAVEL" }), { finalists: [], reason: "mistura_de_canais_nao_verificavel" });
});

test("semana de teste (condição do Sol): 7 dias consecutivos, >= 98 qualificadas por nicho, distribuição estável e zero pago; só autoriza o teste de 21 dias", () => {
  assert.deepEqual({ ...TEST_WEEK }, { days: 7, minQualifiedPerNiche: 98, maxDayShare: 0.30, maxPaid: 0, windowDays: 21 });
  const days = Array.from({ length: 7 }, (_, i) => new Date(Date.parse("2026-11-03T00:00:00Z") + i * 86400000).toISOString().slice(0, 10));
  const mk = (per, { skip = null, paid = {} } = {}) => Object.entries(per).flatMap(([n, q]) => days.filter((d) => d !== skip).flatMap((day, i) => {
    const qq = Array.isArray(q) ? q[i] : q;
    return [{ day, metric: `sdt:${n}:visita`, n: qq + 5 }, { day, metric: `sdt:${n}:qualificada`, n: qq }, ...(paid[n] && i === 0 ? [{ day, metric: `sdt:${n}:pago`, n: paid[n] }] : [])];
  }));
  const P = { since: "2026-11-03", until: "2026-11-09" };
  const ok = testWeekSummary(mk({ confeitaria: 14, "loja-de-roupas": 15, "salao-e-barbearia": 20 }), P);
  assert.equal(ok.decision, "AUTORIZA_TESTE_21_DIAS");
  assert.equal(ok.niches.confeitaria.qualified, 98);
  const low = testWeekSummary(mk({ confeitaria: 30, "loja-de-roupas": 30, "salao-e-barbearia": 13 }), P);
  assert.deepEqual([low.decision, low.niches["salao-e-barbearia"].reasons], ["NAO_AUTORIZA", ["menos_de_98_qualificadas"]], "um nicho com 91 segura a autorização");
  const gap = testWeekSummary(mk({ confeitaria: 20, "loja-de-roupas": 20, "salao-e-barbearia": 20 }, { skip: "2026-11-05" }), P);
  assert.deepEqual([gap.decision, gap.niches.confeitaria.reasons], ["NAO_AUTORIZA", ["dias_nao_consecutivos"]], "dia sem tráfego quebra a sequência");
  const spike = testWeekSummary(mk({ confeitaria: [80, 4, 4, 4, 4, 4, 4], "loja-de-roupas": 20, "salao-e-barbearia": 20 }), P);
  assert.deepEqual([spike.decision, spike.niches.confeitaria.reasons], ["NAO_AUTORIZA", ["distribuicao_instavel"]], "um dia com 77% das qualificadas");
  const paid = testWeekSummary(mk({ confeitaria: 20, "loja-de-roupas": 20, "salao-e-barbearia": 20 }, { paid: { "loja-de-roupas": 1 } }), P);
  assert.deepEqual([paid.decision, paid.niches["loja-de-roupas"].reasons], ["NAO_AUTORIZA", ["trafego_pago"]], "uma visita paga basta para não autorizar");
  for (const until of ["2026-11-08", "2026-11-10"]) assert.equal(testWeekSummary(mk({ confeitaria: 99, "loja-de-roupas": 99, "salao-e-barbearia": 99 }), { since: "2026-11-03", until }).decision, "PERIODO_INVALIDO", until);
  assert.match(ok.note, /somente a abertura do teste de 21 dias/);
});
