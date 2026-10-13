import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluate, CATALOG_SQL, TABLES } from "../scripts/audit/financial-ddl-readonly.mjs";

const k = (table, name, cols, unique = true, partial = false) => ({ table, name, cols, unique, partial });
const GOOD = [k("orders", "orders_pkey", ["order_id"]), k("orders", "orders_request_id_key", ["request_id"]),
  k("financial_events", "fe_uq", ["provider_event_id"]), k("service_fulfillment", "sf_uq", ["order_id"])];

test("all required unique keys present -> PASS", () => {
  assert.equal(evaluate(GOOD, TABLES).verdict, "PASS");
  assert.equal(evaluate([...GOOD.slice(0, 2), k("financial_events", "x", ["provider_event_id", "provider"]), GOOD[3]], TABLES).verdict, "PASS");
});
test("missing, non-unique, partial or wider keys -> FAIL", () => {
  const without = name => GOOD.filter(g => g.name !== name);
  assert.equal(evaluate(without("fe_uq"), TABLES).results.find(r => r.id === "R1").verdict, "FAIL");
  assert.equal(evaluate([...without("fe_uq"), k("financial_events", "i", ["provider_event_id"], false)], TABLES).verdict, "FAIL");
  assert.equal(evaluate([...without("fe_uq"), k("financial_events", "p", ["provider_event_id"], true, true)], TABLES).results.find(r => r.id === "R1").detail, "only_partial_unique:p");
  assert.equal(evaluate([...without("orders_request_id_key"), k("orders", "w", ["request_id", "session_id"])], TABLES).verdict, "FAIL");
  assert.equal(evaluate(GOOD, TABLES.filter(t => t !== "service_fulfillment")).results.find(r => r.id === "R3").detail, "table_missing");
});
test("script is catalog-only and read-only", () => {
  const src = readFileSync(new URL("../scripts/audit/financial-ddl-readonly.mjs", import.meta.url), "utf8");
  assert.match(src, /begin transaction read only/);
  assert.match(src, /show transaction_read_only/);
  const sqls = [...src.matchAll(/db\.query\(\s*("[^"]*"|`[^`]*`|CATALOG_SQL)/g)].map(m => m[1] === "CATALOG_SQL" ? CATALOG_SQL : m[1]);
  for (const s of sqls) assert.doesNotMatch(s, /\b(insert|update|delete|alter|create|drop|truncate|grant)\b/i, s);
  for (const t of TABLES) assert.doesNotMatch(src, new RegExp(`from\\s+${t}\\b`, "i"), "never reads rows of " + t);
  assert.doesNotMatch(src, /e\.message|e\?\.message/, "never prints driver messages");
});
