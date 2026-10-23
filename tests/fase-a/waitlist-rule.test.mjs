// P01 Fase A: regra de decisão pré-registrada (docs/p01/FASE_A_PROTOCOLO.md §5) e intervalo de Wilson.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
// WAITLIST_MODULE: o executor de mutantes troca o módulo testado.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { liaActivation, parseLia, CONSENT_VERSION, RETENTION, wilson, decide, RULE, normalizeContact, isEligibleTraffic, visitorSecret, windowOf, personFromCookie, sourceTag, sourceGroup, channelBalance, finalistsOf, testWeekSummary, TEST_WEEK, summarize, WA_OWNED_TAGS, SOURCE_CLASSES, UNIT, AVISO_VERSION, SMALL_CELL_K, suppressSmallCells, anonymousAggregate, retentionTriggers } =
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
  for (const s of ["300 navegadores/dispositivos pseudônimos", "≥ 8%", "≥ 5%", "≥ 20", "INCONCLUSIVO", "R$ 27", "R$ 47", "Wilson", "WAITLIST_VISITOR_SECRET", "M-SOL-085", "navegador/dispositivo pseudônimo", "zvfa_optout=1", "Sec-GPC: 1", "60 dias após o fim da janela", "Sem teto genérico de 180", "waitlist_deletion_log", "células pequenas", "Aviso antes da coleta", "docs/lgpd/ROPA-fase-a.md", "sensibilidade", "oráculo", "30 dias após a decisão", "8 dias", "**v5 (23/10/2026)**", "semana de teste", "≥ 98 visitas qualificadas", "21 dias", "`wa_status`", "`parc_<nome>`", "`meta_<nome>`", "Mistura de canais", "origem ausente **nunca** conta", "`wa_owned`", "métrica secundária", "## 2.2. Multi-aparelho e multi-nicho", "docs/lgpd/LIA-fase-a.md"]) assert.ok(doc.includes(s), s);
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
  const row = (niche, o = {}) => ({ niche, browsers: 300, signups: 30, browsers_wa_owned: 40, signups_wa_owned: 2, browsers_linhas: 0, browsers_confirmados_linhas: 0, aliases: 0, signups_linhas: 0, raw: {}, ...o });
  const out = summarize([row("confeitaria")], { windowId: "fa1", sources: [{ niche: "confeitaria", src: "ig_post", n: 300 }, { niche: "confeitaria", src: "wa_status", n: 30 }, { niche: "confeitaria", src: "wa_lista", n: 10 }] });
  const c = out.niches.confeitaria;
  assert.deepEqual(c.source_mix_decision_population, { ig_post: 300 });
  assert.deepEqual(c.source_mix, { ig_post: 300, wa_status: 30, wa_lista: 10 });
  assert.deepEqual({ ...c.secondary.wa_owned, wilson95: undefined }, { source_class: "wa_owned", unit: UNIT, browsers: 40, signups: 2, conversion: 0.05, wilson95: undefined, decides: false });
  near(c.secondary.wa_owned.wilson95.low, wilson(2, 40).low);
  assert.equal(c.decision, "GO", "a secundária (5%) não muda a decisão primária (10%)");
  assert.equal(c.excluded_source.wa_owned, 40);
  assert.equal(out.protocol, "v5");
  assert.equal(c.unit, "navegador_dispositivo_pseudonimo");
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

