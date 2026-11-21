import test from "node:test";
import assert from "node:assert/strict";
import { computeAutonomy, computePublications, forecastSales, nextRun, recommend, metric, AGENDA, BLUESKY_STATUS_PREFIX, blueskyStatusEntry } from "../scripts/audit/command-center-snapshot.mjs";
import { BLUESKY_STATUS_PREFIX as ENGINE_BLUESKY_STATUS_PREFIX, blueskyStatusKey } from "../worker/acquisition-engine.mjs";

const now = Date.parse("2026-10-12T12:00:00Z");
const run = (path, event, conclusion, at) => ({ path: ".github/workflows/" + path, event, status: "completed", conclusion, created_at: at, updated_at: at });

test("autonomy counts recoveries, manual runs and MTTR from real runs", () => {
  const a = computeAutonomy([
    run("a.yml", "schedule", "success", "2026-10-11T10:00:00Z"),
    run("a.yml", "schedule", "failure", "2026-10-11T13:00:00Z"),
    run("a.yml", "schedule", "success", "2026-10-11T14:00:00Z"),
    run("b.yml", "schedule", "failure", "2026-10-11T15:00:00Z"),
    run("b.yml", "workflow_dispatch", "success", "2026-10-11T16:00:00Z"),
    run("a.yml", "schedule", "success", "2026-10-01T10:00:00Z"),
  ], now);
  assert.equal(a.scheduledRuns, 4); assert.equal(a.failed, 2); assert.equal(a.recoveredAutomatically, 1);
  assert.equal(a.unrecovered, 1); assert.equal(a.manualRuns, 1); assert.equal(a.mttrMinutes, 60);
  assert.equal(a.runSuccessPct, 60); // (2 ok + 1 recovered) / (4 scheduled + 1 manual)
  // Plano Mestre v1.2 §9: run success is not autonomy; the real index comes from the action record (main()).
  assert.equal(a.autonomyPct, null);
});

test("no runs means no autonomy number, never a fake 100%", () => {
  assert.equal(computeAutonomy([], now).autonomyPct, null);
  assert.equal(computeAutonomy([], now).runSuccessPct, null);
});

test("publication completion only counts recorded slots", () => {
  const p = computePublications({ "2026-10-12": { telegram: { status: "publicado" }, bluesky: { status: "erro" } }, "2026-10-11": { youtube: { status: "publicado" } } });
  assert.deepEqual([p.expected, p.published, p.pct], [3, 2, 66.7]);
});

test("forecast refuses without history, gives an interval with it", () => {
  assert.equal(forecastSales({}, null, now).status, "insufficient");
  const byDay = {};
  for (let i = 0; i < 20; i++) byDay[new Date(now - i * 864e5).toISOString().slice(0, 10)] = { approved: i % 4 === 0 ? 1 : 0, grossCents: i % 4 === 0 ? 24700 : 0 };
  const f = forecastSales(byDay, "2026-09-22", now);
  assert.equal(f.status, "ok"); assert.ok(f.salesInterval80[0] <= f.salesExpected && f.salesExpected <= f.salesInterval80[1]);
});

test("next run respects hour and day-of-month", () => {
  assert.equal(nextRun({ m: 0, h: 13 }, now), "2026-10-12T13:00:00.000Z");
  assert.equal(nextRun({ m: 0, h: 9, dom: [1, 11, 21] }, now), "2026-10-21T09:00:00.000Z");
  assert.ok(AGENDA.every((a) => nextRun(a.cron, now)));
});

test("metrics without value are marked missing; recommendations carry evidence", () => {
  assert.equal(metric(null, "x", null, "d").integrity, "missing");
  const r = recommend({ funnel: { sources: { youtube: { views: 10, checkout_intent: 0 } } }, reach: null, sales: { totals: { approved: 0 } }, publications: { pct: 100 } });
  assert.ok(r.length >= 2 && r.every((x) => x.evidence && x.action && x.confidence));
});

import { classifyBuyPage } from "../scripts/audit/command-center-snapshot.mjs";
test("buy page classification reflects what the buyer sees", () => {
  assert.equal(classifyBuyPage(200, "<h1>Vendas abrem em breve</h1>"), "closed");
  assert.equal(classifyBuyPage(200, "<button>Ir para o pagamento seguro</button>"), "checkout");
  assert.equal(classifyBuyPage(503, ""), "error");
});

