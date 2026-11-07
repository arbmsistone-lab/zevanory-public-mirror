// P03 | Checagens de navegador (scripts/audit/p03-pages-browser.mjs) contra páginas mínimas servidas em
// 127.0.0.1: uma página limpa (nenhum achado, controle de falso positivo) e uma variante por defeito.
// Fora de tests/*.test.mjs de propósito: precisa de playwright + axe-core ($QUALITY_MODULES), instalados
// só no job p03 / all-pages-audit. Sem eles o arquivo FALHA (não pula). Marcadores [Nn.k] referenciados por
// scripts/ci/mutants_p03_pages_allow.json.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { auditPage } from "../../scripts/audit/p03-pages-browser.mjs";

const req = createRequire(join(process.env.QUALITY_MODULES || join(process.cwd(), "node_modules"), "noop.js"));
const { chromium } = req("playwright");
const axeSource = readFileSync(req.resolve("axe-core/axe.min.js"), "utf8");

const CSS = `:focus-visible{outline:3px solid #1a5a96;outline-offset:2px}
.skip-link{position:fixed;left:8px;top:8px;transform:translateY(-200%);background:#ffc72c;color:#000;padding:12px}
.skip-link:focus{transform:none}
a,button,input{display:inline-block;min-height:44px;min-width:44px;padding:10px;box-sizing:border-box}
body{margin:0;font:16px/1.5 sans-serif;color:#111;background:#fff}`;
const CLEAN = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Limpa</title><style>${CSS}/*X*/</style></head>` +
  `<body><a class="skip-link" href="#c">Ir para o conteúdo</a><header><nav aria-label="Principal"><a href="/a">Início</a> <a href="/b">Outra</a></nav></header>` +
  `<main id="c" tabindex="-1"><h1>Limpa</h1><p>Texto da página.</p><button type="button">Ok</button><!--M--></main><footer><p>Rodapé</p></footer></body></html>`;
const V = {
  clean: CLEAN,
  axe: CLEAN.replace("<!--M-->", '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="10" height="10">'),
  contrast: CLEAN.replace("<!--M-->", '<p style="color:#b8b8b8;background:#fff">texto com contraste baixo</p>'),
  overflow: CLEAN.replace("<!--M-->", '<div style="width:640px;background:#eee">largo</div>'),
  target: CLEAN.replace("<!--M-->", '<a href="/a" style="display:inline-block;min-height:0;min-width:0;padding:0;width:14px;height:14px;line-height:14px;font-size:10px" aria-label="mini">m</a>'),
  skip: CLEAN.replace('href="#c">Ir', 'href="#nada">Ir'),
  ring: CLEAN.replace("/*X*/", "*:focus,*:focus-visible{outline:none!important;box-shadow:none!important}"),
  order: CLEAN.replace('<button type="button">Ok</button>', '<button type="button" tabindex="3">Ok</button>'),
  trap: CLEAN.replace("<!--M-->", '<input id="t" aria-label="campo"><script>document.getElementById("t").addEventListener("keydown",e=>{if(e.key==="Tab")e.preventDefault()})</script>'),
  console: CLEAN.replace("<!--M-->", '<script>console.error("falha proposital")</script>'),
  asset: CLEAN.replace("<!--M-->", '<img src="/nao-existe.png" alt="figura" width="10" height="10">'),
};
let server, browser, base;
before(async () => {
  server = createServer((q, r) => {
    const k = q.url.slice(1).split("?")[0];
    if (V[k]) { r.writeHead(200, { "content-type": "text/html; charset=utf-8" }); r.end(V[k]); }
    else { r.writeHead(404, { "content-type": "text/plain" }); r.end("x"); }
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); });
const run = (k, o = {}) => auditPage(browser, base + k, { axeSource, viewport: "360", ...o });
const codes = (r) => r.problems.map((p) => p.code);

test("N1 página limpa: nenhum achado em 360 e 1350, claro e escuro", async () => {
  for (const viewport of ["360", "1350"]) for (const scheme of ["light", "dark"]) {
    const r = await run("clean", { viewport, scheme });
    assert.deepEqual(r.problems, [], `[N1.1] ${viewport}-${scheme}`);
    assert.ok(r.info.keyboard.stops >= r.info.keyboard.expected && r.info.keyboard.expected >= 4, "[N1.2] ciclo de Tab percorrido");
  }
});
test("N2 HTTP diferente do esperado", async () => { assert.ok(codes(await run("nao-existe")).includes("B01"), "[N2.1] 404 onde se espera 200"); assert.deepEqual(codes(await run("nao-existe", { expectStatus: 404 })).filter((c) => c === "B01"), [], "[N2.2] 404 esperado"); });
test("N3 axe serious/critical", async () => {
  assert.ok((await run("axe")).problems.some((p) => p.code === "B02" && /critical image-alt/.test(p.msg)), "[N3.1] imagem sem alt (critical)");
  assert.ok((await run("contrast")).problems.some((p) => p.code === "B02" && /serious color-contrast/.test(p.msg)), "[N3.2] contraste insuficiente (serious)");
});
test("N4 rolagem horizontal em 360 px", async () => { assert.ok(codes(await run("overflow")).includes("B03"), "[N4.1] elemento de 640 px"); assert.ok(!codes(await run("overflow", { viewport: "1350" })).includes("B03"), "[N4.2] cabe em 1350"); });
test("N5 alvo de toque menor que 24 px", async () => { assert.ok(codes(await run("target")).includes("B04"), "[N5.1] alvo 14x14"); });
test("N6 skip-link que não leva ao main", async () => { assert.ok(codes(await run("skip")).includes("B05"), "[N6.1] skip-link para âncora inexistente"); });
test("N7 foco invisível", async () => { assert.ok(codes(await run("ring")).includes("B06"), "[N7.1] outline removido"); });
test("N8 ordem de foco fora do DOM", async () => {
  const r = await run("order");
  assert.ok(r.problems.some((p) => p.code === "B07" && /tabindex positivo/.test(p.msg)), "[N8.1] tabindex positivo");
  assert.ok(r.problems.some((p) => p.code === "B07" && /fora da ordem do DOM/.test(p.msg)), "[N8.2] sequência real de Tab fora da ordem do DOM");
});
test("N9 armadilha de teclado", async () => { assert.ok((await run("trap")).problems.some((p) => p.code === "B08" && /armadilha/.test(p.msg)), "[N9.1] Tab bloqueado num campo"); });
test("N10 erro de console e sub-recurso quebrado", async () => {
  assert.ok(codes(await run("console")).includes("B09"), "[N10.1] console.error");
  assert.ok(codes(await run("asset")).includes("B09"), "[N10.2] imagem 404");
});
