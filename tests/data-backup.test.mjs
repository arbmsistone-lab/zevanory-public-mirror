import test from "node:test";
import assert from "node:assert/strict";
import { manifestHash, chunk, validIdent, sha256, KV_PREFIXES } from "../scripts/ops/data-backup.mjs";

test("manifest hash is order independent and content sensitive", () => {
  const a = manifestHash({ x: sha256("1"), y: sha256("2") });
  assert.equal(a, manifestHash({ y: sha256("2"), x: sha256("1") }));
  assert.notEqual(a, manifestHash({ x: sha256("1"), y: sha256("3") }));
});

test("identifiers are validated before reaching SQL", () => {
  assert.ok(validIdent("zevanory_leads"));
  for (const bad of ['x"; drop table y; --', "Leads", "a b", "", "1abc"]) assert.equal(validIdent(bad), false);
});

test("chunking keeps every item", () => {
  const parts = chunk(Array.from({ length: 205 }, (_, i) => i), 100);
  assert.deepEqual(parts.map((p) => p.length), [100, 100, 5]);
});

test("critical prefixes cover ledger, subscribers, leads and the sales switch", () => {
  for (const p of ["zpc:sales:", "zpc:cp:", "zpc:lead:interest:", "sales:open:v1"]) assert.ok(KV_PREFIXES.includes(p));
});

test("logs never print the database URL", async () => {
  const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../scripts/ops/data-backup.mjs", import.meta.url), "utf8"));
  assert.match(src, /replace\(\/postgres\(ql\)\?:/);
  assert.doesNotMatch(src, /console\.log\([^)]*DATABASE_URL/);
});
