-- ZEVANORY | P20 (Roteiro Mestre v4.7, seção 9.1): diário de eventos críticos no Cloudflare D1.
-- Banco dedicado zevanory-diario-p20 (criado pelo proprietário; nunca reutilizar outro banco).
-- Somente inclusão: UPDATE e DELETE em diario_v1 são abortados por trigger. Cada linha encadeia o hash da
-- anterior (worker/diario-p20.mjs, chainHash). diario_head guarda a cabeça para o compare-and-set.

CREATE TABLE IF NOT EXISTS diario_v1 (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT UNIQUE NOT NULL,
  tipo TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  ref TEXT,
  payload_json TEXT NOT NULL,
  payload_sha TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  chain_hash TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS diario_v1_tipo_ts ON diario_v1 (tipo, ts_ms);
CREATE INDEX IF NOT EXISTS diario_v1_ref ON diario_v1 (ref);

CREATE TABLE IF NOT EXISTS diario_head (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  seq INTEGER NOT NULL,
  chain_hash TEXT NOT NULL
);

-- Cabeça genesis: seq 0, 64 zeros.
INSERT OR IGNORE INTO diario_head (id, seq, chain_hash)
VALUES (1, 0, '0000000000000000000000000000000000000000000000000000000000000000');

CREATE TRIGGER IF NOT EXISTS diario_v1_sem_update
BEFORE UPDATE ON diario_v1
BEGIN
  SELECT RAISE(ABORT, 'diario_v1_somente_inclusao');
END;

CREATE TRIGGER IF NOT EXISTS diario_v1_sem_delete
BEFORE DELETE ON diario_v1
BEGIN
  SELECT RAISE(ABORT, 'diario_v1_somente_inclusao');
END;

-- A cabeça só avança de um em um e nunca é apagada.
CREATE TRIGGER IF NOT EXISTS diario_head_so_avanca
BEFORE UPDATE ON diario_head
WHEN NEW.seq <> OLD.seq + 1 OR NEW.id <> OLD.id
BEGIN
  SELECT RAISE(ABORT, 'diario_head_so_avanca');
END;

CREATE TRIGGER IF NOT EXISTS diario_head_sem_delete
BEFORE DELETE ON diario_head
BEGIN
  SELECT RAISE(ABORT, 'diario_head_sem_delete');
END;