import { updateUptime } from "../scripts/audit/command-center-snapshot.mjs";
test("uptime: appends each run, keeps 7 days and reports availability with its denominator", () => {
  const t0 = Date.parse("2026-10-01T00:00:00Z");
  let u = updateUptime(null, [{ url: "a", ok: true, ms: 10 }], t0);
  u = updateUptime(u, [{ url: "a", ok: false, ms: 0 }], t0 + 3600e3);
  assert.deepEqual(u.last24h.a, { ok: 1, total: 2, pct: 50 });
  const later = updateUptime(u, [{ url: "a", ok: true, ms: 9 }], t0 + 8 * 24 * 3600e3);
  assert.equal(later.history.length, 1, "older than 7 days dropped");
  assert.deepEqual(later.last7d.a, { ok: 1, total: 1, pct: 100 });
});
import { kvQuotaForecast } from "../scripts/audit/command-center-snapshot.mjs";
test("KV quota early warning: 60% or a projection over 90% warns before the 70% shedding line", () => {
  const at = (h) => Date.parse("2026-10-14T00:00:00Z") + h * 3600e3;
  const q = (writes) => ({ verified: true, writes, limit: 1000 });
  // Real 14/10 readings: 300 at 11:44 (ok), 564 at 16:57 (projection ~800 -> ok), 600+ -> early.
  assert.equal(kvQuotaForecast(q(300), at(11.73)).level, "ok");
  assert.equal(kvQuotaForecast(q(564), at(16.95)).level, "ok");
  assert.equal(kvQuotaForecast(q(564), at(16.95)).projectedEndOfDay, 799);
  assert.equal(kvQuotaForecast(q(600), at(20)).level, "early");
  assert.equal(kvQuotaForecast(q(400), at(10)).level, "early", "projected 960 (>90%) warns early");
  assert.equal(kvQuotaForecast(q(720), at(22)).level, "shedding");
  assert.equal(kvQuotaForecast(q(910), at(23)).level, "critical");
  assert.equal(kvQuotaForecast(q(500), at(11)).level, "critical", "projected 1090 would close sales");
  assert.equal(kvQuotaForecast(q(5), at(0.1)).level, "ok", "first hour is not extrapolated from minutes");
  assert.equal(kvQuotaForecast({ verified: false }), null);
});

test("F1: status de falha do Bluesky (bluesky:status:AAAAMMDD) vira entrada \"erro\" na matriz de publicações", () => {
  assert.equal(BLUESKY_STATUS_PREFIX, ENGINE_BLUESKY_STATUS_PREFIX);
  assert.equal(BLUESKY_STATUS_PREFIX + "2026-11-10".replaceAll("-", ""), blueskyStatusKey("2026-11-10"));
  const e = blueskyStatusEntry({ ok: false, motivo: "similarity", similaridade: 0.95, day: "2026-11-10", at: "2026-11-10T22:35:00Z" });
  assert.deepEqual(e, { status: "erro", url: null, at: "2026-11-10T22:35:00Z", code: "similarity", similarity: 0.95 });
  assert.equal(blueskyStatusEntry(null), null); assert.equal(blueskyStatusEntry({ ok: true }), null);
  assert.equal(blueskyStatusEntry({ ok: false }).code, "desconhecido");
  const pubs = computePublications({ "2026-11-10": { bluesky: e } });
  assert.deepEqual([pubs.expected, pubs.published], [1, 0]);
});
test("publicações: dia fora da agenda do blog (seg/qua/sex) não conta como previsto; rejeitado/erro continuam contando", () => {
  const p = computePublications({
    "2026-11-13": { blog: { status: "publicado" }, bluesky: { status: "publicado" } },
    "2026-11-14": { blog: { status: "fora_da_agenda" }, bluesky: { status: "publicado" } },
    "2026-11-12": { blog: { status: "erro" } },
  });
  assert.deepEqual(p.perChannel.blog, { expected: 2, published: 1 }, "13/11 publicado + 12/11 erro; 14/11 fora da agenda não entra");
  assert.equal(p.expected, 4); assert.equal(p.published, 3);
});

