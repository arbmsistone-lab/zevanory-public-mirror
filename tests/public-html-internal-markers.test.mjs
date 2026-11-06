// DEC-06 termos: the published legal pages are the owner-approved final text. No public HTML (canonical
// sources, sales-public build, pages-mirror stubs) may carry draft/hold markers or internal work codes,
// neither in visible text nor in HTML comments: "NÃO PUBLICAR", "minuta", "DEC-0x", "NC-0xx", "P23", "#946".
// docs/, evidence/ and tests/ are internal and are not scanned.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { readTextNormalized } from "./helpers/text.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set([".git", "node_modules", "docs", "evidence", "tests"]);
const MARKERS = [
  ["NÃO PUBLICAR", /n[ãa]o\s+publicar/i],
  ["minuta", /\bminutas?\b/i],
  ["DEC-0", /\bDEC-0\d/],
  ["NC-0", /\bNC-0\d/],
  ["P23", /\bP23\b/],
  ["#946", /#946\b/],
];

function htmlFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) htmlFiles(p, out);
    else if (name.endsWith(".html")) out.push(p);
  }
  return out;
}

export function internalMarkers(html) {
  const comments = [...html.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1]).join("\n");
  const text = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  const hits = [];
  for (const [label, re] of MARKERS) {
    if (re.test(comments)) hits.push("comment:" + label);
    if (re.test(text)) hits.push("text:" + label);
  }
  return hits;
}

test("public HTML carries no draft/hold marker or internal code in comments or visible text", () => {
  const files = htmlFiles(ROOT);
  const rel = files.map((f) => relative(ROOT, f).split("\\").join("/"));
  for (const need of ["termos/index.html", "reembolso/index.html", "sales-public/termos.html", "sales-public/reembolso.html"]) {
    assert.ok(rel.includes(need), "scan covers " + need);
  }
  assert.ok(files.length > 200, "scan is not vacuous: " + files.length);
  const bad = [];
  for (const f of files) {
    const hits = internalMarkers(readTextNormalized(f));
    if (hits.length) bad.push(relative(ROOT, f) + ": " + hits.join(", "));
  }
  assert.deepEqual(bad, []);
});

test("the marker detector catches every forbidden marker in comments and in text (not vacuous)", () => {
  const page = (s) => `<!doctype html><html><body><main><p>Texto final.</p>${s}</main></body></html>`;
  assert.deepEqual(internalMarkers(page("")), []);
  assert.deepEqual(internalMarkers(page("<p>Licença de uso pessoal; o suporte resolve sem custo.</p>")), []);
  const cases = {
    "NÃO PUBLICAR": "NÃO PUBLICAR", minuta: "Minuta jurídica", "DEC-0": "DEC-01 v3", "NC-0": "NC-016 A4", P23: "aprovação P23", "#946": "PR #946",
  };
  for (const [label, s] of Object.entries(cases)) {
    assert.deepEqual(internalMarkers(page(`<!-- ${s} -->`)), ["comment:" + label], "comment " + label);
    assert.deepEqual(internalMarkers(page(`<p>${s}</p>`)), ["text:" + label], "text " + label);
  }
});
