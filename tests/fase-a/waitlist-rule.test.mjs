// P01 Fase A: regra de decisão pré-registrada (docs/p01/FASE_A_PROTOCOLO.md §5) e intervalo de Wilson.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
// WAITLIST_MODULE: o executor de mutantes troca o módulo testado.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { liaActivation, parseLia, CONSENT_VERSION, RETENTION, wilson, decide, RULE, normalizeContact, isEligibleTraffic, visitorSecret, windowOf, personFromCookie, sourceTag, sourceGroup, channelBalance, finalistsOf, testWeekSummary, TEST_WEEK, summarize, WA_OWNED_TAGS, SOURCE_CLASSES } =
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
  for (const s of ["300 pessoas experimentais", "≥ 8%", "≥ 5%", "≥ 20", "INCONCLUSIVO", "R$ 27", "R$ 47", "Wilson", "WAITLIST_VISITOR_SECRET", "M-SOL-085", "sensibilidade", "oráculo", "30 dias após a decisão", "180 dias", "8 dias", "**v4 (23/10/2026)**", "semana de teste", "≥ 98 visitas qualificadas", "21 dias", "`wa_status`", "`parc_<nome>`", "`meta_<nome>`", "Mistura de canais", "origem ausente **nunca** conta", "`wa_owned`", "métrica secundária", "## 2.2. Multi-aparelho e multi-nicho", "docs/lgpd/LIA-fase-a.md"]) assert.ok(doc.includes(s), s);
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

