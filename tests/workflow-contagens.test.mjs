// Causa raiz do #1068 (17/11): o P18 passou de 18 para 20 testes, o manifesto foi atualizado, mas o workflow
// p18-commercial-check.yml exigia "# tests 18" escrito à mão — o CI reprovou só depois do push. Este teste cruza TODA
// contagem fixa de workflow ("# tests N" logo depois de um `node --test <arquivos>`) com o manifesto da suíte
// (tests/node-suite.manifest), que é a fonte da verdade das contagens. Roda na suíte local e no CI, sem custo.
// Arquivos fora do manifesto (tests/ci, tests/integration, tests/guards) não têm contagem de referência aqui: ficam
// listados como "não conferidos", nunca como aprovados.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { readTextNormalized } from "./helpers/text.mjs";
export function lerManifesto(texto) {
  const m = new Map();
  for (const l of texto.split(/\r?\n/)) { const x = /^(tests\/\S+\.test\.mjs)\s+(\d+)\s*$/.exec(l.trim()); if (x) m.set(x[1], Number(x[2])); }
  return m;
}
// Pares (arquivos de teste, contagem exigida) de um workflow: a contagem "# tests N" vale para o `node --test` anterior
// mais próximo (até 6 linhas acima, como os passos atuais escrevem).
export function contagensFixas(yml) {
  const linhas = yml.split(/\r?\n/), out = [];
  linhas.forEach((l, i) => {
    const c = /"# tests (\d+)"/.exec(l); if (!c) return;
    for (let j = i; j >= Math.max(0, i - 6); j--) {
      const n = /node --test\s+(.*)$/.exec(linhas[j]);
      if (n) { const arquivos = [...n[1].matchAll(/(tests\/[^\s|;&)]+\.test\.mjs)/g)].map((x) => x[1]); if (arquivos.length) out.push({ linha: i + 1, arquivos, exigido: Number(c[1]) }); return; }
    }
  });
  return out;
}
export function conferir(workflows, manifesto) {
  const divergentes = [], conferidos = [], naoConferidos = [];
  for (const [nome, yml] of workflows) for (const c of contagensFixas(yml)) {
    if (!c.arquivos.every((a) => manifesto.has(a))) { naoConferidos.push(`${nome}:${c.linha}`); continue; }
    const soma = c.arquivos.reduce((s, a) => s + manifesto.get(a), 0);
    (soma === c.exigido ? conferidos : divergentes).push(`${nome}:${c.linha} exige ${c.exigido}, manifesto ${soma} (${c.arquivos.join(" ")})`);
  }
  return { divergentes, conferidos, naoConferidos };
}
test("contagens fixas dos workflows batem com o manifesto da suíte (causa raiz do #1068)", () => {
  const manifesto = lerManifesto(readTextNormalized(new URL("./node-suite.manifest", import.meta.url)));
  const dir = new URL("../.github/workflows/", import.meta.url), wfs = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => [f, readTextNormalized(new URL(f, dir))]);
  const r = conferir(wfs, manifesto);
  console.log(`CONTAGENS conferidos=${r.conferidos.length} nao_conferidos=${r.naoConferidos.length} divergentes=${r.divergentes.length}`);
  assert.ok(r.conferidos.length >= 10, "a conferência precisa achar as contagens dos workflows: " + r.conferidos.length);
  assert.deepEqual(r.divergentes, [], "contagem de workflow diferente do manifesto");
});
test("conferência de contagens: detecta divergência, soma vários arquivos e não aprova arquivo fora do manifesto", () => {
  const man = lerManifesto("tests/a.test.mjs 18\ntests/b.test.mjs 2\n");
  const wf = (n, arqs) => `      - run: |\n          node --test ${arqs} | tee /tmp/t.txt\n          for l in "# tests ${n}" "# pass ${n}"; do grep -qx "$l" /tmp/t.txt; done\n`;
  assert.equal(conferir([["x.yml", wf(18, "tests/a.test.mjs")]], man).divergentes.length, 0);
  assert.match(conferir([["x.yml", wf(18, "tests/a.test.mjs")]], lerManifesto("tests/a.test.mjs 20\n")).divergentes[0], /exige 18, manifesto 20/, "o caso exato do #1068");
  assert.equal(conferir([["x.yml", wf(20, "tests/a.test.mjs tests/b.test.mjs")]], man).conferidos.length, 1, "soma de dois arquivos");
  const fora = conferir([["x.yml", wf(5, "tests/ci/z.test.mjs")]], man);
  assert.deepEqual([fora.conferidos.length, fora.divergentes.length, fora.naoConferidos.length], [0, 0, 1], "fora do manifesto: não conferido, nunca aprovado");
});
