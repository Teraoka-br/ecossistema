-- Migration 023: SH Ordens de Serviço, PEACS standalone, Demonstrativo de Saldos
--               + campos de formulário de análise (color, problema, part fields)

-- ---------------------------------------------------------------------------
-- SH Ordens de Serviço (substitui SH Catálogo como tabela de destino do card SH)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sh_os_imports (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  filename            TEXT    NOT NULL,
  file_hash           TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'PENDING',
  rows_found          INTEGER NOT NULL DEFAULT 0,
  rows_valid          INTEGER,
  issues_count        INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at         TEXT,
  created_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS sh_os_rows (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  sh_os_import_id   INTEGER NOT NULL REFERENCES sh_os_imports(id) ON DELETE CASCADE,
  os_norm           TEXT,
  imei_norm         TEXT,
  os_raw            TEXT,
  imei_raw          TEXT,
  marca             TEXT,
  modelo            TEXT,
  cor               TEXT,
  defeito           TEXT,
  obs_servico       TEXT,
  raw_data_json     TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sh_os_rows_os_norm   ON sh_os_rows(os_norm)   WHERE os_norm IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sh_os_rows_imei_norm ON sh_os_rows(imei_norm) WHERE imei_norm IS NOT NULL;

-- ---------------------------------------------------------------------------
-- PEACS standalone (complementa a PEACS embedded no card Pedidos)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS peacs_imports (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  filename            TEXT    NOT NULL,
  file_hash           TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'PENDING',
  rows_found          INTEGER NOT NULL DEFAULT 0,
  rows_valid          INTEGER,
  issues_count        INTEGER NOT NULL DEFAULT 0,
  updated_date        TEXT,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at         TEXT,
  created_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- ---------------------------------------------------------------------------
-- Demonstrativo de Saldos
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS demonstrativo_imports (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  filename            TEXT    NOT NULL,
  file_hash           TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'PENDING',
  rows_found          INTEGER NOT NULL DEFAULT 0,
  rows_valid          INTEGER,
  issues_count        INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at         TEXT,
  created_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS demonstrativo_rows (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  demonstrativo_import_id INTEGER NOT NULL REFERENCES demonstrativo_imports(id) ON DELETE CASCADE,
  referencia              TEXT,
  referencia_norm         TEXT,
  descricao               TEXT,
  codigo_comercial        TEXT,
  fabricante              TEXT,
  grupo                   TEXT,
  subgrupo                TEXT,
  familia                 TEXT,
  saldo                   REAL,
  created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_demonstrativo_rows_ref ON demonstrativo_rows(referencia_norm) WHERE referencia_norm IS NOT NULL;

-- ---------------------------------------------------------------------------
-- repair_cases: campos novos para análise
-- (color já existe desde migration 013; apenas problema é novo)
-- ---------------------------------------------------------------------------
ALTER TABLE repair_cases ADD COLUMN problema TEXT;

-- ---------------------------------------------------------------------------
-- part_requests: campos de formulário de análise
-- ---------------------------------------------------------------------------
ALTER TABLE part_requests ADD COLUMN peca_nome         TEXT;
ALTER TABLE part_requests ADD COLUMN incluir_cor        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE part_requests ADD COLUMN cor_usada          TEXT;
ALTER TABLE part_requests ADD COLUMN field_origins_json TEXT;
