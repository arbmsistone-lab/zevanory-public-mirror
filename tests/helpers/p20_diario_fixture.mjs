// ZEVANORY | P20 diário D1: gera a leitura SINTÉTICA do diário (formato de scripts/p20/diario-d1-read.mjs) a partir de
// um PostgreSQL de origem descartável. Cada pedido da origem vira o evento order_created que o gancho do checkout grava
// (mesmo construtor, instante = created_at do banco), num D1 falso com SQL de verdade (node:sqlite, migrações reais).
// Uso: PGHOST=... PGDATABASE=<origem> node tests/helpers/p20_diario_fixture.mjs <saida.json> <lido_em-iso> [ts_ms_pedido_extra]
// O pedido extra (opcional) existe só no diário: simula um evento sem origem na cópia.
import { writeFileSync, readFileSync } from "node:fs";
import { createD1 } from "./d1-sqlite.mjs";
import { psqlSql } from "./p20_worker_backup_fixture.mjs";
import { appendEvent } from "../../worker/diario-p20.mjs";
import { eventoPedidoCriado } from "../../worker/diario-sombra.mjs";
import { SCHEMA_LEITURA } from "../../scripts/p20/diario-d1-read.mjs";

const [out, lidoEm, extraTs] = process.argv.slice(2);
const mig = ["0001_diario_v1.sql", "0002_diario_v1_ts.sql"].map((f) => readFileSync(new URL("../../migrations/d1/" + f, import.meta.url), "utf8")).join("\n");
const rows = await psqlSql().query("select order_id::text as order_id, provider, offer_id, amount::text as amount, (floor(extract(epoch from created_at) * 1000))::bigint as ts_ms from orders order by created_at", []);
const evs = rows.map((r) => eventoPedidoCriado({ orderId: r.order_id, provider: r.provider, offerId: r.offer_id, amount: r.amount, ts: Number(r.ts_ms) + 700 }));
if (extraTs) evs.push(eventoPedidoCriado({ orderId: "5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9", provider: "mercadopago", offerId: "sem-origem", amount: 1, ts: Number(extraTs) }));
const db = createD1(mig);
for (const e of evs.sort((a, b) => a.ts_ms - b.ts_ms)) {
  const r = await appendEvent(db, e);
  if (!r.ok) throw new Error("append " + r.code);
}
writeFileSync(out, JSON.stringify({ schema: SCHEMA_LEITURA, estado: "lido", database_id: "sintetico", lido_em: lidoEm, head: db.head(), rows: db.rows(), consultas: 0 }) + "\n");
console.log(JSON.stringify({ eventos: evs.length }));
