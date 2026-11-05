import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cpClosedResponse, isCpPublicRoute } from "../../worker/nc015-sales-scope.mjs";

test("DEC-04: CP tombstone is accessible HTML, 404 and never purchasable", async () => {
  assert.equal(isCpPublicRoute("/conteudo-pronto"), true);
  for (const route of ["/conteudo-pronto", "/conteudo-pronto/"]) {
    assert.equal(isCpPublicRoute(route), true);
    const r = cpClosedResponse();
    assert.equal(r.status, 404);
    assert.match(r.headers.get("content-type") || "", /^text\/html/);
    assert.match(r.headers.get("x-robots-tag") || "", /noindex/);
    assert.match(r.headers.get("cache-control") || "", /no-store/);
    const html = await r.text();
    assert.match(html, /<html lang="pt-BR">/);
    assert.match(html, /<title>Página indisponível \| ZEVANORY<\/title>/);
    assert.match(html, /<h1>Página indisponível<\/h1>/);
    assert.match(html, /<meta name="robots" content="noindex,nofollow">/);
    assert.doesNotMatch(html, /pay\.hotmart\.com|mercadopago|\/comprar\//i);
  }
});

test("E3: missing dark theme never turns summary green and still writes evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "sales-budget-regression-"));
  try {
    const light = join(dir, "light.json"), dark = join(dir, "absent-dark.json"), out = join(dir, "summary.json");
    writeFileSync(light, JSON.stringify({ scheme: "light", budget: { performance: 95 }, runs: 3, pages: { "/termos": {} }, failures: [] }));
    const run = spawnSync(process.execPath, ["scripts/audit/sales-budget-summary.mjs", light, dark, out], { encoding: "utf8" });
    assert.equal(run.status, 1, run.stdout + run.stderr);
    const report = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(report.pass, false);
    assert.equal(report.themes.dark.pass, false);
    assert.match(report.themes.dark.failures[0], /missing\/invalid dark report/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
