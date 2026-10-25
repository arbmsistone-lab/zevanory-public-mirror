// Gates Lighthouse: todo workflow que invoca Lighthouse usa EXATAMENTE a versão aprovada abaixo (fonte
// única; o 12.x reprova o "Content-Signal" que o Managed robots.txt da Cloudflare antepõe ao robots.txt
// da zona: robots-txt=0, SEO 92) e nenhum limiar, URL ou categoria auditada muda. Trocar de versão exige
// mudar APPROVED_LIGHTHOUSE aqui (revisão explícita) e todos os workflows no mesmo PR. Workflow novo com
// Lighthouse precisa ser registrado aqui com seus limiares.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { readTextNormalized } from "./helpers/text.mjs";

const dir = new URL("../.github/workflows/", import.meta.url);
const workflows = Object.fromEntries(readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => [f, readTextNormalized(new URL(f, dir))]));
const f5Gate = readTextNormalized(new URL("../scripts/f5_lighthouse_gate.mjs", import.meta.url));
const salesBudget = readTextNormalized(new URL("../scripts/audit/sales-quality-budget.mjs", import.meta.url));
export const APPROVED_LIGHTHOUSE = "13.5.0";
const CATEGORIES = "--only-categories=performance,accessibility,best-practices,seo";
const count = (text, needle) => text.split(needle).length - 1;

// Limiar/URL exatos por gate: [trecho, ocorrências esperadas].
const GATES = {
  "zevanory-remote-quality-gates.yml": [
    ["if(s.performance<90||s.accessibility<95||s.seo<95)", 1],
    ["if(s['best-practices']<95 && (!cfOnly || bad.length))", 1],
    ["npx lighthouse https://zevanory.api.br/solucoes", 1],
    [CATEGORIES, 1],
  ],
  "zevanory-apex-engineering.yml": [
    ["if(median.performance<95||median.accessibility<100||median.seo<100) process.exit(1);", 2],
    ["if(applicationBestPractices<100) process.exit(1);", 2],
    ["if(median['best-practices']<100 && providerNoise.length===0) process.exit(1);", 2],
    ["npx lighthouse https://vendas.zevanory.api.br/solucoes", 2],
    [CATEGORIES, 2],
  ],
  "arbm-sist-ped-supreme.yml": [
    ["if(s.performance<90||s.accessibility<100||s['best-practices']<95||s.seo<95) process.exit(1);", 1],
    ["npx lighthouse http://127.0.0.1:4173/zevanory-public-mirror/arbm-sist/", 1],
    [CATEGORIES, 1],
  ],
  "zevanory-f5-performance-matrix.yml": [
    ["ORIGIN: https://vendas.zevanory.api.br", 1],
    ["node scripts/f5_lighthouse_gate.mjs", 1],
  ],
  // E3 (2026-10-24): pre-merge budget on the PR's own sales build (localhost, through the Worker).
  "sales-ux-quality.yml": [
    ["node scripts/audit/sales-quality-budget.mjs http://127.0.0.1:8787 /tmp/sales-ux/budget-after\n", 1],
    ["--report-only", 1],
  ],
};

test(`every workflow that invokes Lighthouse is registered and pins exactly lighthouse@${APPROVED_LIGHTHOUSE}`, () => {
  assert.match(APPROVED_LIGHTHOUSE, /^\d+\.\d+\.\d+$/);
  assert.ok(Number(APPROVED_LIGHTHOUSE.split(".")[0]) >= 13, "lighthouse 12.x flags Cloudflare Content-Signal as invalid robots.txt");
  const invoking = Object.keys(workflows).filter((f) => /npx lighthouse|lighthouse@|lighthouse\/cli|f5_lighthouse_gate/.test(workflows[f])).sort();
  assert.deepEqual(invoking, Object.keys(GATES).sort(), "workflow with Lighthouse not registered (or registered one no longer runs it)");
  for (const [f, text] of Object.entries(workflows)) {
    const pins = [...text.matchAll(/lighthouse@([^\s"'`]*)/g)].map((m) => m[1]);
    if (GATES[f]) assert.ok(pins.length >= 1, f + ": installs Lighthouse without an explicit pin");
    for (const v of pins) assert.equal(v, APPROVED_LIGHTHOUSE, `${f}: lighthouse@${v} differs from the approved lighthouse@${APPROVED_LIGHTHOUSE}`);
    for (const line of text.split("\n").filter((l) => /\bnpm\s+(install|i|add)\b/.test(l))) {
      assert.ok(!line.split(/\s+/).includes("lighthouse"), `${f}: unpinned lighthouse in: ${line.trim()}`);
    }
  }
});

for (const [f, checks] of Object.entries(GATES)) {
  test(`${f}: thresholds, audited URL and categories unchanged`, () => {
    for (const [needle, n] of checks) assert.equal(count(workflows[f], needle), n, `${f}: changed or missing: ${needle}`);
  });
}

test("f5 gate script: per-run thresholds and categories unchanged", () => {
  for (const needle of ['perf: device === "desktop" ? 98 : 95, a11y: 100, bp: 100, seo: 100,', "lcp: 2500, cls: 0.1, tbt: 200,",
    '"--only-categories=performance,accessibility,best-practices,seo"', 'require.resolve("lighthouse/cli/index.js")']) {
    assert.equal(count(f5Gate, needle), 1, "f5_lighthouse_gate.mjs changed or missing: " + needle);
  }
});

test("sales UX budget script: thresholds, pages and categories unchanged (E3)", () => {
  for (const needle of ['const BUDGET = { performance: 95, accessibility: 100, "best-practices": 100, seo: 100 };',
    '"--only-categories=performance,accessibility,best-practices,seo"', 'req.resolve("lighthouse/cli/index.js")',
    '"/solucoes,/zevanory-sales,/ia-na-pratica,/termos"', '["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]',
    'v.impact === "serious" || v.impact === "critical"', "r.width < 44 || r.height < 44", 'reducedMotion: "reduce"']) {
    assert.equal(count(salesBudget, needle), 1, "sales-quality-budget.mjs changed or missing: " + needle);
  }
});
