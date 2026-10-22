// B07/F02-08 T1: o que o Worker enviaria ao banco (camada C). Uma ÚNICA instrução parametrizada por escrita
// do ledger (compatível com o driver HTTP neon(), sem transação interativa); o trigger ledger_fence roda na
// mesma transação implícita. (epoch, writer, db_identity) vêm das variáveis de deploy do Worker:
// ZEVANORY_WRITE_EPOCH, ZEVANORY_WRITER_ID, ZEVANORY_DB_IDENTITY.
// `query(text, params)` é o executor (no Worker: neon(); no teste: cliente do protocolo estendido do PG).

// Leitura de partida: o Worker recusa partir se a identidade do banco não for a esperada (fail-closed).
export const SQL_IDENTITY = 'SELECT db_identity::text AS db_identity, epoch::text AS epoch, owner FROM write_fence WHERE id=1';

// Escrita do ledger: instrução única. O filtro por db_identity faz a própria instrução não gravar nada se o
// banco for outro (0 linhas => erro no Worker), e o trigger recusa época/dono que não sejam os atuais (42501).
export const SQL_LEDGER_INSERT =
  'INSERT INTO ledger(op_id, writer, epoch, amount) ' +
  'SELECT $1::text, $2::text, $3::bigint, $4::int FROM write_fence f WHERE f.id = 1 AND f.db_identity = $5::uuid ' +
  'RETURNING op_id';

export class WorkerRefused extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

export function configFromEnv(env) {
  const epoch = env.ZEVANORY_WRITE_EPOCH, writer = env.ZEVANORY_WRITER_ID, dbIdentity = env.ZEVANORY_DB_IDENTITY;
  if (!/^[1-9][0-9]*$/.test(String(epoch ?? ''))) throw new WorkerRefused('CONFIG', 'ZEVANORY_WRITE_EPOCH inválida');
  if (!writer) throw new WorkerRefused('CONFIG', 'ZEVANORY_WRITER_ID ausente');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(dbIdentity ?? '')))
    throw new WorkerRefused('CONFIG', 'ZEVANORY_DB_IDENTITY inválida');
  return { epoch: String(epoch), writer: String(writer), dbIdentity: String(dbIdentity) };
}

// Partida do Worker: lê a identidade do banco; diferente da esperada => recusa partir.
export async function startWorker(query, cfg) {
  const rows = await query(SQL_IDENTITY, []);
  if (rows.length !== 1) throw new WorkerRefused('DB_IDENTITY', 'write_fence ausente');
  if (rows[0].db_identity !== cfg.dbIdentity)
    throw new WorkerRefused('DB_IDENTITY', `db_identity do banco difere da esperada`);
  return { cfg, query };
}

// Escrita do ledger: 1 instrução. Retorna 'OK' só com a linha devolvida pelo RETURNING.
export async function writeLedger(worker, opId, amount) {
  const { cfg, query } = worker;
  const rows = await query(SQL_LEDGER_INSERT, [opId, cfg.writer, cfg.epoch, String(amount), cfg.dbIdentity]);
  if (rows.length !== 1) throw new WorkerRefused('DB_IDENTITY', 'instrução não gravou: banco com outra identidade');
  return 'OK';
}
