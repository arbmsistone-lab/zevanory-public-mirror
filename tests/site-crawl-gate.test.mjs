// ZEVANORY | scripts/ci/site_crawl_gate.mjs and the GitHub Pages redirect stubs (site audit C-01/C-02, item 4).
// The gate must catch: internal jargon in visible text (not in markup/JSON-LD), and any Pages page that is not a
// noindex redirect to the sales host with matching canonical/refresh/link and no assets, prices or contato@.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { readTextNormalized } from "./helpers/text.mjs";
import { requireTool } from "./helpers/toolchain.mjs";
import { spawnSync } from "node:child_process";
import { jargonHits, visibleText, stubProblems } from "../scripts/ci/site_crawl_gate.mjs";

const ROOT = new URL("..", import.meta.url);
const stub = (t = "https://vendas.zevanory.api.br/solucoes") =>
  `<!doctype html><html lang="pt-BR"><head><meta name="robots" content="noindex"><link rel="canonical" href="${t}"><meta http-equiv="refresh" content="0; url=${t}"></head><body><main><a href="${t}">x</a></main></body></html>`;

test("jargon is counted in visible text only", () => {
  const html = '<head><title>FAIL_CLOSED</title></head><body><script type="application/ld+json">{"x":"tenant"}</script><p>Conta por tenant, gates oficiais e kill-switch.</p><p>SHAMPOO e READYMADE não contam.</p></body>';
  assert.deepEqual(jargonHits(visibleText(html)), { tenant: 1, "kill-switch": 1, "gates oficiais": 1 });
  assert.deepEqual(jargonHits(visibleText("<p>Venda liberada antes dos gates oficiais. Gate antes da venda. zero dependência de JS.</p>")),
    { "gates oficiais": 1, "Gate antes da venda": 1, "zero dependência de JS": 1 });
});

test("a compliant stub passes; each defect is caught", () => {
  assert.deepEqual(stubProblems(stub()), []);
  const cases = [
    [stub().replace('<meta name="robots" content="noindex">', ""), "no noindex"],
    [stub().replace(/<link rel="canonical"[^>]*>/, ""), "no canonical to the sales host"],
    [stub().replace(/<meta http-equiv[^>]*>/, ""), "no 0 s meta refresh to the sales host"],
    [stub().replace(/<a href[^>]*>x<\/a>/, ""), "no visible link to the sales host"],
    [stub().replace('content="0; url=https://vendas.zevanory.api.br/solucoes"', 'content="0; url=https://vendas.zevanory.api.br/termos"'), "canonical, refresh and link disagree"],
    [stub().replace("</head>", '<link rel="stylesheet" href="/product.css"></head>'), "loads assets (stylesheet/img/script)"],
    [stub().replace("</main>", "<p>R$ 247</p></main>"), "price/offer/legacy contact text"],
    [stub().replace("</main>", "<p>contato@zevanory.api.br</p></main>"), "price/offer/legacy contact text"],
    [stub("https://zevanory.api.br/solucoes"), "no canonical to the sales host"],
  ];
  for (const [html, problem] of cases) assert.ok(stubProblems(html).includes(problem), problem);
});

test("committed Pages layer: generator output is current and every stub is compliant", () => {
  const PYTHON = process.platform === "win32" ? "python" : "python3";
  requireTool(PYTHON);
  const r = spawnSync(PYTHON, ["-B", "scripts/build_pages_mirror.py", "--check"], { cwd: ROOT, encoding: "utf8", windowsHide: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const dir = new URL("../pages-mirror/", import.meta.url);
  const files = readdirSync(dir);
  assert.ok(files.includes("index.html") && files.includes("404.html") && files.includes("quem-criou.html") && files.includes("robots.txt"));
  for (const f of files.filter((n) => n.endsWith(".html"))) {
    const text = readTextNormalized(new URL(f, dir));
    assert.match(text, /^---\npermalink: \/[^\n]*\nlayout: null\n---\n<!doctype html>/, f + ": Jekyll front matter (permalink) then the stub");
    assert.deepEqual(stubProblems(text), [], f);
    assert.doesNotMatch(text, /\{\{|\{%/, f + ": no Liquid syntax");
  }
  const robots = readTextNormalized(new URL("robots.txt", dir));
  assert.match(robots, /^User-agent: \*\nAllow: \/$/m);
  assert.doesNotMatch(robots, /sitemap/i);
  const config = readTextNormalized(new URL("../_config.yml", import.meta.url));
  for (const top of ["index.html", "quem-criou", "lucro-e-caixa", "sales-public", "docs", "sitemap.xml", "robots.txt", "product.css"]) {
    assert.match(config, new RegExp(`^  - ${top.replace(".", "\\.")}$`, "m"), "excluded from Pages: " + top);
  }
  assert.doesNotMatch(config, /^ {2}- pages-mirror$/m, "the stubs themselves are published");
});
