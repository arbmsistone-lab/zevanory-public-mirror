// B07/F02-08 T1 (PROPOSTA_B07 §7): a instrução exata do Worker contra PostgreSQL 16 efêmero do runner.
// Variáveis: PGPORT (cluster trust em 127.0.0.1), FENCE_SQL (caminho do SQL; mutantes M1–M7 trocam este
// arquivo), WORKER_MODULE (caminho do módulo do Worker; o mutante M12 troca este arquivo).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { connect } from './pgwire.mjs';

const PORT = Number(process.env.PGPORT);
const FENCE_SQL = readFileSync(process.env.FENCE_SQL, 'utf8');
const W = await import(pathToFileURL(process.env.WORKER_MODULE).href);
const IDENT = randomUUID();
let seq = 0;

async function freshDb() {
  const admin = await connect({ port: PORT });
  const db = `t1_${process.pid}_${++seq}`;
  await admin.simple(`CREATE DATABASE ${db}`); admin.close();
  const c = await connect({ port: PORT, database: db });
  await c.simple(FENCE_SQL);
  await c.query('INSERT INTO write_fence VALUES (1, 1, $1, $2::uuid)', ['W1', IDENT]);
  return { db, c, open: () => connect({ port: PORT, database: db }) };
}
const env = (epoch, writer, ident = IDENT) => W.configFromEnv({
  ZEVANORY_WRITE_EPOCH: String(epoch), ZEVANORY_WRITER_ID: writer, ZEVANORY_DB_IDENTITY: ident });
const ledger = async (c) => (await c.query(
  "SELECT coalesce(string_agg(op_id||':'||writer||'@'||coalesce(epoch::text,'null')||'='||amount, ',' ORDER BY op_id),'') AS l FROM ledger"))[0].l;
const fence = async (c) => (await c.query("SELECT epoch||'/'||owner AS f FROM write_fence"))[0].f;
const fenced = (e) => e && e.code === '42501' && /^FENCED:/.test(e.message);

test('T1-a W1@1 aceito; promoção CAS; W1@1 recusado depois; W2@2 aceito', async () => {
  const { c } = await freshDb();
  const w1 = await W.startWorker(c.query, env(1, 'W1'));
  assert.equal(await W.writeLedger(w1, 'op1', 100), 'OK');
  // promote_writer é função escalar: a CAS perdedora (0 linhas no UPDATE) devolve NULL.
  assert.equal((await c.query('SELECT promote_writer($1, $2) AS e', ['1', 'W2']))[0].e, '2');
  assert.equal((await c.query('SELECT promote_writer($1, $2) AS e', ['1', 'W3']))[0].e, null, 'CAS perdedora devolve NULL');
  await assert.rejects(W.writeLedger(w1, 'op2', 100), fenced, 'escritor antigo W1@1 tem de ser recusado com FENCED/42501');
  const w2 = await W.startWorker(c.query, env(2, 'W2'));
  assert.equal(await W.writeLedger(w2, 'op2', 100), 'OK');
  assert.equal(await fence(c), '2/W2');
  assert.equal(await ledger(c), 'op1:W1@1=100,op2:W2@2=100');
  c.close();
});

test('T1-b promoção concorrente: exatamente 1 vencedora', async () => {
  const { c, open } = await freshDb();
  const a = await open(), b = await open();
  await a.query('BEGIN');
  const ra = await a.query('SELECT promote_writer($1, $2) AS e', ['1', 'W2']);
  const pb = b.query('SELECT promote_writer($1, $2) AS e', ['1', 'W3']); // bloqueia na linha de a
  await new Promise(r => setTimeout(r, 400));
  await a.query('COMMIT');
  const rb = await pb;
  const wins = [ra, rb].filter(r => r[0].e !== null).length;
  assert.equal(wins, 1, `vencedoras=${wins}`);
  assert.equal(await fence(c), '2/W2');
  a.close(); b.close(); c.close();
});

test('T1-c época futura, não-dono, época NULL e alteração de linha antiga recusados', async () => {
  const { c } = await freshDb();
  const w1 = await W.startWorker(c.query, env(1, 'W1'));
  assert.equal(await W.writeLedger(w1, 'op1', 100), 'OK');
  await c.query('SELECT promote_writer($1, $2)', ['1', 'W2']);
  await assert.rejects(W.writeLedger(await W.startWorker(c.query, env(3, 'W2')), 'opF', 100), fenced, 'época futura');
  await assert.rejects(W.writeLedger(await W.startWorker(c.query, env(2, 'W3')), 'opX', 100), fenced, 'não-dono');
  await assert.rejects(c.query(W.SQL_LEDGER_INSERT, ['opN', 'W2', null, '100', IDENT]), (e) => !!e.code, 'época NULL');
  await assert.rejects(c.query('UPDATE ledger SET amount = $1 WHERE op_id = $2', ['999', 'op1']), fenced, 'UPDATE de linha da época 1');
  assert.equal(await ledger(c), 'op1:W1@1=100');
  c.close();
});

test('T1-d db_identity errado: Worker recusa partir e a instrução não grava', async () => {
  const { c } = await freshDb();
  const wrong = randomUUID();
  await assert.rejects(W.startWorker(c.query, env(1, 'W1', wrong)), (e) => e.code === 'DB_IDENTITY', 'partida com identidade errada');
  // Mesmo que a checagem de partida fosse pulada, a instrução única não grava em banco com outra identidade.
  const bypass = { cfg: env(1, 'W1', wrong), query: c.query };
  await assert.rejects(W.writeLedger(bypass, 'opI', 100), (e) => e.code === 'DB_IDENTITY', 'instrução com identidade errada');
  assert.equal(await ledger(c), '');
  c.close();
});