test("LIA v2 (texto substitutivo da AVAL 101) + ROPA (art. 37) + gatilhos de RIPD (art. 38) versionados e pendentes; textos coerentes com o código", () => {
  const read = (f) => fs.readFileSync(new URL("../../docs/lgpd/" + f, import.meta.url), "utf8");
  const lia = read("LIA-fase-a.md"), ropa = read("ROPA-fase-a.md"), ripd = read("RIPD-gatilhos-fase-a.md");
  for (const s of ["Versão: 2", "arts. 7º, IX, e 10", "## 0. Estado e escopo", "## 1. Finalidade específica e resultado permitido", "## 2. Dados mínimos e necessidade",
    "## 3. Expectativa e balanceamento", "## 4. Transparência, opt-out e direitos", "## 5. Retenção e eliminação", "## 6. Segurança e governança", "## 7. Aprovação fail-closed",
    "navegadores/dispositivos pseudônimos", "não representa uma pessoa única", "“Não participar da medição”", "`zvfa_optout=1`", "`Sec-GPC: 1`", "não será descrita como opt-out",
    "não serão armazenados em formato bruto nem como derivado individual persistente", "não é dirigido a crianças ou adolescentes", "Cloudflare e Neon/Postgres",
    "`[canal e identidade formal a confirmar pelo proprietário]`", "não será orientado a enviar o valor\nbruto do cookie por e-mail".replace("\\n", "\n"), "60 dias após o fechamento da janela",
    "Não existe\nprorrogação genérica até 180 dias".replace("\\n", "\n"), "supressão de células pequenas", "`FASE_A_LIA_APPROVED_SHA256`"]) assert.ok(lia.includes(s), "LIA: " + s);
  for (const s of ["Versão: 1", "art. 37", "Cloudflare, Inc.", "Neon", "Transferência internacional", "[região do projeto Neon a confirmar pelo proprietário no painel]", "waitlist_deletion_log",
    "60 dias após o fim da janela", "SHA do código aprovado", "Incidentes", "[canal e identidade formal a confirmar pelo proprietário]", "`FASE_A_ROPA_APPROVED_SHA256`"]) assert.ok(ropa.includes(s), "ROPA: " + s);
  for (const s of ["art. 38", "Fingerprinting", "Cruzamento", "Tráfego pago", "Novo operador", "criança ou adolescente", "Incidente"]) assert.ok(ripd.includes(s), "RIPD: " + s);
  for (const doc of [lia, ropa, ripd]) {
    assert.ok(doc.includes("PENDENTE DE REVISÃO JURÍDICA"), "marcador de pendência");
    assert.equal(parseLia(doc).approval, null, "aprovação nunca preenchida por automação");
  }
  assert.ok(!/encarregad[oa] \(LGPD\): suporte@/i.test(lia + ropa), "suporte@ não é chamado de encarregado sem designação formal");
  assert.deepEqual({ ...RETENTION }, { afterDecisionDays: 30, afterWindowCloseDays: 60, signupMaxMonths: 12, cookieMaxDays: 60 });
  assert.equal(UNIT, "navegador_dispositivo_pseudonimo");
  assert.match(AVISO_VERSION, /^fase-a-aviso-v\d+-\d{4}-\d{2}-\d{2}$/);
});

test("retenção: gatilhos pré-registrados (encerrado sem continuidade, decisão + 30, janela + 60) e agregado anonimizado com supressão de células < 5", () => {
  const now = Date.parse("2026-12-10T12:00:00Z");
  assert.deepEqual(retentionTriggers({}, now), { purpose_over: false, trigger: null, window_cut: "2026-10-11" });
  assert.equal(retentionTriggers({ FASE_A_DECISION_DATE: "2026-11-10" }, now).trigger, "30_dias_apos_decisao");
  assert.equal(retentionTriggers({ FASE_A_DECISION_DATE: "2026-11-11" }, now).purpose_over, false, "29 dias");
  assert.equal(retentionTriggers({ FASE_A_CLOSED_NO_CONTINUATION: "2026-12-10" }, now).trigger, "encerrado_sem_continuidade");
  assert.equal(retentionTriggers({ FASE_A_CLOSED_NO_CONTINUATION: "2026-12-11" }, now).purpose_over, false, "ainda não encerrado");
  assert.equal(retentionTriggers({ FASE_A_CLOSED_NO_CONTINUATION: "x" }, now).purpose_over, false);
  assert.equal(SMALL_CELL_K, 5);
  assert.deepEqual(suppressSmallCells({ a: 0, b: 1, c: 4, d: 5, e: 2.5, f: [3, 9], g: "x" }), { a: 0, b: "<5", c: "<5", d: 5, e: 2.5, f: ["<5", 9], g: "x" });
  const row = (niche, browsers, signups) => ({ niche, browsers, signups, browsers_wa_owned: 2, signups_wa_owned: 1, browsers_linhas: 0, browsers_confirmados_linhas: 0, aliases: 0, signups_linhas: 0, raw: {} });
  const sum = summarize([row("confeitaria", 40, 3), row("loja-de-roupas", 400, 40)], { windowId: "fa1", sources: [{ niche: "confeitaria", src: "ig_post", n: 40 }, { niche: "loja-de-roupas", src: "ig_post", n: 4 }] });
  const ag = anonymousAggregate(sum);
  assert.deepEqual([ag.niches.confeitaria.eligible_browsers, ag.niches.confeitaria.signups, ag.niches.confeitaria.conversion, ag.niches.confeitaria.wilson95], [40, "<5", undefined, undefined], "proporção de célula pequena omitida");
  assert.deepEqual([ag.niches["loja-de-roupas"].signups, ag.niches["loja-de-roupas"].conversion, ag.niches["loja-de-roupas"].source_mix.ig_post], [40, 0.1, "<5"]);
  assert.deepEqual(ag.niches.confeitaria.secondary_wa_owned, { browsers: "<5", signups: "<5" });
  const flat = JSON.stringify(ag);
  for (const v of [1, 2, 3, 4]) assert.ok(!new RegExp(`:${v}[,}]`).test(flat), "contagem pequena exposta: " + v);
});

