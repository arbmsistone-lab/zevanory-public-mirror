// Gates Lighthouse: todo workflow que invoca Lighthouse fixa uma versão EXATA >= 13 (o 12.x reprova o
// "Content-Signal" que o Managed robots.txt da Cloudflare antepõe ao robots.txt da zona: robots-txt=0,
// SEO 92) e nenhum limiar, URL ou categoria auditada muda. Workflow novo com Lighthouse precisa ser
// registrado aqui com seus limiares.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { readTextNormalized } from "./helpers/text.mjs";

const dir = new URL("../.github/workflows/", import.meta.url);
const workflows = Object.fromEntries(readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => [f, readTextNormalized(new URL(f, dir))]));
const f5Gate = readTextNormalized(new URL("../scripts/f5_lighthouse_gate.mjs", import.meta.url));
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
};

test("every workflow that invokes Lighthouse is registered and pins an exact version >= 13", () => {
  const invoking = Object.keys(workflows).filter((f) => /npx lighthouse|lighthouse@|lighthouse\/cli|f5_lighthouse_gate/.test(workflows[f])).sort();
  assert.deepEqual(invoking, Object.keys(GATES).sort(), "workflow with Lighthouse not registered (or registered one no longer runs it)");
  for (const [f, text] of Object.entries(workflows)) {
    const pins = [...text.matchAll(/lighthouse@([^\s"'`]+)/g)].map((m) => m[1]);
    if (GATES[f]) assert.ok(pins.length >= 1, f + ": installs Lighthouse without an explicit pin");
    for (const v of pins) {
      assert.match(v, /^\d+\.\d+\.\d+$/, `${f}: lighthouse must be pinned to an exact version, got ${v}`);
      assert.ok(Number(v.split(".")[0]) >= 13, `${f}: lighthouse ${v} flags Cloudflare Content-Signal as invalid robots.txt`);
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
