-- Migration 004 — bipagem operacional e snapshot oficial de estoque.
--
-- Estende count_sessions/count_scans (criadas vazias na migration 001, nunca
-- usadas até aqui) com os campos necessários para a contagem física real, e
-- cria reference_mappings/stock_snapshots/stock_snapshot_items.
--
-- count_sessions/count_scans são recriadas (rename + recreate + copia) para
-- poder adicionar CHECK/NOT NULL/índice único parcial, que o SQLite não
-- permite acrescentar via ALTER TABLE em uma tabela já existente. Como essas
-- tabelas nunca foram gravadas por nenhuma fase anterior, a cópia é só uma
-- garantia formal — não há perda de dados real neste passo.

-- =========================================================================
-- count_sessions — uma sessão de contagem física (no máximo uma OPEN)
-- =========================================================================
ALTER TABLE count_sessions RENAME TO count_sessions_old;

CREATE TABLE count_sessions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  import_batch_id  INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
  responsible_name TEXT    NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'OPEN'
                     CHECK (status IN ('OPEN','FINALIZED','CANCELLED')),
  started_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at      TEXT,
  notes            TEXT,
  finalized_by     TEXT,
  cancelled_at     TEXT,
  cancelled_by     TEXT,
  cancel_reason    TEXT
);

INSERT INTO count_sessions (id, responsible_name, status, started_at, finished_at)
SELECT id, COALESCE(responsible_name, '(desconhecido)'), status, started_at, finished_at
FROM count_sessions_old;

DROP TABLE count_sessions_old;

-- No máximo uma sessão OPEN no sistema inteiro (índice único parcial).
CREATE UNIQUE INDEX idx_count_sessions_one_open ON count_sessions(status) WHERE status = 'OPEN';
CREATE INDEX idx_count_sessions_batch ON count_sessions(import_batch_id);
CREATE INDEX idx_count_sessions_status ON count_sessions(status);

-- =========================================================================
-- count_scans — uma linha por beep; nunca apagada, só cancelada.
-- =========================================================================
ALTER TABLE count_scans RENAME TO count_scans_old;

CREATE TABLE count_scans (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      INTEGER NOT NULL REFERENCES count_sessions(id) ON DELETE CASCADE,
  reference       TEXT    NOT NULL,
  reference_norm  TEXT    NOT NULL,
  chave_peca      TEXT,
  chave_peca_norm TEXT,
  mapping_status  TEXT    NOT NULL
                   CHECK (mapping_status IN ('RECOGNIZED','UNKNOWN_REFERENCE','MISSING_KEY','CONFLICT')),
  source          TEXT,
  scanned_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  cancelled_at    TEXT,
  cancelled_by    TEXT,
  cancel_reason   TEXT
);

INSERT INTO count_scans (id, session_id, reference, reference_norm, chave_peca, mapping_status, source, scanned_at, cancelled_at)
SELECT id, session_id, reference, UPPER(TRIM(reference)), chave_peca, 'UNKNOWN_REFERENCE', source, scanned_at, cancelled_at
FROM count_scans_old;

DROP TABLE count_scans_old;

CREATE INDEX idx_count_scans_session ON count_scans(session_id);
CREATE INDEX idx_count_scans_session_ref ON count_scans(session_id, reference_norm);
CREATE INDEX idx_count_scans_session_status ON count_scans(session_id, mapping_status);

-- =========================================================================
-- reference_mappings — correções manuais de referência (fatos do sistema;
-- nunca apagados por reimportação, pois não pertencem a nenhum import_batch).
-- =========================================================================
CREATE TABLE reference_mappings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  reference       TEXT    NOT NULL,
  reference_norm  TEXT    NOT NULL,
  chave_peca      TEXT    NOT NULL,
  chave_peca_norm TEXT    NOT NULL,
  active          INTEGER NOT NULL DEFAULT 1,
  created_by      TEXT,
  notes           TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- reference_norm é único apenas entre mapeamentos ATIVOS (permite histórico
-- de mapeamentos desativados sem violar a unicidade).
CREATE UNIQUE INDEX idx_reference_mappings_active_norm
  ON reference_mappings(reference_norm) WHERE active = 1;

-- =========================================================================
-- stock_snapshots — um snapshot por sessão finalizada (estado oficial)
-- =========================================================================
CREATE TABLE stock_snapshots (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  count_session_id INTEGER NOT NULL REFERENCES count_sessions(id) ON DELETE CASCADE,
  import_batch_id  INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
  status           TEXT    NOT NULL DEFAULT 'OFFICIAL' CHECK (status IN ('OFFICIAL')),
  total_units      INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  created_by       TEXT,
  notes            TEXT
);

-- Uma sessão finalizada só pode ter um snapshot.
CREATE UNIQUE INDEX idx_stock_snapshots_session ON stock_snapshots(count_session_id);
CREATE INDEX idx_stock_snapshots_status ON stock_snapshots(status);

-- =========================================================================
-- stock_snapshot_items — consolidado por (referência normalizada, chave normalizada)
-- =========================================================================
CREATE TABLE stock_snapshot_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id      INTEGER NOT NULL REFERENCES stock_snapshots(id) ON DELETE CASCADE,
  reference        TEXT    NOT NULL,
  reference_norm   TEXT    NOT NULL,
  chave_peca       TEXT,
  chave_peca_norm  TEXT,
  counted_quantity INTEGER NOT NULL CHECK (counted_quantity > 0),
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (snapshot_id, reference_norm, chave_peca_norm)
);

CREATE INDEX idx_snapshot_items_snapshot ON stock_snapshot_items(snapshot_id);
