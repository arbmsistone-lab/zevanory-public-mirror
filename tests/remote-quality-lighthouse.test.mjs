// remote-quality: o auditor Lighthouse fica fixado numa versão exata que reconhece o "Content-Signal"
// do Managed robots.txt da Cloudflare, e os limiares do gate nunca baixam (90/95/95/95).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readTextNormalized } from "./helpers/text.mjs";

const wf = readTextNormalized(new URL("../.github/workflows/zevanory-remote-quality-gates.yml", import.meta.url));

test("remote-quality pins an exact Lighthouse >= 13 (Content-Signal safelisted upstream)", () => {
  const pins = [...wf.matchAll(/lighthouse@([^\s]+)/g)].map((m) => m[1]);
  assert.ok(pins.length >= 1, "lighthouse install missing");
  for (const v of pins) {
    assert.match(v, /^\d+\.\d+\.\d+$/, "lighthouse must be pinned to an exact version, got " + v);
    assert.ok(Number(v.split(".")[0]) >= 13, "lighthouse 12.x flags Cloudflare Content-Signal as invalid robots.txt: " + v);
  }
});

test("remote-quality thresholds are unchanged and still audit the live /solucoes", () => {
  assert.ok(wf.includes("if(s.performance<90||s.accessibility<95||s.seo<95)"), "score thresholds changed");
  assert.ok(wf.includes("if(s['best-practices']<95 && (!cfOnly || bad.length))"), "best-practices threshold changed");
  assert.ok(wf.includes("npx lighthouse https://zevanory.api.br/solucoes"), "audited URL changed");
  assert.ok(wf.includes("--only-categories=performance,accessibility,best-practices,seo"), "categories changed");
});