// Diagnóstico 15/11/2026 (+ contra-auditoria GPT-6 do #1060): as leituras de pay.hotmart.com no runner falham com
// "TypeError" desde 11/11 sem causa. Registra nome do erro + código de rede (nunca mensagem/URL com query) e, no
// "unknown" do caminho de compra, host + caminho finais e título públicos. Testado pelos campos PRODUZIDOS pelos probes.
test("diagnóstico de rede: causaRede preserva o nome (TimeoutError) e o código de rede, sem texto livre", async () => {
  const { causaRede } = await import("../scripts/audit/command-center-snapshot.mjs");
  assert.equal(causaRede(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })), "TypeError:ECONNRESET");
  assert.equal(causaRede(Object.assign(new TypeError("fetch failed"), { cause: { name: "ConnectTimeoutError", code: "UND_ERR_CONNECT_TIMEOUT" } })), "TypeError:UND_ERR_CONNECT_TIMEOUT");
  assert.equal(causaRede(Object.assign(new TypeError("x"), { cause: { name: "ConnectTimeoutError" } })), "TypeError:ConnectTimeoutError");
  assert.equal(causaRede(Object.assign(new TypeError("x"), { cause: { code: "a b/c?token=1" } })), "TypeError:abctoken1");
  assert.equal(causaRede(new TypeError("sem causa")), "TypeError");
  // timeout REAL de AbortSignal.timeout(): DOMException TimeoutError com code numérico 23 -> "TimeoutError"
  // (o timer do AbortSignal.timeout não segura o processo: um setTimeout comum mantém o laço vivo até o abort)
  const real = await new Promise((res) => { const s = AbortSignal.timeout(5); const vivo = setTimeout(() => {}, 1000); s.addEventListener("abort", () => { clearTimeout(vivo); res(s.reason); }); });
  assert.equal(real?.name, "TimeoutError"); assert.equal(causaRede(real), "TimeoutError");
});
test("probes: campos efetivamente produzidos em redirecionamento, timeout e erro de rede (fetch simulado)", async () => {
  const { probeBuyFlow, probeHotmart } = await import("../scripts/audit/command-center-snapshot.mjs");
  const resp = (status, url, html) => ({ status, url, text: async () => html });
  // caminho de compra: redirecionado para outro host com query/fragmento -> host e caminho gravados, query fora
  const bf = await probeBuyFlow(async (u) => resp(200, "https://desafio.exemplo.net/cdn-cgi/challenge?token=SEGREDO#x", "<html><title>Just a moment...</title>body</html>"));
  assert.equal(bf.length, 3);
  assert.deepEqual({ ...bf[0], sku: undefined }, { sku: undefined, http: 200, state: "unknown", finalHost: "desafio.exemplo.net", finalPath: "/cdn-cgi/challenge", title: "Just a moment...", bytes: 48 });
  assert.doesNotMatch(JSON.stringify(bf), /SEGREDO|token=|#x/);
  // página certa (Hotmart): sem campos extras de diagnóstico
  const ok = await probeBuyFlow(async () => resp(200, "https://vendas.zevanory.api.br/hotmart/lucro-e-caixa", '<a href="https://pay.hotmart.com/L1?off=a">Comprar</a>'));
  assert.equal(ok[0].state, "foreign_checkout"); assert.equal(ok[0].finalHost, undefined);
  // timeout real e erro de rede: 1 nova tentativa, causa gravada
  const to = await probeBuyFlow(async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); });
  assert.deepEqual(to[0], { sku: "ZEV-IA-011", http: 0, state: "error", cause: "TimeoutError", retried: true });
  const hm = await probeHotmart(async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); });
  assert.ok(hm.length >= 5); assert.deepEqual(hm[0], { slug: hm[0].slug, http: 0, error: "TypeError", cause: "TypeError:ECONNRESET", etapa: "rede" });
  assert.doesNotMatch(JSON.stringify(hm), /fetch failed/, "sem mensagem livre");
});

test("sonda Hotmart (21/11): rede, corpo, destino ausente/inválido e 049 válido ficam em etapas distintas", async () => {
  const { probeHotmart } = await import("../scripts/audit/command-center-snapshot.mjs");
  const { classifyHotmartProbe } = await import("../scripts/audit/funnel-counting.mjs");
  const resp = (status, url, html) => ({ status, url, text: async () => html });
  // 1) erro de rede: etapa "rede", http 0, causa sem mensagem livre -> "error"
  const rede = await probeHotmart(async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }); });
  assert.equal(rede[0].etapa, "rede"); assert.equal(rede[0].cause, "TypeError:ENOTFOUND"); assert.equal(classifyHotmartProbe(rede[0]), "error");
  // 2) resposta com URL final vazia (antes: ERR_INVALID_URL gravado como falha de rede): etapa "destino", inconclusivo,
  //    mesmo com texto de encerramento no corpo
  const vazia = await probeHotmart(async () => resp(200, "", "vendas deste produto estão temporariamente encerradas"));
  assert.equal(vazia[0].etapa, "destino"); assert.equal(vazia[0].destino, "ausente"); assert.equal(vazia[0].http, 200);
  assert.equal(classifyHotmartProbe(vazia[0]), "inconclusive"); assert.equal(vazia[0].error, undefined);
  const invalida = await probeHotmart(async () => resp(200, "não é url", ""));
  assert.equal(invalida[0].destino, "invalido"); assert.equal(classifyHotmartProbe(invalida[0]), "inconclusive");
  // 3) corpo ilegível: etapa "corpo", inconclusivo
  const corpo = await probeHotmart(async () => ({ status: 200, url: "https://pay.hotmart.com/error?errorMessage=049", text: async () => { throw new TypeError("terminated"); } }));
  assert.equal(corpo[0].etapa, "corpo"); assert.equal(classifyHotmartProbe(corpo[0]), "inconclusive");
  // a marca de inconclusivo prevalece sobre qualquer sinal de fechamento que acompanhe a leitura
  assert.equal(classifyHotmartProbe({ ...corpo[0], finalHost: "pay.hotmart.com", finalPath: "/error", errorCode: "049", blockedText: true }), "inconclusive");
  // 4) 049 válido (200 + /error?errorMessage=049): etapa "ok", fechado
  const f049 = await probeHotmart(async () => resp(200, "https://pay.hotmart.com/error?errorMessage=049&checkoutLoadId=x", "<title>Hotmart</title>Agradecemos o interesse, mas as vendas deste produto estão temporariamente encerradas."));
  assert.equal(f049[0].etapa, "ok"); assert.equal(f049[0].errorCode, "049"); assert.equal(classifyHotmartProbe(f049[0]), "closed");
  assert.doesNotMatch(JSON.stringify(f049), /checkoutLoadId/, "sem query no destino gravado");
  // 5) 403/429/5xx com 049 na URL: inconclusivo (HTTP antes do 049)
  for (const s of [403, 429, 500, 503]) {
    const x = await probeHotmart(async () => resp(s, "https://pay.hotmart.com/error?errorMessage=049", "temporariamente encerradas"));
    assert.equal(classifyHotmartProbe(x[0]), "inconclusive", "http " + s);
  }
  // 6) checkout aberto com a oferta: aceitando
  const ab = await probeHotmart(async (u) => resp(200, u, "<html>" + new URL(u).pathname.slice(1) + "</html>"));
  assert.equal(classifyHotmartProbe(ab[0]), "accepting");
});

