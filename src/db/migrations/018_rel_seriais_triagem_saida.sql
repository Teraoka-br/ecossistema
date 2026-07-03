-- Migration 018 — Rel Estoque de Seriais (CSV Datasys) e Triagem Saída.
-- Fontes não cobertas pela migration 015 (SH/HIS/PEACS/BKP).

CREATE TABLE rel_seriais_imports (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  filename            TEXT    NOT NULL,
  file_hash           TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','COMPLETED','FAILED','CANCELLED')),
  rows_found          INTEGER NOT NULL DEFAULT 0,
  rows_valid          INTEGER NOT NULL DEFAULT 0,
  issues_count        INTEGER NOT NULL DEFAULT 0,
  created_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at         TEXT
);
CREATE UNIQUE INDEX idx_rel_seriais_hash ON rel_seriais_imports(file_hash)
  WHERE status NOT IN ('FAILED','CANCELLED');
CREATE INDEX idx_rel_seriais_created ON rel_seriais_imports(created_at);

CREATE TABLE rel_seriais_rows (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  rel_seriais_import_id   INTEGER NOT NULL REFERENCES rel_seriais_imports(id) ON DELETE CASCADE,
  imei                    TEXT,
  imei_norm               TEXT,
  technician_name         TEXT,
  age_days                INTEGER,
  cost                    REAL,
  raw_data_json           TEXT,
  repair_case_id          INTEGER REFERENCES repair_cases(id) ON DELETE SET NULL,
  created_at              TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_rel_seriais_rows_import ON rel_seriais_rows(rel_seriais_import_id);
CREATE INDEX idx_rel_seriais_rows_imei   ON rel_seriais_rows(imei_norm);
CREATE INDEX idx_rel_seriais_rows_case   ON rel_seriais_rows(repair_case_id);

CREATE TABLE triagem_saida_imports (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  filename            TEXT    NOT NULL,
  file_hash           TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','COMPLETED','FAILED','CANCELLED')),
  rows_found          INTEGER NOT NULL DEFAULT 0,
  rows_linked         INTEGER NOT NULL DEFAULT 0,
  rows_unlinked       INTEGER NOT NULL DEFAULT 0,
  issues_count        INTEGER NOT NULL DEFAULT 0,
  created_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at         TEXT
);
CREATE UNIQUE INDEX idx_triagem_saida_hash ON triagem_saida_imports(file_hash)
  WHERE status NOT IN ('FAILED','CANCELLED');
CREATE INDEX idx_triagem_saida_created ON triagem_saida_imports(created_at);

CREATE TABLE triagem_saida_rows (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  triagem_saida_import_id  INTEGER NOT NULL REFERENCES triagem_saida_imports(id) ON DELETE CASCADE,
  imei                     TEXT,
  imei_norm                TEXT,
  os                       TEXT,
  os_norm                  TEXT,
  brand                    TEXT,
  model                    TEXT,
  destination              TEXT,
  grade                    TEXT,
  exit_date                TEXT,
  raw_data_json            TEXT,
  repair_case_id           INTEGER REFERENCES repair_cases(id) ON DELETE SET NULL,
  link_issue               TEXT,
  created_at               TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_triagem_saida_rows_import ON triagem_saida_rows(triagem_saida_import_id);
CREATE INDEX idx_triagem_saida_rows_imei   ON triagem_saida_rows(imei_norm);
CREATE INDEX idx_triagem_saida_rows_case   ON triagem_saida_rows(repair_case_id);