test("origem (v4): lista fechada wa_status, wa_lista, ig_story, ig_post, ig_reel, fb_grupo, parc_*, organico, direto, meta_* reservado; classe wa_owned pré-registrada", () => {
  for (const t of ["wa_status", "wa_lista", "ig_story", "ig_post", "ig_reel", "fb_grupo", "organico", "direto", "parc_x1", "meta_ads"]) assert.equal(sourceTag({ utm: t }), t);
  assert.equal(sourceTag({ utm: "WA_STATUS" }), "wa_status");
  for (const t of ["youtube", "parc_", "meta_", "parc_" + "a".repeat(21), "x"]) assert.equal(sourceTag({ utm: t }), "invalido", t);
  assert.equal(sourceTag({ refExternal: true }), "organico");
  assert.equal(sourceTag({}), "direto");
  assert.deepEqual(["wa_status", "wa_lista", "parc_x", "meta_y", "sem_tag", "invalido", "ig_post", "direto"].map(sourceGroup), ["wa_owned", "wa_owned", "parceiro", "reservado_meta", "sem_origem", "sem_origem", "canal", "canal"]);
  assert.deepEqual([...WA_OWNED_TAGS], ["wa_status", "wa_lista"]);
  assert.deepEqual([...SOURCE_CLASSES], ["canal", "wa_owned", "parceiro", "reservado_meta", "sem_origem"]);
  // wa_owned sai da mistura da população da decisão, mas aparece na mistura total e na métrica secundária (sem decidir).
  const row = (niche, o = {}) => ({ niche, persons: 300, signups: 30, persons_wa_owned: 40, signups_wa_owned: 2, persons_linhas: 0, persons_confirmadas_linhas: 0, aliases: 0, signups_linhas: 0, pessoa_dia: 0, raw: {}, ...o });
  const out = summarize([row("confeitaria")], { windowId: "fa1", sources: [{ niche: "confeitaria", src: "ig_post", n: 300 }, { niche: "confeitaria", src: "wa_status", n: 30 }, { niche: "confeitaria", src: "wa_lista", n: 10 }] });
  const c = out.niches.confeitaria;
  assert.deepEqual(c.source_mix_decision_population, { ig_post: 300 });
  assert.deepEqual(c.source_mix, { ig_post: 300, wa_status: 30, wa_lista: 10 });
  assert.deepEqual({ ...c.secondary.wa_owned, wilson95: undefined }, { source_class: "wa_owned", persons: 40, signups: 2, conversion: 0.05, wilson95: undefined, decides: false });
  near(c.secondary.wa_owned.wilson95.low, wilson(2, 40).low);
  assert.equal(c.decision, "GO", "a secundária (5%) não muda a decisão primária (10%)");
  assert.equal(c.excluded_source.wa_owned, 40);
  assert.equal(out.protocol, "v4");
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

test("LIA (LGPD art. 7º, IX e art. 10) registrada e versionada: finalidade, necessidade, balanceamento, minimização, direitos, opt-out e pendência de revisão jurídica", () => {
  const lia = fs.readFileSync(new URL("../../docs/lgpd/LIA-fase-a.md", import.meta.url), "utf8");
  for (const s of ["Versão: 1", "art. 7º, IX", "art. 10", "## 1. Finalidade", "## 2. Necessidade", "## 3. Balanceamento",
    "## 4. Minimização e salvaguardas", "## 5. Direitos do titular", "## 6. Oposição (opt-out)", "dado pessoal pseudonimizado", "WAITLIST_VISITOR_SECRET",
    "rotação", "30 dias após a decisão", "runWaitlistRetention", "consentimento separado", "wa_owned", "multi-aparelho", "art. 18"]) assert.ok(lia.includes(s), s);
  // Coerência com o código: retenção e versão do consentimento citadas são as implementadas.
  assert.ok(lia.includes("`" + CONSENT_VERSION + "`"), "versão do consentimento");
  assert.ok(lia.includes(RETENTION.measurementMaxDays + " dias") && lia.includes(RETENTION.cookieMaxDays + " dias"));
  // Enquanto não houver linha de aprovação completa, o marcador de pendência tem de estar lá.
  if (!parseLia(lia).approval) assert.ok(lia.includes("PENDENTE DE REVISÃO JURÍDICA"), "LIA sem aprovação precisa do marcador de pendência");
});

test("trava da LIA (AVAL 099): ativação só com LIA sem pendência, tabela de aprovação completa e FASE_A_LIA_APPROVED_SHA256 igual ao sha256; LIA editada depois da aprovação desliga", async () => {
  const { TEST_LIA, TEST_LIA_SHA, APPROVED_TEXT, REAL_LIA_TEXT, approvedText, manifestOf } = await import("./lia-fixture.mjs");
  const ok = { FASE_A_LIA_APPROVED_SHA256: TEST_LIA_SHA };
  assert.deepEqual([liaActivation(ok, TEST_LIA).active, liaActivation(ok, TEST_LIA).reason], [true, null]);
  assert.equal(liaActivation({ FASE_A_LIA_APPROVED_SHA256: TEST_LIA_SHA.toUpperCase() }, TEST_LIA).active, true, "hex maiúsculo aceito");
  // O repositório: LIA pendente => travada, mesmo com qualquer hash configurado (inclusive o do próprio arquivo).
  const real = await manifestOf(REAL_LIA_TEXT);
  assert.equal(real.pending_marker, true);
  assert.equal(real.approval, null);
  assert.equal(liaActivation({ FASE_A_LIA_APPROVED_SHA256: real.sha256 }, real).reason, "lia_pendente_de_revisao");
  assert.equal(liaActivation({ FASE_A_LIA_APPROVED_SHA256: real.sha256 }).reason, "lia_pendente_de_revisao", "manifesto embutido no Worker");
  const reasons = async (text, env = null) => { const m = await manifestOf(text); return liaActivation(env || { FASE_A_LIA_APPROVED_SHA256: m.sha256 }, m).reason; };
  // Tabela incompleta (mesmo com o hash do próprio texto configurado).
  for (const row of ["| Revisora | | 1 | APROVADA | x |", "| Revisora | 2026-02-30 | 1 | APROVADA | x |", "| Revisora | 2026-10-24 | 2 | APROVADA | x |",
    "| Revisora | 2026-10-24 | 1 | pendente | x |", "| _pendente_ | 2026-10-24 | 1 | APROVADA | x |", "| | 2026-10-24 | 1 | APROVADA | x |", "| Revisora | 2026-10-24 | | APROVADA | x |"])
    assert.ok(["lia_aprovacao_incompleta", "lia_pendente_de_revisao"].includes(await reasons(approvedText(REAL_LIA_TEXT, row))), row);
  assert.equal(await reasons(approvedText(REAL_LIA_TEXT, "| Revisora | 2026-10-24 | 2 | APROVADA | x |")), "lia_aprovacao_incompleta", "versão diferente da LIA");
  // Marcador de pendência que sobrou = travada, mesmo com tabela completa.
  assert.equal(await reasons(APPROVED_TEXT + "\nPENDENTE DE REVISÃO JURÍDICA\n"), "lia_pendente_de_revisao");
  // Hash: ausente, mal formado, divergente.
  assert.equal(liaActivation({}, TEST_LIA).reason, "aprovacao_nao_configurada");
  assert.equal(liaActivation({ FASE_A_LIA_APPROVED_SHA256: "z".repeat(64) }, TEST_LIA).reason, "aprovacao_formato_invalido");
  assert.equal(liaActivation({ FASE_A_LIA_APPROVED_SHA256: "0".repeat(64) }, TEST_LIA).reason, "lia_alterada_apos_aprovacao");
  // Edição de UM caractere depois da aprovação: novo sha256, a mesma aprovação deixa de valer.
  const edited = await manifestOf(APPROVED_TEXT.replace("Finalidade", "Finalidades"));
  assert.notEqual(edited.sha256, TEST_LIA_SHA);
  assert.deepEqual([liaActivation(ok, edited).active, liaActivation(ok, edited).reason], [false, "lia_alterada_apos_aprovacao"]);
  // CRLF não muda o hash (checkout Windows).
  assert.equal((await manifestOf(APPROVED_TEXT.replace(/\n/g, "\r\n"))).sha256, TEST_LIA_SHA);
  for (const bad of [null, {}, { ...TEST_LIA, sha256: "x" }]) assert.equal(liaActivation(ok, bad).reason, "lia_manifesto_invalido");
});

test("manifesto da LIA embutido no Worker (worker/fase-a-lia.generated.mjs) idêntico ao documento: editar a LIA sem regenerar quebra o CI", async () => {
  const { buildManifest, liaText, render, GENERATED } = await import("../../scripts/fase_a/lia_manifest.mjs");
  const want = render(await buildManifest(liaText()));
  assert.equal(fs.readFileSync(GENERATED, "utf8").replace(/\r\n/g, "\n"), want, "rode: node scripts/fase_a/lia_manifest.mjs --write");
});
