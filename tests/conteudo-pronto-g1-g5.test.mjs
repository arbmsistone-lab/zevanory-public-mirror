// Conteúdo Pronto: defeitos G1–G5 da prova local. DEC-14 (consenso Claude+GPT-6; DEC-04): os 20 testes deste arquivo
// que exercitavam o pipeline legado em KV (webhook, fila de pendentes, lease, entrega, boas-vindas, tokens em KV e rotas
// de operador), removido pelo NC-012 e pelo DEC-14(b), foram APOSENTADOS por mudança de escopo, um a um, em
// docs/ops/dec14-cp-retirement-registry.json (CP-G1G5-01..20), com o substituto DO de cada um quando existe
// (scripts/cp-nc012-fulfillment.test.mjs, scripts/cp-g03-g04-candidate.test.mjs, scripts/cp-nc014-l1-campaign.test.mjs).
// Fica o validador puro de posts (G3), que continua em vigor no gerador.
import test from "node:test";
import assert from "node:assert/strict";
import * as CS from "../worker/content-service.mjs";

const legenda = (i) => `Tema ${i}: cada peça passa por uma prova com hora marcada, para você não esperar e sair sabendo o que será ajustado. Combinamos o prazo por escrito e fazemos o acabamento à mão, porque é ele que faz a roupa durar e vestir bem.`;
const post = (i, mode) => ({ tema: "Tema " + i, legenda: legenda(i), cta: "Agende sua prova pelo Direct", hashtags: mode === "sem" ? [] : ["#costura", "#sobmedida"], imagem: mode === "sem" ? "" : "mãos fazendo o acabamento de uma bainha" });

test("[G3] validador: post sem hashtag, sem imagem, com legenda curta ou tema repetido é recusado", () => {
  assert.equal(CS.validatePosts([post(1)], 1).length, 1);
  assert.equal(CS.validatePosts([{ ...post(1), hashtags: [] }], 1), null, "[G3] sem hashtag");
  assert.equal(CS.validatePosts([{ ...post(1), hashtags: ["#", "# "] }], 1), null, "[G3] hashtag vazia");
  assert.equal(CS.validatePosts([{ ...post(1), imagem: "" }], 1), null, "[G3] sem imagem");
  assert.equal(CS.validatePosts([{ ...post(1), imagem: "foto" }], 1), null, "[G3] imagem vaga");
  assert.equal(CS.validatePosts([{ ...post(1), legenda: "x".repeat(CS.LEGENDA_MIN - 1) }], 1), null, "[G3] legenda curta");
  assert.equal(CS.validatePosts([post(1), { ...post(2), tema: "tema 1" }], 2), null, "[G3] tema repetido");
});
