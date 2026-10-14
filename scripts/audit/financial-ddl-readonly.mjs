// T4 financial frontier: read-only check of the REAL production schema against the idempotency the
// code relies on. Reads only catalog metadata (pg_index / pg_constraint) inside a READ ONLY
// transaction; never reads rows, never writes. Prints verdicts only (the repo and its logs are public).
// Exit: 0 PASS, 1 FAIL (a required unique key is missing), 2 NAO_COMPROVADO (could not read).
export const TABLES = Object.freeze(["orders", "financial_events", "service_fulfillment", "artifact_download_tokens"]);
// Each requirement: a UNIQUE (or PK) key whose column set is exactly one of `accept`.
export const REQUIREMENTS = Object.freeze([
  { id: "R1", table: "financial_events", accept: [["provider_event_id"], ["provider", "provider_event_id"]], why: "INSERT ... ON CONFLICT DO NOTHING dedupes webhook replays only if provider_event_id is unique" },
  { id: "R2", table: "orders", accept: [["request_id"]], why: "INSERT ... ON CONFLICT (request_id) needs a unique key on request_id (otherwise the statement errors)" },
  { id: "R3", table: "service_fulfillment", accept: [["order_id"]], why: "ON CONFLICT (order_id) keeps one fulfillment per order" },
  { id: "R4", table: "orders", accept: [["order_id"]], why: "order_id identifies the order in every financial CTE" },
]);
const norm = cols => [...cols].map(String).sort().join(",");
// keys: [{table, name, unique:boolean, partial:boolean, cols:[...]}]
export function evaluate(keys, tablesFound) {
  const results = REQUIREMENTS.map(r => {
    if (!tablesFound.includes(r.table)) return { id: r.id, table: r.table, verdict: "FAIL", detail: "table_missing" };
    const ok = keys.find(k => k.table === r.table && k.unique && !k.partial && r.accept.some(a => norm(a) === norm(k.cols)));
    const partial = keys.find(k => k.table === r.table && k.unique && k.partial && r.accept.some(a => norm(a) === norm(k.cols)));
    if (ok) return { id: r.id, table: r.table, verdict: "PASS", detail: `${ok.name}(${ok.cols.join(",")})` };
    return { id: r.id, table: r.table, verdict: "FAIL", detail: partial ? `only_partial_unique:${partial.name}` : "no_matching_unique_key" };
  });
  const verdict = results.every(r => r.verdict === "PASS") ? "PASS" : "FAIL";
  return { verdict, results };
}
export const CATALOG_SQL = `
  select c.relname::text as "table", i.relname::text as name, x.indisunique as "unique", (x.indpred is not null) as partial,
         array(select a.attname from unnest(x.indkey) with ordinality k(attnum, o)
               join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum order by k.o)::text[] as cols
    from pg_index x join pg_class c on c.oid = x.indrelid join pg_class i on i.oid = x.indexrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = current_schema() and c.relname = any($1)`;
async function main() {
  if (!process.env.DATABASE_URL) { console.log("FINANCIAL_DDL: NAO_COMPROVADO database_url_absent"); return 2; }
  const { default: pg } = await import("pg");
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: true } });
  try {
    await db.connect();
    await db.query("begin transaction read only");
    await db.query("set local statement_timeout = 10000");
    const ro = (await db.query("show transaction_read_only")).rows[0]?.transaction_read_only;
    if (ro !== "on") { console.log("FINANCIAL_DDL: NAO_COMPROVADO transaction_not_read_only"); return 2; }
    const tables = (await db.query("select table_name from information_schema.tables where table_schema = current_schema() and table_name = any($1)", [TABLES])).rows.map(r => r.table_name);
    const keys = (await db.query(CATALOG_SQL, [TABLES])).rows;
    await db.query("rollback");
    const out = evaluate(keys, tables);
    for (const r of out.results) console.log(`FINANCIAL_DDL ${r.id} ${r.table}: ${r.verdict} ${r.detail}`);
    console.log(`FINANCIAL_DDL_TABLES_FOUND=${tables.sort().join(",")}`);
    console.log(`FINANCIAL_DDL: ${out.verdict}`);
    return out.verdict === "PASS" ? 0 : 1;
  } catch (e) {
    console.log(`FINANCIAL_DDL: NAO_COMPROVADO ${e?.code || "error"}`); // no message: may echo connection details
    return 2;
  } finally { await db.end().catch(() => {}); }
}
if (import.meta.url === `file://${process.argv[1]}`) main().then(code => process.exit(code));
