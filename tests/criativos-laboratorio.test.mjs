// Laboratório de Criativos (reauditoria NC-01..NC-07): pesquisa só com fatos de metadados e Shorts confirmados;
// medidas só do vídeo renderizado; afirmações conferidas contra o cálculo e a oferta publicada; decisão persistida e
// exigida pelo gate de publicação. Sem rede: fetch falso. A calibração com OCR real fica em tests/media.
import test from "node:test";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { conferirManifesto, conferirNumeros } from "../scripts/shorts-v3/render.mjs";
import assert from "node:assert/strict";
import { desempenho, pesquisarTema, youtubeToken, confirmarShort, padroesDeMetadados } from "../scripts/criativos/pesquisa.mjs";
import { CRITERIOS, NOTA_MINIMA, montarPadrao, validarPadrao } from "../scripts/criativos/padrao.mjs";
import { valoresFalados, valoresNaTela, conferirAfirmacoes, ofertaPublicada } from "../scripts/criativos/afirmacoes.mjs";
import { checagensObjetivas, precosOficiais, permitidosDe, permitidosDaProveniencia, lerJuri, decidir, avaliar, promptJuri, registrarDecisao, exigirAprovacao, cicloCriativo, MAX_TENTATIVAS } from "../scripts/criativos/avaliador.mjs";
const NOW = Date.parse("2026-11-13T12:00:00Z");
const ID = (n) => ("v" + n).padEnd(11, "x");
const ev = (n, extra = {}) => ({ id: ID(n), sku: "ZEV-LCX-011", titulo: n % 2 ? "Sua loja vende e não sobra?" : "Por que não sobra R$ 100?", canal: "c", segundos: 30 + n, views: 10000 * (n + 1), likes: 500 * (n + 1), comments: 50, score: 100 - n, url: "u", confirmado_short: true, ...extra });
const EVID = Array.from({ length: 8 }, (_, i) => ev(i));
const NUM = { preco_venda: 180, custo_produto_frete: 132, taxa_cartao: 9, taxa_cartao_pct: 5, margem_antes_fixas: 39, margem_pct: "21,7%", preco_minimo: 176, desconto_maximo: "2,2%", meta_margem_pct: 20 };
const PERM = permitidosDe(NUM, 147);
const FALAS = ["Sua loja vende, mas o dinheiro desaparece?", "Pegue sua última venda: um tênis de cento e oitenta reais.", "O produto e o frete custaram cento e trinta e dois.", "A taxa do cartão levou mais nove.", "Sobram trinta e nove reais antes das despesas fixas.", "E ela mostra o desconto máximo: dois vírgula dois por cento.", "Lucro e Caixa: cento e quarenta e sete reais, com arrependimento em sete dias corridos.", "Kit completo no link da descrição."];
const TELAS = ["ZEVANORY LOJA LUCRO CAIXA Sua loja vende", "Recebeu R$ 180 Produto frete R$ 132 Taxa do cartão (5%) R$9 Margem antes das despesas fixas R$ 39", "Margem de contribuição 21,7%", "Preço mínimo p/ meta de 20% R$ 176 Desconto máximo 2,2%", "Lucro & Caixa R$ 147 pagamento único arrependimento em 7 dias"];
const MED = { quadros: TELAS.map((texto) => ({ texto })), medidas: { alturaTextoMinPx: 24, foraAreaSegura: 0, quadrosVazios: 0, provaReal: true, textoNaoReconhecido: 0, origem: "medicao_independente_ocr" } };
const CRI = { sku: "ZEV-LCX-011", falas: FALAS, oferta: { nome: "Lucro & Caixa", preco: 147 } };
const OFICIAL = { fonte: "https://vendas.zevanory.api.br/lucro-e-caixa", preco: 147, versao: "sha256:abc", lido_em: "2026-11-13T12:00:00Z" };
const PADRAO = montarPadrao({ evidencia: EVID, geradoEm: "2026-11-13T12:00:00Z" });
const ALTO = { notas: { gancho: 9.8, legibilidade: 9.6, prova: 9.7, oferta: 9.6, marca: 9.9 }, problemas: [], melhorias: [] };
const gem = (saida) => async () => ({ status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(saida) }] } }] }) });

