// D1 falso que executa SQL de verdade (SQLite embutido do Node 22+, node:sqlite) para os testes do diário P20.
// Reproduz a superfície do binding D1 usada por worker/diario-p20.mjs: prepare(sql).bind(...) -> first(col?) /
// all() / run(), e batch([...]) atômico (uma transação; erro desfaz tudo e propaga). bind(undefined) é recusado
// como no D1. hooks.beforeBatch(n) roda antes de cada batch (n = número do batch, a partir de 1) para simular
// outro escritor mudando a cabeça entre a leitura e a escrita. Sem rede, sem arquivo: banco em memória.
// O aviso ExperimentalWarning do SQLite embutido é filtrado só durante a carga (o resto dos avisos segue normal).
const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (/SQLite is an experimental feature/.test(String(w?.message ?? w)) ? undefined : emit.call(process, w, ...rest));
const { DatabaseSync } = await import("node:sqlite").finally(() => { process.emitWarning = emit; });

export function createD1(migrationSql) {
  const raw = new DatabaseSync(":memory:");
  raw.exec(migrationSql);
  const hooks = { beforeBatch: null, failBatch: null };
  let batches = 0;

  const exec = (sql, params) => {
    const st = raw.prepare(sql);
    if (/^\s*(select|with|pragma)\b/i.test(sql) || /\breturning\b/i.test(sql)) {
      return { results: st.all(...params).map((r) => ({ ...r })), success: true, meta: { changes: 0 } };
    }
    const r = st.run(...params);
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  };

  class Stmt {
    constructor(sql, params = []) { this.sql = sql; this.params = params; }
    bind(...params) {
      if (params.some((p) => p === undefined)) throw new TypeError("D1_TYPE_ERROR: undefined não é aceito em bind");
      return new Stmt(this.sql, params);
    }
    async first(col) {
      const row = exec(this.sql, this.params).results[0] ?? null;
      return col ? (row ? row[col] ?? null : null) : row;
    }
    async all() { return exec(this.sql, this.params); }
    async run() { return exec(this.sql, this.params); }
  }

  const db = {
    raw,
    hooks,
    get batches() { return batches; },
    prepare: (sql) => new Stmt(sql),
    async batch(stmts) {
      batches++;
      if (hooks.beforeBatch) await hooks.beforeBatch(batches);
      if (hooks.failBatch) throw new Error("D1_ERROR: indisponível (simulado)");
      raw.exec("BEGIN");
      try {
        const out = stmts.map((s) => exec(s.sql, s.params));
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
    rows: () => raw.prepare("select * from diario_v1 order by seq").all().map((r) => ({ ...r })),
    head: () => ({ ...raw.prepare("select seq, chain_hash from diario_head where id = 1").get() }),
  };
  return db;
}