test("trava da LIA (AVAL 099/101): ativação só com LIA E ROPA sem pendência, tabelas de aprovação completas e hashes aprovados iguais; documento editado depois da aprovação desliga", async () => {
  const F = await import("./lia-fixture.mjs");
  const { TEST_LIA, TEST_ROPA, TEST_DOCS, APPROVED_ENV, APPROVED_TEXT, APPROVED_ROPA_TEXT, REAL_LIA_TEXT, REAL_ROPA_TEXT, approvedText, manifestOf } = F;
  const act = (env, docs) => liaActivation(env, docs);
  assert.deepEqual([act(APPROVED_ENV, TEST_DOCS).active, act(APPROVED_ENV, TEST_DOCS).reason], [true, null]);
  assert.equal(act({ FASE_A_LIA_APPROVED_SHA256: TEST_LIA.sha256.toUpperCase(), FASE_A_ROPA_APPROVED_SHA256: TEST_ROPA.sha256 }, TEST_DOCS).active, true, "hex maiúsculo aceito");
  // Repositório: LIA e ROPA pendentes => travada, mesmo com os hashes dos próprios arquivos.
  const real = { lia: await manifestOf(REAL_LIA_TEXT), ropa: await manifestOf(REAL_ROPA_TEXT, "docs/lgpd/ROPA-fase-a.md") };
  assert.deepEqual([real.lia.pending_marker, real.lia.approval, real.ropa.pending_marker, real.ropa.approval], [true, null, true, null]);
  const realEnv = { FASE_A_LIA_APPROVED_SHA256: real.lia.sha256, FASE_A_ROPA_APPROVED_SHA256: real.ropa.sha256 };
  assert.equal(act(realEnv, real).reason, "lia_pendente_de_revisao");
  assert.equal(liaActivation(realEnv).reason, "lia_pendente_de_revisao", "manifesto embutido no Worker");
  // ROPA: a LIA aprovada sozinha NÃO liga.
  assert.equal(act({ ...APPROVED_ENV, FASE_A_ROPA_APPROVED_SHA256: real.ropa.sha256 }, { lia: TEST_LIA, ropa: real.ropa }).reason, "ropa_pendente_de_revisao");
  assert.equal(act({ FASE_A_LIA_APPROVED_SHA256: TEST_LIA.sha256 }, TEST_DOCS).reason, "ropa_aprovacao_nao_configurada");
  assert.equal(act({ ...APPROVED_ENV, FASE_A_ROPA_APPROVED_SHA256: "0".repeat(64) }, TEST_DOCS).reason, "ropa_alterada_apos_aprovacao");
  const ropaEdited = await manifestOf(APPROVED_ROPA_TEXT + "\nNova região.\n", "docs/lgpd/ROPA-fase-a.md");
  assert.equal(act(APPROVED_ENV, { lia: TEST_LIA, ropa: ropaEdited }).reason, "ropa_alterada_apos_aprovacao");
  assert.equal(act(APPROVED_ENV, { lia: TEST_LIA, ropa: await manifestOf(approvedText(REAL_ROPA_TEXT, "| Revisora | 2026-10-24 | 9 | APROVADA | x |"), "docs/lgpd/ROPA-fase-a.md") }).reason, "ropa_aprovacao_incompleta");
  // LIA: tabela incompleta (mesmo com o hash do próprio texto configurado).
  const liaReason = async (text) => { const m = await manifestOf(text); return act({ ...APPROVED_ENV, FASE_A_LIA_APPROVED_SHA256: m.sha256 }, { lia: m, ropa: TEST_ROPA }).reason; };
  for (const row of ["| Revisora | | 2 | APROVADA | x |", "| Revisora | 2026-02-30 | 2 | APROVADA | x |", "| Revisora | 2026-10-24 | 1 | APROVADA | x |",
    "| Revisora | 2026-10-24 | 2 | pendente | x |", "| _pendente_ | 2026-10-24 | 2 | APROVADA | x |", "| | 2026-10-24 | 2 | APROVADA | x |", "| Revisora | 2026-10-24 | | APROVADA | x |"])
    assert.ok(["lia_aprovacao_incompleta", "lia_pendente_de_revisao"].includes(await liaReason(approvedText(REAL_LIA_TEXT, row))), row);
  assert.equal(await liaReason(approvedText(REAL_LIA_TEXT, "| Revisora | 2026-10-24 | 1 | APROVADA | x |")), "lia_aprovacao_incompleta", "versão diferente da LIA");
  assert.equal(await liaReason(APPROVED_TEXT + "\nPENDENTE DE REVISÃO JURÍDICA\n"), "lia_pendente_de_revisao", "marcador que sobrou");
  // Hash: ausente, mal formado, divergente.
  assert.equal(act({ FASE_A_ROPA_APPROVED_SHA256: TEST_ROPA.sha256 }, TEST_DOCS).reason, "lia_aprovacao_nao_configurada");
  assert.equal(act({ ...APPROVED_ENV, FASE_A_LIA_APPROVED_SHA256: "z".repeat(64) }, TEST_DOCS).reason, "lia_aprovacao_formato_invalido");
  assert.equal(act({ ...APPROVED_ENV, FASE_A_LIA_APPROVED_SHA256: "0".repeat(64) }, TEST_DOCS).reason, "lia_alterada_apos_aprovacao");
  // Edição de UM caractere depois da aprovação: novo sha256, a mesma aprovação deixa de valer.
  const edited = await manifestOf(APPROVED_TEXT.replace("Finalidade", "Finalidades"));
  assert.notEqual(edited.sha256, TEST_LIA.sha256);
  assert.deepEqual([act(APPROVED_ENV, { lia: edited, ropa: TEST_ROPA }).active, act(APPROVED_ENV, { lia: edited, ropa: TEST_ROPA }).reason], [false, "lia_alterada_apos_aprovacao"]);
  // CRLF não muda o hash (checkout Windows).
  assert.equal((await manifestOf(APPROVED_TEXT.replace(/\n/g, "\r\n"))).sha256, TEST_LIA.sha256);
  for (const bad of [null, {}, { ...TEST_LIA, sha256: "x" }]) assert.equal(act(APPROVED_ENV, { lia: bad, ropa: TEST_ROPA }).reason, "lia_manifesto_invalido");
  assert.equal(act(APPROVED_ENV, { lia: TEST_LIA, ropa: null }).reason, "ropa_manifesto_invalido");
});

test("manifesto da LIA e do ROPA embutido no Worker (worker/fase-a-lia.generated.mjs) idêntico aos documentos: editar sem regenerar quebra o CI", async () => {
  const { expected, GENERATED } = await import("../../scripts/fase_a/lia_manifest.mjs");
  const want = await expected();
  assert.equal(fs.readFileSync(GENERATED, "utf8").replace(/\r\n/g, "\n"), want, "rode: node scripts/fase_a/lia_manifest.mjs --write");
});
