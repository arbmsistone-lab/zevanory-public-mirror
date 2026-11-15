import test from "node:test";
import assert from "node:assert/strict";
import { scoreRamo, productIdeas } from "../scripts/intel/market-weekly.mjs";

test("scores follow the weights, keep evidence and pick the matching product", () => {
  const g = { slug: "ia-para-padaria", name: "Padaria" };
  const data = { base: ["padaria artesanal", "padaria perto"], ia: ["ia para padaria marketing"], planilha: ["planilha padaria grátis", "planilha controle padaria", "planilha custo padaria"], vendas: ["como vender mais pão"], financeiro: ["como organizar financeiro padaria"], yt: [] };
  const r = scoreRamo(g, data, 10, 2);
  assert.ok(r.score > 0 && r.score <= 100);
  assert.equal(r.product, "lucro-e-caixa");
  assert.ok(r.topQueries.length > 0);
  assert.equal(Object.keys(r.parts).length, 7);
  assert.equal(productIdeas([r])[0].status, "proposta (não lançada)");
});

test("no signals means zero, never an invented score", () => {
  const r = scoreRamo({ slug: "ia-para-x", name: "X" }, { base: [], ia: [], planilha: [], vendas: [], financeiro: [], yt: [] });
  assert.equal(r.signals, 0); assert.ok(r.score <= 5);
});

// Mercado Livre como fonte de demanda (só leitura; ordem executiva 14/11: preparação). Evidência sem peso no score.
test("ML tendências: lê só GET /trends/MLB, token opcional, status honesto, nada inventado; casa palavras com ramos", async () => {
  const { lerTendencias, casarRamos, termosRamo, ML_TRENDS_URL } = await import("../scripts/intel/ml-tendencias.mjs");
  const chamadas = [];
  const ok = (j) => async (url, init) => { chamadas.push({ url, init }); return { status: 200, json: async () => j }; };
  const r = await lerTendencias({ token: "tk", fetchImpl: ok([{ keyword: "ração para gato", url: "https://lista.mercadolivre.com.br/racao-para-gato" }, { keyword: "camiseta oversized", url: "https://evil.example/x" }, { keyword: "" }, { foo: 1 }]) });
  assert.equal(r.status, "ok"); assert.equal(r.palavras.length, 2); assert.equal(r.palavras[1].url, null, "URL fora do ML descartada");
  assert.equal(chamadas[0].url, ML_TRENDS_URL); assert.equal(chamadas[0].init.headers.authorization, "Bearer tk"); assert.equal(chamadas[0].init.method, undefined, "só GET");
  const sem = await lerTendencias({ fetchImpl: async (url, init) => { assert.equal(init.headers.authorization, undefined); return { status: 403, json: async () => ({}) }; } });
  assert.deepEqual([sem.status, sem.palavras], ["sem_token", []]);
  assert.equal((await lerTendencias({ token: "tk", fetchImpl: async () => ({ status: 403 }) })).status, "http_403");
  assert.equal((await lerTendencias({ fetchImpl: async () => { throw Object.assign(new Error("x"), { name: "TimeoutError" }); } })).status, "rede_TimeoutError");
  assert.equal((await lerTendencias({ fetchImpl: ok({ erro: 1 }) })).status, "formato_invalido");
  assert.equal((await lerTendencias({ fetchImpl: ok([]) })).status, "vazio");
  assert.deepEqual(termosRamo("Loja de roupas"), ["roupa"]); assert.deepEqual(termosRamo("Pet shop"), ["pet"]);
  const guias = [{ slug: "ia-para-loja-de-roupas", name: "Loja de roupas" }, { slug: "ia-para-padaria", name: "Padaria" }, { slug: "ia-para-otica", name: "Ótica" }];
  const m = casarRamos(guias, [{ keyword: "roupas femininas" }, { keyword: "óculos de sol" }, { keyword: "padaria industrial forno" }]);
  assert.deepEqual(m.map((x) => [x.slug, x.palavras_ml]), [["ia-para-loja-de-roupas", ["roupas femininas"]], ["ia-para-padaria", ["padaria industrial forno"]]]);
});
test("relatório semanal: ML entra como evidência sem peso, não derruba o job e nunca anuncia", async () => {
  const { readTextNormalized } = await import("./helpers/text.mjs");
  const src = readTextNormalized("scripts/intel/market-weekly.mjs"), ml = readTextNormalized("scripts/intel/ml-tendencias.mjs");
  assert.match(src, /mercadoLivre: \{ fonte: "api\.mercadolibre\.com\/trends\/MLB", status: ml\.status/);
  assert.match(src, /if \(!totalSignals\) process\.exit\(1\);/, "só a falta dos sinais principais falha o job");
  assert.doesNotMatch(src, /ml\.status[^\n]*process\.exit/);
  assert.doesNotMatch(ml, /method:\s*"(POST|PUT|DELETE)"|\/items|\/questions|\/orders/, "nenhuma escrita no ML");
});