test("pesquisa: Shorts confirmados no próprio YouTube (/shorts/ 200 sem redirecionar), data revalidada", async () => {
  const fetchImpl = async (u, o) => {
    u = String(u);
    if (u.includes("/search?")) return { status: 200, json: async () => ({ items: [ID(1), ID(2), ID(3), ID(4)].map((videoId) => ({ id: { videoId } })) }) };
    if (u.includes("/videos?")) return { status: 200, json: async () => ({ items: [
      { id: ID(1), snippet: { title: "A", publishedAt: "2026-10-01T00:00:00Z" }, statistics: { viewCount: "100000", likeCount: "5000", commentCount: "100" }, contentDetails: { duration: "PT45S" } },
      { id: ID(2), snippet: { title: "B", publishedAt: "2026-10-01T00:00:00Z" }, statistics: { viewCount: "900000", likeCount: "60000", commentCount: "900" }, contentDetails: { duration: "PT30S" } },
      { id: ID(3), snippet: { title: "C antigo", publishedAt: "2024-01-01T00:00:00Z" }, statistics: { viewCount: "9999999" }, contentDetails: { duration: "PT30S" } },
      { id: ID(4), snippet: { title: "D curto mas não é Short", publishedAt: "2026-10-01T00:00:00Z" }, statistics: { viewCount: "800000" }, contentDetails: { duration: "PT40S" } }] }) };
    if (u.startsWith("https://www.youtube.com/shorts/")) { assert.equal(o.redirect, "manual"); return { status: u.endsWith(ID(4)) ? 303 : 200 }; }
    throw Error("url inesperada " + u);
  };
  const r = await pesquisarTema({ sku: "ZEV-LCX-011", consultas: ["caixa"], token: "t", now: NOW, fetchImpl });
  assert.deepEqual(r.map((v) => v.id), [ID(2), ID(1)], "antigo e não-Short ficam fora");
  assert.ok(r.every((v) => v.confirmado_short === true));
  assert.equal(await confirmarShort("curto", fetchImpl), false, "id inválido nunca é Short");
  assert.equal(await confirmarShort(ID(9), async () => { throw Error("rede"); }), false, "rede falhou = não confirmado");
  assert.ok(desempenho({ views: 1e6, likes: 1e4, comments: 10, publicado: "2026-10-01T00:00:00Z" }, NOW) > desempenho({ views: 1e4, likes: 1e2, comments: 1, publicado: "2026-10-01T00:00:00Z" }, NOW));
  await assert.rejects(() => youtubeToken({}), /credencial_ausente/);
});
test("padrão (NC-01): só fatos calculados por código a partir de metadados; adulterar um fato invalida", () => {
  const f = padroesDeMetadados(EVID);
  assert.deepEqual(f.map((x) => x.fato).sort(), ["duracao_mediana_s", "engajamento_mediano", "palavras_titulo_mediana", "titulo_numero_pct", "titulo_pergunta_pct"].sort());
  assert.ok(f.every((x) => x.criterio === "metadados" && x.evidencias.length >= 3));
  assert.ok(!f.some((x) => /legib|\bvisual\b|\bcena|ritmo de edi/i.test(x.padrao)), "nenhuma conclusão visual");
  assert.equal(validarPadrao(PADRAO), PADRAO);
  assert.throws(() => validarPadrao({ ...PADRAO, observado: [...PADRAO.observado, { criterio: "gancho", padrao: "Gancho visual com zoom", evidencias: [ID(1), ID(2), ID(3)] }] }), /fatos_nao_conferem/);
  assert.throws(() => validarPadrao({ ...PADRAO, evidencia: PADRAO.evidencia.map((v, i) => i ? v : { ...v, confirmado_short: false }) }), /nao_short/);
  assert.throws(() => validarPadrao({ ...PADRAO, nota_minima: 7 }), /padrao_invalido/);
  assert.throws(() => validarPadrao({ ...PADRAO, criterios: CRITERIOS.slice(1) }), /padrao_invalido/);
  assert.throws(() => padroesDeMetadados(EVID.slice(0, 3)), /evidencia_insuficiente/);
  assert.equal(NOTA_MINIMA, 9.5);
});
test("afirmações (NC-03): números falados e na tela precisam estar no conjunto calculado ou no preço oficial", () => {
  assert.deepEqual(valoresFalados(FALAS.join(" ")).map((v) => v.valor + (v.unidade || "")), ["180R$", "132", "9", "39R$", "2.2%", "147R$", "7dias"]);
  assert.deepEqual(valoresNaTela("R$ 12.400 R$9 21,7% (5%)").map((v) => v.valor + v.unidade), ["12400R$", "9R$", "21.7%", "5%"]);
  assert.deepEqual(conferirAfirmacoes({ falas: FALAS, telas: TELAS, permitidos: PERM }), []);
  const bad = (falas, telas) => conferirAfirmacoes({ falas: falas || FALAS, telas: telas || TELAS, permitidos: PERM });
  assert.ok(bad(null, [...TELAS, "Lucro de R$ 39 por venda"]).includes("lucro_fora_do_nome_do_produto"));
  assert.ok(bad(null, [...TELAS, "Sobram R$ 48"]).includes("valor_nao_conferido:R$48"));
  assert.ok(bad(null, [...TELAS, "margem de 30%"]).includes("valor_nao_conferido:30%"));
  assert.ok(bad([...FALAS, "Sobram quarenta e oito reais."]).includes("valor_falado_nao_conferido:48R$"));
  assert.ok(bad([...FALAS, "Desconto de dois por cento."]).includes("valor_falado_nao_conferido:2%"), "arredondar 2,2% para 2% é afirmação diferente");
  assert.ok(bad([...FALAS, "Resultado garantido."]).includes("promessa_proibida"));
  assert.ok(bad(null, [...TELAS, "garantia de 7 dias"]).some((m) => m.startsWith("politica_formulacao_divergente")), "política única: só a redação aprovada");
  assert.ok(bad([...FALAS, "Use um reserva de peça fictício."]).includes("concordancia_genero"));
});
test("objetivas (NC-02, adversarial): nada declarado pelo criativo vale como medida", () => {
  assert.deepEqual(checagensObjetivas({ criativo: CRI, medicao: MED, permitidos: PERM, oficial: OFICIAL }), []);
  const mentiroso = { ...CRI, medidas: { fonteMinPx: 99, quadroVazioSeg: 0, foraAreaSegura: 0, provaReal: true } };
  assert.deepEqual(checagensObjetivas({ criativo: mentiroso, medicao: null, permitidos: PERM, oficial: OFICIAL }), ["medicao_independente_ausente"]);
  assert.deepEqual(checagensObjetivas({ criativo: mentiroso, medicao: { ...MED, medidas: { ...MED.medidas, origem: "declarado" } }, permitidos: PERM, oficial: OFICIAL }), ["medicao_independente_ausente"]);
  const m = (k, v) => checagensObjetivas({ criativo: CRI, medicao: { ...MED, medidas: { ...MED.medidas, [k]: v } }, permitidos: PERM, oficial: OFICIAL });
  assert.ok(m("provaReal", false).includes("sem_prova_real_do_produto"));
  assert.ok(m("alturaTextoMinPx", 12).includes("texto_pequeno_demais"));
  assert.ok(m("quadrosVazios", 1).includes("quadro_vazio"));
  assert.ok(m("foraAreaSegura", 2).includes("conteudo_fora_da_area_segura"));
  assert.ok(m("textoNaoReconhecido", 1).includes("texto_nao_reconhecido"), "texto essencial não lido reprova");
  assert.ok(m("textoNaoReconhecido", undefined).includes("texto_nao_reconhecido"), "ausência da medida reprova (falha fechada)");
  const semPreco = { ...MED, quadros: MED.quadros.map((q) => ({ texto: q.texto.replace("R$ 147", "") })) };
  assert.ok(checagensObjetivas({ criativo: CRI, medicao: semPreco, permitidos: PERM, oficial: OFICIAL }).includes("preco_oficial_ausente_no_video"));
  assert.ok(checagensObjetivas({ criativo: CRI, medicao: MED, permitidos: PERM, oficial: { ...OFICIAL, preco: 97 } }).includes("oferta_publicada_divergente"));
  assert.ok(checagensObjetivas({ criativo: CRI, medicao: MED, permitidos: PERM, oficial: null }).includes("oferta_publicada_nao_conferida"));
  assert.ok(checagensObjetivas({ criativo: { ...CRI, oferta: { nome: "Lucro & Caixa", preco: 97 } }, medicao: MED, permitidos: PERM, oficial: OFICIAL }).includes("preco_divergente"));
  assert.deepEqual(precosOficiais()["ZEV-LCX-011"], ["Lucro & Caixa", 147]);
});
test("oferta publicada: preço lido da página de vendas no ar, com versão; ilegível falha", async () => {
  const o = await ofertaPublicada("lucro-e-caixa", async (u) => ({ status: 200, text: async () => '<a href="/comprar/ZEV-LCX-011">Comprar agora · R$ 147</a>' }));
  assert.equal(o.preco, 147); assert.match(o.versao, /^sha256:[a-f0-9]{16}$/); assert.equal(o.fonte, "https://vendas.zevanory.api.br/lucro-e-caixa");
  await assert.rejects(() => ofertaPublicada("lucro-e-caixa", async () => ({ status: 503, text: async () => "" })), /ilegivel/);
  await assert.rejects(() => ofertaPublicada("lucro-e-caixa", async () => ({ status: 200, text: async () => "<p>sem preço</p>" })), /sem_preco/);
});
test("júri e decisão: notas estritas; aprova só com objetivas OK e TODAS >= 9,5; IA fora/inválida DESCARTA", async () => {
  assert.throws(() => lerJuri({ notas: { gancho: "10" } }), /juri_nota_invalida/);
  assert.equal(decidir({ objetivas: [], juri: lerJuri(ALTO) }).decisao, "APROVADO");
  assert.equal(decidir({ objetivas: [], juri: lerJuri({ notas: { ...ALTO.notas, oferta: 9.4 } }) }).decisao, "DESCARTADO");
  const base = { criativo: CRI, padrao: PADRAO, quadrosPng: [Buffer.from("p")], medicao: MED, permitidos: PERM, oficial: OFICIAL, key: "k" };
  assert.equal((await avaliar({ ...base, fetchImpl: gem(ALTO) })).decisao, "APROVADO");
  for (const f of [async () => ({ status: 503 }), gem({ notas: { gancho: 10 } }), gem("texto")]) assert.equal((await avaliar({ ...base, fetchImpl: f })).decisao, "DESCARTADO");
  assert.equal((await avaliar({ ...base, medicao: null, fetchImpl: gem(ALTO) })).decisao, "DESCARTADO", "notas altas não compensam falta de medição");
  assert.match(promptJuri(PADRAO), /metadados[\s\S]*não descrevem o visual/);
});
test("decisão assinada (NC-R03): gate exige chave, assinatura HMAC, APROVADO, mesmo vídeo (sha256), notas e prazo", () => {
  const video = Buffer.from("video-real"), em = "2026-11-13T12:00:00Z", chave = "k".repeat(40);
  const reg = (av, c = chave) => registrarDecisao({ videoBytes: video, sku: "ZEV-LCX-011", avaliacao: av, padrao: PADRAO, commit: "abc", oficial: OFICIAL, chave: c, em });
  const ok = reg({ aprovado: true, nota_geral: 9.7, juri: lerJuri(ALTO), motivos: [] });
  assert.equal(ok.schema, 2); assert.match(ok.assinatura, /^hmac-sha256:[a-f0-9]{64}$/);
  assert.equal(exigirAprovacao(ok, video, { chave, now: NOW }), true);
  assert.throws(() => exigirAprovacao(ok, video, { now: NOW }), /chave_de_decisao_ausente/);
  assert.throws(() => exigirAprovacao(ok, video, { chave: "x".repeat(40), now: NOW }), /assinatura_invalida/, "outra chave");
  assert.throws(() => exigirAprovacao(reg({ aprovado: true, juri: lerJuri(ALTO) }, null), video, { chave, now: NOW }), /assinatura_invalida/, "registro sem assinatura");
  assert.throws(() => exigirAprovacao({ ...ok, decisao: "APROVADO", aprovado: true, notas: { ...ok.notas, prova: 10 } }, video, { chave, now: NOW }), /assinatura_invalida/, "adulterar após assinar");
  const falso = { ...reg({ aprovado: false, motivos: ["quadro_vazio"] }), decisao: "APROVADO", aprovado: true };
  assert.throws(() => exigirAprovacao(falso, video, { chave, now: NOW }), /assinatura_invalida/, "reprovado forjado como aprovado");
  assert.throws(() => exigirAprovacao(ok, Buffer.from("outro"), { chave, now: NOW }), /video_diferente/);
  assert.throws(() => exigirAprovacao(ok, null, { chave, now: NOW }), /video_ausente/);
  assert.throws(() => exigirAprovacao(null, video, { chave, now: NOW }), /decisao_ausente/);
  assert.throws(() => exigirAprovacao(reg({ aprovado: false, motivos: ["quadro_vazio"] }), video, { chave, now: NOW }), /reprovado/);
  assert.throws(() => exigirAprovacao(reg({ aprovado: "sim", juri: lerJuri(ALTO) }), video, { chave, now: NOW }), /reprovado/);
  assert.throws(() => exigirAprovacao(ok, video, { chave, now: NOW + 49 * 3600000 }), /vencida/);
  assert.throws(() => exigirAprovacao(reg({ aprovado: true, juri: lerJuri({ notas: { ...ALTO.notas, prova: 9.4 } }) }), video, { chave, now: NOW }), /notas_insuficientes/);
  const rep = reg({ aprovado: false, motivos: ["quadro_vazio"] });
  assert.deepEqual([rep.decisao, rep.motivos], ["DESCARTADO", ["quadro_vazio"]]);
});
test("proveniência (NC-R05, adversarial): números permitidos só vêm da planilha íntegra; adulterar dados ou manifesto bloqueia", async () => {
  const spec = JSON.parse(readFileSync("data/shorts-v3/lcx.json", "utf8"));
  const P = await conferirManifesto(spec);
  const perm = permitidosDaProveniencia(P, 147);
  for (const v of [180, 132, 9, 39, 176, 147]) assert.ok(perm.reais.includes(v), "R$ " + v);
  for (const v of [5, 21.7, 2.2, 20]) assert.ok(perm.pct.includes(v), v + "%");
  assert.deepEqual(await conferirNumeros(spec), []);
  assert.throws(() => permitidosDaProveniencia({ ...P, resultados_calculados_pela_planilha: { ...P.resultados_calculados_pela_planilha, Status: "ERRO" } }, 147), /proveniencia_invalida/);
  assert.throws(() => permitidosDaProveniencia(null, 147), /proveniencia_invalida/);
  assert.ok((await conferirNumeros({ ...spec, numeros: { ...spec.numeros, margem_antes_fixas: 60 } })).includes("margem_divergente"), "número do roteiro fora da planilha");
  const d = mkdtempSync(join(tmpdir(), "prov-")), rel = (f) => relative(process.cwd(), join(d, f));
  writeFileSync(join(d, "prov.json"), JSON.stringify({ ...P, entradas: { ...P.entradas, "Preço atual": 250 } }));
  const M = JSON.parse(readFileSync(spec.manifesto, "utf8"));
  writeFileSync(join(d, "man.json"), JSON.stringify({ arquivos: { ...M.arquivos, [rel("prov.json")]: M.arquivos[spec.proveniencia_numeros] } }));
  await assert.rejects(() => conferirManifesto({ ...spec, manifesto: rel("man.json"), proveniencia_numeros: rel("prov.json") }), /v3_proveniencia_adulterada/, "planilha adulterada com hash antigo");
  writeFileSync(join(d, "man2.json"), JSON.stringify({ arquivos: { [spec.proveniencia_numeros]: M.arquivos[spec.proveniencia_numeros] } }));
  await assert.rejects(() => conferirManifesto({ ...spec, manifesto: rel("man2.json") }), /v3_manifesto_sem/, "captura fora do manifesto");
  await assert.rejects(() => conferirManifesto({ ...spec, manifesto: undefined }), /v3_manifesto_ausente/);
});
test("ciclo: refaz com o feedback, no máximo 3 tentativas; sem aprovação = BLOQUEADO com relatório", async () => {
  assert.equal(MAX_TENTATIVAS, 3);
  const vistos = [];
  const ok = await cicloCriativo({ gerar: async ({ tentativa, feedback }) => { vistos.push(feedback); return { t: tentativa }; },
    avaliarCriativo: async (c) => c.t === 2 ? { aprovado: true, decisao: "APROVADO", nota_geral: 9.7, motivos: [] } : { aprovado: false, decisao: "DESCARTADO", nota_geral: 8, motivos: ["nota_abaixo:gancho=8"], juri: { problemas: ["gancho fraco"], melhorias: [] } } });
  assert.deepEqual([ok.estado, ok.tentativa, vistos[1].problemas], ["APROVADO", 2, ["gancho fraco"]]);
  let n = 0;
  const bloq = await cicloCriativo({ gerar: async () => ({}), avaliarCriativo: async () => { n++; return { aprovado: false, decisao: "DESCARTADO", nota_geral: 9.1, motivos: ["nota_abaixo:oferta=9.1"] }; } });
  assert.deepEqual([bloq.estado, n], ["BLOQUEADO", 3]); assert.match(bloq.relatorio, /3 tentativas.*9\.1.*oferta=9\.1/);
});
