-- Migration 031 — Rel. Estoque de Seriais "Com Saldo" (fonte separada)
-- Tabela espelho de rel_seriais_imports para distinguir uploads "todos" x "com saldo".

CREATE TABLE rel_seriais_saldo_imports (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  filename            TEXT    NOT NULL,
  file_hash           TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','COMPLETED','FAILED','CANCELLED')),
  rows_found          INTEGER NOT NULL DEFAULT 0,
  rows_valid          INTEGER NOT NULL DEFAULT 0,
  issues_count        INTEGER NOT NULL DEFAULT 0,
  rows_inserted       INTEGER NOT NULL DEFAULT 0,
  rows_updated        INTEGER NOT NULL DEFAULT 0,
  rows_unchanged      INTEGER NOT NULL DEFAULT 0,
  report_scope        TEXT    NOT NULL DEFAULT 'UNKNOWN',
  created_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at         TEXT
);
CREATE UNIQUE INDEX idx_rel_seriais_saldo_hash ON rel_seriais_saldo_imports(file_hash)
  WHERE status NOT IN ('FAILED','CANCELLED');
CREATE INDEX idx_rel_seriais_saldo_created ON rel_seriais_saldo_imports(created_at);
