// Laboratório de Criativos: pesquisa (dados reais do YouTube), padrão nota 10 com evidência, avaliador que aprova
// ou descarta sozinho. Sem rede: fetch falso.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readTextNormalized } from "./helpers/text.mjs";
import { desempenho, pesquisarTema, youtubeToken } from "../scripts/criativos/pesquisa.mjs";
import { CRITERIOS, NOTA_MINIMA, validarObservado, montarPadrao, validarPadrao } from "../scripts/criativos/padrao.mjs";
import { checagensObjetivas, precosOficiais, lerJuri, decidir, avaliar, promptJuri } from "../scripts/criativos/avaliador.mjs";
const NOW = Date.parse("2026-11-13T12:00:00Z");
const ev = (id, views = 50000, extra = {}) => ({ id, sku: "ZEV-LCX-011", titulo: "t" + id, canal: "c", segundos: 40, views, likes: views / 20, comments: views / 200, score: 1, url: "u", publicado: "2026-10-01T00:00:00Z", ...extra });
const EVID = ["a", "b", "c", "d", "e"].map((x) => ev(x));
const OBS = { padroes: [{ criterio: "gancho", padrao: "Pergunta de dor em até 6 palavras", evidencias: ["a", "b", "c"] }, { criterio: "prova", padrao: "Mostra a ferramenta na tela antes de 10 s", evidencias: ["a", "c", "d"] }, { criterio: "oferta", padrao: "Preço só depois do benefício", evidencias: ["b", "d", "e"] }] };
const PADRAO = montarPadrao({ evidencia: EVID, observado: validarObservado(OBS, EVID), geradoEm: "2026-11-13T12:00:00Z" });
const CAL = (n) => JSON.parse(readTextNormalized(new URL(`../docs/criativos/calibracao/${n}/criativo.json`, import.meta.url)));

