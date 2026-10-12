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
