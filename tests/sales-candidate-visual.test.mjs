import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const wf = readFileSync(new URL("../.github/workflows/sales-candidate-visual.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const gate = readFileSync(new URL("../scripts/audit/sales-visual-gate.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const apex = readFileSync(new URL("../.github/workflows/zevanory-apex-engineering.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("candidate gate runs on the PR build served from localhost, never on the published site", () => {
  assert.match(wf, /python3 scripts\/build_sales_public\.py/);
  assert.match(wf, /git diff --exit-code -- sales-public/);
  assert.match(wf, /http:\/\/127\.0\.0\.1:8787/);
  assert.doesNotMatch(wf + gate, /zevanory\.api\.br/);
});
test("least privilege: read-only token, no secrets, no deploy", () => {
  assert.match(wf, /permissions:\n  contents: read\n/);
  assert.doesNotMatch(wf, /secrets\.|wrangler|TOKEN/);
});
test("same assertions and Playwright version as the apex gate, plus the owner's extra viewports", () => {
  for (const a of ["r.width<44||r.height<44", "de.scrollWidth>de.clientWidth+1", "r.right>de.clientWidth+1||r.left<-1"]) {
    assert.ok(apex.replace(/\s/g, "").includes(a.replace(/\s/g, "")), "apex changed: " + a);
    assert.ok(gate.replace(/\s/g, "").includes(a.replace(/\s/g, "")), "gate missing: " + a);
  }
  assert.equal(/playwright@([\d.]+)/.exec(wf)[1], /playwright@([\d.]+)/.exec(apex)[1]);
  for (const vp of ["[390, 844]", "[1024, 768]", "[1280, 720]", "[1366, 768]", "[1536, 730]", "[768, 1024]", "[1440, 900]", "[1920, 1080]"]) assert.ok(gate.includes(vp), vp);
});