test("sonda Hotmart PR3 r2: 049 de outro domínio e 051 da Hotmart NÃO são fechamento; só 049 em pay.hotmart.com", async () => {
  const { probeHotmart } = await import("../scripts/audit/command-center-snapshot.mjs");
  const { classifyHotmartProbe } = await import("../scripts/audit/funnel-counting.mjs");
  const resp = (status, url, html) => ({ status, url, text: async () => html });
  const fecha = "Agradecemos o interesse, mas as vendas deste produto estão temporariamente encerradas.";
  // casos reproduzidos pelo GPT-6
  const outroDominio = await probeHotmart(async () => resp(200, "https://pay.hotmart.com.evil.example/error?errorMessage=049", fecha));
  assert.equal(outroDominio[0].finalHost, "pay.hotmart.com.evil.example"); assert.equal(classifyHotmartProbe(outroDominio[0]), "inconclusive");
  const outroHost = await probeHotmart(async () => resp(200, "https://checkout.exemplo.com/error?errorMessage=049", fecha));
  assert.equal(classifyHotmartProbe(outroHost[0]), "inconclusive");
  const e051 = await probeHotmart(async () => resp(200, "https://pay.hotmart.com/error?errorMessage=051", "<title>Hotmart</title>Ops"));
  assert.equal(e051[0].errorCode, "051"); assert.equal(classifyHotmartProbe(e051[0]), "inconclusive");
  const semCodigo = await probeHotmart(async () => resp(200, "https://pay.hotmart.com/error", fecha));
  assert.equal(classifyHotmartProbe(semCodigo[0]), "inconclusive", "página de erro sem 049 explícito");
  // texto genérico de indisponibilidade no host oficial, fora da página de erro: não fecha nem aceita
  const generico = await probeHotmart(async (u) => resp(200, u, "<html>" + new URL(u).pathname.slice(1) + " indisponível</html>"));
  assert.equal(classifyHotmartProbe(generico[0]), "inconclusive");
  // evidência específica: 049 no host oficial
  const ok049 = await probeHotmart(async () => resp(200, "https://pay.hotmart.com/error?errorMessage=049", fecha));
  assert.equal(classifyHotmartProbe(ok049[0]), "closed");
  const maiusc = await probeHotmart(async () => resp(200, "https://PAY.HOTMART.COM/error?errorMessage=049", fecha));
  assert.equal(classifyHotmartProbe(maiusc[0]), "closed", "host normalizado pelo URL");
  // sinais contraditórios no host oficial (código de erro fora da página /error, mesmo com a oferta): inconclusivo
  assert.equal(classifyHotmartProbe({ http: 200, finalHost: "pay.hotmart.com", finalPath: "/F107979716H", errorCode: "049", offerMarker: true }), "inconclusive");
  // aceitando também exige o host oficial
  const aceitaFora = await probeHotmart(async (u) => resp(200, "https://espelho.exemplo.com" + new URL(u).pathname, "<html>" + new URL(u).pathname.slice(1) + "</html>"));
  assert.equal(classifyHotmartProbe(aceitaFora[0]), "inconclusive");
});