test("pesquisa: usa YouTube real (search por viewCount, Shorts BR, 180 dias) e ordena por desempenho", async () => {
  const urls = [];
  const fetchImpl = async (u) => { urls.push(String(u)); if (String(u).includes("/search?")) return { status: 200, json: async () => ({ items: [{ id: { videoId: "x1" } }, { id: { videoId: "x2" } }, { id: { videoId: "x3" } }] }) };
    return { status: 200, json: async () => ({ items: [
      { id: "x1", snippet: { title: "A", channelTitle: "c", publishedAt: "2026-10-01T00:00:00Z", thumbnails: {} }, statistics: { viewCount: "100000", likeCount: "5000", commentCount: "100" }, contentDetails: { duration: "PT45S" } },
      { id: "x2", snippet: { title: "B", channelTitle: "c", publishedAt: "2026-10-01T00:00:00Z", thumbnails: {} }, statistics: { viewCount: "900000", likeCount: "60000", commentCount: "900" }, contentDetails: { duration: "PT30S" } },
      { id: "x3", snippet: { title: "C longo", channelTitle: "c", publishedAt: "2026-10-01T00:00:00Z", thumbnails: {} }, statistics: { viewCount: "999999" }, contentDetails: { duration: "PT12M" } }] }) }; };
  const r = await pesquisarTema({ sku: "ZEV-LCX-011", consultas: ["caixa"], token: "t", now: NOW, fetchImpl });
  assert.deepEqual(r.map((v) => v.id), ["x2", "x1"], "vídeo longo fica fora; maior desempenho primeiro");
  const s = new URL(urls[0]).searchParams;
  assert.deepEqual([s.get("order"), s.get("videoDuration"), s.get("regionCode"), s.get("relevanceLanguage")], ["viewCount", "short", "BR", "pt"]);
  assert.ok(desempenho(ev("q", 1e6), NOW) > desempenho(ev("q", 1e4), NOW));
});
test("pesquisa: credencial ausente, HTTP de erro ou nenhum resultado falham (nunca padrão vazio)", async () => {
  await assert.rejects(() => youtubeToken({}), /credencial_ausente/);
  await assert.rejects(() => pesquisarTema({ sku: "S", consultas: ["q"], token: "t", now: NOW, fetchImpl: async () => ({ status: 403, json: async () => ({}) }) }), /http_403/);
  await assert.rejects(() => pesquisarTema({ sku: "S", consultas: ["q"], token: "t", now: NOW, fetchImpl: async () => ({ status: 200, json: async () => ({ items: [] }) }) }), /sem_resultados/);
});
test("padrão: IA só entra com padrões citando >=3 vídeos reais; base fixa não pode ser alterada", () => {
  assert.equal(PADRAO.nota_minima, NOTA_MINIMA); assert.equal(NOTA_MINIMA, 9.5);
  assert.throws(() => validarObservado({ padroes: [{ criterio: "gancho", padrao: "inventado sem prova", evidencias: ["a", "zz", "yy"] }] }, EVID), /sem_evidencia/);
  assert.throws(() => validarPadrao({ ...PADRAO, nota_minima: 7 }), /padrao_invalido/);
  assert.throws(() => validarPadrao({ ...PADRAO, criterios: CRITERIOS.slice(1) }), /padrao_invalido/);
  assert.throws(() => validarPadrao({ ...PADRAO, observado: [{ criterio: "gancho", padrao: "x", evidencias: ["a"] }] }), /evidencia/);
});
test("objetivas: catálogo oficial vem do Worker de vendas; preço/nome divergentes, termos proibidos e falta de prova reprovam", () => {
  const p = precosOficiais();
  assert.deepEqual(p["ZEV-LCX-011"], ["Lucro & Caixa", 147]);
  assert.deepEqual(checagensObjetivas(CAL("v3-mockup")), []);
  const v2 = checagensObjetivas(CAL("v2-reprovado"));
  for (const m of ["concordancia_genero", "texto_artificial_ficticio", "quadro_vazio", "sem_prova_real_do_produto", "preco_divergente"]) assert.ok(v2.includes(m), m);
  const base = CAL("v3-mockup");
  assert.ok(checagensObjetivas({ ...base, oferta: { nome: "Lucro & Caixa", preco: 97 } }).includes("preco_divergente"));
  assert.ok(checagensObjetivas({ ...base, textos: [...base.textos, "Lucro de R$ 39 por venda"] }).includes("lucro_sem_todos_os_custos"));
  assert.ok(checagensObjetivas({ ...base, textos: [...base.textos, "resultado garantido"] }).includes("promessa_proibida"));
  assert.ok(checagensObjetivas({ ...base, medidas: { ...base.medidas, fonteMinPx: 20 } }).includes("texto_pequeno_demais"));
  assert.ok(checagensObjetivas({ ...base, medidas: { ...base.medidas, foraAreaSegura: 2 } }).includes("conteudo_fora_da_area_segura"));
  assert.deepEqual(checagensObjetivas({ ...base, sku: "ZEV-XXX-999" }), ["sku_fora_do_catalogo"]);
});
test("júri: notas estritas 0–10; aprova só com objetivas OK e TODAS as notas >= 9,5", () => {
  assert.throws(() => lerJuri({ notas: { gancho: "10" } }), /juri_nota_invalida/);
  assert.throws(() => lerJuri({ notas: { gancho: 11, legibilidade: 9, prova: 9, oferta: 9, marca: 9 } }), /juri_nota_invalida/);
  const alto = lerJuri({ notas: { gancho: 9.8, legibilidade: 9.6, prova: 9.7, oferta: 9.5, marca: 9.9 } });
  assert.deepEqual(decidir({ objetivas: [], juri: alto }).decisao, "APROVADO");
  assert.equal(decidir({ objetivas: [], juri: { ...alto, notas: { ...alto.notas, oferta: 9.4 } } }).decisao, "DESCARTADO");
  assert.equal(decidir({ objetivas: ["quadro_vazio"], juri: alto }).decisao, "DESCARTADO");
  assert.deepEqual(decidir({ objetivas: [], juri: null }), { aprovado: false, decisao: "DESCARTADO", nota_geral: null, motivos: ["nota_abaixo:juri_indisponivel"] });
});
test("avaliar: IA indisponível ou resposta inválida DESCARTA; resposta válida usa o padrão pesquisado e os quadros", async () => {
  const png = Buffer.from("png");
  const off = await avaliar({ criativo: CAL("v3-mockup"), padrao: PADRAO, quadrosPng: [png], key: "k", fetchImpl: async () => ({ status: 503 }) });
  assert.equal(off.decisao, "DESCARTADO"); assert.equal(off.erro, "ia_indisponivel");
  let body = null;
  const ok = await avaliar({ criativo: CAL("v3-mockup"), padrao: PADRAO, quadrosPng: [png, png], key: "k", fetchImpl: async (_, r) => { body = JSON.parse(r.body); return { status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ notas: { gancho: 9.6, legibilidade: 9.7, prova: 9.8, oferta: 9.6, marca: 9.9 }, problemas: [], melhorias: ["x"] }) }] } }] }) }; } });
  assert.equal(ok.decisao, "APROVADO");
  assert.equal(body.contents[0].parts.filter((p) => p.inline_data).length, 2, "os quadros vão para o júri");
  assert.match(body.contents[0].parts[0].text, /Pergunta de dor em até 6 palavras/, "o padrão observado entra no júri");
  assert.match(promptJuri(PADRAO), /gancho[\s\S]*legibilidade[\s\S]*prova[\s\S]*oferta[\s\S]*marca/);
});
test("ciclo: refaz com o feedback, no máximo 3 tentativas; sem aprovação = BLOQUEADO com relatório", async () => {
  const { cicloCriativo, MAX_TENTATIVAS } = await import("../scripts/criativos/avaliador.mjs");
  assert.equal(MAX_TENTATIVAS, 3);
  const vistos = [];
  const ok = await cicloCriativo({ gerar: async ({ tentativa, feedback }) => { vistos.push(feedback); return { t: tentativa }; },
    avaliarCriativo: async (c) => c.t === 2 ? { aprovado: true, decisao: "APROVADO", nota_geral: 9.7, motivos: [] } : { aprovado: false, decisao: "DESCARTADO", nota_geral: 8, motivos: ["nota_abaixo:gancho=8"], juri: { problemas: ["gancho fraco"], melhorias: [] } } });
  assert.equal(ok.estado, "APROVADO"); assert.equal(ok.tentativa, 2); assert.deepEqual(vistos[1].problemas, ["gancho fraco"], "a 2ª tentativa recebe os problemas da 1ª");
  let n = 0;
  const bloq = await cicloCriativo({ gerar: async () => ({}), avaliarCriativo: async () => { n++; return { aprovado: false, decisao: "DESCARTADO", nota_geral: 9.1, motivos: ["nota_abaixo:oferta=9.1"] }; } });
  assert.equal(bloq.estado, "BLOQUEADO"); assert.equal(n, 3); assert.match(bloq.relatorio, /3 tentativas.*9\.1.*oferta=9\.1/);
});
